/**
 * zen-fs-config — ConfigRepo Implementation
 *
 * Core implementation of IConfigRepo and the createConfigRepo factory.
 */

import {
  ZenFSSync,
  SyncDirection,
  type SyncableFS,
  type SyncPairStatus,
  type SyncResult,
  type SyncEvent,
  type SyncEventHandler,
  type SyncFilter,
} from 'zen-fs-sync';
import type {
  IConfigRepo,
  ConfigRepoOptions,
  BackendsMeta,
  BackendDescriptor,
  ConflictArchive,
  ConflictInfo,
  TombstoneMeta,
  SyncGroupType,
  AppDataBackendDescriptor,
  AppDataGroupDescriptor,
  AppDataGroup,
  ConfigSyncGroupDescriptor,
  BackendSyncState,
  CacheOptions,
} from './types';
import { createSerializerChain, configKeyToFilePath } from './serializer';
import { createChrootFS } from './context-fs';
import type { PathAwareSerializer } from './serializer';
import { backendToSyncableFS } from './adapters';
import { createBackend, mergeAccountFields, getAccountFields, getBackendMetadata, type BackendInstance } from './backend-registry';
import { resolveLocalPrimary, localPrimaryType } from './folder-backend';
import { createLogger } from '@richard432/localstorage-logger';
import { versionPathFor, incrementVersion, writeVersion, readVersion } from './version';
import { purgeMtimeSidecars, isMtimeSidecar, type PurgeMtimeOptions, type MtimePurgeResult } from './mtime-cleanup';
import { purgeKeepFiles, type PurgeKeepOptions, type KeepPurgeResult } from './keep-cleanup';
import { migrateVersionSidecars, type VersionMigrationResult } from './version-migration';
import {
  META_DIR,
  CONFIG_DIR,
  CONFLICTS_DIR,
  LEGACY_CONFLICTS_DIR,
  TOMBSTONES_DIR,
  META_BACKENDS_DIR,
  encodeMetaPath,
  ensureParentDir,
  readGroupDescriptor,
  writeGroupDescriptor,
  readBackendMetaDescriptors,
  writeBackendMetaDescriptor,
  removeBackendMetaDescriptor,
  backendMetaFilePath,
  assertValidBackendId,
  DATA_GROUP_DEFAULT_FEATURES,
  readTombstonesFromFs,
  TombstoneStore,
  VersionStore,
  ConflictStore,
} from './group-meta';
import {
  mergeDescriptorCreatedAt,
  serializeAppDataGroupDescriptor,
  serializeBackendDescriptor,
} from './canonical-json';
import type {
  VersionMeta,
  SyncGroupFeatures,
  SyncGroupHandle,
} from './types';

const log = createLogger('zen-fs-config:config-repo');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GROUP_DESCRIPTOR_FILE = `${META_DIR}/group.json`;
// Config-sync group metadata lives in `.config/` (never synced by data groups).
const GROUP_TYPE_FILE = `${CONFIG_DIR}/group-type`;
const LEGACY_GROUP_TYPE_FILE = `${META_DIR}/group-type`;
const BACKENDS_FILE = `${META_DIR}/backends.json`; // Legacy single-file format (pre-0.4.0)
/**
 * 后端描述符的权威目录：`/.meta/backends/{id}.json`。
 * 配置组与数据组共用同一位置，不再区分。
 */
const BACKENDS_DIR = META_BACKENDS_DIR;
/**
 * 历史位置 `/.config/backends/`。**不再读取**：里面的文件按普通内容对待，
 * 只在删除后端时尽力清理残留。
 */
const LEGACY_BACKENDS_DIR = `${CONFIG_DIR}/backends`;
const APP_DATA_GROUPS_DIR = `${CONFIG_DIR}/app-data-groups`;
const LEGACY_APP_DATA_GROUPS_DIR = `${META_DIR}/app-data-groups`;
// Display metadata (name) for the config-sync group itself. Separate file so
// renaming never touches backend/sync configuration.
const CONFIG_SYNC_GROUP_FILE = `${CONFIG_DIR}/config-sync-group.json`;
const LEGACY_CONFIG_SYNC_GROUP_FILE = `${META_DIR}/config-sync-group.json`;
const GROUP_NAME_MAX_LENGTH = 40;
const NODES_DIR = '/nodes';
const SHARED_DIR = '/shared';

/** Fixed group id of the config-sync group. */
export const CONFIG_GROUP_ID = 'config';

/** All capabilities are on for the config-sync group. */
const CONFIG_GROUP_FEATURES: SyncGroupFeatures = {
  tombstones: true,
  versions: true,
  conflicts: true,
  configHost: true,
  appData: false,
};

// ---------------------------------------------------------------------------
// Directory deletion helpers
// ---------------------------------------------------------------------------

/** Minimal FS surface needed to walk a directory tree. */
type TreeFS = {
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ mode?: number }>;
  rmdir?(path: string): Promise<void>;
};

function isDirectoryMode(mode?: number): boolean {
  return typeof mode === 'number' && (mode & 0o40000) === 0o40000;
}

async function isDirectoryPath(fs: TreeFS, absolutePath: string): Promise<boolean> {
  try {
    const st = await fs.stat(absolutePath);
    return isDirectoryMode(st?.mode);
  } catch {
    return false;
  }
}

/** Collect every file path under `dir` (absolute, recursively). */
async function collectFilesUnder(fs: TreeFS, dir: string, out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir);
  for (const entry of entries) {
    const child = dir === '/' ? `/${entry}` : `${dir}/${entry}`;
    if (await isDirectoryPath(fs, child)) {
      await collectFilesUnder(fs, child, out);
    } else {
      out.push(child);
    }
  }
  return out;
}

/**
 * Collect every directory path under `dir` (absolute, recursively), including
 * `dir` itself. Used to record `.keep` tombstones when deleting a tree: Git /
 * RemoteStorage keep otherwise-empty directories alive with an internal
 * `.keep` placeholder that never reaches the local primary, so it needs an
 * explicit tombstone to be removed from replicas.
 */
async function collectDirectoriesUnder(fs: TreeFS, dir: string, out: string[] = []): Promise<string[]> {
  out.push(dir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return out; // Already gone — nothing else to record
  }
  for (const entry of entries) {
    const child = dir === '/' ? `/${entry}` : `${dir}/${entry}`;
    if (await isDirectoryPath(fs, child)) await collectDirectoriesUnder(fs, child, out);
  }
  return out;
}

/** Remove a directory tree bottom-up; contained files must be gone already. */
async function removeDirectoryTree(fs: TreeFS, dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return; // Already gone
  }
  for (const entry of entries) {
    const child = dir === '/' ? `/${entry}` : `${dir}/${entry}`;
    if (await isDirectoryPath(fs, child)) await removeDirectoryTree(fs, child);
  }
  try {
    await fs.rmdir?.(dir);
  } catch {
    /* best effort — a leftover empty dir is harmless */
  }
}

/**
 * A FS surface that can be enumerated, plus a human-readable label used when
 * its enumeration fails (local cache vs a specific replica backend).
 */
type NamedTreeFS = { label: string; fs: TreeFS };

/**
 * Collect files under `dir` from **every** surface and merge the results.
 *
 * The local primary only mirrors what this node has already seen: a directory
 * whose children live solely on a backend (e.g. archives written by an older
 * build) would otherwise be enumerated as empty, so deleting it would never
 * write per-file tombstones and the children would simply be pulled back.
 *
 * A surface whose enumeration fails is reported through `onError` and skipped;
 * it must never be silently treated as an empty directory.
 */
async function collectFilesUnderAny(
  surfaces: NamedTreeFS[],
  dir: string,
  onError: (label: string, error: unknown) => void,
): Promise<string[]> {
  const merged = new Set<string>();
  for (const surface of surfaces) {
    try {
      for (const file of await collectFilesUnder(surface.fs, dir)) merged.add(file);
    } catch (error) {
      onError(surface.label, error);
    }
  }
  return [...merged];
}

/**
 * Strict variant of {@link collectDirectoriesUnder}: a failing `readdir` is
 * propagated to the caller instead of being treated as "no subdirectories".
 * Paths discovered before the failure are kept in `out`.
 */
async function collectDirectoriesUnderStrict(
  fs: TreeFS,
  dir: string,
  out: string[] = [],
): Promise<string[]> {
  out.push(dir);
  const entries = await fs.readdir(dir);
  for (const entry of entries) {
    const child = dir === '/' ? `/${entry}` : `${dir}/${entry}`;
    if (await isDirectoryPath(fs, child)) await collectDirectoriesUnderStrict(fs, child, out);
  }
  return out;
}

/** Directory-path counterpart of {@link collectFilesUnderAny} (includes `dir`). */
async function collectDirectoriesUnderAny(
  surfaces: NamedTreeFS[],
  dir: string,
  onError: (label: string, error: unknown) => void,
): Promise<string[]> {
  const merged = new Set<string>();
  for (const surface of surfaces) {
    const found: string[] = [];
    try {
      await collectDirectoriesUnderStrict(surface.fs, dir, found);
    } catch (error) {
      // Keep whatever was walked before the failure; never treat it as empty.
      onError(surface.label, error);
    }
    for (const child of found) merged.add(child);
  }
  return [...merged];
}

/** True when `path` is a directory on at least one surface. */
async function isDirectoryAny(surfaces: NamedTreeFS[], path: string): Promise<boolean> {
  for (const surface of surfaces) {
    if (await isDirectoryPath(surface.fs, path)) return true;
  }
  return false;
}

/** True when an unlink failure means "the entry was already gone" rather than a
 * real deletion failure. Needed for backend-internal placeholders (`.keep` /
 * `.mtime`) that are hidden from `exists()`: the only way to remove them is
 * unlink(), and the only signal we get is the error.
 */
function isNotFoundError(err: unknown): boolean {
  const code = (err as any)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return true;
  const message = String((err as any)?.message ?? err);
  return /ENOENT|not found|does not exist|\b404\b/i.test(message);
}

/**
 * Validate and normalize a group display name. Ids are never edited, so this
 * only guards the human-readable label.
 */
function normalizeGroupName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Group name must be a string');
  }
  const name = value.trim();
  if (!name) {
    throw new Error('Group name must not be empty');
  }
  if (name.length > GROUP_NAME_MAX_LENGTH) {
    throw new Error(`Group name must be at most ${GROUP_NAME_MAX_LENGTH} characters`);
  }
  return name;
}

/**
 * 配置同步组专用的顶层路径。
 * 数据同步组与配置同步组可能共用同一个远端账号/根目录，因此数据组的两向同步
 * 必须跳过这些路径：既不能把配置内容（`.config/`、`.meta/backends` 等）推送到
 * 数据组远端，也不能从数据组远端把它们拉进数据组。
 *
 * 注意：`.meta/` 不再整体排除。`.meta/tombstones`、`.meta/versions`、
 * `.meta/conflicts` 属于通用同步元数据，必须允许跨设备同步，否则删除会在
 * 其他设备复活。数据组视图通过 `hiddenPrefixes` 隐藏这些目录（隐藏 ≠ 不同步）。
 */
const CONFIG_ONLY_PREFIXES = [CONFIG_DIR, NODES_DIR, SHARED_DIR];

/** Fixed ID for the local IndexedDB primary backend. */
export const LOCAL_IDB_BACKEND_ID = 'local-idb';

/** Encode a file path into a tombstone filename (no slashes, no dots issue). */
function tombstoneFileName(filePath: string): string {
  return `${encodeMetaPath(filePath)}.json`;
}

/** Tombstone path in the new (canonical) or legacy layout. */
function tombstonePathFor(filePath: string, dir = TOMBSTONES_DIR): string {
  return `${dir}/${tombstoneFileName(filePath)}`;
}

/** Decode a tombstone filename back to the original file path. */
function decodeTombstoneFileName(name: string): string {
  return '/' + name
    .replace(/\.json$/, '')
    .replace(/\+\+/g, '.')
    .replace(/__/g, '/');
}

/**
 * Produce a stable string representation of a backend descriptor's options.
 * Object keys are sorted recursively so that two objects with the same
 * key-value pairs but different insertion order produce the same string.
 *
 * This is critical for deduplication: without stable key ordering,
 * `JSON.stringify({ token: 'a', owner: 'b' })` !== `JSON.stringify({ owner: 'b', token: 'a' })`,
 * causing the dedup logic to miss duplicates.
 */
function stableOptionsKey(options: Record<string, unknown> | undefined): string {
  if (!options || typeof options !== 'object') return '{}';
  return JSON.stringify(sortKeysDeep(options));
}

function sortKeysDeep(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Extract only the endpoint-identity options for a backend descriptor.
 *
 * If the backend type declares `identityFields` metadata, only those keys are
 * kept (so client-side tuning options — `basePath`, `persistCache`, `maxSize`,
 * `cacheFile`, etc. — do NOT break dedup). Types without `identityFields`
 * metadata fall back to the full options blob (legacy behavior), preserving
 * existing dedup semantics for unregistered/custom backends.
 */
function identityOptions(type: string, options: Record<string, unknown> | undefined): Record<string, unknown> {
  const fields = getBackendMetadata(type)?.identityFields;
  if (!fields || fields.length === 0) return options ?? {};
  const subset: Record<string, unknown> = {};
  for (const f of fields) {
    if (options && options[f] !== undefined) subset[f] = options[f];
  }
  // 归一化 Gitee/GitHub 的 baseUrl：空/未设置 → 默认端点，并去掉尾部斜杠，
  // 使「未设/空 baseUrl」与「显式默认端点」的同一仓库判为同一后端（此前该差异会误判为不同）。
  if (type === 'Gitee' || type === 'GitHub') {
    const defaultEndpoint = type === 'Gitee' ? 'https://gitee.com/api/v5' : 'https://api.github.com';
    const raw = options && options.baseUrl;
    const value = typeof raw === 'string' && raw.trim() !== '' ? raw : defaultEndpoint;
    subset['baseUrl'] = value.replace(/\/+$/, '');
  }
  return subset;
}

/**
 * Generate a dedup key for a backend descriptor.
 * Two backends with the same type + endpoint-identity options (regardless of
 * key ordering or extra client-side tuning options) produce the same key.
 */
function backendDedupKey(desc: BackendDescriptor): string {
  return `${desc.type}:${stableOptionsKey(identityOptions(desc.type, desc.options))}`;
}

/**
 * Age rank for a data backend — SMALLER means OLDER.
 * - backends with a numeric `createdAt` use that timestamp;
 * - legacy backends without `createdAt` are treated as the oldest; among
 *   those, a fixed id (not ending in a numeric timestamp, e.g.
 *   `RemoteStorage-primary`) ranks oldest, while dynamic ids like
 *   `remotestorage-1784761846529` rank by their embedded timestamp.
 */
function backendAgeRank(b: AppDataBackendDescriptor): number {
  if (typeof b.createdAt === 'number') return b.createdAt;
  const m = /-(\d{10,})$/.exec(b.id);
  if (m) return Number(m[1]);
  return -Infinity; // fixed/legacy id → oldest
}

/**
 * Deduplicate data backends that point to the same endpoint (same type +
 * options). When duplicates are found, the OLDEST one is kept (per product
 * requirement) and the rest are returned as `removed` so the caller can drop
 * them from the persisted descriptor. This cleans up the case where a
 * data-sync backend got registered twice — e.g. once with a fixed `*-primary`
 * id and again with a dynamically generated `remotestorage-<timestamp>` id.
 */
function dedupeAppDataBackends(
  backends: AppDataBackendDescriptor[],
): { kept: AppDataBackendDescriptor[]; removed: AppDataBackendDescriptor[] } {
  const byKey = new Map<string, AppDataBackendDescriptor>();
  const removed: AppDataBackendDescriptor[] = [];
  for (const b of backends) {
    const key = backendDedupKey({ id: b.id, type: b.type, options: b.options });
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, b);
      continue;
    }
    // Duplicate endpoint — keep the older of the two.
    if (backendAgeRank(b) < backendAgeRank(existing)) {
      removed.push(existing);
      byKey.set(key, b);
    } else {
      removed.push(b);
    }
  }
  return { kept: Array.from(byKey.values()), removed };
}

// ---------------------------------------------------------------------------
// Minimal async FS interface for internal use
// ---------------------------------------------------------------------------

interface MinimalAsyncFS extends BackendInstance {}

// ---------------------------------------------------------------------------
// ConfigRepo
// ---------------------------------------------------------------------------

export class ConfigRepo implements IConfigRepo {
  readonly appId: string;
  readonly nodeId: string;
  /** Fixed id for the unified sync-group model. */
  readonly groupId = CONFIG_GROUP_ID;
  readonly kind = 'config' as const;
  /** Capability switches — the config group is the superset. */
  readonly features: SyncGroupFeatures = CONFIG_GROUP_FEATURES;
  /** Display name, hydrated from `.config/config-sync-group.json`. */
  name?: string;
  /** Chroot-isolated fs for app-facing API. Typed as `any` to match `typeof import('node:fs')` duck-typically. */
  readonly fs: any;
  /** Un-chrooted fs for low-level browsing. */
  readonly rootFS: any;

  private cachedFS: MinimalAsyncFS;
  private fullFS: SyncableFS;
  private serializer: PathAwareSerializer;
  private syncEngine: ZenFSSync;
  private replicaBackends: Map<string, { instance: any; syncable: SyncableFS; pairId: string }>;
  private appDataGroups: Map<string, AppDataGroupImpl> = new Map();
  private onConflictCallback?: (conflict: ConflictInfo) => Promise<unknown | null>;
  private disposed = false;
  private configCache = new Map<string, unknown>();
  private readonly primaryBackendId: string;
  private readonly cacheOptions?: CacheOptions;
  private readonly pollIntervalMs?: number;
  /** Tombstone cache — avoids redundant reads within a single flush() cycle. */
  private tombstoneCache: TombstoneMeta[] | null = null;
  /**
   * 墓碑存在期间被排除在同步之外的路径。
   *
   * 远端副本可能仍残留被删路径（哪怕只剩 `.keep` / `.keep.mtime` 占位）。
   * 若同步照常进行，这类残留会被当成"远端新增"再拉回本地，造成空壳复活。
   * 这些路径改由 processTombstones 主动删除，直到所有副本确认不存在、
   * 墓碑被 GC 之后才恢复同步。
   */
  private readonly tombstoneExcludePrefixes: string[] = [];
  private readonly syncFilter: SyncFilter = { excludePrefixes: this.tombstoneExcludePrefixes };
  /**
   * 本轮 processTombstones 中，各副本对墓碑路径"已确认不存在"的结果。
   * 目录类路径用 exists() 复核；`.mtime` 侧车对部分后端不可见，只能用
   * unlink() 是否成功来判定。
   */
  private readonly tombstoneConfirmations = new Map<string, Set<string>>();
  /** Per-backend sync state (successful pairs + connect failures). */
  private backendStates = new Map<string, BackendSyncState>();
  /** Last known backend descriptors, for the synchronous unified handle API. */
  private backendDescriptorCache: AppDataBackendDescriptor[] = [];
  /**
   * Tracks the background initial sync started by createConfigRepo().
   * `flush()` and `dispose()` will await this if it hasn't completed yet,
   * preventing concurrent syncEngine.syncAll() calls.
   */
  private initialSyncPromise: Promise<void> | null = null;

