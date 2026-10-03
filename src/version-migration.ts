/**
 * zen-fs-config — Legacy Version Sidecar Migration
 *
 * Version sidecars used to be stored as hidden dotfiles:
 *
 *   config file:  /app-a/db.json
 *   version file: /app-a/.db.json.version        (OLD — starts with `.`)
 *
 * They are now stored as `<name>.version` (no leading dot):
 *
 *   version file: /app-a/db.json.version         (NEW)
 *
 * This module migrates existing legacy sidecars to the new naming at startup,
 * preserving version history (the file content is byte-identical after rename).
 *
 * Ambiguity safety: a legacy path `.x.version` could in theory belong to either
 * a dotfile config `.x` (whose version is unchanged by the rename) or a
 * non-dot config `x` (old naming). We resolve it by probing the directory:
 *   - `.x` exists  → it's the dotfile config's version → NEW path == legacy → skip
 *   - `x`  exists  → rename legacy `.x.version` → `x.version`
 *   - neither      → orphan (config gone) → delete
 *
 * We also delete the remote residual legacy path from every replica so the
 * sync engine does not pull the old sidecar back (zen-fs-sync syncs `.version`
 * files on both ends).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import { versionPathFor } from './version';

/** Minimal async FS surface needed to read/rename/delete on the local primary. */
export interface MigrateLocalFS {
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mode?: number }>;
  readFile(path: string, encoding?: string): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** Minimal async FS surface needed to delete remote residual legacy sidecars. */
export interface MigrateReplicaFS {
  unlink(path: string): Promise<void>;
}

export interface VersionMigrationOptions {
  /** Root to scan. Default: `/` (the whole local primary). */
  root?: string;
  /** Report what would change without touching anything. */
  dryRun?: boolean;
  /** Replica backends whose legacy sidecars should be deleted. */
  replicas?: MigrateReplicaFS[];
}

