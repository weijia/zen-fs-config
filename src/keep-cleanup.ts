/**
 * zen-fs-config — `.keep` placeholder cleanup (local primary only)
 *
 * Backends that cannot store empty directories (Git, RemoteStorage…) keep a
 * directory alive with an internal `.keep` placeholder — exactly like the
 * `.mtime` sidecar, this is backend-internal metadata that MUST be hidden from
 * callers (see zen-fs-sync/docs/SyncableFS.md §1/§2).
 *
 * Older builds leaked `.keep` files into the local primary (IndexedDB on
 * browser, Folder on Node), where they linger forever: the sync engine now
 * skips `.keep` paths on both sides, so nothing ever removes them, and every
 * walk re-creates confusion about which directories are "real".
 *
 * This module walks the local primary and deletes those leaked `.keep` files.
 * It never touches replica (remote) backends: their placeholders are live
 * metadata that keep real (empty) directories alive, and deleting them would
 * lose directory structure.
 *
 * The intentional `.keep` placeholder at `/.meta/backends/.keep` (used to keep
 * the backends directory alive) is protected and never deleted — see
 * `protectedDirs`. Any other `.keep` (including `/.meta/.keep`, which some older
 * builds leaked into the local primary) is treated as a leak and purged.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal async FS surface needed for the purge. */
export interface PurgeableFS {
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mode?: number }>;
  unlink(path: string): Promise<void>;
}

export interface PurgeKeepOptions {
  /** Root to scan. Default: `/` (the whole local primary). */
  root?: string;
  /** Report what would be deleted without unlinking anything. */
  dryRun?: boolean;
  /**
   * Exact paths (or directories and their subtrees) whose `.keep` files are
   * NEVER deleted. Defaults to `['/.meta/backends/.keep']` to protect the
   * single intentional placeholder that keeps `/.meta/backends` alive. A leaked
   * `.keep` elsewhere (e.g. `/.meta/.keep`, `/docs/.keep`) is still purged.
   */
  protectedDirs?: string[];
}

export interface KeepPurgeResult {
  /** Files visited during the walk (`.keep` included). */
  scanned: number;
  /** Placeholders deleted — or, in dryRun, that would be deleted. */
  removed: string[];
  /** Placeholders that could not be deleted (unlink failed). */
  failed: string[];
}

// ---------------------------------------------------------------------------
// Placeholder detection
// ---------------------------------------------------------------------------

/**
 * True when a file name is the internal `.keep` directory placeholder.
 *
 * Matches exactly `.keep` (the file name), which is the only form produced by
 * the backends — never a suffix match, so `foo.keep` is left untouched.
 */
export function isKeepFile(fileName: string): boolean {
  return fileName === '.keep';
}

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

const S_IFDIR = 0o40000;
// Only the single intentional placeholder that keeps `/.meta/backends` alive is
// protected. Older builds leaked `.keep` files into `/.meta/.keep` (and other
// locations) on the local primary; those must be purged, not shielded.
const DEFAULT_PROTECTED_DIRS = ['/.meta/backends/.keep'];

function isDirectory(stat: { mode?: number }): boolean {
  return typeof stat.mode === 'number' && (stat.mode & S_IFDIR) === S_IFDIR;
}

function joinPath(dir: string, entry: string): string {
  if (dir === '/' || dir === '') return `/${entry}`;
  return `${dir.replace(/\/+$/, '')}/${entry}`;
}

/** True when `fullPath` is inside (or is) one of the protected directories. */
function isProtected(fullPath: string, protectedDirs: string[]): boolean {
  return protectedDirs.some((d) => {
    const dir = d.endsWith('/') ? d.slice(0, -1) : d;
    return fullPath === dir || fullPath.startsWith(dir + '/');
  });
}

/**
 * Delete every leaked `.keep` placeholder stored in a local primary backend.
 *
 * Walks the whole tree from `options.root` — including dotfiles and `/.meta/`
 * entries — but skips any directory listed in `protectedDirs` (default
 * `/.meta`) so the intentional backends placeholder survives. Unreadable
 * entries are skipped; failures on individual files are collected in `failed`
 * instead of aborting the walk.
 */
export async function purgeKeepFiles(
  fs: PurgeableFS,
  options: PurgeKeepOptions = {},
): Promise<KeepPurgeResult> {
  const root = options.root && options.root !== '' ? options.root : '/';
  const dryRun = options.dryRun ?? false;
  const protectedDirs = options.protectedDirs ?? DEFAULT_PROTECTED_DIRS;

  const result: KeepPurgeResult = { scanned: 0, removed: [], failed: [] };
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (isProtected(dir, protectedDirs)) continue; // never descend into meta

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue; // directory gone / unreadable — nothing to purge here
    }

    for (const entry of entries) {
      const fullPath = joinPath(dir, entry);
      if (isProtected(fullPath, protectedDirs)) continue; // extra safety

      let stat: { mode?: number };
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue; // broken entry
      }

      if (isDirectory(stat)) {
        stack.push(fullPath);
        continue;
      }

      result.scanned++;
      if (!isKeepFile(entry)) continue;

      if (dryRun) {
        result.removed.push(fullPath);
        continue;
      }

      try {
        await fs.unlink(fullPath);
        result.removed.push(fullPath);
      } catch {
        result.failed.push(fullPath);
      }
    }
  }

  return result;
}