  constructor(
    appId: string,
    nodeId: string,
    primaryBackendId: string,
    cachedFS: MinimalAsyncFS,
    serializer: PathAwareSerializer,
    onConflict?: (conflict: ConflictInfo) => Promise<unknown | null>,
    pollIntervalMs?: number,
    cacheOptions?: CacheOptions,
  ) {
    this.appId = appId;
    this.nodeId = nodeId;
    this.primaryBackendId = primaryBackendId;
    this.cachedFS = cachedFS;
    this.serializer = serializer;
    this.syncEngine = new ZenFSSync();
    this.replicaBackends = new Map();
    this.onConflictCallback = onConflict;
    this.pollIntervalMs = pollIntervalMs;
    this.cacheOptions = cacheOptions;

    this.fullFS = backendToSyncableFS(cachedFS, primaryBackendId);
    // Deletes through the app-facing fs are tombstone-aware (files and dirs),
    // so `repo.fs.promises.unlink/rmdir` never silently resurrects data.
    this.fs = createChrootFS(cachedFS, `/${appId}`, {
      onUnlink: (path) => this.deleteFile(path),
      onRmdir: (path) => this.deleteFile(path),
    });
    // rootFS = no chroot, so admin UI can browse /.meta/, /shared/, /nodes/, etc.
    this.rootFS = createChrootFS(cachedFS, '/');
  }

  /** Full path to this node's directory on the primary backend. */
  get nodePath(): string {
    return `/nodes/${this.nodeId}`;
  }

  /** Number of replica backends registered (excludes the local primary). */
  get replicaCount(): number {
    return this.replicaBackends.size;
  }

  // -----------------------------------------------------------------------
  // IConfigRepo — Load
  // -----------------------------------------------------------------------

  async load(rawConfig?: string): Promise<void> {
    this.assertNotDisposed();

    if (rawConfig) {
      const data = JSON.parse(rawConfig);
      if (data.backends) {
        await this.updateBackends({
          version: 1,
          backends: data.backends,
        } as BackendsMeta);
      }
    }

    await this.reloadConfigCache();
  }

  // -----------------------------------------------------------------------
  // IConfigRepo — Config Read/Write
  // -----------------------------------------------------------------------

  getConfig<T = unknown>(path: string): T {
    this.assertNotDisposed();
    const filePath = configKeyToFilePath(path);
    const key = `/${this.appId}${filePath}`;
    if (!this.configCache.has(key)) {
      throw new Error(
        `Config not loaded: ${path}. Call load() first, or use fs.promises.readFile().`,
      );
    }
    return this.configCache.get(key) as T;
  }

  setConfig(path: string, data: unknown): void {
    this.assertNotDisposed();
    const filePath = configKeyToFilePath(path);
    const fullPath = `/${this.appId}${filePath}`;
    const bytes = this.serializer.serialize(data, fullPath);

    this.configCache.set(fullPath, data);

    this.persistConfig(fullPath, bytes).catch((err) => {
      log.error(`[zen-fs-config] Failed to persist ${fullPath}:`, err);
    });
  }

  // -----------------------------------------------------------------------
  // IConfigRepo — Node-Local Config
  // -----------------------------------------------------------------------

  async getNodeConfig<T = unknown>(nodeId: string, path: string): Promise<T> {
    this.assertNotDisposed();
    const filePath = configKeyToFilePath(path);
    const fullPath = `${NODES_DIR}/${nodeId}${filePath}`;
    try {
      const raw = await this.cachedFS.readFile(fullPath);
      return this.serializer.deserialize(toUint8Array(raw), fullPath) as T;
    } catch {
      throw new Error(`Node config not found: ${nodeId}${path}`);
    }
  }

  async setNodeConfig(nodeId: string, path: string, data: unknown): Promise<void> {
    this.assertNotDisposed();
    const filePath = configKeyToFilePath(path);
    const fullPath = `${NODES_DIR}/${nodeId}${filePath}`;
    const bytes = this.serializer.serialize(data, fullPath);

    await this.ensureDir(fullPath);
    await this.cachedFS.writeFile(fullPath, bytes);
  }

  // -----------------------------------------------------------------------
  // IConfigRepo — Publish Node Config
  // -----------------------------------------------------------------------

  async publishNodeConfig(
    nodeId: string,
    options?: { paths?: string[] },
  ): Promise<SyncResult> {
    this.assertNotDisposed();

    const nodeDir = `${NODES_DIR}/${nodeId}`;
    const files: string[] = options?.paths?.map((p) => configKeyToFilePath(p))
      .map((p) => `${nodeDir}${p}`) ?? [];

    if (files.length === 0) {
      const allFiles = await this.walkDir(nodeDir);
      files.push(...allFiles);
    }

    const results: SyncResult[] = [];
    for (const [_id, replica] of this.replicaBackends) {
      const pair = this.syncEngine.addPair(
        this.fullFS,
        replica.syncable,
        {
          direction: SyncDirection.OneWay,
          filter: {
            includePrefixes: files,
          },
        },
        '/',
      );
      try {
        const result = await this.syncEngine.sync(pair.pairId);
        results.push(result);
      } finally {
        this.syncEngine.removePair(pair.pairId);
      }
    }

    return results.reduce(
      (acc, r) => ({
        ...acc,
        filesCreated: acc.filesCreated + r.filesCreated,
        filesUpdated: acc.filesUpdated + r.filesUpdated,
        filesDeleted: acc.filesDeleted + r.filesDeleted,
        conflicts: [...acc.conflicts, ...r.conflicts],
        changes: [...acc.changes, ...r.changes],
        durationMs: acc.durationMs + r.durationMs,
      }),
      {
        pairId: `publish-${nodeId}`,
        direction: SyncDirection.OneWay,
        timestamp: Date.now(),
        filesCreated: 0,
        filesUpdated: 0,
        filesDeleted: 0,
        filesSkipped: 0,
        conflicts: [],
        changes: [],
        durationMs: 0,
      } as SyncResult,
    );
  }

  // -----------------------------------------------------------------------
  // IConfigRepo — Peek Node Config
  // -----------------------------------------------------------------------

  async peekNodeConfig<T = unknown>(nodeId: string, path: string): Promise<T> {
    this.assertNotDisposed();
    const filePath = configKeyToFilePath(path);
    const fullPath = `${NODES_DIR}/${nodeId}${filePath}`;
    try {
      const raw = await this.cachedFS.readFile(fullPath);
      return this.serializer.deserialize(toUint8Array(raw), fullPath) as T;
    } catch {
      throw new Error(`Node config not found: ${nodeId}${path}`);
    }
  }

  // -----------------------------------------------------------------------
  // IConfigRepo — Sync Management
  // -----------------------------------------------------------------------

  async flush(): Promise<SyncResult[]> {
    this.assertNotDisposed();
    // Wait for background initial sync if still running — prevents
    // concurrent syncEngine.syncAll() calls which could cause race conditions.
    if (this.initialSyncPromise) {
      await this.initialSyncPromise;
      this.initialSyncPromise = null;
    }
    // 1. Process tombstones: delete actual files on all replicas
    await this.processTombstones();
    // 2. Run normal sync (syncs data files + tombstone files)
    const resultsMap = await this.syncEngine.syncAll();
    // Invalidate tombstone cache — sync may have pulled new tombstones from remote
    this.invalidateTombstoneCache();
    // 3. Post-sync dedup: sync may have pulled duplicate backend descriptors
    //    from remote. Re-run readAllBackendDescriptors to detect and remove
    //    any duplicates that arrived via sync, then process their tombstones
    //    so the deletion propagates back to remote.
    await this.readAllBackendDescriptors();
    await this.processTombstones();
    // 4. Update tombstone confirmations + GC
    await this.updateTombstoneConfirmations();
    await this.gcTombstones();
    // Clear cache — flush is complete, next read should fetch fresh data
    this.invalidateTombstoneCache();
    return Array.from(resultsMap.values());
  }

  // -----------------------------------------------------------------------
  // Tombstone (Deletion Tracking)
  // -----------------------------------------------------------------------

  /**
   * Write the tombstone record for `filePath` under `.meta/tombstones/`.
   * Records only metadata — it never creates the deleted file locally, and the
   * legacy `/.meta/.deleted/` archive is neither read nor written.
   */
  private async writeTombstoneFor(filePath: string): Promise<void> {
    const normalizedPath = filePath.startsWith('/') ? filePath : '/' + filePath;
    const tombstone: TombstoneMeta = {
      path: normalizedPath,
      deletedAt: Date.now(),
      deletedBy: this.primaryBackendId,
      confirmedBy: [this.primaryBackendId],
    };
    const tombstoneBytes = new TextEncoder().encode(JSON.stringify(tombstone, null, 2));
    const tombstonePath = tombstonePathFor(normalizedPath, TOMBSTONES_DIR);
    await this.ensureDir(tombstonePath);
    await this.cachedFS.writeFile(tombstonePath, tombstoneBytes);
  }

  /**
   * Delete a file and write a tombstone so the deletion propagates
   * to all backends instead of being treated as "missing file → re-create".
   */
  async deleteFile(path: string): Promise<void> {
    this.assertNotDisposed();
    const normalizedPath = path.startsWith('/') ? path : '/' + path;

    // Directories are deleted as a tree: one tombstone per contained file.
    // The sync layer works file-by-file, so a directory-path tombstone alone
    // would be a no-op on backends without directory entries and the children
    // would be resurrected on the next pull.
    //
    // Enumeration must span the local cache **and** every replica backend: a
    // path may live only on a backend (the cache never saw it), and reading
    // just the cache would silently produce "empty directory" → no tombstones
    // → the children come straight back.
    const surfaces: NamedTreeFS[] = [{ label: 'local-cache', fs: this.cachedFS }];
    for (const [id, replica] of this.replicaBackends) {
      surfaces.push({ label: id, fs: replica.instance as TreeFS });
    }
    const onEnumerateError = (label: string, error: unknown) => {
      const reason = (error as any)?.message ?? String(error);
      log.warn(
        `[ConfigRepo] deleteFile(directory): cannot enumerate "${label}" under ${normalizedPath}: ${reason}`,
      );
    };

    if (await isDirectoryAny(surfaces, normalizedPath)) {
      const files = await collectFilesUnderAny(surfaces, normalizedPath, onEnumerateError);
      for (const file of files) await this.deleteFile(file);
      // Backends that cannot store empty directories keep them alive with an
      // internal `.keep` placeholder, which readdir()/createSnapshot() hide and
      // the local primary does not carry. Without an explicit tombstone it
      // survives the delete and the directory reappears on the next pull.
      //
      // The placeholder's `<dir>/.keep.mtime` sidecar is a REAL blob (backends
      // persist mtime as `<name>.mtime`): if only `.keep` is tombstoned, the
      // sidecar alone keeps the directory alive in Git. It also outlives the
      // `.keep` itself when an older build already removed the placeholder.
      for (const dir of await collectDirectoriesUnderAny(surfaces, normalizedPath, onEnumerateError)) {
        const keepPath = dir === '/' ? '/.keep' : `${dir}/.keep`;
        await this.writeTombstoneFor(keepPath);
        await this.writeTombstoneFor(`${keepPath}.mtime`);
      }
      await removeDirectoryTree(this.cachedFS, normalizedPath);
      this.invalidateTombstoneCache();
      this.schedulePostDeleteSync();
      log.log(`[ConfigRepo] deleteFile(directory): ${normalizedPath} (${files.length} file(s))`);
      return;
    }

    // 1. Write tombstone (new `.meta/tombstones` + legacy mirror for one cycle)
    await this.writeTombstoneFor(normalizedPath);

    // 2. Delete the actual file on primary
    try {
      await this.cachedFS.unlink(normalizedPath);
    } catch {
      // File may already be gone — tombstone is still valid
    }

    // 3. Also delete the version sidecar if it exists
    const versionPath = versionPathFor(normalizedPath);
    if (versionPath) {
      try {
        await this.cachedFS.unlink(versionPath);
      } catch { /* no version file */ }
    }

    // 3b. Best-effort: drop the backend-internal mtime sidecar from the local
    // primary as well (older builds leaked `<file>.mtime` into it, and a stale
    // sidecar would outlive its data file forever). Remote backends delete it
    // inside their own remove() path.
    if (!isMtimeSidecar(normalizedPath)) {
      try {
        await this.cachedFS.unlink(`${normalizedPath}.mtime`);
      } catch { /* no sidecar */ }
    }

    log.log(`[ConfigRepo] deleteFile: ${normalizedPath} (tombstone at ${tombstonePathFor(normalizedPath)})`);
    // Invalidate cache — a new tombstone was written
    this.invalidateTombstoneCache();

    // 4. Trigger a background sync to propagate the tombstone immediately.
    // Without this, the tombstone sits locally until the next poll interval
    // (default 30 min) or manual flush. During that window, zen-fs-sync's
    // onChange could fire and resurrect the file from a remote replica.
    // The preSyncHook on each sync pair will processTombstones() before
    // the snapshot comparison runs, preventing resurrection.
    this.schedulePostDeleteSync();
  }

  /**
   * Background sync scheduled after a deleteFile() call.
   * Uses a short debounce to coalesce multiple rapid deletions.
   * If a sync is already in progress, the next poll will pick up the tombstone.
   */
  private postDeleteSyncTimer?: ReturnType<typeof setTimeout>;
  private schedulePostDeleteSync(): void {
    if (this.postDeleteSyncTimer) {
      clearTimeout(this.postDeleteSyncTimer);
    }
    this.postDeleteSyncTimer = setTimeout(() => {
      this.postDeleteSyncTimer = undefined;
      if (this.disposed) return;
      // syncAll() on each pair triggers preSyncHook → processTombstones
      // before the snapshot comparison, then postSyncHook for confirmation/GC.
      this.syncEngine.syncAll().catch((err) => {
        log.warn('[ConfigRepo] post-delete sync failed:', err);
      });
    }, 500); // 500ms debounce — coalesce rapid deletions
  }

  /**
   * Read all tombstones from the primary backend.
   * Results are cached within a flush() cycle to avoid redundant reads.
   */
  private async readTombstones(): Promise<TombstoneMeta[]> {
    // Return cached result if available
    if (this.tombstoneCache !== null) {
      return this.tombstoneCache;
    }
    this.tombstoneCache = await readTombstonesFromFs(this.cachedFS, (message) => log.warn(message));
    this.refreshSyncExclusions(this.tombstoneCache);
    return this.tombstoneCache;
  }

  /**
   * 把当前墓碑路径同步到同步排除表。
   *
   * 排除表与各同步对共享同一个数组实例（zen-fs-sync 在每次检测时实时读取
   * `filter.excludePrefixes`），所以这里原地更新即可生效。
   */
  private refreshSyncExclusions(tombstones: TombstoneMeta[]): void {
    this.tombstoneExcludePrefixes.length = 0;
    const add = (target: string) => {
      this.tombstoneExcludePrefixes.push(target, `${target}/`);
    };
    for (const tombstone of tombstones) {
      if (!tombstone.path) continue;
      add(tombstone.path);
      // `.keep` / `.keep.mtime` 墓碑只可能来自历史数据：旧版同步引擎会在目标端
      // 为每个源目录 mkdir 保活空目录。现行同步引擎不再同步空目录，这里保留
      // 目录级排除是为了防御历史 `.keep` 墓碑与异常远端残留——只排除占位文件
      // 的话，副本上残留的空目录仍可能被重建出来。
      if (
        tombstone.path === '/.keep' ||
        tombstone.path.endsWith('/.keep') ||
        tombstone.path.endsWith('/.keep.mtime')
      ) {
        const dir = tombstone.path.slice(0, tombstone.path.lastIndexOf('/')) || '/';
        if (dir !== '/') add(dir);
      }
    }
  }

  /** Invalidate the tombstone cache — call after tombstones are modified. */
  private invalidateTombstoneCache(): void {
    this.tombstoneCache = null;
  }

  /**
   * Before sync: for each tombstone, delete the actual file on all replicas.
   * This prevents bi-directional sync from copying the file back.
   *
   * Before calling unlink() on each backend, we check exists() first.
   * This avoids sending wasteful DELETE requests (or GET-then-404) to
   * remote backends when the file was already removed on a previous cycle.
   * Local backends (IndexedDB) are cheap to check, so the guard is
   * effectively free for them.
   */
  private async processTombstones(): Promise<void> {
    const tombstones = await this.readTombstones();
    // 每轮重置：`.mtime` 侧车对部分后端不可见，只能用本轮 unlink 结果确认。
    this.tombstoneConfirmations.clear();
    if (tombstones.length === 0) return;

    let processed = 0;
    let alreadyDeleted = 0;
    let unresolved = 0;

    for (const tombstone of tombstones) {
      // `.mtime` sidecars and `.keep` placeholders are backend-internal and
      // hidden from the backend's index (GiteeFS keeps them in its SHA cache
      // only), so `exists()` returns false even when the blob is still on the
      // remote. Attempt the unlink unconditionally for them — that is what
      // removes `<dir>/.keep.mtime` / `<dir>/.keep`. Otherwise a hidden
      // placeholder would be "confirmed gone" without ever being deleted, the
      // tombstone would be GC'd, and the empty directory would reappear on the
      // next pull.
      const isKeepPlaceholder =
        tombstone.path === '/.keep' || tombstone.path.endsWith('/.keep');
      const forceDelete = isMtimeSidecar(tombstone.path) || isKeepPlaceholder;
      const tVersionPath = forceDelete ? null : versionPathFor(tombstone.path);

      // 侧车墓碑（`<file>.mtime` / `<file>.version` / `<file>.version.mtime`）只在
      // 其数据文件也已被删除时才该清理。数据文件仍然存在 = 这个侧车是"仍在用的
      // 元数据"：每轮都先 DELETE、随后由同步/写入路径重建，会形成
      // delete → create 的提交抖动（Gitee 上还会因读侧滞后撞 400）。
      // 这里改为不动它：内容需要更新时由写入路径直接 PUT 覆写。
      const sidecarOwner = sidecarOwnerPath(tombstone.path);
      const isKeepSidecar = sidecarOwner === '/.keep' || (sidecarOwner?.endsWith('/.keep') ?? false);
      const liveSidecarCandidate = sidecarOwner !== null && !isKeepSidecar;

      // 1. 本地主存储：清掉可能被重建的残留（目录按树删，含 `.keep` 占位）。
      if (forceDelete) {
        if (!(liveSidecarCandidate && await this.pathExistsOnBackend(this.cachedFS, sidecarOwner!))) {
          try { await this.cachedFS.unlink(tombstone.path); processed++; } catch { /* 已不存在 */ }
        }
      } else {
        const existedOnPrimary = await this.pathExistsOnBackend(this.cachedFS, tombstone.path);
        const gone = await this.purgePathOnBackend(this.cachedFS, tombstone.path);
        if (gone) { if (existedOnPrimary) processed++; else alreadyDeleted++; }
        else unresolved++;
        if (tVersionPath) await this.purgePathOnBackend(this.cachedFS, tVersionPath);
      }

      // 2. 所有副本：同样按树清理；只有确认不存在才记录"已确认"。
      for (const [replicaId, replica] of this.replicaBackends) {
        let gone: boolean;
        if (forceDelete) {
          if (liveSidecarCandidate && await this.pathExistsOnBackend(replica.instance, sidecarOwner!)) {
            // 数据文件仍在 → 侧车仍在被使用，保留（不再 DELETE 后重建）。
            gone = true;
            alreadyDeleted++;
          } else {
            // `.mtime` 侧车对 exists() 不可见，unlink 成功（或明确报"不存在"）
            // 才算确认删除。
            try { await replica.instance.unlink(tombstone.path); gone = true; }
            catch (err) { gone = isNotFoundError(err); }
            if (gone) processed++;
          }
        } else {
          const existed = await this.pathExistsOnBackend(replica.instance, tombstone.path);
          gone = await this.purgePathOnBackend(replica.instance, tombstone.path);
          if (gone) { if (existed) processed++; else alreadyDeleted++; }
          if (tVersionPath) await this.purgePathOnBackend(replica.instance, tVersionPath);
        }

        if (gone) {
          let confirmed = this.tombstoneConfirmations.get(tombstone.path);
          if (!confirmed) {
            confirmed = new Set<string>();
            this.tombstoneConfirmations.set(tombstone.path, confirmed);
          }
          confirmed.add(replicaId);
        } else {
          // 副本仍持有该路径（哪怕只剩 `.keep` / `.keep.mtime`）：
          // 墓碑必须保留，等下一轮继续清理。
          unresolved++;
          log.warn(
            `[ConfigRepo] tombstone kept: ${tombstone.path} still present on replica ${replicaId}`,
          );
        }
      }
    }

    if (processed > 0 || alreadyDeleted > 0 || unresolved > 0) {
      log.log(
        `[ConfigRepo] processTombstones: ${tombstones.length} tombstone(s), ` +
        `${processed} deleted, ${alreadyDeleted} already gone, ${unresolved} unresolved`,
      );
    }
  }

