/**
 * zen-fs-config — Shared Sync-Group Metadata
 *
 * Implements the layout agreed in SYNC-GROUP-UNIFICATION.zh-CN.md:
 *
 *   /.meta/group.json                 # group descriptor (kind/id/features)
 *   /.meta/tombstones/{encoded}.json  # tombstones (the only deletion record)
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
import { createLogger } from '@richard432/localstorage-logger';
import {
  mergeBackendDescriptor,
  serializeBackendDescriptor,
  serializeGroupDescriptor,
} from './canonical-json';

const log = createLogger('zen-fs-config:tombstones');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const META_DIR = '/.meta';
export const GROUP_DESCRIPTOR_FILE = `${META_DIR}/group.json`;
export const META_BACKENDS_DIR = `${META_DIR}/backends`;
export const TOMBSTONES_DIR = `${META_DIR}/tombstones`;
/**
 * 历史归档目录。仅作为常量保留（旧数据仍在远端，按普通内容对待）：
 * 既不读取也不写入，删除状态只以 {@link TOMBSTONES_DIR} 为准。
 */
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

/**
 * Decode a tombstone entry name back into the deleted file path.
 * `a__b++json.json` → `/a/b.json`. Returns `null` for names that cannot have
 * been produced by {@link encodeMetaPath}.
 *
 * This is the last-resort source of the target path: the name encodes the path,
 * so it survives a truncated or concatenated tombstone body.
 */
export function decodeMetaPath(entry: string): string | null {
  if (!entry.endsWith('.json')) return null;
  const encoded = entry.slice(0, -'.json'.length);
  if (!encoded) return null;
  return `/${encoded.replace(/__/g, '/').replace(/\+\+/g, '.')}`;
}

function fallbackTombstone(path: string): TombstoneMeta {
  // The body is unusable: keep the record minimal but still valid so the
  // downstream confirmation/GC passes can rewrite it into a well-formed file.
  return { path, deletedAt: 0, deletedBy: 'unknown', confirmedBy: [] };
}

function normalizeTombstoneRecord(value: unknown, fallbackPath?: string): TombstoneMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawPath = typeof record.path === 'string' ? record.path : fallbackPath;
  if (!rawPath) return null;
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const confirmedBy = Array.isArray(record.confirmedBy)
    ? (record.confirmedBy as unknown[]).filter((id): id is string => typeof id === 'string')
    : [];
  return {
    path,
    deletedAt: typeof record.deletedAt === 'number' ? record.deletedAt : 0,
    deletedBy: typeof record.deletedBy === 'string' ? record.deletedBy : 'unknown',
    confirmedBy,
  };
}

/**
 * Extract every balanced `{...}` object from `raw`.
 *
 * Tombstones are written with a plain PUT/POST to the remote. When two writers
 * race on the same path (or a write is cut off mid-body), the result is a
 * truncated object followed by the beginning of another one — invalid JSON that
 * still contains recoverable complete objects. Braces inside strings are
 * ignored so a path such as `/{a}.json` cannot confuse the scanner.
 */
