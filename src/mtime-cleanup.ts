/**
 * zen-fs-config — mtime sidecar cleanup
 *
 * Backends that cannot store a precise mtime natively (RemoteStorage, Gitee,
 * …) persist it in a `.mtime` sidecar next to each file
 * (`data.json` → `.data.json.mtime`). A sidecar is backend-internal metadata:
 * it belongs to the backend that produced it and must never be handed out by
 * `readdir()`/`createSnapshot()`.
 *
 * Older builds did leak them, and once a sidecar lands in the local primary
 * (IndexedDB on browser, Folder on Node) it stays there forever — zen-fs-sync
 * deliberately skips `.mtime` paths on both sides, so nothing ever removes
 * them, and every walk logs:
 *
 *   [zen-fs-sync] mtime sidecar leaked from backend "local-idb" …
 *
 * This module walks the local primary and deletes those leaked files. It never
 * touches replica (remote) backends: their sidecars are live metadata, and
 * deleting them would cost network calls and lose mtime precision.
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

export interface PurgeMtimeOptions {
  /** Root to scan. Default: `/` (the whole local primary). */
  root?: string;
  /** Report what would be deleted without unlinking anything. */
  dryRun?: boolean;
}

export interface MtimePurgeResult {
  /** Files visited during the walk (sidecars included). */
  scanned: number;
  /** Sidecars deleted — or, in dryRun, that would be deleted. */
  removed: string[];
  /** Sidecars that could not be deleted (unlink failed). */
  failed: string[];
}

// ---------------------------------------------------------------------------
// Sidecar detection
// ---------------------------------------------------------------------------

/**
 * True when a file name is an mtime sidecar.
 *
 * Uses the same rule as zen-fs-sync's walker (`path.endsWith('.mtime')`), so
 * the pathological nested form (`.foo.mtime.mtime`) is covered too.
 */
export function isMtimeSidecar(fileName: string): boolean {
  return fileName.endsWith('.mtime');
}

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

const S_IFDIR = 0o40000;

function isDirectory(stat: { mode?: number }): boolean {
  return typeof stat.mode === 'number' && (stat.mode & S_IFDIR) === S_IFDIR;
}

function joinPath(dir: string, entry: string): string {
  if (dir === '/' || dir === '') return `/${entry}`;
  return `${dir.replace(/\/+$/, '')}/${entry}`;
}

/**
 * Delete every `.mtime` sidecar stored in a local primary backend.
 *
 * Walks the whole tree from `options.root` — including dotfiles and `/.meta/`,
 * because sidecars live next to their data file as `<name>.mtime` files.
 * Unreadable entries are skipped; failures on individual files are collected
 * in `failed` instead of aborting the walk.
 */
export async function purgeMtimeSidecars(
  fs: PurgeableFS,
  options: PurgeMtimeOptions = {},
): Promise<MtimePurgeResult> {
  const root = options.root && options.root !== '' ? options.root : '/';
  const dryRun = options.dryRun ?? false;

  const result: MtimePurgeResult = { scanned: 0, removed: [], failed: [] };
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue; // directory gone / unreadable — nothing to purge here
    }

    for (const entry of entries) {
      const fullPath = joinPath(dir, entry);

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
      if (!isMtimeSidecar(entry)) continue;

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