  /**
   * 删除墓碑目标在某个后端上的全部残留。
   *
   * 目录不能直接 unlink（会抛 EISDIR）。旧实现把这个异常当成"已被并发删除"
   * 而继续推进确认，墓碑随后被 GC；但副本上的占位目录仍然存在，下一次同步
   * 就把它当作远端内容拉回本地，形成空壳复活。
   *
   * 这里按树清理：
   * 1. 强制删掉 `.keep` / `.keep.mtime` 占位（部分后端把 `.keep` 隐藏在索引里，
   *    readdir 看不到，只能按路径直接删）；
   * 2. 递归清理可见子项；
   * 3. rmdir（后端不支持目录时退回 unlink）。
   *
   * @returns 是否确认该路径已不存在；清理失败返回 false，墓碑必须保留。
   */
  private async purgePathOnBackend(fs: any, targetPath: string): Promise<boolean> {
    let isDir = false;
    try {
      const stat = await fs.stat(targetPath);
      isDir = typeof stat?.isDirectory === 'function'
        ? stat.isDirectory()
        : !!(stat && ((stat.mode ?? 0) & 0o170000) === 0o040000);
    } catch {
      // stat 失败：路径可能本就不存在，也可能后端不支持 stat。
      if (!(await this.pathExistsOnBackend(fs, targetPath))) return true;
    }

    if (!isDir) {
      try { await fs.unlink(targetPath); } catch { /* 可能已被删除 */ }
      return !(await this.pathExistsOnBackend(fs, targetPath));
    }

    for (const placeholder of [`${targetPath}/.keep`, `${targetPath}/.keep.mtime`]) {
      try { await fs.unlink(placeholder); } catch { /* 不存在或后端不支持 */ }
    }
    let children: string[] = [];
    try { children = await fs.readdir(targetPath); } catch { /* 目录可能已消失 */ }
    for (const child of children) {
      await this.purgePathOnBackend(fs, `${targetPath}/${child}`);
    }
    try { await fs.rmdir(targetPath); } catch {
      try { await fs.unlink(targetPath); } catch { /* 仍存在 */ }
    }
    if (await this.pathExistsOnBackend(fs, targetPath)) {
      // 目录还在（多半是占位文件又出现）：再清一次占位后判定失败。
      for (const placeholder of [`${targetPath}/.keep`, `${targetPath}/.keep.mtime`]) {
        try { await fs.unlink(placeholder); } catch { /* ignore */ }
      }
      try { await fs.rmdir(targetPath); } catch { /* ignore */ }
      return !(await this.pathExistsOnBackend(fs, targetPath));
    }
    return true;
  }

  /** 后端无关的存在性判断：优先 exists()，否则退化为 stat()。 */
  private async pathExistsOnBackend(fs: any, path: string): Promise<boolean> {
    if (typeof fs?.exists === 'function') {
      try { return !!(await fs.exists(path)); } catch { return false; }
    }
    try { await fs.stat(path); return true; } catch { return false; }
  }

  /**
   * Safe existence check — returns false on any error instead of throwing.
   * Used by processTombstones to avoid unnecessary unlink() calls.
   */
  private async safeExists(fs: any, path: string): Promise<boolean> {
    try {
      // Gather diagnostic info about the fs object
      const ctorName = fs?.constructor?.name ?? typeof fs;
      const hasExists = typeof fs?.exists === 'function';
      const hasStat = typeof fs?.stat === 'function';
      const innerBackend = fs?.inner?.constructor?.name;
      const innerBackendName = fs?.inner?.backendName;
      const directBackendName = fs?.backendName;
      const backendLabel = innerBackendName ?? directBackendName ?? innerBackend ?? ctorName;

      log.log(`[TOMB-TRACE] safeExists(${path}): fs type=${ctorName} backend=${backendLabel} hasExists=${hasExists} hasStat=${hasStat} inner=${innerBackend ?? 'N/A'}`);

      if (hasExists) {
        log.log(`[TOMB-TRACE] safeExists(${path}): → calling fs.exists() [backend=${backendLabel}]`);
        const result = await fs.exists(path);
        log.log(`[TOMB-TRACE] safeExists(${path}): ← fs.exists() [backend=${backendLabel}] → ${result}`);
        return result;
      }
      // Fallback: try stat() — if it throws, the file doesn't exist
      log.log(`[TOMB-TRACE] safeExists(${path}): no exists(), calling fs.stat() [backend=${backendLabel}]`);
      await fs.stat(path);
      log.log(`[TOMB-TRACE] safeExists(${path}): ← fs.stat() [backend=${backendLabel}] → OK (exists)`);
      return true;
    } catch (err: any) {
      const errCode = err?.code ?? err?.status ?? '';
      const errName = err?.constructor?.name ?? '';
      log.log(`[TOMB-TRACE] safeExists(${path}): ← ERROR ${errName} ${errCode} ${err?.message ?? err}`);
      return false;
    }
  }

  /** Public wrapper for processTombstones — used by createConfigRepo. */
  async processTombstonesPublic(): Promise<void> {
    await this.processTombstones();
  }

  /**
   * Delete leaked `.mtime` sidecar files from the local primary backend
   * (IndexedDB on browser, Folder on Node).
   *
   * Sidecars are produced by backends that keep a precise mtime out-of-band
   * (RemoteStorage, Gitee…). Once one is copied into the local primary it is
   * never removed: zen-fs-sync skips `.mtime` paths on both sides, so it is
   * invisible to sync, and every walk warns about the leak.
   *
   * Only the local primary is scanned — replica sidecars are live metadata of
   * the backend that owns them and must be left alone.
   *
   * @param options.root Scan only this subtree (default `/`).
   * @param options.dryRun List the sidecars without deleting them.
   */
  async purgeMtimeSidecars(options?: PurgeMtimeOptions): Promise<MtimePurgeResult> {
    this.assertNotDisposed();
    const result = await purgeMtimeSidecars(this.cachedFS, options);
    if (result.removed.length > 0) {
      log.log(
        `[ConfigRepo] purged ${result.removed.length} .mtime sidecar(s) from local primary` +
        (options?.dryRun ? ' (dry run)' : ''),
        result.removed,
      );
    }
    if (result.failed.length > 0) {
      log.warn(`[ConfigRepo] failed to purge ${result.failed.length} .mtime sidecar(s):`, result.failed);
    }
    return result;
  }

  /**
   * Delete leaked `.keep` placeholders from the local primary backend.
   *
   * Backends that cannot store empty directories (Gitee, RemoteStorage…) keep a
   * directory alive with an internal `.keep` placeholder. Older builds copied
   * those backend-internal files into the local primary, where sync ignores
   * them — so they linger forever. `/.meta/backends/.keep` (intentional) is
   * protected and never removed.
   *
   * @param options.root Scan only this subtree (default `/`).
   * @param options.dryRun List the placeholders without deleting them.
   */
  async purgeKeepFiles(options?: PurgeKeepOptions): Promise<KeepPurgeResult> {
    this.assertNotDisposed();
    const result = await purgeKeepFiles(this.cachedFS, options);
    if (result.removed.length > 0) {
      log.log(
        `[ConfigRepo] purged ${result.removed.length} .keep placeholder(s) from local primary` +
        (options?.dryRun ? ' (dry run)' : ''),
        result.removed,
      );
    }
    if (result.failed.length > 0) {
      log.warn(`[ConfigRepo] failed to purge ${result.failed.length} .keep placeholder(s):`, result.failed);
    }
    return result;
  }

  /**
   * Migrate legacy `.x.version` sidecars (old dotfile naming) to the new
   * `<name>.version` naming. Renames local sidecars (preserving content/history)
   * and deletes the residual legacy copy from every replica backend so sync
   * does not pull it back. Best-effort: failures are logged, never thrown.
   *
   * Runs once at startup (see createConfigRepo). Safe to call again.
   */
  async migrateLegacyVersionSidecars(): Promise<VersionMigrationResult> {
    this.assertNotDisposed();
    const replicas = [...this.replicaBackends.values()].map((r) => ({
      unlink: (p: string) => r.syncable.unlink(p),
    }));
    const result = await migrateVersionSidecars(this.cachedFS, { replicas });
    if (result.renamed.length > 0) {
      log.log(
        `[ConfigRepo] migrated ${result.renamed.length} legacy version sidecar(s) to new naming`,
        result.renamed,
      );
    }
    if (result.deleted.length > 0) {
      log.log(
        `[ConfigRepo] removed ${result.deleted.length} orphaned legacy version sidecar(s)`,
        result.deleted,
      );
    }
    if (result.remoteDeleted.length > 0) {
      log.log(
        `[ConfigRepo] removed ${result.remoteDeleted.length} remote residual legacy version sidecar(s)`,
      );
    }
    if (result.failed.length > 0) {
      log.warn(`[ConfigRepo] failed to migrate ${result.failed.length} legacy version sidecar(s):`, result.failed);
    }
    return result;
  }

  /**
   * Perform a full sync + dedup cycle without the watch snapshot cache.
   * Used by createConfigRepo to pull remote-only files (like duplicate
   * backend descriptors) that watch()'s initial snapshot would skip.
   */
  async initialSyncAndDedup(): Promise<void> {
    this.syncEngine.unwatchAll();
    await this.syncEngine.syncAll();
    await this.readAllBackendDescriptors();
    await this.processTombstones();
    this.syncEngine.watchAll();
  }

  /**
   * Start the initial sync + dedup cycle in the background.
   * `flush()` and `dispose()` will await this promise if it hasn't
   * completed yet, preventing concurrent syncEngine operations.
   */
  startBackgroundSync(): void {
    this.initialSyncPromise = this.initialSyncAndDedup()
      .then(() => {
        log.log('[ConfigRepo] Background initial sync complete');
      })
      .catch((err) => {
        log.error('[ConfigRepo] Background initial sync failed:', err);
      })
      .finally(() => {
        this.initialSyncPromise = null;
      });
  }

  /**
   * After sync: mark each tombstone as confirmed by replicas where the target
   * path was actually verified absent.
   *
   * 旧实现把所有副本无条件写进 confirmedBy，只要有一轮同步跑过就认为
   * "所有副本都删干净了"。但副本可能因为网络/后端限制删除失败，或只剩
   * `.keep` / `.keep.mtime` 占位目录；墓碑一旦被 GC，下一轮同步就把残留
   * 当作远端内容拉回本地。现在只确认 processTombstones 本轮真正清干净的副本。
   */
  private async updateTombstoneConfirmations(): Promise<void> {
    const tombstones = await this.readTombstones();
    if (tombstones.length === 0) return;

    let modified = 0;
    for (const tombstone of tombstones) {
      let changed = false;
      const confirmedReplicas = this.tombstoneConfirmations.get(tombstone.path);
      for (const replicaId of this.replicaBackends.keys()) {
        if (tombstone.confirmedBy.includes(replicaId)) continue;
        if (!confirmedReplicas?.has(replicaId)) continue;
        tombstone.confirmedBy.push(replicaId);
        changed = true;
      }
      // Only rewrite when the confirmation set actually changed — otherwise we
      // would re-touch the tombstone's mtime every cycle and feed the sync
      // engine a spurious "changed file", causing needless MTIME NORMALIZE churn
      // until the tombstone is eventually GC'd.
      if (changed) {
        try {
          const bytes = new TextEncoder().encode(JSON.stringify(tombstone, null, 2));
          const tombstonePath = tombstonePathFor(tombstone.path, TOMBSTONES_DIR);
          if (await this.safeExists(this.cachedFS, tombstonePath)) {
            await this.cachedFS.writeFile(tombstonePath, bytes);
          }
          modified++;
        } catch { /* ignore write error */ }
      }
    }

    log.log(`[ConfigRepo] updateTombstoneConfirmations: ${modified} tombstone(s) updated`);
    // Invalidate cache — tombstones were modified (confirmedBy updated)
    if (modified > 0) this.invalidateTombstoneCache();
  }

  /**
   * 墓碑路径是否已在所有副本上确认不存在。
   *
   * `.mtime` 侧车与 `.keep` 占位对部分后端不可见（`exists()` 恒为 false），
   * 因此只能相信本轮 `processTombstones` 的 unlink 结果；其余路径在 GC 前
   * 现场复核一次，避免"确认之后副本又把残留带了回来"。
   *
   * 任一位置仍存在就返回 false —— 墓碑必须保留，直到真正删干净。
   */
  private async allReplicasConfirmAbsent(path: string): Promise<boolean> {
    const confirmed = this.tombstoneConfirmations.get(path);
    const hiddenPlaceholder = isMtimeSidecar(path) || path === '/.keep' || path.endsWith('/.keep');
    if (hiddenPlaceholder) {
      for (const replicaId of this.replicaBackends.keys()) {
        if (!confirmed?.has(replicaId)) return false;
      }
      return true;
    }

    for (const [, replica] of this.replicaBackends) {
      if (await this.pathExistsOnBackend(replica.instance, path)) return false;
    }
    return true;
  }

  /**
   * GC: remove tombstones where all backends in backends.json have confirmed.
   *
   * Tombstones are deleted from ALL backends (local + replicas), not just
   * the local IndexedDB. If we only deleted locally, the sync engine would
   * see them as "created on target" and copy them back every cycle — causing
   * an infinite loop of copy → GC → copy → GC.
   */
  private async gcTombstones(): Promise<void> {
    const tombstones = await this.readTombstones();
    if (tombstones.length === 0) return;

    // Only require confirmation from the replica backends. The implicit local
    // primary is the origin of the deletion and is never expected to appear in
    // confirmedBy as a *replica*; getBackends() also lists it (and any
    // non-replica descriptors), which made `every()` unsatisfiable and left
    // tombstones alive forever — re-touched (mtime=now) on every sync cycle and
    // feeding the sync engine spurious MTIME NORMALIZE churn.
    const allBackendIds = [...this.replicaBackends.keys()];

    for (const tombstone of tombstones) {
      // 不能只看历史 confirmedBy：某副本可能在上一次确认之后又把路径/占位目录
      // 带了回来。GC 前必须逐个副本复核"当前确实不存在"。
      const allConfirmed = await this.allReplicasConfirmAbsent(tombstone.path);
      if (allConfirmed) {
        const tombstonePath = tombstonePathFor(tombstone.path, TOMBSTONES_DIR);

        // Delete tombstone on local primary
        try {
          await this.cachedFS.unlink(tombstonePath);
        } catch { /* already gone */ }

        // Delete tombstone on all replicas — prevents the sync engine
        // from re-copying them back on the next cycle.
        for (const [, replica] of this.replicaBackends) {
          if (await this.safeExists(replica.instance, tombstonePath)) {
            try {
              await replica.instance.unlink(tombstonePath);
            } catch { /* race */ }
          }
        }

        log.log(`[ConfigRepo] gcTombstones: removed ${tombstonePath} (all ${allBackendIds.length} backends confirmed)`);
      }
    }
  }

  /**
   * Sync .meta/ files (backends.json) to all replica backends.
   *
   * This ensures the backend topology is available on every replica, enabling
   * any program that connects to any backend to discover the full topology.
   *
   * Called automatically by createConfigRepo() after setupSync().
   */
  async syncMetaToReplicas(): Promise<void> {
    this.assertNotDisposed();
    // Instead of directly writing to replicas (which bypasses the sync engine),
    // trigger the sync engine to sync all pending changes immediately.
    // The sync engine performs hash-based change detection, only transfers
    // changed files, and handles conflicts properly.
    const results = await this.flush();
    for (const result of results) {
      log.log(
        `[ConfigRepo] syncMetaToReplicas: ${result.pairId} ` +
        `+${result.filesCreated}/~${result.filesUpdated}/-${result.filesDeleted} ` +
        `skip:${result.filesSkipped} ${result.durationMs}ms`,
      );
    }
  }

  getSyncStatuses(): Map<string, SyncPairStatus> {
    this.assertNotDisposed();
    return this.syncEngine.getStatusAll();
  }

  /**
   * Per-backend sync state. Includes replica descriptors that failed to connect
   * (they have no sync pair, so they never show up in getSyncStatuses()).
   */
  getBackendSyncStates(): Map<string, BackendSyncState> {
    this.assertNotDisposed();
    return new Map(this.backendStates);
  }