function extractJsonObjects(raw: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * Parse one tombstone file body, tolerating corruption.
 *
 * Policy — a corrupt tombstone means "this path was deleted" (conservative):
 *   - The alternative ("ignore it") is what the old `catch {}` did, and it lets
 *     a stale replica resurrect a file the user deliberately deleted. That is
 *     unrecoverable data loss from the user's point of view.
 *   - Honoring it costs at most one extra unlink of an already-absent path,
 *     which is idempotent and cheap.
 *   - The target path is recovered from the filename (`decodeMetaPath`) when the
 *     body is unusable, so a truncated write still protects the right file.
 *
 * A body can contain several JSON documents (a cut-off write followed by a
 * concurrent rewrite). Every balanced object is returned; the caller merges
 * duplicates by path.
 */
export function parseTombstoneFile(
  raw: string,
  fallbackPath?: string,
): { tombstones: TombstoneMeta[]; problems: string[] } {
  const problems: string[] = [];
  const text = raw.trim();
  if (text === '') {
    problems.push('empty body');
    if (fallbackPath) {
      problems.push('path derived from filename');
      return { tombstones: [fallbackTombstone(fallbackPath)], problems };
    }
    problems.push('no path derivable from filename — skipped');
    return { tombstones: [], problems };
  }

  try {
    const parsed = normalizeTombstoneRecord(JSON.parse(text), fallbackPath);
    if (parsed) return { tombstones: [parsed], problems: [] };
    problems.push('JSON parsed but has no usable "path"');
  } catch (err) {
    problems.push(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const recovered = extractJsonObjects(text)
    .map((chunk) => {
      try {
        return normalizeTombstoneRecord(JSON.parse(chunk));
      } catch {
        return null;
      }
    })
    .filter((t): t is TombstoneMeta => t !== null);

  if (recovered.length > 0) {
    if (recovered.length > 1) problems.push(`${recovered.length} concatenated documents recovered`);
    return { tombstones: recovered, problems };
  }

  if (fallbackPath) {
    problems.push('no recoverable document; path derived from filename');
    return { tombstones: [fallbackTombstone(fallbackPath)], problems };
  }

  problems.push('no recoverable document and no path derivable from filename — skipped');
  return { tombstones: [], problems };
}

function mergeTombstone(byPath: Map<string, TombstoneMeta>, tombstone: TombstoneMeta): void {
  const prev = byPath.get(tombstone.path);
  if (!prev) {
    byPath.set(tombstone.path, tombstone);
    return;
  }
  // Duplicate writes (same file, or new + legacy mirror) must not block GC:
  // union the confirmations, keep the first record's metadata.
  for (const id of tombstone.confirmedBy) {
    if (!prev.confirmedBy.includes(id)) prev.confirmedBy.push(id);
  }
}

/**
 * Read every tombstone from `.meta/tombstones/`, never dropping a corrupt
 * record silently.
 *
 * `warn` receives a human-readable diagnostic (file path + parse problem) for
 * each file that needed repair or recovery.
 */
export async function readTombstonesFromFs(
  fs: MetaFS,
  warn: (message: string) => void,
): Promise<TombstoneMeta[]> {
  const byPath = new Map<string, TombstoneMeta>();
  {
    const dir = TOMBSTONES_DIR;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return []; // directory doesn't exist in this layout
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const filePath = `${dir}/${entry}`;
      let raw: string;
      try {
        raw = new TextDecoder().decode(toBytes(await fs.readFile(filePath)));
      } catch (err) {
        warn(
          `[Tombstones] unreadable tombstone ${filePath}: ` +
          `${err instanceof Error ? err.message : String(err)} — skipped`,
        );
        continue;
      }
      const { tombstones, problems } = parseTombstoneFile(raw, decodeMetaPath(entry) ?? undefined);
      if (problems.length > 0) {
        const action = tombstones.length > 0
          ? tombstones.map((t) => `"${t.path}" treated as deleted`).join(', ')
          : 'skipped';
        warn(`[Tombstones] corrupt tombstone ${filePath}: ${problems.join('; ')} → ${action}`);
      }
      for (const tombstone of tombstones) mergeTombstone(byPath, tombstone);
    }
  }
  return Array.from(byPath.values());
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
 * 删除状态只写在 `/.meta/tombstones/`；历史归档目录不再读写。
 */
export class TombstoneStore {
  constructor(
    private fs: MetaFS,
    private author: string,
  ) {}

  private pathFor(filePath: string): string {
    return `${TOMBSTONES_DIR}/${encodeMetaPath(filePath)}.json`;
  }

  /** All tombstones. */
  async list(): Promise<TombstoneMeta[]> {
    return readTombstonesFromFs(this.fs, (message) => log.warn(message));
  }

  /** Write a tombstone. */
  async write(tombstone: TombstoneMeta): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(tombstone, null, 2));
    const p = this.pathFor(tombstone.path);
    await ensureParentDir(this.fs, p);
    await this.fs.writeFile(p, bytes);
  }

  /** Persist an updated tombstone (confirmations) when it still exists. */
  async save(tombstone: TombstoneMeta): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(tombstone, null, 2));
    const p = this.pathFor(tombstone.path);
    if (!(await existsSafe(this.fs, p))) return;
    await this.fs.writeFile(p, bytes);
  }

  /** Delete a tombstone. */
  async remove(tombstone: TombstoneMeta): Promise<void> {
    const p = this.pathFor(tombstone.path);
    if (!(await existsSafe(this.fs, p))) return;
    try {
      await this.fs.unlink(p);
    } catch {
      /* race */
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

  /** Remove tombstones confirmed by every connected backend. */
  async gc(allBackendIds: string[], targets: TombstoneTarget[] = []): Promise<void> {
    const tombstones = await this.list();
    for (const tombstone of tombstones) {
      const allConfirmed = allBackendIds.every((id) => tombstone.confirmedBy.includes(id));
      if (!allConfirmed) continue;
      const p = this.pathFor(tombstone.path);
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
