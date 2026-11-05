/**
 * zen-fs-config — Shared Sync-Group Metadata
 *
 * Implements the layout agreed in SYNC-GROUP-UNIFICATION.zh-CN.md:
 *
 *   /.meta/group.json                 # group descriptor (kind/id/features)
 *   /.meta/tombstones/{encoded}.json  # tombstones (legacy: /.meta/.deleted)
 *   /.meta/versions/{encoded}.json    # version records for data groups
 *   /.meta/conflicts/{conflictId}/    # conflict archives (legacy: /.meta/.conflicts)
 *   /.config/**                       # config-sync only (not synced by data groups)
 *
 * Both the config-sync group and the data-sync groups use the `.meta/` helpers
 * below; `.config/` paths stay in config-repo.ts because only that group owns
 * them.
 */

import type {
  AppDataBackendDescriptor,
  ConflictArchive,
  GroupDescriptor,
  SyncGroupFeatures,
  TombstoneMeta,
  VersionMeta,
} from './types';
import { sha256 } from './version';
import {
  mergeBackendDescriptor,
  serializeBackendDescriptor,
  serializeGroupDescriptor,
} from './canonical-json';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const META_DIR = '/.meta';
export const GROUP_DESCRIPTOR_FILE = `${META_DIR}/group.json`;
export const META_BACKENDS_DIR = `${META_DIR}/backends`;
export const TOMBSTONES_DIR = `${META_DIR}/tombstones`;
export const LEGACY_TOMBSTONES_DIR = `${META_DIR}/.deleted`;
export const VERSIONS_DIR = `${META_DIR}/versions`;
export const CONFLICTS_DIR = `${META_DIR}/conflicts`;
export const LEGACY_CONFLICTS_DIR = `${META_DIR}/.conflicts`;
export const CONFIG_DIR = '/.config';

/** Default features for a data-sync group: tombstones on, versions/conflicts opt-in. */
export const DATA_GROUP_DEFAULT_FEATURES: SyncGroupFeatures = {
  tombstones: true,
  versions: false,
  conflicts: false,
  configHost: false,
  appData: true,
};

// ---------------------------------------------------------------------------
// Small fs helpers (work with backend instances and SyncableFS alike)
// ---------------------------------------------------------------------------

type MetaFS = {
  readFile(path: string, encoding?: string): Promise<any>;
  writeFile(path: string, data: any): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string): Promise<any>;
  unlink(path: string): Promise<void>;
  exists?(path: string): Promise<boolean>;
};

function toBytes(raw: any): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (typeof raw === 'string') return new TextEncoder().encode(raw);
  return new Uint8Array(raw);
}

/** Create every parent directory of `filePath`. mkdir is idempotent. */
export async function ensureParentDir(fs: MetaFS, filePath: string): Promise<void> {
  const parts = filePath.split('/').filter(Boolean);
  parts.pop();
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    try {
      await fs.mkdir(current);
    } catch {
      /* already exists */
    }
  }
}