  /**
   * Mirror per-pair `sync:error` into `getBackendSyncStates()`.
   *
   * `SyncEngine.syncAll()` catches per-pair exceptions and substitutes an empty
   * result, so a failed replica otherwise only shows up as a missing
   * `lastResult`. Recording the real error lets callers report the actual
   * status (401/403/404/timeout) instead of guessing "remote unreachable or
   * invalid credentials".
   */
  private trackSyncErrors(backendId: string, pairId: string): void {
    this.syncEngine.on(pairId, 'sync:error', (event) => {
      const error = event.error;
      this.backendStates.set(backendId, {
        backendId,
        pairId,
        error: {
          message: error instanceof Error ? error.message : String(error ?? 'sync failed'),
          timestamp: Date.now(),
        },
      });
    });
    this.syncEngine.on(pairId, 'sync:end', () => {
      const current = this.backendStates.get(backendId);
      if (current?.error) this.backendStates.set(backendId, { backendId, pairId });
    });
  }

  /** Registered replica backend descriptors (excludes the implicit local primary). */
  listBackends(): AppDataBackendDescriptor[] {
    this.assertNotDisposed();
    return [...this.backendDescriptorCache];
  }

  /** 配置组的权威后端列表（`.meta/backends/`），与 `listBackends()` 相同。 */
  listDeclaredBackends(): AppDataBackendDescriptor[] {
    return this.listBackends();
  }

  /** Update the config-sync group's display name only. */
  async rename(name: string): Promise<void> {
    this.assertNotDisposed();
    const descriptor = await this.updateConfigSyncGroupDescriptor({ name });
    this.name = descriptor.name;
  }

  // -----------------------------------------------------------------------
  // IConfigRepo — Conflict Management
  // -----------------------------------------------------------------------

  async resolveConflict(conflictId: string, mergedContent: unknown): Promise<void> {
    this.assertNotDisposed();

    // New layout first, legacy `.meta/.conflicts` as a one-cycle fallback.
    let metaPath: string | null = null;
    let archive: ConflictArchive | null = null;
    for (const dir of [CONFLICTS_DIR, LEGACY_CONFLICTS_DIR]) {
      const candidate = `${dir}/${conflictId}`;
      try {
        const raw = await this.cachedFS.readFile(candidate);
        archive = JSON.parse(new TextDecoder().decode(toUint8Array(raw)) as string) as ConflictArchive;
        metaPath = candidate;
        break;
      } catch { /* try next layout */ }
    }
    if (!metaPath || !archive) {
      throw new Error(`Failed to resolve conflict ${conflictId}: archive not found`);
    }

    try {
      const configPath = archive.conflictPath;
      const bytes = this.serializer.serialize(mergedContent, configPath);
      await this.cachedFS.writeFile(configPath, bytes);

      const author = `${this.appId}/${this.nodeId}`;
      const version = await incrementVersion(
        this.fullFS,
        configPath,
        bytes,
        author,
      );
      await this.writeVersionSidecar(configPath, version);

      // Save resolved content as a separate backup file
      const conflictDir = metaPath.substring(0, metaPath.lastIndexOf('/'));
      const resolvedBackupPath = `${conflictDir}/resolved`;
      const resolvedBytes = typeof mergedContent === 'string'
        ? new TextEncoder().encode(mergedContent)
        : new TextEncoder().encode(JSON.stringify(mergedContent, null, 2));
      await this.cachedFS.writeFile(resolvedBackupPath, resolvedBytes);

      // Update metadata with resolved backup path
      archive.resolvedBackupPath = `./resolved`;
      await this.cachedFS.writeFile(
        metaPath,
        new TextEncoder().encode(JSON.stringify(archive, null, 2)),
      );
    } catch (err) {
      throw new Error(`Failed to resolve conflict ${conflictId}: ${err}`);
    }
  }

  async listConflicts(): Promise<ConflictArchive[]> {
    this.assertNotDisposed();

    const archives: ConflictArchive[] = [];
    const seen = new Set<string>();
    for (const dir of [CONFLICTS_DIR, LEGACY_CONFLICTS_DIR]) {
      let entries: string[];
      try {
        entries = await this.cachedFS.readdir(dir);
      } catch {
        continue; // directory doesn't exist yet
      }
      for (const entry of entries) {
        if (seen.has(entry)) continue;
        // Each conflict is a directory containing meta.json
        const metaPath = `${dir}/${entry}/meta.json`;
        try {
          const raw = await this.cachedFS.readFile(metaPath);
          const archive = JSON.parse(
            new TextDecoder().decode(toUint8Array(raw)),
          );
          seen.add(entry);
          archives.push(archive);
        } catch {
          // Skip entries without valid meta.json
        }
      }
    }
    return archives.sort((a, b) => a.timestamp - b.timestamp);
  }

  async readConflictBackup(conflictId: string, fileType: 'source' | 'target' | 'resolved'): Promise<string> {
    this.assertNotDisposed();

    for (const dir of [CONFLICTS_DIR, LEGACY_CONFLICTS_DIR]) {
      const conflictDir = `${dir}/${conflictId}`.replace(/\/meta\.json$/, '');
      try {
        const raw = await this.cachedFS.readFile(`${conflictDir}/${fileType}`);
        return new TextDecoder().decode(toUint8Array(raw));
      } catch { /* try next layout */ }
    }
    throw new Error(`Conflict backup not found: ${conflictId}/${fileType}`);
  }

  // -----------------------------------------------------------------------
  // IConfigRepo — Lifecycle
  // -----------------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.disposed) return;
    // Wait for background initial sync if still running
    if (this.initialSyncPromise) {
      await this.initialSyncPromise;
      this.initialSyncPromise = null;
    }
    this.disposed = true;
    // Clear post-delete sync timer
    if (this.postDeleteSyncTimer) {
      clearTimeout(this.postDeleteSyncTimer);
      this.postDeleteSyncTimer = undefined;
    }
    this.syncEngine.dispose();

    for (const [_id, replica] of this.replicaBackends) {
      if (replica.instance?.dispose) {
        await replica.instance.dispose();
      }
    }
    this.replicaBackends.clear();