export interface VersionMigrationResult {
  /** Local legacy sidecars renamed to the new naming. */
  renamed: string[];
  /** Local orphan legacy sidecars deleted (no owning config). */
  deleted: string[];
  /** Remote residual legacy sidecars deleted (best-effort). */
  remoteDeleted: string[];
  /** Paths that failed to migrate. */
  failed: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const S_IFDIR = 0o40000;

function isDir(stat: { mode?: number }): boolean {
  return typeof stat.mode === 'number' && (stat.mode & S_IFDIR) === S_IFDIR;
}

function joinPath(dir: string, entry: string): string {
  if (dir === '/' || dir === '') return `/${entry}`;
  return `${dir.replace(/\/+$/, '')}/${entry}`;
}

async function existsPath(fs: MigrateLocalFS, p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Extract the owning config name from a legacy version sidecar filename. */
function configNameFromLegacy(entry: string): string {
  // entry is like `.db.json.version` or `.db.json.version.mtime`
  const noMtime = entry.endsWith('.version.mtime')
    ? entry.slice(0, -'.version.mtime'.length)
    : entry.slice(0, -'.version'.length);
  // noMtime starts with '.'; the config name is everything after it.
  return noMtime.slice(1);
}

type Target = { action: 'rename' | 'skip' | 'delete'; newPath?: string };

/**
 * Decide what to do with a legacy version sidecar found at `legacyVerPath`
 * (its filename is `entry`, living in `dir`).
 */
async function resolveTarget(
  fs: MigrateLocalFS,
  dir: string,
  entry: string,
): Promise<Target> {
  const configName = configNameFromLegacy(entry);
  const configPath = joinPath(dir, configName);
  const dotConfigPath = joinPath(dir, `.${configName}`);

  // Dotfile config owns this version → new path equals legacy path → no-op.
  if (await existsPath(fs, dotConfigPath)) {
    return { action: 'skip' };
  }
  // Non-dot config exists → rename legacy `.x.version` → `x.version`.
  // Use versionPathFor() so the new path matches the rest of the system
  // (it returns a relative path for root-level configs, e.g. `db.json` →
  // `db.json.version` without a leading slash).
  if (await existsPath(fs, configPath)) {
    return { action: 'rename', newPath: versionPathFor(configPath) ?? `${configName}.version` };
  }
  // No owning config → orphan, safe to delete.
  return { action: 'delete' };
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Walk `fs` from `options.root` and migrate every legacy `.x.version` /
 * `.x.version.mtime` sidecar to the new `<name>.version` / `<name>.version.mtime`
 * naming. Best-effort: failures are collected in `failed`, never thrown.
 */
export async function migrateVersionSidecars(
  fs: MigrateLocalFS,
  options: VersionMigrationOptions = {},
): Promise<VersionMigrationResult> {
  const root = options.root && options.root !== '' ? options.root : '/';
  const dryRun = options.dryRun ?? false;
  const replicas = options.replicas ?? [];

  const result: VersionMigrationResult = {
    renamed: [],
    deleted: [],
    remoteDeleted: [],
    failed: [],
  };
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue; // directory gone / unreadable
    }

    for (const entry of entries) {
      const full = joinPath(dir, entry);

      let stat: { mode?: number };
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (isDir(stat)) {
        stack.push(full);
        continue;
      }

      // Only legacy version sidecars start with '.' and end with .version/.version.mtime.
      const isLegacyVersion =
        entry.startsWith('.') &&
        (entry.endsWith('.version') || entry.endsWith('.version.mtime'));
      if (!isLegacyVersion) continue;

      // The legacy version path (strip the trailing .mtime if this is its sidecar).
      const legacyVerPath = entry.endsWith('.version.mtime')
        ? full.slice(0, -'.mtime'.length)
        : full;

      const target = await resolveTarget(fs, dir, entry);
      if (target.action === 'skip') continue;

      const legacyMtimePath = `${legacyVerPath}.mtime`;
      const newMtimePath = target.newPath ? `${target.newPath}.mtime` : null;

      if (dryRun) {
        if (target.action === 'rename') result.renamed.push(full);
        else result.deleted.push(full);
        continue;
      }

      // Local operation: rename (preserve content) or delete orphan.
      try {
        if (target.action === 'rename') {
          // Don't clobber an existing new-style sidecar.
          if (await existsPath(fs, target.newPath!)) {
            await fs.unlink(legacyVerPath);
            result.deleted.push(full);
          } else {
            const content = await fs.readFile(legacyVerPath);
            const bytes =
              typeof content === 'string'
                ? new TextEncoder().encode(content)
                : content;
            await fs.writeFile(target.newPath!, bytes);
            await fs.unlink(legacyVerPath);
            result.renamed.push(full);
          }
          // Migrate the mtime sidecar of the version file, if present.
          if (newMtimePath && (await existsPath(fs, legacyMtimePath))) {
            try {
              const mc = await fs.readFile(legacyMtimePath);
              const mb = typeof mc === 'string' ? new TextEncoder().encode(mc) : mc;
              await fs.writeFile(newMtimePath, mb);
              await fs.unlink(legacyMtimePath);
            } catch {
              /* mtime sidecar is best-effort */
            }
          }
        } else {
          // Orphan: delete the version sidecar and its mtime sibling.
          await fs.unlink(legacyVerPath);
          result.deleted.push(full);
          if (await existsPath(fs, legacyMtimePath)) {
            try {
              await fs.unlink(legacyMtimePath);
            } catch {
              /* ignore */
            }
          }
        }
      } catch (e: any) {
        result.failed.push(full);
        continue;
      }

      // Clean remote residual legacy paths (both ends), best-effort.
      for (const rep of replicas) {
        for (const rp of [legacyVerPath, legacyMtimePath]) {
          try {
            await rep.unlink(rp);
            result.remoteDeleted.push(rp);
          } catch {
            /* not-found / unreachable — ignore */
          }
        }
      }
    }
  }

  return result;
}