async function readJson<T>(fs: MetaFS, path: string): Promise<T | null> {
  const raw = await readText(fs, path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Read a text file, returning `null` when it does not exist / cannot be read. */
async function readText(fs: MetaFS, path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(toBytes(await fs.readFile(path)));
  } catch {
    return null;
  }
}

async function writeJson(fs: MetaFS, path: string, value: unknown): Promise<void> {
  await ensureParentDir(fs, path);
  await fs.writeFile(path, new TextEncoder().encode(JSON.stringify(value, null, 2)));
}

async function existsSafe(fs: MetaFS, path: string): Promise<boolean> {
  try {
    if (typeof fs.exists === 'function') return await fs.exists(path);
    await fs.readFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Backend-internal mtime sidecar (`<name>.mtime`).
 *
 * GiteeFS keeps these out of its Index and only in its SHA cache, so `exists()`
 * reports `false` for them even when the blob is still on the remote. They must
 * be unlinked unconditionally, otherwise `<dir>/.keep.mtime` survives a
 * directory delete and keeps the (now empty) directory alive in Git.
 */
function isMtimeSidecarPath(path: string): boolean {
  return path.endsWith('.mtime');
}

/**
 * Encode a file path into a flat metadata entry name.
 * `/a/b.json` → `a__b++json`
 */
export function encodeMetaPath(filePath: string): string {
  const normalized = filePath.startsWith('/') ? filePath : `/${filePath}`;
  return normalized.replace(/^\//, '').replace(/\//g, '__').replace(/\./g, '++');
}

// ---------------------------------------------------------------------------
// Group descriptor
// ---------------------------------------------------------------------------

/** Read `.meta/group.json`. `updatedAt` is deprecated and ignored on read. */
export async function readGroupDescriptor(fs: MetaFS): Promise<GroupDescriptor | null> {
  const parsed = await readJson<GroupDescriptor & { updatedAt?: number }>(fs, GROUP_DESCRIPTOR_FILE);
  if (!parsed) return null;
  const { updatedAt: _ignored, ...rest } = parsed;
  return rest as GroupDescriptor;
}

/**
 * Write `.meta/group.json`.
 *
 * 幂等：内容与磁盘现有内容字节相同则不写。`updatedAt` 是 deprecated 字段，
 * 不再写入（写进随同步走的内容会形成「写 → 内容变 → 触发同步 → 对端再写」
 * 的无限回环）。
 */
export async function writeGroupDescriptor(fs: MetaFS, descriptor: GroupDescriptor): Promise<void> {
  const bytes = serializeGroupDescriptor(descriptor);
  if ((await readText(fs, GROUP_DESCRIPTOR_FILE)) === bytes) return;
  await ensureParentDir(fs, GROUP_DESCRIPTOR_FILE);
  await fs.writeFile(GROUP_DESCRIPTOR_FILE, new TextEncoder().encode(bytes));
}

// ---------------------------------------------------------------------------
// Data-group backend descriptors (`.meta/backends/{id}.json`)
// ---------------------------------------------------------------------------

/**
 * Backend ids become file names, so they must not escape `.meta/backends/`.
 * `/`, `\` and `..` are rejected (path traversal).
 */
export function assertValidBackendId(id: string): void {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('Backend id must be a non-empty string');
  }
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`Invalid backend id "${id}": must not contain "/", "\\" or ".."`);
  }
}

/** Path of a data-group backend descriptor: `.meta/backends/{id}.json`. */
export function backendMetaFilePath(id: string): string {
  assertValidBackendId(id);
  return `${META_BACKENDS_DIR}/${id}.json`;
}

/**
 * Read every backend descriptor from `.meta/backends/`.
 *
 * Returns `null` when the directory does not exist (→ caller may lazily
 * backfill from the config group's bootstrap descriptor) and `[]` when the
 * directory exists but holds no usable descriptors (→ authoritative empty list,
 * e.g. after every backend was removed).
 */
export async function readBackendMetaDescriptors(
  fs: MetaFS,
): Promise<AppDataBackendDescriptor[] | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(META_BACKENDS_DIR);
  } catch {
    return null;
  }
  const out: AppDataBackendDescriptor[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const desc = await readJson<AppDataBackendDescriptor>(fs, `${META_BACKENDS_DIR}/${entry}`);
    if (!desc || typeof desc.id !== 'string' || typeof desc.type !== 'string') continue;
    out.push(desc);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Write one backend descriptor with canonical bytes.
 *
 * `createdAt` is merged with the value already on disk by `min`, so two devices
 * never rewrite each other's file just because they recorded different
 * timestamps. Returns `true` when the file was actually written.
 */
export async function writeBackendMetaDescriptor(
  fs: MetaFS,
  descriptor: AppDataBackendDescriptor,
): Promise<boolean> {
  assertValidBackendId(descriptor.id);
  const path = backendMetaFilePath(descriptor.id);
  const raw = await readText(fs, path);
  let existing: AppDataBackendDescriptor | null = null;
  if (raw !== null) {
    try {
      existing = JSON.parse(raw) as AppDataBackendDescriptor;
    } catch {
      existing = null; // corrupt → overwrite with the good copy
    }
  }
  const bytes = serializeBackendDescriptor(mergeBackendDescriptor(existing, descriptor));
  if (raw === bytes) return false;
  await ensureParentDir(fs, path);
  await fs.writeFile(path, new TextEncoder().encode(bytes));
  return true;
}

/** Delete one backend descriptor file. The caller is responsible for the tombstone. */
export async function removeBackendMetaDescriptor(fs: MetaFS, id: string): Promise<void> {
  const path = backendMetaFilePath(id);
  try {
    await fs.unlink(path);
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// TombstoneStore
// ---------------------------------------------------------------------------

export interface TombstoneTarget {
  id: string;
  fs: any;
}

/**
 * Tombstone store for a group's local store.
 *
 * New writes go to `/.meta/tombstones/`; for one release cycle a mirror copy is
 * also written to the legacy `/.meta/.deleted/` path so older clients still see
 * deletions. Reads accept both.
 */
export class TombstoneStore {
  constructor(
    private fs: MetaFS,
    private author: string,
  ) {}

  private pathFor(filePath: string, dir = TOMBSTONES_DIR): string {
    return `${dir}/${encodeMetaPath(filePath)}.json`;
  }

  /** All tombstones, new path first, legacy only for paths not already seen. */
  async list(): Promise<TombstoneMeta[]> {
    const byPath = new Map<string, TombstoneMeta>();
    for (const dir of [TOMBSTONES_DIR, LEGACY_TOMBSTONES_DIR]) {
      let entries: string[];
      try {
        entries = await this.fs.readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const data = await readJson<TombstoneMeta>(this.fs, `${dir}/${entry}`);
        if (!data || typeof data.path !== 'string') continue;
        const prev = byPath.get(data.path);
        if (prev) {
          // Merge confirmations so GC is not blocked by a stale mirror.
          for (const id of data.confirmedBy ?? []) {
            if (!prev.confirmedBy.includes(id)) prev.confirmedBy.push(id);
          }
        } else {
          byPath.set(data.path, data);
        }
      }
    }
    return Array.from(byPath.values());
  }

  /** Write a tombstone (new + legacy mirror). */
  async write(tombstone: TombstoneMeta): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(tombstone, null, 2));
    const paths = [
      this.pathFor(tombstone.path),
      this.pathFor(tombstone.path, LEGACY_TOMBSTONES_DIR),
    ];
    for (const p of paths) {
      await ensureParentDir(this.fs, p);
      await this.fs.writeFile(p, bytes);
    }
  }

  /** Persist an updated tombstone (confirmations) to whichever paths exist. */
  async save(tombstone: TombstoneMeta): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(tombstone, null, 2));
    for (const dir of [TOMBSTONES_DIR, LEGACY_TOMBSTONES_DIR]) {
      const p = this.pathFor(tombstone.path, dir);
      if (!(await existsSafe(this.fs, p))) continue;
      await this.fs.writeFile(p, bytes);
    }
  }

  /** Delete a tombstone from both layouts. */
  async remove(tombstone: TombstoneMeta): Promise<void> {
    for (const dir of [TOMBSTONES_DIR, LEGACY_TOMBSTONES_DIR]) {
      const p = this.pathFor(tombstone.path, dir);
      if (!(await existsSafe(this.fs, p))) continue;
      try {
        await this.fs.unlink(p);
      } catch {
        /* race */
      }
    }
  }

  /**
   * Delete every tombstoned file (and its version record) on the local store
   * and on each target backend, so bi-directional sync cannot resurrect it.
   */
  async process(targets: TombstoneTarget[] = []): Promise<void> {
    const tombstones = await this.list();
    for (const tombstone of tombstones) {
      await this.deleteEverywhere(this.fs, tombstone.path);
      for (const target of targets) {
        await this.deleteEverywhere(target.fs, tombstone.path);
      }
    }
  }

  private async deleteEverywhere(fs: any, filePath: string): Promise<void> {
    // `.mtime` sidecars are hidden from the backend index (GiteeFS keeps them in
    // its SHA cache only), so exists() lies and the unlink below would never run.
    // Attempt the delete unconditionally — a missing blob just throws and is ignored.
    if (!isMtimeSidecarPath(filePath) && !(await existsSafe(fs, filePath))) return;
    try {
      await fs.unlink(filePath);
    } catch {
      /* race — already gone */
    }
  }

  /** Add the given backend ids to every tombstone's confirmation set. */
  async confirm(backendIds: string[]): Promise<number> {
    const tombstones = await this.list();
    let modified = 0;
    for (const tombstone of tombstones) {
      let changed = false;
      for (const id of backendIds) {
        if (!tombstone.confirmedBy.includes(id)) {
          tombstone.confirmedBy.push(id);
          changed = true;
        }
      }
      if (!changed) continue;
      try {
        await this.save(tombstone);
        modified++;
      } catch {
        /* ignore */
      }
    }
    return modified;
  }

  /** Remove tombstones confirmed by every connected backend (and their mirrors). */
  async gc(allBackendIds: string[], targets: TombstoneTarget[] = []): Promise<void> {
    const tombstones = await this.list();
    for (const tombstone of tombstones) {
      const allConfirmed = allBackendIds.every((id) => tombstone.confirmedBy.includes(id));
      if (!allConfirmed) continue;
      for (const dir of [TOMBSTONES_DIR, LEGACY_TOMBSTONES_DIR]) {
        const p = this.pathFor(tombstone.path, dir);
        if (await existsSafe(this.fs, p)) {
          try {
            await this.fs.unlink(p);
          } catch {
            /* race */
          }
        }
        for (const target of targets) {
          if (await existsSafe(target.fs, p)) {
            try {
              await target.fs.unlink(p);
            } catch {
              /* race */
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// VersionStore (data groups)
// ---------------------------------------------------------------------------

/**
 * Version records for data files, stored centrally under `/.meta/versions/`.
 * Config-sync keeps its historical `<file>.version` sidecars; only data groups
 * use this store (see SYNC-GROUP-UNIFICATION §4.4 for the migration note).
 */
export class VersionStore {
  constructor(
    private fs: MetaFS,
    private author: string,
  ) {}

  /** `null` for metadata paths and version files themselves. */
  pathFor(filePath: string): string | null {
    const normalized = filePath.startsWith('/') ? filePath : `/${filePath}`;
    if (normalized.startsWith(`${META_DIR}/`)) return null;
    if (normalized.endsWith('.version')) return null;
    return `${VERSIONS_DIR}/${encodeMetaPath(normalized)}.json`;
  }

  async read(filePath: string): Promise<VersionMeta | null> {
    const p = this.pathFor(filePath);
    if (!p) return null;
    return readJson<VersionMeta>(this.fs, p);
  }

  async record(filePath: string, content: Uint8Array): Promise<VersionMeta | null> {
    const p = this.pathFor(filePath);
    if (!p) return null;
    const prev = await this.read(filePath);
    const hash = await sha256(content);
    if (prev && prev.hash === hash) return prev;
    const meta: VersionMeta = {
      version: (prev?.version ?? 0) + 1,
      hash,
      author: this.author,
      timestamp: Date.now(),
    };
    await writeJson(this.fs, p, meta);
    return meta;
  }

  async remove(filePath: string): Promise<void> {
    const p = this.pathFor(filePath);
    if (!p || !(await existsSafe(this.fs, p))) return;
    try {
      await this.fs.unlink(p);
    } catch {
      /* race */
    }
  }
}

// ---------------------------------------------------------------------------
// ConflictStore (data groups)
// ---------------------------------------------------------------------------

export interface RawConflict {
  path: string;
  sourceContent: string;
  targetContent: string;
  resolvedWith?: string;
}

/**
 * Conflict archives for data files, stored under `/.meta/conflicts/`.
 * Legacy `/.meta/.conflicts/` archives stay readable (list/read fallback).
 */
export class ConflictStore {
  constructor(
    private fs: MetaFS,
    private appId: string,
    private nodeId: string,
    private versions: VersionStore,
  ) {}

  /** Persist source/target backups + meta.json. Returns the archive record. */
  async archive(conflict: RawConflict, timestamp = Date.now()): Promise<ConflictArchive> {
    const conflictId = `${timestamp}_${conflict.path.replace(/\//g, '_')}`;
    const dir = `${CONFLICTS_DIR}/${conflictId}`;
    await ensureParentDir(this.fs, `${dir}/meta.json`);
    await this.fs.writeFile(`${dir}/source`, new TextEncoder().encode(conflict.sourceContent));
    await this.fs.writeFile(`${dir}/target`, new TextEncoder().encode(conflict.targetContent));

    const sourceVersion = (await this.versions.read(conflict.path))?.version ?? 0;
    const archive: ConflictArchive = {
      conflictPath: conflict.path,
      timestamp,
      sourceAuthor: `${this.appId}/${this.nodeId}`,
      targetAuthor: 'unknown',
      sourceVersion,
      targetVersion: 0,
      ...(conflict.resolvedWith ? { resolvedStrategy: conflict.resolvedWith as any } : {}),
      sourceBackupPath: './source',
      targetBackupPath: './target',
    };
    await writeJson(this.fs, `${dir}/meta.json`, archive);
    return archive;
  }

  /** All archives, new layout first, legacy entries only when not shadowed. */
  async list(): Promise<ConflictArchive[]> {
    const seen = new Set<string>();
    const archives: ConflictArchive[] = [];
    for (const dir of [CONFLICTS_DIR, LEGACY_CONFLICTS_DIR]) {
      let entries: string[];
      try {
        entries = await this.fs.readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (seen.has(entry)) continue;
        const archive = await readJson<ConflictArchive>(this.fs, `${dir}/${entry}/meta.json`);
        if (!archive) continue;
        seen.add(entry);
        archives.push(archive);
      }
    }
    return archives.sort((a, b) => a.timestamp - b.timestamp);
  }

  private candidatesFor(conflictId: string): string[] {
    const id = conflictId.replace(/\/meta\.json$/, '');
    return [`${CONFLICTS_DIR}/${id}`, `${LEGACY_CONFLICTS_DIR}/${id}`];
  }

  async readBackup(conflictId: string, fileType: 'source' | 'target' | 'resolved'): Promise<string> {
    for (const dir of this.candidatesFor(conflictId)) {
      const p = `${dir}/${fileType}`;
      try {
        return new TextDecoder().decode(toBytes(await this.fs.readFile(p)));
      } catch {
        /* try next */
      }
    }
    throw new Error(`Conflict backup not found: ${conflictId}/${fileType}`);
  }

  /** Resolve a conflict with raw (already serialized) content. */
  async resolve(conflictId: string, mergedContent: string | Uint8Array): Promise<void> {
    for (const dir of this.candidatesFor(conflictId)) {
      const metaPath = `${dir}/meta.json`;
      const archive = await readJson<ConflictArchive>(this.fs, metaPath);
      if (!archive) continue;

      const bytes = typeof mergedContent === 'string'
        ? new TextEncoder().encode(mergedContent)
        : mergedContent;
      await ensureParentDir(this.fs, archive.conflictPath);
      await this.fs.writeFile(archive.conflictPath, bytes);
      await this.versions.record(archive.conflictPath, bytes);

      await this.fs.writeFile(`${dir}/resolved`, bytes);
      archive.resolvedBackupPath = './resolved';
      await writeJson(this.fs, metaPath, archive);
      return;
    }
    throw new Error(`Failed to resolve conflict ${conflictId}: archive not found`);
  }
}