    for (const [_id, group] of this.appDataGroups) {
      await group.dispose();
    }
    this.appDataGroups.clear();
    this.configCache.clear();
  }

  // -----------------------------------------------------------------------
  // Internal — Setup
  // -----------------------------------------------------------------------

  async setupSync(
    backends: BackendDescriptor[],
    primaryBackendId: string,
    pollIntervalMs?: number,
  ): Promise<void> {
    log.log(`[ConfigRepo] setupSync: ${backends.length} backends, primary=${primaryBackendId} pollInterval=${pollIntervalMs ?? 'default'}ms`);

    for (const desc of backends) {
      if (desc.id === primaryBackendId) continue;
      if ((desc as any).enabled === false) {
        log.log(`[ConfigRepo] Skipping disabled replica: ${desc.id}`);
        continue;
      }
      log.log(`[ConfigRepo] Creating replica backend: id=${desc.id}, type=${desc.type}`);
      try {
        const instance = await createBackend(desc);

        // Wrap replica with CachedFileSystem when caching is enabled.
        // This avoids redundant network reads on Gitee/RemoteStorage backends
        // by caching content + revision tokens (ETag / Git blob SHA) in IndexedDB.
        // The local IndexedDB primary is NOT cached (it's already local storage).
        let fsInstance = instance;
        if (this.cacheOptions) {
          const { wrapWithCache } = await import('./cache-wrapper');
          fsInstance = wrapWithCache(instance, desc.id, this.cacheOptions);
          log.log(`[ConfigRepo] Replica ${desc.id} wrapped with CachedFileSystem (store=${this.cacheOptions.storeType ?? 'IdbCacheStore'})`);
        }

        const syncable = backendToSyncableFS(fsInstance, `${desc.type}(${desc.id})`);

        // Create sync pair with tombstone hooks.
        // preSyncHook: processTombstones() deletes real files on replicas
        //   BEFORE sync runs, so zen-fs-sync doesn't resurrect them via
        //   snapshot comparison (especially after restart when in-memory
        //   snapshots are lost).
        // postSyncHook: sync may have pulled new tombstones from remote.
        //   Re-process tombstones and update confirmations.
        //   NOTE: gcTombstones() is intentionally NOT called here — GC
        //   only happens in flush() to give tombstones time to propagate
        //   to all replicas across multiple sync cycles. Running GC in
        //   every postSyncHook would delete tombstones before offline
        //   replicas have a chance to see them.
        const pair = this.syncEngine.addPair(
          this.fullFS,
          syncable,
          {
            direction: SyncDirection.BiDirectional,
            conflictStrategy: 'source-wins' as any,
            pollIntervalMs,
            // 墓碑未清理前排除被删路径：副本残留（含 `.keep` 占位）不会被当成
            // "远端新增"再拉回本地。
            filter: this.syncFilter,
            preSyncHook: async () => {
              try {
                this.invalidateTombstoneCache();
                await this.processTombstones();
              } catch (err) {
                log.warn('[ConfigRepo] preSyncHook processTombstones failed:', err);
              }
            },
            postSyncHook: async () => {
              try {
                this.invalidateTombstoneCache();
                await this.processTombstones();
                await this.updateTombstoneConfirmations();
              } catch (err) {
                log.warn('[ConfigRepo] postSyncHook tombstone processing failed:', err);
              }
            },
          },
          '/',
        );

        this.replicaBackends.set(desc.id, { instance: fsInstance, syncable, pairId: pair.pairId });
        this.backendStates.set(desc.id, { backendId: desc.id, pairId: pair.pairId });

        // Register conflict handler
        const conflictHandler: SyncEventHandler = (event: SyncEvent) => {
          this.handleConflict(event);
        };
        this.syncEngine.on(pair.pairId, 'conflict', conflictHandler);
        this.trackSyncErrors(desc.id, pair.pairId);

        // NOTE: Do NOT call watch() here. watch() triggers buildInitialSnapshots()
        // which caches a merged (source ∪ target) snapshot WITHOUT actually
        // syncing files. This causes subsequent syncAll() to see "unchanged"
        // and skip, leaving remote-only files (like duplicate backend
        // descriptors) un-pulled. The caller (createConfigRepo) will do an
        // initial sync first, then call watchAll().

        log.log(`[ConfigRepo] Replica ${desc.id} created, sync pair=${pair.pairId}`);
      } catch (err: any) {
        log.error(`[ConfigRepo] Failed to create replica ${desc.id} (${desc.type}):`, err);
        this.backendStates.set(desc.id, {
          backendId: desc.id,
          error: {
            message: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          },
        });
      }
    }

    log.log(`[ConfigRepo] setupSync complete. Replicas:`, Array.from(this.replicaBackends.keys()));
    log.log(`[ConfigRepo] Sync statuses:`, this.getSyncStatuses());
  }

  // -----------------------------------------------------------------------
  // Internal — Persistence
  // -----------------------------------------------------------------------

  /** Write version sidecar for a config file (no-op for .version files). */
  private async writeVersionSidecar(configPath: string, version: VersionMeta): Promise<void> {
  	const vPath = versionPathFor(configPath);
  	if (!vPath) return;
  	// Skip the write if the stored sidecar already records the same content
  	// hash. This prevents redundant PUTs to remote backends when the config
  	// data is unchanged (incrementVersion already returns the previous record
  	// in that case, so the hashes match). readVersion goes through fullFS
  	// (local-first), so this is a cheap local check that saves a network write.
  	try {
  		const existing = await readVersion(this.fullFS, vPath);
  		if (existing && existing.hash === version.hash) {
  			log.log('[ConfigRepo] skip version sidecar (hash unchanged):', vPath);
  			return;
  		}
  	} catch {
  		// No existing sidecar (or unreadable) — proceed to write.
  	}
  	log.log('[ConfigRepo] write version sidecar:', vPath, 'v' + version.version);
  	await this.ensureDir(vPath);
  	await writeVersion(this.fullFS, vPath, version);
  }

  /** Delete version sidecar on a backend (no-op for .version files). */
  private async unlinkVersionSidecar(fs: any, configPath: string): Promise<void> {
    const vPath = versionPathFor(configPath);
    if (!vPath) return;
    // Check existence before unlink — avoids wasteful DELETE requests
    // on remote backends (RemoteStorage, Gitee, WebDAV) when the version
    // sidecar was never created or already deleted on a previous cycle.
    if (!(await this.safeExists(fs, vPath))) return;
    try { await fs.unlink(vPath); } catch { /* race — removed between exists and unlink */ }
  }

  /** Read version sidecar (returns null for .version files). */
  private async readVersionSidecar(configPath: string): Promise<VersionMeta | null> {
    const vPath = versionPathFor(configPath);
    if (!vPath) return null;
    return readVersion(this.fullFS, vPath);
  }

  private async persistConfig(fullPath: string, bytes: Uint8Array): Promise<void> {
    await this.ensureDir(fullPath);
    await this.cachedFS.writeFile(fullPath, bytes);

    const author = `${this.appId}/${this.nodeId}`;
    const version = await incrementVersion(this.fullFS, fullPath, bytes, author);
    await this.writeVersionSidecar(fullPath, version);
  }

  private async reloadConfigCache(): Promise<void> {
    const appDir = `/${this.appId}`;
    try {
      const files = await this.walkDir(appDir);
      // Parallelize file reads — avoids serial await for each file
      const readResults = await Promise.all(
        files.map(async (filePath) => {
          try {
            const raw = await this.cachedFS.readFile(filePath);
            const data = this.serializer.deserialize(toUint8Array(raw), filePath);
            return { filePath, data };
          } catch {
            return null;
          }
        }),
      );
      for (const item of readResults) {
        if (item) this.configCache.set(item.filePath, item.data);
      }
    } catch {
      // App directory might not exist yet
    }
  }

  // -----------------------------------------------------------------------
  // Internal — Conflict Handling
  // -----------------------------------------------------------------------

  private async handleConflict(event: SyncEvent): Promise<void> {
    const conflict = event.conflict;
    if (!conflict) return;

    const conflictId = `${event.timestamp}_${conflict.path.replace(/\//g, '_')}`;
    const conflictDir = `${CONFLICTS_DIR}/${conflictId}`;

    // Backup conflict file contents as separate files
    const sourceBackupPath = `${conflictDir}/source`;
    const targetBackupPath = `${conflictDir}/target`;

    await this.ensureDir(conflictDir);
    await this.cachedFS.writeFile(
      sourceBackupPath,
      new TextEncoder().encode(conflict.sourceContent),
    );
    await this.cachedFS.writeFile(
      targetBackupPath,
      new TextEncoder().encode(conflict.targetContent),
    );

    let sourceVersion = 0;
    try {
      const srcVer = await this.readVersionSidecar(conflict.path);
      if (srcVer) sourceVersion = srcVer.version;
    } catch { /* ignore */ }

    // Write metadata JSON (no inline content)
    const archive: ConflictArchive = {
      conflictPath: conflict.path,
      timestamp: event.timestamp,
      sourceAuthor: `${this.appId}/${this.nodeId}`,
      targetAuthor: 'unknown',
      sourceVersion,
      targetVersion: 0,
      resolvedStrategy: conflict.resolvedWith as any,
      sourceBackupPath: `./source`,
      targetBackupPath: `./target`,
    };

    const metaPath = `${conflictDir}/meta.json`;
    await this.cachedFS.writeFile(
      metaPath,
      new TextEncoder().encode(JSON.stringify(archive, null, 2)),
    );

    if (this.onConflictCallback) {
      const info: ConflictInfo = {
        conflictId: `${conflictId}/meta.json`,
        path: conflict.path,
        sourceAuthor: archive.sourceAuthor,
        targetAuthor: archive.targetAuthor,
        sourceContent: this.tryParse(conflict.sourceContent),
        targetContent: this.tryParse(conflict.targetContent),
      };
      try {
        const customMerge = await this.onConflictCallback(info);
        if (customMerge !== null && customMerge !== undefined) {
          await this.resolveConflict(`${conflictId}/meta.json`, customMerge);
        }
      } catch (err) {
        log.error('[zen-fs-config] Conflict handler error:', err);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal — File System Helpers
  // -----------------------------------------------------------------------

  async ensureDir(filePath: string): Promise<void> {
    const parts = filePath.split('/').filter(Boolean);
    parts.pop();
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      // mkdir is idempotent — no need to exists() first.
      // This avoids HEAD+GET 404 probes on every first-time directory creation.
      try {
        await this.fullFS.mkdir(current);
      } catch {
        // Directory might already exist — that's fine
      }
    }
  }

  private async walkDir(dir: string): Promise<string[]> {
    const results: string[] = [];
    const stack = [dir];

    while (stack.length > 0) {
      const current = stack.pop()!;
      try {
        const entries = await this.cachedFS.readdir(current);
        // Parallelize stat calls — avoids serial await for each entry
        const statResults = await Promise.all(
          entries
            .filter(
              (entry: string) =>
                !entry.startsWith('.') &&
                !entry.endsWith('.version') &&
                !entry.endsWith('.mtime'),
            )
            .map(async (entry: string) => {
              const fullPath = current === '/' ? `/${entry}` : `${current}/${entry}`;
              try {
                const stat = await this.cachedFS.stat(fullPath);
                return { fullPath, stat };
              } catch {
                return null;
              }
            }),
        );
        for (const item of statResults) {
          if (!item) continue;
          if (item.stat.mode !== undefined && (item.stat.mode & 0o40000) === 0o40000) {
            stack.push(item.fullPath);
          } else {
            results.push(item.fullPath);
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    return results;
  }

  async writeMetaFile(path: string, data: unknown): Promise<void> {
    await this.ensureDir(path);

    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
    await this.cachedFS.writeFile(path, bytes);

    // Generate version sidecar for meta files, same as config data files
    const author = `${this.appId}/${this.nodeId}`;
    const version = await incrementVersion(this.fullFS, path, bytes, author);
    await this.writeVersionSidecar(path, version);
  }

  async readMetaFile<T>(path: string): Promise<T | null> {
    try {
      const raw = await this.cachedFS.readFile(path);
      return JSON.parse(new TextDecoder().decode(toUint8Array(raw))) as T;
    } catch {
      return null;
    }
  }

  /** Read a text file; `null` when absent (used for byte-compare-then-write). */
  private async readTextIfExists(path: string): Promise<string | null> {
    try {
      const raw = await this.cachedFS.readFile(path);
      return new TextDecoder().decode(toUint8Array(raw));
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Internal — Individual Backend Descriptor Files
  // -----------------------------------------------------------------------

  /** Path for a single backend descriptor: `.meta/backends/{id}.json`. */
  backendFilePath(id: string): string {
    return `${BACKENDS_DIR}/${id}.json`;
  }

  /**
   * Legacy pre-0.7 path `/.config/backends/{id}.json`.
   *
   * 该目录已不再读取：此处只用于删除后端时尽力清理残留副本。
   */
  legacyBackendFilePath(id: string): string {
    return `${LEGACY_BACKENDS_DIR}/${id}.json`;
  }

  /** Read every parseable descriptor in one directory. */
  private async readBackendDescriptorsFrom(dir: string): Promise<{
    items: { desc: BackendDescriptor; mtime: number }[];
    corruptFiles: string[];
  }> {
    let entries: string[];
    try {
      entries = await this.cachedFS.readdir(dir);
    } catch {
      return { items: [], corruptFiles: [] }; // Directory doesn't exist yet
    }
    const jsonEntries = entries.filter((e: string) => e.endsWith('.json'));

    // Parallelize readFile + stat for all descriptor files
    const readResults = await Promise.all(
      jsonEntries.map(async (entry: string) => {
        const filePath = `${dir}/${entry}`;
        try {
          const raw = await this.cachedFS.readFile(filePath);
          const desc = JSON.parse(new TextDecoder().decode(toUint8Array(raw)));
          if (desc.id && desc.type) {
            let mtime = 0;
            try {
              const stat = await this.cachedFS.stat(filePath);
              mtime = stat.mtimeMs ?? 0;
            } catch { /* mtime unknown */ }
            return { kind: 'ok' as const, desc, mtime };
          } else {
            log.warn(`[ConfigRepo] Backend descriptor ${entry} is missing id/type fields, marking for cleanup`);
            return { kind: 'corrupt' as const, filePath };
          }
        } catch (parseErr) {
          log.warn(`[ConfigRepo] Backend descriptor ${entry} has corrupted JSON: ${parseErr}. Marking for cleanup.`);
          return { kind: 'corrupt' as const, filePath };
        }
      }),
    );

    const items: { desc: BackendDescriptor; mtime: number }[] = [];
    const corruptFiles: string[] = [];
    for (const result of readResults) {
      if (result.kind === 'ok') {
        items.push({ desc: result.desc, mtime: result.mtime });
      } else {
        corruptFiles.push(result.filePath);
      }
    }
    return { items, corruptFiles };
  }

  /**
   * Read all backend descriptors from `.meta/backends/*.json` — the single
   * authoritative location for both config-sync and data-sync groups.
   *
   * `/.config/backends/` is intentionally **not** read: leftovers there are
   * plain content and never take part in backend enumeration.
   *
   * If duplicate backends are detected (same type + options but different id),
   * only the first one (sorted by id) is kept and the rest are removed
   * (including their version sidecar files).
   */
  async readAllBackendDescriptors(): Promise<BackendDescriptor[]> {
    const fresh = await this.readBackendDescriptorsFrom(BACKENDS_DIR);

    const items = [...fresh.items];
    const corruptFiles = [...fresh.corruptFiles];

    // Clean up corrupted descriptor files: delete on all replicas, tombstone, delete locally.
    // This prevents corrupted files from persisting and being re-synced indefinitely.
    for (const corruptPath of corruptFiles) {
      // 1. Delete on all known replicas directly
      for (const [, replica] of this.replicaBackends) {
        try { await replica.instance.unlink(corruptPath); } catch { /* not on this replica */ }
        await this.unlinkVersionSidecar(replica.instance, corruptPath);
      }
      // 2. Create a tombstone + delete locally
      try {
        await this.deleteFile(corruptPath);
      } catch {
        // deleteFile might fail if sync engine isn't set up yet — fall back to plain unlink
        try { await this.cachedFS.unlink(corruptPath); } catch { /* already gone */ }
        await this.unlinkVersionSidecar(this.cachedFS, corruptPath);
      }
    }

    // Deduplicate: same type + options (stable key) but different id.
    // Keep the one with the earliest mtime (created first).
    const seen = new Map<string, { desc: BackendDescriptor; mtime: number }>();
    const duplicates: string[] = [];

    for (const item of items) {
      const key = backendDedupKey(item.desc);
      const existing = seen.get(key);
      if (existing) {
        if (item.mtime < existing.mtime) {
          // New one is older — keep it, mark the existing as duplicate
          duplicates.push(existing.desc.id);
          seen.set(key, item);
        } else {
          // Existing is older (or same time) — keep existing, mark new as duplicate
          duplicates.push(item.desc.id);
        }
      } else {
        seen.set(key, item);
      }
    }

    if (duplicates.length > 0) {
      log.log(
        `[ConfigRepo] readAllBackendDescriptors: removing ${duplicates.length} duplicate(s): ${duplicates.join(', ')}`,
      );
      for (const dupId of duplicates) {
        for (const descPath of [this.backendFilePath(dupId), this.legacyBackendFilePath(dupId)]) {
          // 1. Delete the descriptor file on ALL known replicas directly.
          //    This is critical: if we only write a tombstone + delete locally,
          //    the sync engine will see "remote has file, local doesn't" and
          //    copy it back — re-creating the duplicate in an infinite loop.
          //    By deleting on all replicas NOW, both sides are clean.
          for (const [, replica] of this.replicaBackends) {
            try {
              await replica.instance.unlink(descPath);
            } catch { /* not on this replica */ }
            await this.unlinkVersionSidecar(replica.instance, descPath);
          }

          // 2. Create a tombstone + delete the local file.
          //    The tombstone ensures late-joining replicas also delete the file.
          try {
            await this.deleteFile(descPath);
          } catch {
            // deleteFile might fail if called before sync engine is set up
            // (e.g. during createConfigRepo's tempRepo phase). Fall back to plain unlink.
            try { await this.cachedFS.unlink(descPath); } catch { /* already gone */ }
            await this.unlinkVersionSidecar(this.cachedFS, descPath);
          }
        }
      }
    }

    const result = Array.from(seen.values()).map(i => i.desc);
    this.backendDescriptorCache = result;
    return result;
  }

  /**
   * Write a single backend descriptor to `.meta/backends/{id}.json`.
   *
   * Uses the canonical serializer and is only written when the bytes actually
   * differ (no needless sync churn). `/.config/backends/` is never written.
   */
  async writeBackendDescriptor(desc: BackendDescriptor): Promise<void> {
    assertValidBackendId(desc.id);
    const author = `${this.appId}/${this.nodeId}`;
    const text = serializeBackendDescriptor(desc);
    const bytes = new TextEncoder().encode(text);
    const path = this.backendFilePath(desc.id);
    if ((await this.readTextIfExists(path)) !== text) {
      await this.ensureDir(path);
      await this.cachedFS.writeFile(path, bytes);
      const version = await incrementVersion(this.fullFS, path, bytes, author);
      await this.writeVersionSidecar(path, version);
    }
    // Keep the synchronous unified-handle cache in sync.
    const existing = this.backendDescriptorCache.findIndex((b) => b.id === desc.id);
    if (existing >= 0) this.backendDescriptorCache[existing] = { ...desc };
    else this.backendDescriptorCache.push({ ...desc });
  }

  /**
   * Remove a single backend descriptor: always `.meta/backends/{id}.json`, plus
   * a best-effort cleanup of the legacy `/.config/backends/{id}.json` residue.
   */
  async removeBackendDescriptor(id: string): Promise<void> {
    for (const path of [this.backendFilePath(id), this.legacyBackendFilePath(id)]) {
      try { await this.cachedFS.unlink(path); } catch { /* already gone */ }
      await this.unlinkVersionSidecar(this.cachedFS, path);
    }
    this.backendDescriptorCache = this.backendDescriptorCache.filter((b) => b.id !== id);
  }

  // -----------------------------------------------------------------------
  // IConfigRepo — Meta file access (no chroot)
  // -----------------------------------------------------------------------

  async getBackends(): Promise<BackendsMeta | null> {
    this.assertNotDisposed();
    const descriptors = await this.readAllBackendDescriptors();
    // Always include the implicit local IndexedDB primary at the front
    const fullList: BackendDescriptor[] = [
      {
        id: LOCAL_IDB_BACKEND_ID,
        type: localPrimaryType(),
        options: { storeName: '' }, // actual storeName / path is internal
        description: `Local ${localPrimaryType()} primary (implicit)`,
      },
      ...descriptors,
    ];
    return { version: 1, backends: fullList };
  }

  async updateBackends(meta: BackendsMeta): Promise<void> {
    this.assertNotDisposed();
    // Filter out the implicit local IndexedDB — it's never stored as a file
    const replicas = meta.backends.filter(b => b.id !== LOCAL_IDB_BACKEND_ID);
    if (replicas.length === 0 && meta.backends.length === 0) {
      return;
    }

    // Ensure backends directory exists
    await this.ensureDir(`${BACKENDS_DIR}/.keep`);

    // Write each backend as an individual file
    for (const desc of replicas) {
      await this.writeBackendDescriptor(desc);
    }

    // Remove any backend files that are no longer in the list.
    // Use deleteFile (tombstone) to prevent sync from re-introducing
    // the deleted descriptor from a remote that still has it.
    const keepIds = new Set(replicas.map(b => b.id));
    const current = await this.readAllBackendDescriptors();
    for (const desc of current) {
      if (!keepIds.has(desc.id)) {
        const descPath = this.backendFilePath(desc.id);
        try {
          await this.deleteFile(descPath);
        } catch {
          await this.removeBackendDescriptor(desc.id);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // IConfigRepo — Dynamic Backend Management
  // -----------------------------------------------------------------------

  async addBackend(id: string, type: string, options: Record<string, unknown>, description?: string): Promise<void> {
    this.assertNotDisposed();

    if (id === LOCAL_IDB_BACKEND_ID) {
      throw new Error(`Cannot add backend with reserved ID "${LOCAL_IDB_BACKEND_ID}"`);
    }

    // Check if already exists — by ID AND by type+options
    const existing = await this.readAllBackendDescriptors();
    if (existing.some(b => b.id === id)) {
      throw new Error(`Backend "${id}" already exists. Use removeBackend() first.`);
    }
    // Check for duplicate configuration (same type + options, different ID)
    const newKey = backendDedupKey({ id, type, options });
    const dup = existing.find(b => backendDedupKey(b) === newKey);
    if (dup) {
      throw new Error(
        `Backend "${id}" has the same configuration as existing backend "${dup.id}" (type=${type}). ` +
        `Use removeBackend("${dup.id}") first, or connect with the existing backend's ID.`,
      );
    }

    // Create backend instance, write descriptor, pair and initial sync.
    await this.setupReplica(id, type, options, description);
  }

  /**
   * Instantiate a config-sync replica, persist its descriptor, create its
   * sync pair, register lifecycle hooks and run the initial sync/watch.
   * Shared by addBackend() and replaceBackend().
   */
  private async setupReplica(
    id: string,
    type: string,
    options: Record<string, unknown>,
    description?: string,
  ): Promise<string> {
    log.log(`[ConfigRepo] addBackend: creating ${id} (${type})...`);
    const instance = await createBackend({ type, options });
    const syncable = backendToSyncableFS(instance, `${type}(${id})`);

    // Save descriptor
    const desc: BackendDescriptor = { id, type, options, description };
    await this.writeBackendDescriptor(desc);

    // Register as replica with tombstone hooks
    const pair = this.syncEngine.addPair(
      this.fullFS,
      syncable,
      {
        direction: SyncDirection.BiDirectional,
        conflictStrategy: 'source-wins' as any,
        // 墓碑未清理前排除被删路径，避免副本残留复活到本地。
        filter: this.syncFilter,
        preSyncHook: async () => {
          try {
            this.invalidateTombstoneCache();
            await this.processTombstones();
          } catch (err) {
            log.warn('[ConfigRepo] preSyncHook processTombstones failed:', err);
          }
        },
        postSyncHook: async () => {
          try {
            this.invalidateTombstoneCache();
            await this.processTombstones();
            await this.updateTombstoneConfirmations();
          } catch (err) {
            log.warn('[ConfigRepo] postSyncHook tombstone processing failed:', err);
          }
        },
      },
      '/',
    );

    this.replicaBackends.set(id, { instance, syncable, pairId: pair.pairId });
    this.backendStates.set(id, { backendId: id, pairId: pair.pairId });

    // Register conflict handler
    const conflictHandler: SyncEventHandler = (event: SyncEvent) => {
      this.handleConflict(event);
    };
    this.syncEngine.on(pair.pairId, 'conflict', conflictHandler);
    this.trackSyncErrors(id, pair.pairId);

    log.log(`[ConfigRepo] addBackend: ${id} (${type}) added, sync pair=${pair.pairId}`);

    // Trigger initial sync FIRST (pulls remote-only files, pushes local files).
    // Then start watching. If we watch before syncing, buildInitialSnapshots()
    // caches a merged snapshot without copying, causing syncAll() to skip.
    await this.syncMetaToReplicas();
    this.syncEngine.watch(pair.pairId);
    return pair.pairId;
  }

  async removeBackend(id: string): Promise<void> {
    this.assertNotDisposed();

    if (id === LOCAL_IDB_BACKEND_ID) {
      throw new Error('Cannot remove the local IndexedDB primary backend');
    }

    const replica = this.replicaBackends.get(id);
    // `.meta/backends/{id}.json` is authoritative; `.config/backends/{id}.json`
    // is a legacy residue that is only cleaned up best-effort (it is no longer
    // read, so a failed cleanup cannot resurrect the backend).
    const descPaths = [this.backendFilePath(id), this.legacyBackendFilePath(id)];

    if (replica) {
      // Backend is actively registered — full cleanup path.
      // 1. Delete the descriptor file on the remote backend DIRECTLY.
      //    This must happen BEFORE removing the sync pair, because once the
      //    sync pair is gone, we can no longer reach the remote through the
      //    normal sync flow. Without this, the remote keeps the file and
      //    another backend's sync pair would pull it back.
      for (const descPath of descPaths) {
        try {
          await replica.instance.unlink(descPath);
        } catch { /* not on remote */ }
        await this.unlinkVersionSidecar(replica.instance, descPath);

        // 2. Create a tombstone + delete the local file.
        //    The tombstone ensures that if another backend syncs to the same
        //    remote, the deleted file won't be re-introduced.
        try {
          await this.deleteFile(descPath);
        } catch {
          // deleteFile might fail in edge cases — fall back to plain unlink
          await this.removeBackendDescriptor(id);
        }
      }

      // 3. Stop watching and remove sync pair
      this.syncEngine.removePair(replica.pairId);
      log.log(`[ConfigRepo] removeBackend: sync pair ${replica.pairId} removed`);

      // 4. Remove from replica map
      this.replicaBackends.delete(id);

      // 5. Dispose backend instance
      if (replica.instance?.dispose) {
        await replica.instance.dispose();
      }
    } else {
      // Backend is NOT in replicaBackends — this happens when:
      //   - The backend failed to initialize (e.g. auth error during setupSync)
      //   - A reconnect created a new ConfigRepo that didn't register this backend
      //   - The backend was disabled (enabled === false) and skipped during setupSync
      // We still need to write a tombstone and clean up the descriptor so the
      // deletion propagates to other replicas via sync.
      log.log(`[ConfigRepo] removeBackend: "${id}" not in replicaBackends, cleaning up descriptor only`);
      for (const descPath of descPaths) {
        try {
          await this.deleteFile(descPath);
        } catch {
          await this.removeBackendDescriptor(id);
        }
      }
    }

    // 6. Trigger sync on remaining pairs to propagate the tombstone.
    //    The tombstone must reach all remaining backends so they don't
    //    re-introduce the deleted descriptor from their snapshots.
    //    schedulePostDeleteSync() (called by deleteFile above) handles this,
    //    but we also trigger it here to ensure it runs even if deleteFile's
    //    timer hasn't fired yet.
    this.backendStates.delete(id);
    this.schedulePostDeleteSync();

    log.log(`[ConfigRepo] removeBackend: ${id} removed (tombstone written, remote cleaned)`);
  }

  /**
   * Replace a config-sync backend's parameters in place (same id).
   *
   * Probe the new parameters first: if the backend cannot even be created
   * (e.g. missing token), nothing is touched and the error is rethrown.
   * Otherwise the old pair is removed, the descriptor rewritten, and a new
   * pair created against the new target with an initial sync. If that fails,
   * the old descriptor and pair are restored. The descriptor file is never
   * tombstoned, so this never delete-then-recreates it.
   */
  async replaceBackend(
    id: string,
    type: string,
    options: Record<string, unknown>,
    description?: string,
  ): Promise<void> {
    this.assertNotDisposed();
    if (id === LOCAL_IDB_BACKEND_ID) {
      throw new Error('Cannot edit the local IndexedDB primary backend');
    }
    const all = await this.readAllBackendDescriptors();
    const before = all.find((b) => b.id === id);
    if (!before) {
      throw new Error(`Backend "${id}" not found`);
    }

    // Fail before touching the live pair when the new options are invalid.
    const probe = await createBackend({ type, options });
    try { await probe.dispose?.(); } catch { /* best effort */ }

    const newKey = backendDedupKey({ id, type, options });
    const dup = all.find((b) => b.id !== id && backendDedupKey(b) === newKey);
    if (dup) {
      throw new Error(
        `新参数与已有后端「${dup.id}」指向同一远端（类型与参数完全相同），` +
        `请先删除重复后端「${dup.id}」或改用不同参数`,
      );
    }

    // Tear down the old pair (descriptor stays; it is overwritten below).
    const oldReplica = this.replicaBackends.get(id);
    if (oldReplica) {
      this.syncEngine.removePair(oldReplica.pairId);
      this.replicaBackends.delete(id);
      try { await oldReplica.instance?.dispose?.(); } catch { /* best effort */ }
    }

    try {
      await this.setupReplica(id, type, options, description ?? before.description);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`[ConfigRepo] replaceBackend: "${id}" failed, rolling back old options:`, err);
      try {
        await this.setupReplica(id, before.type, before.options, before.description);
      } catch (rollbackErr) {
        log.error(`[ConfigRepo] replaceBackend: rollback for "${id}" ALSO failed:`, rollbackErr);
      }
      throw new Error(`更新后端参数失败：${reason}（已尝试回滚旧参数）`);
    }
  }

  // -----------------------------------------------------------------------
  // IConfigRepo — Group Type
  // -----------------------------------------------------------------------

  /** Write the group-type marker file if it doesn't exist. */
  async ensureGroupType(type: SyncGroupType): Promise<void> {
    this.assertNotDisposed();
    for (const path of [GROUP_TYPE_FILE, LEGACY_GROUP_TYPE_FILE]) {
      try {
        const existing = await this.cachedFS.readFile(path, 'utf-8');
        const current = (existing as string).trim();
        if (current && current !== type) {
          log.warn(`[ConfigRepo] group-type already set to "${current}" at ${path}, ignoring request to set "${type}"`);
          return;
        }
      } catch {
        // File doesn't exist — write it below
      }
    }
    const bytes = new TextEncoder().encode(type);
    for (const path of [GROUP_TYPE_FILE, LEGACY_GROUP_TYPE_FILE]) {
      if (await this.safeExists(this.cachedFS, path)) continue;
      await this.ensureDir(path);
      await this.cachedFS.writeFile(path, bytes);
    }
    // Unified group descriptor (`.meta/group.json`) — written once, for both
    // kinds. Renames update it explicitly; launches must not rewrite it (that
    // would produce needless sync churn).
    const existingDescriptor = await readGroupDescriptor(this.cachedFS);
    if (!existingDescriptor) {
      await writeGroupDescriptor(this.cachedFS, {
        schemaVersion: 2,
        kind: 'config',
        id: CONFIG_GROUP_ID,
        ...(this.name ? { name: this.name } : {}),
        features: CONFIG_GROUP_FEATURES,
      });
    } else if (existingDescriptor.schemaVersion !== 2) {
      // One-time upgrade of a legacy descriptor: drop the deprecated
      // `updatedAt` and adopt schemaVersion 2. After this, byte-identical
      // launches never write again.
      const name = existingDescriptor.name ?? this.name;
      await writeGroupDescriptor(this.cachedFS, {
        schemaVersion: 2,
        kind: 'config',
        id: existingDescriptor.id ?? CONFIG_GROUP_ID,
        ...(name ? { name } : {}),
        features: existingDescriptor.features ?? CONFIG_GROUP_FEATURES,
      });
    }
    log.log(`[ConfigRepo] group-type set to "${type}"`);
  }

  /** Read the group-type marker. Returns null if not set (new path, then legacy). */
  async getGroupType(): Promise<SyncGroupType | null> {
    this.assertNotDisposed();
    for (const path of [GROUP_TYPE_FILE, LEGACY_GROUP_TYPE_FILE]) {
      try {
        const raw = await this.cachedFS.readFile(path, 'utf-8');
        const type = (raw as string).trim() as SyncGroupType;
        if (type === 'config-sync' || type === 'data-sync') return type;
      } catch {
        /* try legacy */
      }
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // IConfigRepo — App Data Groups (data-sync groups)
  // -----------------------------------------------------------------------

  /** Path for a single app data group descriptor: .config/app-data-groups/{appId}/{id}.json */
  private appDataGroupFilePath(id: string): string {
    return `${APP_DATA_GROUPS_DIR}/${this.appId}/${id}.json`;
  }

  /** Legacy descriptor path: .meta/app-data-groups/{appId}/{id}.json */
  private legacyAppDataGroupFilePath(id: string): string {
    return `${LEGACY_APP_DATA_GROUPS_DIR}/${this.appId}/${id}.json`;
  }

  /**
   * Write a data-group descriptor to `.config/app-data-groups/` (registration
   * + bootstrap copy). The legacy `.meta/app-data-groups/` mirror is no longer
   * written; it is still read so old layouts keep working.
   *
   * 这份描述符是**引导副本**：它让只有配置组凭据的新设备知道有哪些数据组、
   * 远端在哪。权威定义在数据组自己的 `.meta/backends/`。
   *
   * 幂等：按规范化字节比较，相同则不写；`createdAt` 与磁盘现值取 `min`，
   * 因此时间戳差异不会让两台设备互相覆盖。
   */
  private async writeAppDataGroupDescriptorFile(
    id: string,
    descriptor: AppDataGroupDescriptor,
  ): Promise<void> {
    const existing = await this.readAppDataGroupDescriptor(id);
    const text = serializeAppDataGroupDescriptor(mergeDescriptorCreatedAt(descriptor, existing));
    const bytes = new TextEncoder().encode(text);
    const author = `${this.appId}/${this.nodeId}`;
    const descPath = this.appDataGroupFilePath(id);
    if ((await this.readTextIfExists(descPath)) === text) return;
    await this.ensureDir(descPath);
    await this.cachedFS.writeFile(descPath, bytes);
    const version = await incrementVersion(this.fullFS, descPath, bytes, author);
    await this.writeVersionSidecar(descPath, version);
  }

  /**
   * Resolve a backend descriptor's options by merging account fields
   * from the referenced config-sync backend (if accountBackendId is set).
   */
  private async resolveAppDataBackendOptions(desc: AppDataBackendDescriptor): Promise<Record<string, unknown>> {
    if (!desc.accountBackendId) {
      return desc.options;
    }
    // Find the referenced config-sync backend's options
    const allBackends = await this.readAllBackendDescriptors();
    const accountBackend = allBackends.find(b => b.id === desc.accountBackendId);
    if (!accountBackend) {
      throw new Error(`Account backend "${desc.accountBackendId}" not found for data backend "${desc.id}"`);
    }
    // Merge account fields from the referenced backend into this backend's options
    return mergeAccountFields(desc.type, accountBackend.options, desc.options);
  }

  /**
   * Reject two groups pointing at the exact same remote endpoint. Two groups
   * syncing the same files independently would fight over deletions and
   * tombstones (see SYNC-GROUP-UNIFICATION §4.3).
   */
  private async assertNoSharedRemote(
    backends: AppDataBackendDescriptor[],
    ownerId: string,
  ): Promise<void> {
    const candidates = new Set(backends.map((b) => backendDedupKey(b)));
    if (candidates.size === 0) return;

    for (const backend of await this.readAllBackendDescriptors()) {
      if (candidates.has(backendDedupKey(backend))) {
        throw new Error(
          `数据组「${ownerId}」的后端「${backend.id}」与配置同步组后端指向同一远端` +
          `（类型与参数完全相同），两个组不能共用同一远端目录，请改用不同的 basePath/repo`,
        );
      }
    }

    for (const other of await this.listAppDataGroups()) {
      if (other.id === ownerId) continue;
      for (const backend of other.backends) {
        if (candidates.has(backendDedupKey(backend))) {
          throw new Error(
            `数据组「${ownerId}」的后端「${backend.id}」与数据组「${other.id}」的后端` +
            `「${backend.id}」指向同一远端（类型与参数完全相同），请为其中一个组更换 basePath`,
          );
        }
      }
    }
  }

  async createAppDataGroup(
    id: string,
    backends: AppDataBackendDescriptor[],
    options: { name?: string; features?: Partial<SyncGroupFeatures> } = {},
  ): Promise<AppDataGroup> {
    this.assertNotDisposed();

    if (this.appDataGroups.has(id)) {
      throw new Error(`App data group "${id}" already exists. Use removeAppDataGroup() first.`);
    }

    log.log(`[ConfigRepo] createAppDataGroup: creating "${id}" with ${backends.length} backend(s)`);

    // Resolve account fields for each backend
    const resolvedBackends: AppDataBackendDescriptor[] = [];
    for (const desc of backends) {
      assertValidBackendId(desc.id);
      const mergedOptions = await this.resolveAppDataBackendOptions(desc);
      resolvedBackends.push({ ...desc, options: mergedOptions });
    }

    // Cross-group uniqueness: no two groups may share the same remote endpoint.
    await this.assertNoSharedRemote(resolvedBackends, id);

    // Create the data-sync group implementation
    const group = new AppDataGroupImpl(
      id,
      this.appId,
      resolvedBackends,
      this.pollIntervalMs,
      this,
      // 显式新拓扑：以参数为准并写入 `.meta/backends/`。
      { name: options.name, features: options.features, backendsAreAuthoritative: true },
    );
    await group.init();

    // Save the **bootstrap copy** to `.config/app-data-groups/{appId}/{id}.json`
    // (+ legacy `.meta/` mirror). The data group's own `.meta/backends/` stays
    // authoritative; this file lets a new device discover the group.
    const descriptor: AppDataGroupDescriptor = {
      id,
      groupType: 'data-sync',
      ...(options.name ? { name: options.name } : {}),
      ...(options.features ? { features: options.features } : {}),
      backends: group.listDeclaredBackends(),
    };
    await this.writeAppDataGroupDescriptorFile(id, descriptor);

    this.appDataGroups.set(id, group);
    log.log(`[ConfigRepo] createAppDataGroup: "${id}" created`);

    return group;
  }

  /**
   * Rewrite an app data group's **bootstrap copy** at
   * `.config/app-data-groups/{appId}/{id}.json` (plus the legacy `.meta/`
   * mirror). The authoritative backend list lives in the data group's own
   * `.meta/backends/`; this file only lets a new device that has nothing but
   * the config group's credentials discover the data groups and their remotes.
   *
   * 幂等：投影字节相同则不写（见 `writeAppDataGroupDescriptorFile`）。
   */
  async updateAppDataGroupDescriptor(
    id: string,
    backends: AppDataBackendDescriptor[],
    meta?: { name?: string; features?: Partial<SyncGroupFeatures> },
  ): Promise<void> {
    this.assertNotDisposed();
    // 保留显示名与能力位：增删后端不能把它们抹掉。
    const existing = await this.readAppDataGroupDescriptor(id);
    const name = meta?.name ?? existing?.name;
    const features = meta?.features ?? existing?.features;
    const descriptor: AppDataGroupDescriptor = {
      id,
      groupType: 'data-sync',
      ...(name ? { name } : {}),
      ...(features ? { features } : {}),
      backends,
    };
    await this.writeAppDataGroupDescriptorFile(id, descriptor);
  }

  /**
   * Change a data-sync group's display name only. `id`, backends, local stores
   * and remote data are untouched, so existing sync pairs keep working.
   */
  async updateAppDataGroupName(id: string, name: string): Promise<void> {
    this.assertNotDisposed();
    const normalized = normalizeGroupName(name);
    const existing = await this.readAppDataGroupDescriptor(id);
    if (!existing) {
      throw new Error(`App data group "${id}" not found`);
    }
    // 数据组自己的 `.meta/group.json` 是权威名；先写它，再回刷引导副本。
    const live = this.appDataGroups.get(id);
    if (live) {
      live.name = normalized;
      try {
        await live.writeOwnGroupDescriptor();
      } catch (err) {
        log.warn(`[ConfigRepo] updateAppDataGroupName: "${id}" group.json update failed:`, err);
      }
    }
    const descriptor: AppDataGroupDescriptor = {
      ...existing,
      id,
      groupType: 'data-sync',
      name: normalized,
    };
    await this.writeAppDataGroupDescriptorFile(id, descriptor);
  }

  /**
   * Replace a data-sync backend's parameters in place (same backend id).
   *
   * Changing parameters means switching to a different remote target: the live
   * group is disposed (old pairs torn down), the descriptor is rewritten, and a
   * fresh group instance creates pairs + performs the initial sync. Old remote
   * data is NOT migrated. If the new options cannot be instantiated, nothing is
   * touched; if re-initialisation fails, the old descriptor is restored.
   */
  async replaceAppDataGroupBackend(
    groupId: string,
    backendId: string,
    type: string,
    options: Record<string, unknown>,
    description?: string,
  ): Promise<AppDataGroup> {
    this.assertNotDisposed();
    assertValidBackendId(backendId);
    const descriptor = await this.readAppDataGroupDescriptor(groupId);
    if (!descriptor) {
      throw new Error(`App data group "${groupId}" not found`);
    }
    // 权威列表优先取数据组自己的声明（描述符只是引导副本，可能落后）。
    const live = this.appDataGroups.get(groupId);
    const declared = live?.listDeclaredBackends() ?? descriptor.backends;
    const index = declared.findIndex((b) => b.id === backendId);
    if (index < 0) {
      throw new Error(`Backend "${backendId}" not found in data group "${groupId}"`);
    }

    // Validate the new parameters before disposing the existing pair. The
    // group's own init also resolves account fields, so do that first.
    const candidate = { ...declared[index], type, options, description: description ?? declared[index].description };
    const mergedOptions = await this.resolveAppDataBackendOptions(candidate);
    const probe = await createBackend({ type, options: mergedOptions });
    try { await probe.dispose?.(); } catch { /* best effort */ }

    const oldBackends = declared.map((b) => ({ ...b }));
    const nextBackends = declared.map((b, i) =>
      i === index ? { ...candidate, options: mergedOptions } : b,
    );

    if (live) {
      await live.dispose();
      this.appDataGroups.delete(groupId);
    }

    try {
      // 先让数据组写自己的权威定义（`.meta/backends/`），再回刷引导副本。
      const group = new AppDataGroupImpl(
        groupId,
        this.appId,
        nextBackends,
        this.pollIntervalMs,
        this,
        { backendsAreAuthoritative: true },
      );
      await group.init();
      await this.updateAppDataGroupDescriptor(groupId, group.listDeclaredBackends());
      this.appDataGroups.set(groupId, group);
      return group;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`[ConfigRepo] replaceAppDataGroupBackend: "${backendId}" failed, rolling back:`, err);
      try {
        const restored = new AppDataGroupImpl(
          groupId,
          this.appId,
          oldBackends,
          this.pollIntervalMs,
          this,
          { backendsAreAuthoritative: true },
        );
        await restored.init();
        await this.updateAppDataGroupDescriptor(groupId, restored.listDeclaredBackends());
        this.appDataGroups.set(groupId, restored);
      } catch (rollbackErr) {
        log.error('[ConfigRepo] replaceAppDataGroupBackend: rollback ALSO failed:', rollbackErr);
      }
      throw new Error(`更新后端参数失败：${reason}（已尝试回滚旧参数）`);
    }
  }

  async getConfigSyncGroupDescriptor(): Promise<ConfigSyncGroupDescriptor | null> {
    this.assertNotDisposed();
    for (const path of [CONFIG_SYNC_GROUP_FILE, LEGACY_CONFIG_SYNC_GROUP_FILE]) {
      try {
        const raw = await this.cachedFS.readFile(path);
        const parsed = JSON.parse(new TextDecoder().decode(toUint8Array(raw)));
        if (parsed && parsed.groupType === 'config-sync') {
          return parsed as ConfigSyncGroupDescriptor;
        }
      } catch { /* absent — treated as default */ }
    }
    return null;
  }

  /**
   * Change the config-sync group's display name only. Backends, the local
   * store and remote data are untouched.
   */
  async updateConfigSyncGroupDescriptor(patch: { name: string }): Promise<ConfigSyncGroupDescriptor> {
    this.assertNotDisposed();
    const normalized = normalizeGroupName(patch?.name);
    const descriptor: ConfigSyncGroupDescriptor = {
      groupType: 'config-sync',
      name: normalized,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(descriptor, null, 2));
    const author = `${this.appId}/${this.nodeId}`;
    for (const path of [CONFIG_SYNC_GROUP_FILE, LEGACY_CONFIG_SYNC_GROUP_FILE]) {
      await this.ensureDir(path);
      await this.cachedFS.writeFile(path, bytes);
      const version = await incrementVersion(this.fullFS, path, bytes, author);
      await this.writeVersionSidecar(path, version);
    }
    // Keep `.meta/group.json` in sync with the display name.
    await writeGroupDescriptor(this.cachedFS, {
      schemaVersion: 2,
      kind: 'config',
      id: CONFIG_GROUP_ID,
      name: normalized,
      features: CONFIG_GROUP_FEATURES,
    });
    return descriptor;
  }

  private async readAppDataGroupDescriptor(id: string): Promise<AppDataGroupDescriptor | null> {
    for (const descPath of [this.appDataGroupFilePath(id), this.legacyAppDataGroupFilePath(id)]) {
      try {
        const raw = await this.cachedFS.readFile(descPath);
        const parsed = JSON.parse(new TextDecoder().decode(toUint8Array(raw)));
        if (parsed && parsed.id === id && parsed.groupType === 'data-sync') {
          return parsed as AppDataGroupDescriptor;
        }
      } catch { /* try next layout */ }
    }
    return null;
  }

  async getAppDataGroup(id: string): Promise<AppDataGroup> {
    this.assertNotDisposed();

    // Return cached instance if available
    const cached = this.appDataGroups.get(id);
    if (cached) return cached;

    // Load from descriptor (new layout first, then legacy)
    const descriptor = await this.readAppDataGroupDescriptor(id);
    if (!descriptor) {
      throw new Error(`App data group "${id}" not found`);
    }
    const group = new AppDataGroupImpl(
      id,
      this.appId,
      descriptor.backends,
      this.pollIntervalMs,
      this,
      descriptor,
    );
    await group.init();
    this.appDataGroups.set(id, group);
    return group;
  }

  async listAppDataGroups(): Promise<AppDataGroupDescriptor[]> {
    this.assertNotDisposed();
    const byId = new Map<string, AppDataGroupDescriptor>();
    for (const dir of [
      `${APP_DATA_GROUPS_DIR}/${this.appId}`,
      `${LEGACY_APP_DATA_GROUPS_DIR}/${this.appId}`,
    ]) {
      let entries: string[];
      try {
        entries = await this.cachedFS.readdir(dir);
      } catch {
        continue; // this layout has no descriptors yet
      }
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          const raw = await this.cachedFS.readFile(`${dir}/${entry}`);
          const desc = JSON.parse(new TextDecoder().decode(toUint8Array(raw)));
          if (desc.id && desc.groupType === 'data-sync' && !byId.has(desc.id)) {
            byId.set(desc.id, desc as AppDataGroupDescriptor);
          }
        } catch { /* skip corrupt */ }
      }
    }
    return Array.from(byId.values());
  }

  async removeAppDataGroup(id: string): Promise<void> {
    this.assertNotDisposed();

    const group = this.appDataGroups.get(id);
    if (group) {
      await group.dispose();
      this.appDataGroups.delete(id);
    }

    // Use deleteFile (tombstone) so the deletion propagates to remote
    // replicas (e.g. the config-sync repo on Gitee) and is NOT resurrected
    // by sync pulling the still-existing remote descriptor back.
    for (const descPath of [this.appDataGroupFilePath(id), this.legacyAppDataGroupFilePath(id)]) {
      try {
        await this.deleteFile(descPath);
      } catch (err) {
        log.log(`[ConfigRepo] removeAppDataGroup: deleteFile failed for "${id}" at ${descPath}:`, err);
        try { await this.cachedFS.unlink(descPath); } catch { /* already gone */ }
        await this.unlinkVersionSidecar(this.cachedFS, descPath);
      }
    }
    log.log(`[ConfigRepo] removeAppDataGroup: "${id}" removed`);
  }

  async listAccountBackends(): Promise<BackendDescriptor[]> {
    this.assertNotDisposed();
    const allBackends = await this.readAllBackendDescriptors();
    // Only return backends whose type has accountFields declared
    return allBackends.filter(b => getAccountFields(b.type).length > 0);
  }

  private tryParse(content: string): unknown {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('ConfigRepo has been disposed');
    }
  }
}

// ---------------------------------------------------------------------------
// AppDataGroupImpl — data-sync group implementation
// ---------------------------------------------------------------------------

/**
 * A data-sync group that provides direct file system access for app data.
 *
 * Uses a separate IndexedDB store (or InMemory in Node.js) as local primary,
 * with bi-directional sync to each registered data backend.
 */
class AppDataGroupImpl implements AppDataGroup {
  readonly groupId: string;
  readonly appId: string;
  readonly kind = 'data' as const;
  readonly features: SyncGroupFeatures;
  name?: string;
  fs: any;

  private syncEngine: ZenFSSync;
  private localFS: BackendInstance;
  private dataBackends: Map<string, { instance: any; syncable: SyncableFS; pairId: string; desc: AppDataBackendDescriptor }> = new Map();
  private backendStates: Map<string, BackendSyncState> = new Map();
  private disposed = false;

  /** `.meta/` stores shared with the config-sync group. */
  private tombstones!: TombstoneStore;
  private versions!: VersionStore;
  private conflicts!: ConflictStore;
  private postDeleteTimer?: ReturnType<typeof setTimeout>;

  constructor(
    groupId: string,
    appId: string,
    backends: AppDataBackendDescriptor[],
    pollIntervalMs: number | undefined,
    parent: ConfigRepo,
    descriptor: Pick<AppDataGroupDescriptor, 'name' | 'features'> & {
      /**
       * `createAppDataGroup` / `replaceAppDataGroupBackend` 传入的是**显式新拓扑**
       * （例如同一个 groupId 被删除后用不同后端重建），此时以构造参数为准并
       * 覆盖 `.meta/backends/`；普通 `getAppDataGroup` 读取时以磁盘为准。
       */
      backendsAreAuthoritative?: boolean;
    } = {},
  ) {
    this.groupId = groupId;
    this.appId = appId;
    this.name = descriptor.name;
    this.features = {
      ...DATA_GROUP_DEFAULT_FEATURES,
      ...descriptor.features,
      // Tombstones are the deletion-correctness primitive: always on.
      tombstones: true,
    };
    this.parent = parent;
    this.syncEngine = new ZenFSSync();
    this.localFS = null as any;
    this.fs = null as any;
    this._backends = backends;
    this._pollIntervalMs = pollIntervalMs;
    this._backendsAreAuthoritative = descriptor.backendsAreAuthoritative === true;
    this._declaredFeatures = descriptor.features;
  }

  private parent: ConfigRepo;
  private _backends: AppDataBackendDescriptor[];
  private _pollIntervalMs?: number;
  private _backendsAreAuthoritative: boolean;
  /** 引导副本（`.config/` 里的描述符）原有的能力位，用于回刷时不丢信息。 */
  private _declaredFeatures?: Partial<SyncGroupFeatures>;

  /** Local "backend" id used in tombstone bookkeeping. */
  private get localBackendId(): string {
    return `local:${this.groupId}`;
  }

  /** All backend ids that must confirm a tombstone before GC. */
  private allBackendIds(): string[] {
    return [this.localBackendId, ...this.dataBackends.keys()];
  }

  private tombstoneTargets(): { id: string; fs: any }[] {
    return [
      { id: this.localBackendId, fs: this.localFS },
      ...Array.from(this.dataBackends.entries()).map(([id, b]) => ({ id, fs: b.instance })),
    ];
  }

  // -------------------------------------------------------------------------
  // Data-group self-description (`.meta/backends/{id}.json`)
  // -------------------------------------------------------------------------

  /**
   * 数据组自己的后端定义是**权威**：`.meta/backends/{id}.json` 随数据组同步，
   * 因此任何设备连上任意一个数据后端都能读到完整拓扑。
   *
   * 引导副本（配置组 `.config/app-data-groups/...` 里的 `backends`）只在
   * 「本地还没有 `.meta/backends/`」时用于首次回填（懒迁移）。
   */
  private async loadBackendDescriptors(): Promise<boolean> {
    if (this._backendsAreAuthoritative) {
      // create / replace：显式新拓扑，直接覆盖磁盘副本。
      await this.persistBackendDescriptors(this._backends);
      return false;
    }

    const stored = await readBackendMetaDescriptors(this.localFS);
    if (stored === null) {
      // 旧版本只把后端写在配置组描述符里 → 首次启动回填，之后以数据组为准。
      await this.persistBackendDescriptors(this._backends);
      return false;
    }

    // 墓碑优先：墓碑存在即视为已删除，即使描述符文件被对端「复活」也不采纳。
    const tombstoned = await this.tombstonedBackendIds();
    const kept: AppDataBackendDescriptor[] = [];
    let pruned = false;
    for (const desc of stored) {
      if (tombstoned.has(desc.id)) {
        await removeBackendMetaDescriptor(this.localFS, desc.id);
        pruned = true;
        continue;
      }
      kept.push(desc);
    }
    this._backends = kept;
    return pruned;
  }

  /** Backend ids that currently have a tombstone for `.meta/backends/{id}.json`. */
  private async tombstonedBackendIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
      for (const tombstone of await this.tombstones.list()) {
        if (!tombstone.path.startsWith(`${META_BACKENDS_DIR}/`)) continue;
        const file = tombstone.path.slice(META_BACKENDS_DIR.length + 1);
        if (file.endsWith('.json')) ids.add(file.slice(0, -'.json'.length));
      }
    } catch {
      /* best effort: tombstone listing failures must not block startup */
    }
    return ids;
  }

  /**
   * 把权威列表写回 `.meta/backends/`：只写有差异的条目；不在列表里的旧条目
   * 写墓碑后 `unlink`（墓碑保证对端不会把已删除的后端复活）。
   *
   * 写入前清除同路径的旧墓碑 —— `addBackend` 是显式的「重新添加」。
   */
  private async persistBackendDescriptors(descs: AppDataBackendDescriptor[]): Promise<void> {
    const keep = new Set(descs.map((d) => d.id));
    let tombstones: TombstoneMeta[] | null = null;
    try {
      tombstones = await this.tombstones.list();
    } catch {
      tombstones = null;
    }

    for (const desc of descs) {
      const path = backendMetaFilePath(desc.id);
      const stale = tombstones?.find((t) => t.path === path);
      if (stale) {
        await this.tombstones.remove(stale);
        tombstones = tombstones!.filter((t) => t !== stale);
      }
      await writeBackendMetaDescriptor(this.localFS, desc);
    }

    for (const old of (await readBackendMetaDescriptors(this.localFS)) ?? []) {
      if (keep.has(old.id)) continue;
      await this.writeTombstoneFor(backendMetaFilePath(old.id));
      await removeBackendMetaDescriptor(this.localFS, old.id);
    }
  }

  /** Write this group's own `.meta/group.json` (idempotent: identical bytes → no write). */
  async writeOwnGroupDescriptor(): Promise<void> {
    await writeGroupDescriptor(this.localFS, {
      schemaVersion: 2,
      kind: 'data',
      id: this.groupId,
      ...(this.name ? { name: this.name } : {}),
      features: this.features,
    });
  }

  async init(): Promise<void> {
    // Create local primary backend (Folder on Node, IndexedDB on browser).
    //
    // Each data group gets its own store: the legacy/default group keeps
    // `data/{appId}` (and `zen-fs-config-data-{appId}`) untouched, while every
    // other group is isolated by groupId — Node: `data/{appId}/{groupId}`,
    // browser: `zen-fs-config-data-{appId}-{groupId}`. Lazy migration: no copy,
    // no move, no deletion.
    try {
      const localPrimary = await resolveLocalPrimary(this.appId, 'data', {
        groupId: this.groupId,
        ...(this.groupId === 'default'
          ? {}
          : { idbStoreName: `zen-fs-config-data-${this.appId}-${this.groupId}` }),
      });
      this.localFS = await createBackend(localPrimary);
    } catch {
      throw new Error(`Failed to create local primary for data group "${this.groupId}"`);
    }

    // Purge leaked .mtime sidecars from this group's local store (they are
    // skipped by sync, so they would otherwise stay there forever).
    try {
      const purged = await purgeMtimeSidecars(this.localFS);
      if (purged.removed.length > 0) {
        log.warn(
          `[AppDataGroup:${this.groupId}] purged ${purged.removed.length} leaked .mtime sidecar(s):`,
          purged.removed,
        );
      }
    } catch (err: any) {
      log.warn(`[AppDataGroup:${this.groupId}] .mtime purge failed:`, err?.message ?? err);
    }

    // Purge leaked `.keep` placeholders from this group's local store too.
    try {
      const purgedKeep = await purgeKeepFiles(this.localFS);
      if (purgedKeep.removed.length > 0) {
        log.warn(
          `[AppDataGroup:${this.groupId}] purged ${purgedKeep.removed.length} leaked .keep placeholder(s):`,
          purgedKeep.removed,
        );
      }
    } catch (err: any) {
      log.warn(`[AppDataGroup:${this.groupId}] .keep purge failed:`, err?.message ?? err);
    }

    const localSyncable = backendToSyncableFS(this.localFS, `local(${this.groupId})`);

    // Unified `.meta/` metadata area (tombstones / versions / conflicts).
    // `/.config/` stays hidden: a data group never owns config payload.
    this.tombstones = new TombstoneStore(this.localFS, this.localBackendId);
    this.versions = new VersionStore(this.localFS, `${this.appId}/${this.groupId}`);
    this.conflicts = new ConflictStore(this.localFS, this.appId, `${this.groupId}`, this.versions);

    // `.meta/backends/` 是数据组的**权威后端定义**：优先读自身副本；目录缺失
    // （旧版本从未写过）时用配置组的引导描述符回填一次，之后一律以数据组为准。
    let backendsChanged = false;
    try {
      backendsChanged = await this.loadBackendDescriptors();
    } catch (err) {
      log.warn(`[AppDataGroup:${this.groupId}] failed to load .meta/backends:`, err);
      this._backends = this._backends ?? [];
    }

    // Unified group descriptor (`.meta/group.json`) — byte-identical launches
    // never rewrite it (no `updatedAt`, no timestamps in synced content).
    try {
      await this.writeOwnGroupDescriptor();
    } catch (err) {
      log.warn(`[AppDataGroup:${this.groupId}] failed to write .meta/group.json:`, err);
    }

    // The app-facing view hides metadata (hiding ≠ not syncing): `.meta/` is
    // synced so tombstones/versions/conflicts reach other devices, but the app
    // must not read or write it directly. Writes record versions when enabled;
    // unlink goes through the tombstone-aware deleteFile.
    this.fs = createChrootFS(this.localFS, '/', {
      hiddenPrefixes: [META_DIR, CONFIG_DIR],
      onWrite: (path, data) => this.recordVersion(path, data),
      onUnlink: (path) => this.deleteFile(path),
      onRmdir: (path) => this.deleteFile(path),
    });

    // Deduplicate backends pointing to the same endpoint — keep the oldest.
    // Fixes the case where a data-sync backend is registered twice (e.g. as a
    // fixed `*-primary` id AND a dynamically generated `remotestorage-<ts>` id),
    // which otherwise creates two sync pairs to the same remote and causes
    // redundant/looping PUTs.
    const { kept, removed } = dedupeAppDataBackends(this._backends);
    if (removed.length > 0) {
      log.warn(
        `[AppDataGroup:${this.groupId}] dedupe: removing ${removed.length} duplicate backend(s) ` +
        `(${removed.map(b => b.id).join(', ')}) — keeping ${kept.map(b => b.id).join(', ')}`,
      );
      this._backends = kept;
      backendsChanged = true;
    }

    // 权威列表变化（去重 / 墓碑裁剪）→ 先落数据组，再回刷引导副本。
    if (backendsChanged) {
      try {
        await this.persistBackendDescriptors(this._backends);
        await this.parent.updateAppDataGroupDescriptor(this.groupId, this._backends, {
          name: this.name,
          features: this._declaredFeatures,
        });
      } catch (err) {
        log.warn(`[AppDataGroup:${this.groupId}] failed to persist backend topology:`, err);
      }
    }

    // Setup sync with each data backend
    for (const desc of this._backends) {
      try {
        const instance = await createBackend({ type: desc.type, options: desc.options });
        const syncable = backendToSyncableFS(instance, `${desc.type}(${desc.id})`);
        const pair = this.syncEngine.addPair(
          localSyncable,
          syncable,
          {
            direction: SyncDirection.BiDirectional,
            conflictStrategy: 'source-wins' as any,
            pollIntervalMs: this._pollIntervalMs,
            // `.meta/` is intentionally NOT excluded: tombstones, versions and
            // conflicts must sync, otherwise deletions resurrect on other devices.
            filter: { excludePrefixes: CONFIG_ONLY_PREFIXES },
            preSyncHook: async () => {
              await this.runTombstonePass('preSync');
            },
            postSyncHook: async () => {
              await this.runTombstonePass('postSync');
              await this.confirmTombstones();
            },
          },
          '/',
        );
        this.dataBackends.set(desc.id, { instance, syncable, pairId: pair.pairId, desc });
        this.backendStates.set(desc.id, { backendId: desc.id, pairId: pair.pairId });

        // Conflict archives land in `.meta/conflicts/` (syncable diagnostics).
        if (this.features.conflicts) {
          const conflictHandler: SyncEventHandler = (event) => {
            this.archiveConflict(event).catch((err) => {
              log.warn(`[AppDataGroup:${this.groupId}] conflict archive failed:`, err);
            });
          };
          this.syncEngine.on(pair.pairId, 'conflict', conflictHandler);
        }
        this.trackSyncErrors(desc.id, pair.pairId);
        // NOTE: Don't watch yet — sync first, then watch (same pattern as ConfigRepo)
        log.log(`[AppDataGroup:${this.groupId}] backend ${desc.id} (${desc.type}) connected, pair=${pair.pairId}`);
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        // Keep the descriptor (it is still in _backends), but record that no
        // pair exists for it so callers can surface it instead of silently
        // showing fewer pairs than backends.
        this.backendStates.set(desc.id, {
          backendId: desc.id,
          error: { message, timestamp: Date.now() },
        });
        log.error(`[AppDataGroup:${this.groupId}] Failed to create backend ${desc.id} (${desc.type}):`, err);
      }
    }

    // Initial sync — pull data from remote backends (before watching)
    try {
      await this.syncEngine.syncAll();
    } catch (err) {
      log.warn(`[AppDataGroup:${this.groupId}] Initial sync failed:`, err);
    }

    // Now start watching — snapshots will reflect the synced state
    this.syncEngine.watchAll();
  }

  getSyncStatuses(): Map<string, SyncPairStatus> {
    return this.syncEngine.getStatusAll();
  }

  async flush(): Promise<SyncResult[]> {
    // Delete tombstoned files everywhere BEFORE syncing, so a remote copy
    // cannot be seen as "newer" and win.
    await this.runTombstonePass('flush-pre');
    const results = await this.syncEngine.syncAll();
    await this.runTombstonePass('flush-post');
    await this.confirmTombstones();
    try {
      await this.tombstones.gc(this.allBackendIds(), this.tombstoneTargets());
    } catch (err) {
      log.warn(`[AppDataGroup:${this.groupId}] tombstone GC failed:`, err);
    }
    return Array.from(results.values());
  }

  getBackendSyncStates(): Map<string, BackendSyncState> {
    return new Map(this.backendStates);
  }

  /** Mirror per-pair `sync:error` into `getBackendSyncStates()` (see ConfigRepo). */
  private trackSyncErrors(backendId: string, pairId: string): void {
    this.syncEngine.on(pairId, 'sync:error', (event) => {
      const error = event.error;
      this.backendStates.set(backendId, {
        backendId,
        pairId,
        error: {
          message: error instanceof Error ? error.message : String(error ?? 'sync failed'),
          timestamp: Date.now(),
        },
      });
    });
    this.syncEngine.on(pairId, 'sync:end', () => {
      const current = this.backendStates.get(backendId);
      if (current?.error) this.backendStates.set(backendId, { backendId, pairId });
    });
  }

  // -----------------------------------------------------------------------
  // Unified SyncGroupHandle — deletion & metadata (data groups)
  // -----------------------------------------------------------------------

  /** Record a version entry when `features.versions` is on. */
  private async recordVersion(path: string, data: any): Promise<void> {
    if (!this.features.versions) return;
    try {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : toUint8Array(data);
      await this.versions.record(path, bytes);
    } catch (err) {
      log.warn(`[AppDataGroup:${this.groupId}] version record failed for ${path}:`, err);
    }
  }

  /** Delete tombstoned files on local + every connected backend before/after sync. */
  private async runTombstonePass(stage: string): Promise<void> {
    try {
      await this.tombstones.process(this.tombstoneTargets());
    } catch (err) {
      log.warn(`[AppDataGroup:${this.groupId}] ${stage} tombstone pass failed:`, err);
    }
  }

  private async confirmTombstones(): Promise<void> {
    try {
      await this.tombstones.confirm(this.allBackendIds());
    } catch (err) {
      log.warn(`[AppDataGroup:${this.groupId}] tombstone confirmations failed:`, err);
    }
  }

  /** Write a tombstone for `filePath`. Records metadata only — it never creates the file. */
  private async writeTombstoneFor(filePath: string): Promise<void> {
    await this.tombstones.write({
      path: filePath.startsWith('/') ? filePath : `/${filePath}`,
      deletedAt: Date.now(),
      deletedBy: this.localBackendId,
      confirmedBy: [this.localBackendId],
    });
  }

  /**
   * Delete a data file with a tombstone in `.meta/tombstones/`.
   * The tombstone is synced (`.meta/` is no longer excluded), so the deletion
   * survives restarts and reaches other devices instead of being resurrected.
   */
  async deleteFile(path: string): Promise<void> {
    if (this.disposed) throw new Error('DataSyncGroup has been disposed');
    const normalized = path.startsWith('/') ? path : `/${path}`;
    if (
      normalized === META_DIR ||
      normalized === CONFIG_DIR ||
      normalized.startsWith(`${META_DIR}/`) ||
      normalized.startsWith(`${CONFIG_DIR}/`)
    ) {
      throw new Error(`Cannot delete metadata path "${normalized}"`);
    }

    // Directory: tombstone every contained file, then drop the empty tree.
    if (await isDirectoryPath(this.localFS, normalized)) {
      const files = await collectFilesUnder(this.localFS, normalized);
      for (const file of files) await this.deleteFile(file);
      // Hidden `.keep` placeholders keep otherwise-empty directories alive on
      // Git/RemoteStorage but never reach the local primary; tombstone them
      // explicitly so a directory whose remote copy only has `.keep` cannot
      // reappear on the next pull. The placeholder's `<dir>/.keep.mtime`
      // sidecar is a real blob too — on its own it keeps the directory alive.
      for (const dir of await collectDirectoriesUnder(this.localFS, normalized)) {
        const keepPath = dir === '/' ? '/.keep' : `${dir}/.keep`;
        await this.writeTombstoneFor(keepPath);
        await this.writeTombstoneFor(`${keepPath}.mtime`);
      }
      await removeDirectoryTree(this.localFS, normalized);
      this.schedulePostDeleteSync();
      log.log(`[AppDataGroup:${this.groupId}] deleteFile(directory): ${normalized} (${files.length} file(s))`);
      return;
    }

    await this.writeTombstoneFor(normalized);

    try {
      await this.localFS.unlink(normalized);
    } catch {
      // Already gone — the tombstone is still valid.
    }

    const versionPath = this.versions.pathFor(normalized);
    if (versionPath) {
      try {
        await this.localFS.unlink(versionPath);
      } catch {
        // No version record — fine.
      }
    }

    // Drop the backend-internal mtime sidecar on the local store as well (older
    // builds leaked `<file>.mtime` into it). Remote backends remove it inside
    // their own remove() path; a leftover sidecar would outlive its data file.
    if (!isMtimeSidecar(normalized)) {
      try {
        await this.localFS.unlink(`${normalized}.mtime`);
      } catch {
        // No sidecar — fine.
      }
    }

    this.schedulePostDeleteSync();
  }

  private schedulePostDeleteSync(): void {
    if (this.postDeleteTimer) return;
    this.postDeleteTimer = setTimeout(() => {
      this.postDeleteTimer = undefined;
      void this.runTombstonePass('postDelete');
    }, 300);
  }

  async listConflicts(): Promise<ConflictArchive[]> {
    return this.conflicts.list();
  }

  async resolveConflict(conflictId: string, mergedContent: unknown): Promise<void> {
    const content = typeof mergedContent === 'string'
      ? mergedContent
      : JSON.stringify(mergedContent, null, 2);
    await this.conflicts.resolve(conflictId, content);
    try {
      await this.syncEngine.syncAll();
    } catch (err) {
      log.warn(`[AppDataGroup:${this.groupId}] sync after conflict resolve failed:`, err);
    }
  }

  readConflictBackup(conflictId: string, fileType: 'source' | 'target' | 'resolved'): Promise<string> {
    return this.conflicts.readBackup(conflictId, fileType);
  }

  purgeMtimeSidecars(options: { root?: string; dryRun?: boolean } = {}): Promise<MtimePurgeResult> {
    return purgeMtimeSidecars(this.localFS, options as PurgeMtimeOptions);
  }

  purgeKeepFiles(options: { root?: string; dryRun?: boolean } = {}): Promise<KeepPurgeResult> {
    return purgeKeepFiles(this.localFS, options as PurgeKeepOptions);
  }

  async rename(name: string): Promise<void> {
    await this.parent.updateAppDataGroupName(this.groupId, name);
    this.name = name.trim();
  }

  private async archiveConflict(event: SyncEvent): Promise<void> {
    const conflict = event.conflict;
    if (!conflict) return;
    await this.conflicts.archive(
      {
        path: conflict.path,
        sourceContent: conflict.sourceContent,
        targetContent: conflict.targetContent,
        ...(conflict.resolvedWith ? { resolvedWith: conflict.resolvedWith } : {}),
      },
      event.timestamp,
    );
  }

  async addBackend(
    id: string,
    type: string,
    options: Record<string, unknown>,
    description?: string,
  ): Promise<void> {
    if (this.disposed) throw new Error('DataSyncGroup has been disposed');
    assertValidBackendId(id);
    if (this.dataBackends.has(id)) {
      throw new Error(`Backend "${id}" already exists in data group "${this.groupId}"`);
    }

    log.log(`[AppDataGroup:${this.groupId}] addBackend: creating ${id} (${type})...`);
    const instance = await createBackend({ type, options });
    const syncable = backendToSyncableFS(instance, `${type}(${id})`);

    const localSyncable = backendToSyncableFS(this.localFS, `local(${this.groupId})`);
    const pair = this.syncEngine.addPair(
      localSyncable,
      syncable,
      {
        direction: SyncDirection.BiDirectional,
        conflictStrategy: 'source-wins' as any,
        pollIntervalMs: this._pollIntervalMs,
        filter: { excludePrefixes: CONFIG_ONLY_PREFIXES },
        preSyncHook: async () => {
          await this.runTombstonePass('preSync');
        },
        postSyncHook: async () => {
          await this.runTombstonePass('postSync');
          await this.confirmTombstones();
        },
      },
      '/',
    );

    const desc: AppDataBackendDescriptor = { id, type, options, description, createdAt: Date.now() };
    this.dataBackends.set(id, { instance, syncable, pairId: pair.pairId, desc });
    this.backendStates.set(id, { backendId: id, pairId: pair.pairId });
    if (this.features.conflicts) {
      this.syncEngine.on(pair.pairId, 'conflict', (event) => {
        this.archiveConflict(event).catch((err) => {
          log.warn(`[AppDataGroup:${this.groupId}] conflict archive failed:`, err);
        });
      });
    }
    this.trackSyncErrors(id, pair.pairId);
    this._backends = [...this._backends.filter(b => b.id !== id), desc];
    log.log(`[AppDataGroup:${this.groupId}] addBackend: ${id} (${type}) connected, pair=${pair.pairId}`);

    // 先写数据组自己的权威定义（`.meta/backends/{id}.json`），再让新 pair 首同步，
    // 这样对端在拉取数据时已经能读到完整拓扑。
    try {
      // 重新添加同一 id 是显式动作：先清掉旧墓碑，再写权威定义。
      const stale = (await this.tombstones.list()).find((t) =>
        t.path === backendMetaFilePath(id),
      );
      if (stale) await this.tombstones.remove(stale);
      await writeBackendMetaDescriptor(this.localFS, desc);
    } catch (err) {
      log.warn(`[AppDataGroup:${this.groupId}] addBackend: failed to write .meta/backends/${id}.json:`, err);
    }

    // Initial sync FIRST, then watch (same pattern as ConfigRepo.addBackend)
    try {
      await this.syncEngine.sync(pair.pairId);
    } catch (err) {
      log.warn(`[AppDataGroup:${this.groupId}] addBackend: initial sync failed for ${id}:`, err);
    }
    this.syncEngine.watch(pair.pairId);

    // 再回刷引导副本（配置组 `.config/app-data-groups`）。投影字节相同则不写。
    // Use _backends (not listBackends()) so descriptors that failed to connect
    // stay listed (and can be fixed/removed) instead of being silently dropped.
    await this.parent.updateAppDataGroupDescriptor(this.groupId, this._backends, {
      name: this.name,
      features: this._declaredFeatures,
    });
  }

  async removeBackend(id: string): Promise<void> {
    if (this.disposed) throw new Error('DataSyncGroup has been disposed');
    const backend = this.dataBackends.get(id);
    const desc = this._backends.find(b => b.id === id);
    if (!backend && !desc) {
      throw new Error(`Backend "${id}" not found in data group "${this.groupId}"`);
    }

    // 数据组权威定义：墓碑 + unlink。墓碑让对端删除同名副本，避免「删除被复活」。
    // 必须在这个后端还挂着 pair 时跑一次墓碑 pass —— 否则它自己远端上的
    // `.meta/backends/{id}.json` 副本会留下来，下次连上又会被拉回来。
    await this.writeTombstoneFor(backendMetaFilePath(id));
    await this.runTombstonePass('removeBackend');
    await removeBackendMetaDescriptor(this.localFS, id);

    if (backend) {
      this.syncEngine.removePair(backend.pairId);
      this.dataBackends.delete(id);
    }
    this.backendStates.delete(id);
    this._backends = this._backends.filter(b => b.id !== id);

    // 再回刷引导副本（投影字节相同则不写）。
    await this.parent.updateAppDataGroupDescriptor(this.groupId, this._backends, {
      name: this.name,
      features: this._declaredFeatures,
    });

    if (backend?.instance?.dispose) {
      await backend.instance.dispose();
    }

    log.log(`[AppDataGroup:${this.groupId}] removeBackend: ${id} removed`);
  }

  listBackends(): AppDataBackendDescriptor[] {
    return Array.from(this.dataBackends.values()).map(b => b.desc);
  }

  /**
   * 声明式后端列表：以数据组自己的 `.meta/backends/` 为准，包含暂时连接失败的条目。
   * 这才是权威列表；`listBackends()` 只是「当前已连接」的视图。
   */
  listDeclaredBackends(): AppDataBackendDescriptor[] {
    return this._backends.map((desc) => ({ ...desc }));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.postDeleteTimer) {
      clearTimeout(this.postDeleteTimer);
      this.postDeleteTimer = undefined;
    }
    this.syncEngine.dispose();
    for (const [_id, backend] of this.dataBackends) {
      if (backend.instance?.dispose) {
        await backend.instance.dispose();
      }
    }
    this.dataBackends.clear();
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function toUint8Array(raw: any): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw instanceof Uint8Array) return raw;
  if (typeof raw === 'string') return new TextEncoder().encode(raw);
  // Node.js Buffer is a subclass of Uint8Array, so the check above covers it.
  // Fall back to Buffer.isBuffer only when Buffer exists (Node.js).
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  return new Uint8Array(raw);
}

// ---------------------------------------------------------------------------
// createConfigRepo — Factory Function
// ---------------------------------------------------------------------------

export async function createConfigRepo(
  appId: string,
  options: ConfigRepoOptions = {},
): Promise<IConfigRepo> {
  // -------------------------------------------------------------------
  // Step 1: Create the local primary backend (IndexedDB on browser, Folder on Node)
  // -------------------------------------------------------------------
  const localPrimary = await resolveLocalPrimary(appId, 'config', {
    idbStoreName: options.idbStoreName,
    folderPath: options.folderPath,
  });
  log.log(`[createConfigRepo] Creating local primary (type: ${localPrimary.type})...`);

  const primaryInstance = await createBackend(localPrimary);

  const cachedFS = primaryInstance;

  // -------------------------------------------------------------------
  // Step 1b: Purge leaked .mtime sidecars from the local primary
  //
  // Older builds copied backend-internal `.mtime` sidecars into the local
  // store. Sync ignores them, so they would otherwise linger forever and
  // warn on every walk. Local-only operation, safe to run on every start.
  // -------------------------------------------------------------------
  if (options.purgeMtimeSidecars !== false) {
    try {
      const purged = await purgeMtimeSidecars(cachedFS);
      if (purged.removed.length > 0) {
        log.warn(
          `[createConfigRepo] purged ${purged.removed.length} leaked .mtime sidecar(s) from local primary:`,
          purged.removed,
        );
      }
    } catch (err: any) {
      log.warn(`[createConfigRepo] .mtime purge failed:`, err?.message ?? err);
    }
  }

  // -------------------------------------------------------------------
  // Step 1c: Purge leaked `.keep` placeholders from the local primary
  //
  // Older builds copied backend-internal `.keep` placeholders (used to keep
  // empty directories alive on Git/RemoteStorage backends) into the local
  // store. Sync ignores them now, so they would otherwise linger forever.
  // `/.meta/backends/.keep` is protected. Local-only, safe every start.
  // -------------------------------------------------------------------
  if (options.purgeKeepFiles !== false) {
    try {
      const purged = await purgeKeepFiles(cachedFS);
      if (purged.removed.length > 0) {
        log.warn(
          `[createConfigRepo] purged ${purged.removed.length} leaked .keep placeholder(s) from local primary:`,
          purged.removed,
        );
      }
    } catch (err: any) {
      log.warn(`[createConfigRepo] .keep purge failed:`, err?.message ?? err);
    }
  }

  // Cache is enabled by default for replica backends (Gitee, RemoteStorage,
  // etc.) using IdbCacheStore. The local IndexedDB primary is not cached.
  // Pass { cache: false } to disable, or { cache: { storeType: 'MemoryCacheStore' } }
  // for session-only caching.
  const cacheOptions: CacheOptions | undefined =
    options.cache === false ? undefined : (options.cache ?? {});

  // -------------------------------------------------------------------
  // Step 2: Ensure /.meta/ directory exists
  // -------------------------------------------------------------------
  try {
    await primaryInstance.mkdir(META_DIR);
    log.log(`[createConfigRepo] /.meta/ ready`);
  } catch (err: any) {
    // EEXIST / File exists is expected on every launch after the first —
    // the directory was already created. Suppress to avoid log noise.
    const msg = err.message || '';
    if (msg.includes('File exists') || msg.includes('EEXIST') || (err as { code?: string }).code === 'EEXIST') {
      // /.meta/ already exists — this is the normal case after first run
    } else {
      log.error(`[createConfigRepo] Failed to ensure /.meta/:`, err.message);
    }
  }

  // -------------------------------------------------------------------
  // Step 2b: Write group-type = "config-sync" (new `.config/` + legacy mirror)
  // -------------------------------------------------------------------
  try {
    const groupTypeBytes = new TextEncoder().encode('config-sync');
    for (const path of [`${CONFIG_DIR}/group-type`, `${META_DIR}/group-type`]) {
      try {
        await primaryInstance.readFile(path);
      } catch {
        await ensureParentDir(primaryInstance, path);
        await primaryInstance.writeFile(path, groupTypeBytes);
        log.log(`[createConfigRepo] group-type set to "config-sync" at ${path}`);
      }
    }
    // Unified descriptor (`.meta/group.json`) — shared by both group kinds.
    if (!(await readGroupDescriptor(primaryInstance))) {
      await writeGroupDescriptor(primaryInstance, {
        schemaVersion: 2,
        kind: 'config',
        id: CONFIG_GROUP_ID,
        features: CONFIG_GROUP_FEATURES,
      });
    }
  } catch (err: any) {
    log.warn(`[createConfigRepo] Failed to write group metadata:`, err.message);
  }

  // -------------------------------------------------------------------
  // Step 3: Create temp repo for meta operations (nodeId not yet known)
  // -------------------------------------------------------------------
  const tempRepo = new ConfigRepo(
    appId, '', LOCAL_IDB_BACKEND_ID, cachedFS, createSerializerChain(), undefined, options.syncPollIntervalMs, cacheOptions,
  );

  // -------------------------------------------------------------------
  // Step 4: Migrate from legacy backends.json if it exists
  // -------------------------------------------------------------------
  const oldBackendsMeta = await tempRepo.readMetaFile<BackendsMeta>(BACKENDS_FILE);
  if (oldBackendsMeta && oldBackendsMeta.backends?.length > 0) {
    log.log(`[createConfigRepo] Migrating ${oldBackendsMeta.backends.length} backend(s) from backends.json to individual files...`);
    await tempRepo.ensureDir(`${BACKENDS_DIR}/.keep`);
    for (const desc of oldBackendsMeta.backends) {
      // Skip the local primary — it's implicit (always id LOCAL_IDB_BACKEND_ID)
      if (desc.id === LOCAL_IDB_BACKEND_ID) {
        log.log(`[createConfigRepo] Skipping local backend ${desc.id} during migration`);
        continue;
      }
      await tempRepo.writeBackendDescriptor(desc);
    }
    // Delete legacy file + version sidecar
    try { await cachedFS.unlink(BACKENDS_FILE); } catch { /* ignore */ }
    {
      const vPath = versionPathFor(BACKENDS_FILE);
      if (vPath) { try { await cachedFS.unlink(vPath); } catch { /* ignore */ } }
    }
    log.log(`[createConfigRepo] Migration complete`);
  }

  // -------------------------------------------------------------------
  // Step 5: Read all backends ONCE (used for both duplicate check and setupSync)
  // -------------------------------------------------------------------
  let allBackends = await tempRepo.readAllBackendDescriptors();

  // -------------------------------------------------------------------
  // Step 5b: If backendInfo is provided, add as replica (if not present)
  // -------------------------------------------------------------------
  if (options.backendInfo) {
    const replicaId = options.primaryBackendId || `${options.backendInfo.type}-replica`;
    const hasReplica = allBackends.some(b => b.id === replicaId);
    // Also check for duplicate configuration (same type + options, different ID)
    const newKey = backendDedupKey({
      id: replicaId,
      type: options.backendInfo.type,
      options: options.backendInfo.options,
    });
    const dupConfig = allBackends.find(b => backendDedupKey(b) === newKey);
    if (!hasReplica && !dupConfig) {
      await tempRepo.writeBackendDescriptor({
        id: replicaId,
        type: options.backendInfo.type,
        options: options.backendInfo.options,
      });
      log.log(`[createConfigRepo] Added replica backend: ${replicaId} (${options.backendInfo.type})`);
      // Append to the array instead of re-reading from disk
      allBackends = [...allBackends, { id: replicaId, type: options.backendInfo.type, options: options.backendInfo.options }];
    } else if (dupConfig) {
      log.log(`[createConfigRepo] Replica with same config already registered as "${dupConfig.id}", skipping`);
    } else {
      log.log(`[createConfigRepo] Replica ${replicaId} already registered`);
    }
  }

  log.log(`[createConfigRepo] Replica backends: ${allBackends.map(b => b.id).join(', ') || '(none)'}`);

  // -------------------------------------------------------------------
  // Step 7: Determine nodeId
  // nodeId is the caller's responsibility to persist (e.g. localStorage).
  // We no longer read/write /nodes/.node-id to avoid sync conflicts.
  // -------------------------------------------------------------------
  let nodeId = options.nodeId;
  if (!nodeId) {
    nodeId = `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    log.log(`[createConfigRepo] Generated nodeId: ${nodeId}`);
  }

  // -------------------------------------------------------------------
  // Step 8: Create final ConfigRepo and set up sync
  // -------------------------------------------------------------------
  const serializer = createSerializerChain(options.serializer);
  const repo = new ConfigRepo(
    appId,
    nodeId,
    LOCAL_IDB_BACKEND_ID,
    cachedFS,
    serializer,
    options.onConflict,
    options.syncPollIntervalMs,
    cacheOptions,
  );

  // Hydrate the unified handle's display name from the descriptor.
  try {
    const nameDescriptor = await repo.getConfigSyncGroupDescriptor();
    if (nameDescriptor?.name) repo.name = nameDescriptor.name;
  } catch { /* name is optional */ }

  await repo.setupSync(allBackends, LOCAL_IDB_BACKEND_ID, options.syncPollIntervalMs);

  // Step 8a: Migrate legacy `.x.version` sidecars to the new `<name>.version`
  // naming. Runs locally (rename) and on every replica (delete residual), so
  // existing version history is preserved and the old dotfile copies disappear
  // from both ends instead of being re-pulled by sync.
  if (options.migrateVersionSidecars !== false) {
    try {
      const mig = await repo.migrateLegacyVersionSidecars();
      if (mig.renamed.length === 0 && mig.deleted.length === 0 && mig.remoteDeleted.length === 0) {
        log.log('[createConfigRepo] no legacy version sidecars to migrate');
      }
    } catch (err: any) {
      log.warn(`[createConfigRepo] version sidecar migration failed:`, err?.message ?? err);
    }
  }

  // Load config cache from local IndexedDB (fast, no network)
  await repo.load();

  // Step 8b: Initial sync + dedup cycle — run in BACKGROUND to avoid
  // blocking the caller. The sync engine's watchAll() will start
  // monitoring for changes once the initial sync completes.
  // flush() and dispose() will await this if called before it finishes.
  if (repo.replicaCount > 0) {
    log.log('[createConfigRepo] Starting background initial sync + dedup...');
    repo.startBackgroundSync();
  }

  // Sync to replicas in the background — watchers are already running,
  // so this just speeds up the initial push. Don't block the caller.
  repo.syncMetaToReplicas().catch((err) => {
    log.error('[createConfigRepo] background syncMetaToReplicas failed:', err);
  });

  return repo;
}

/**
 * 若 `path` 是侧车（`<file>.mtime` / `<file>.version` / `<file>.version.mtime`），
 * 返回它所属的数据文件路径；不是侧车返回 null。
 *
 * 用于墓碑处理时判断侧车是否“仍被现存数据文件使用”：是则绝不能先删后重建，
 * 否则每轮同步都会给同一个文件产生一对 delete/create 提交。
 */
function sidecarOwnerPath(path: string): string | null {
  let owner: string | null = null;
  if (path.endsWith('.mtime')) owner = path.slice(0, -'.mtime'.length);
  else if (path.endsWith('.version')) owner = path.slice(0, -'.version'.length);
  if (owner && owner.endsWith('.version')) owner = owner.slice(0, -'.version'.length);
  return owner === '' ? null : owner;
}
