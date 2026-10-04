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
import { purgeMtimeSidecars, type PurgeMtimeOptions, type MtimePurgeResult } from './mtime-cleanup';
import { purgeKeepFiles, type PurgeKeepOptions, type KeepPurgeResult } from './keep-cleanup';
import { migrateVersionSidecars, type VersionMigrationResult } from './version-migration';
import type { VersionMeta } from './types';

const log = createLogger('zen-fs-config:config-repo');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const META_DIR = '/.meta';
const GROUP_TYPE_FILE = `${META_DIR}/group-type`;
const BACKENDS_FILE = `${META_DIR}/backends.json`; // Legacy single-file format (pre-0.4.0)
const BACKENDS_DIR = `${META_DIR}/backends`;       // New: one JSON file per backend
const APP_DATA_GROUPS_DIR = `${META_DIR}/app-data-groups`; // Per-app data-sync group references
const CONFLICTS_DIR = `${META_DIR}/.conflicts`;
const DELETIONS_DIR = `${META_DIR}/.deleted`;
const NODES_DIR = '/nodes';
const SHARED_DIR = '/shared';

/** Fixed ID for the local IndexedDB primary backend. */
export const LOCAL_IDB_BACKEND_ID = 'local-idb';

/** Encode a file path into a tombstone filename (no slashes, no dots issue). */
function tombstoneFileName(filePath: string): string {
  return filePath
    .replace(/^\//, '')
    .replace(/\//g, '__')
    .replace(/\./g, '++') + '.json';
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
  const meta = getBackendMetadata(type);
  const fields = meta?.identityFields;
  if (!fields || fields.length === 0) {
    log.warn(`[DEDUP-DIAG] identityOptions(${type}): NO identityFields -> falling back to FULL options (dedup will be key-sensitive to tuning fields)`);
    return options ?? {};
  }
  const subset: Record<string, unknown> = {};
  for (const f of fields) {
    if (options && options[f] !== undefined) subset[f] = options[f];
  }
  log.log(`[DEDUP-DIAG] identityOptions(${type}): identityFields=${JSON.stringify(fields)} identitySubset=${JSON.stringify(subset)}`);
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
    this.fs = createChrootFS(cachedFS, `/${appId}`);
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
   * Delete a file and write a tombstone so the deletion propagates
   * to all backends instead of being treated as "missing file → re-create".
   */
  async deleteFile(path: string): Promise<void> {
    this.assertNotDisposed();
    const normalizedPath = path.startsWith('/') ? path : '/' + path;

    // 1. Write tombstone
    const tombstonePath = `${DELETIONS_DIR}/${tombstoneFileName(normalizedPath)}`;
    const tombstone: TombstoneMeta = {
      path: normalizedPath,
      deletedAt: Date.now(),
      deletedBy: this.primaryBackendId,
      confirmedBy: [this.primaryBackendId],
    };
    await this.ensureDir(tombstonePath);
    await this.cachedFS.writeFile(
      tombstonePath,
      new TextEncoder().encode(JSON.stringify(tombstone, null, 2)),
    );

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

    log.log(`[ConfigRepo] deleteFile: ${normalizedPath} (tombstone at ${tombstonePath})`);
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
    try {
      const entries = await this.cachedFS.readdir(DELETIONS_DIR);
      const tombstones: TombstoneMeta[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          const raw = await this.cachedFS.readFile(`${DELETIONS_DIR}/${entry}`);
          const data = JSON.parse(new TextDecoder().decode(toUint8Array(raw)));
          tombstones.push(data as TombstoneMeta);
        } catch { /* skip corrupt tombstone */ }
      }
      this.tombstoneCache = tombstones;
      return tombstones;
    } catch {
      this.tombstoneCache = [];
      return []; // DELETIONS_DIR doesn't exist yet
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
    if (tombstones.length === 0) return;

    let processed = 0;
    let alreadyDeleted = 0;

    for (const tombstone of tombstones) {
      const tVersionPath = versionPathFor(tombstone.path);
      log.log(`[TOMB-TRACE] processing tombstone: path=${tombstone.path} versionPath=${tVersionPath ?? 'null'}`);

      // Delete on primary (in case it was re-created)
      const existedOnPrimary = await this.safeExists(this.cachedFS, tombstone.path);
      log.log(`[TOMB-TRACE] primary safeExists(${tombstone.path}) → ${existedOnPrimary}`);
      if (existedOnPrimary) {
        log.log(`[TOMB-TRACE] tombstone check: ${tombstone.path} on primary → EXISTS`);
      }
      if (existedOnPrimary) {
        try { await this.cachedFS.unlink(tombstone.path); processed++; } catch { /* race */ }
      }
      if (tVersionPath) {
        const vExistedOnPrimary = await this.safeExists(this.cachedFS, tVersionPath);
        log.log(`[TOMB-TRACE] primary safeExists(${tVersionPath}) → ${vExistedOnPrimary}`);
        if (vExistedOnPrimary) {
          try { await this.cachedFS.unlink(tVersionPath); } catch { /* race */ }
        }
      }

      // Delete on all replicas
      for (const [replicaId, replica] of this.replicaBackends) {
        log.log(`[TOMB-TRACE] checking replica: ${replicaId} for ${tombstone.path}`);
        // Check existence before unlink — avoids wasteful DELETE requests
        // on remote backends (RemoteStorage, Gitee, WebDAV) when the file
        // was already deleted on a previous sync cycle.
        const existed = await this.safeExists(replica.instance, tombstone.path);
        log.log(`[TOMB-TRACE] replica ${replicaId} safeExists(${tombstone.path}) → ${existed}`);
        if (existed) {
          log.log(`[TOMB-TRACE] tombstone check: ${tombstone.path} on ${replicaId} → EXISTS`);
          try {
            log.log(`[TOMB-TRACE] calling unlink(${tombstone.path}) on ${replicaId}`);
            await replica.instance.unlink(tombstone.path);
            log.log(`[TOMB-TRACE] tombstone ${tombstone.path}: deleted on ${replicaId}`);
            processed++;
          } catch (err) {
            log.log(`[TOMB-TRACE] unlink(${tombstone.path}) on ${replicaId} FAILED: ${err}`);
            // race — file removed between exists and unlink
            alreadyDeleted++;
          }
        } else {
          log.log(`[TOMB-TRACE] replica ${replicaId}: already gone, skipping unlink`);
          alreadyDeleted++;
        }
        if (tVersionPath) {
          const vExisted = await this.safeExists(replica.instance, tVersionPath);
          log.log(`[TOMB-TRACE] replica ${replicaId} safeExists(${tVersionPath}) → ${vExisted}`);
          if (vExisted) {
            try {
              log.log(`[TOMB-TRACE] calling unlink(${tVersionPath}) on ${replicaId}`);
              await replica.instance.unlink(tVersionPath);
            } catch (err) {
              log.log(`[TOMB-TRACE] unlink(${tVersionPath}) on ${replicaId} FAILED: ${err}`);
            }
          }
        }
      }
    }

    // Only log summary — per-file logs only appear for actual deletions
    if (processed > 0 || alreadyDeleted > 0) {
      log.log(`[TOMB-TRACE] processTombstones: ${tombstones.length} tombstone(s), ${processed} deleted, ${alreadyDeleted} already gone`);
    }
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
   * After sync: mark each tombstone as confirmed by all replica backends.
   */
  private async updateTombstoneConfirmations(): Promise<void> {
    const tombstones = await this.readTombstones();
    if (tombstones.length === 0) return;

    let modified = 0;
    for (const tombstone of tombstones) {
      const tombstonePath = `${DELETIONS_DIR}/${tombstoneFileName(tombstone.path)}`;
      // Add all replica IDs that we just synced with
      let changed = false;
      for (const replicaId of this.replicaBackends.keys()) {
        if (!tombstone.confirmedBy.includes(replicaId)) {
          tombstone.confirmedBy.push(replicaId);
          changed = true;
        }
      }
      // Only rewrite when the confirmation set actually changed — otherwise we
      // would re-touch the tombstone's mtime every cycle and feed the sync
      // engine a spurious "changed file", causing needless MTIME NORMALIZE churn
      // until the tombstone is eventually GC'd.
      if (changed) {
        try {
          await this.cachedFS.writeFile(
            tombstonePath,
            new TextEncoder().encode(JSON.stringify(tombstone, null, 2)),
          );
          modified++;
        } catch { /* ignore write error */ }
      }
    }

    log.log(`[ConfigRepo] updateTombstoneConfirmations: ${modified} tombstone(s) updated`);
    // Invalidate cache — tombstones were modified (confirmedBy updated)
    if (modified > 0) this.invalidateTombstoneCache();
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
      const allConfirmed = allBackendIds.every(id => tombstone.confirmedBy.includes(id));
      if (allConfirmed) {
        const tombstonePath = `${DELETIONS_DIR}/${tombstoneFileName(tombstone.path)}`;

        // Delete tombstone on local primary
        try {
          await this.cachedFS.unlink(tombstonePath);
        } catch { /* already gone */ }

        // Delete tombstone on all replicas — prevents the sync engine
        // from re-copying them back on the next cycle.
        for (const [replicaId, replica] of this.replicaBackends) {
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

  // -----------------------------------------------------------------------
  // IConfigRepo — Conflict Management
  // -----------------------------------------------------------------------

  async resolveConflict(conflictId: string, mergedContent: unknown): Promise<void> {
    this.assertNotDisposed();

    const metaPath = `${CONFLICTS_DIR}/${conflictId}`;
    try {
      const raw = await this.cachedFS.readFile(metaPath);
      const archive: ConflictArchive = JSON.parse(
        new TextDecoder().decode(toUint8Array(raw)),
      );

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
    try {
      const entries = await this.cachedFS.readdir(CONFLICTS_DIR);
      for (const entry of entries) {
        // Each conflict is a directory containing meta.json
        const metaPath = `${CONFLICTS_DIR}/${entry}/meta.json`;
        try {
          const raw = await this.cachedFS.readFile(metaPath);
          const archive = JSON.parse(
            new TextDecoder().decode(toUint8Array(raw)),
          );
          archives.push(archive);
        } catch {
          // Skip entries without valid meta.json
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
    return archives.sort((a, b) => a.timestamp - b.timestamp);
  }

  async readConflictBackup(conflictId: string, fileType: 'source' | 'target' | 'resolved'): Promise<string> {
    this.assertNotDisposed();

    const conflictDir = `${CONFLICTS_DIR}/${conflictId}`.replace(/\/meta\.json$/, '');
    const filePath = `${conflictDir}/${fileType}`;
    const raw = await this.cachedFS.readFile(filePath);
    return new TextDecoder().decode(toUint8Array(raw));
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

        // Register conflict handler
        const conflictHandler: SyncEventHandler = (event: SyncEvent) => {
          this.handleConflict(event);
        };
        this.syncEngine.on(pair.pairId, 'conflict', conflictHandler);

        // NOTE: Do NOT call watch() here. watch() triggers buildInitialSnapshots()
        // which caches a merged (source ∪ target) snapshot WITHOUT actually
        // syncing files. This causes subsequent syncAll() to see "unchanged"
        // and skip, leaving remote-only files (like duplicate backend
        // descriptors) un-pulled. The caller (createConfigRepo) will do an
        // initial sync first, then call watchAll().

        log.log(`[ConfigRepo] Replica ${desc.id} created, sync pair=${pair.pairId}`);
      } catch (err: any) {
        log.error(`[ConfigRepo] Failed to create replica ${desc.id} (${desc.type}):`, err);
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

  // -----------------------------------------------------------------------
  // Internal — Individual Backend Descriptor Files
  // -----------------------------------------------------------------------

  /** Path for a single backend descriptor: .meta/backends/{id}.json */
  backendFilePath(id: string): string {
    return `${BACKENDS_DIR}/${id}.json`;
  }

  /**
   * Read all backend descriptors from .meta/backends/*.json.
   *
   * If duplicate backends are detected (same type + options but different id),
   * only the first one (sorted by id) is kept and the rest are removed
   * (including their version sidecar files).
   */
  async readAllBackendDescriptors(): Promise<BackendDescriptor[]> {
    try {
      const entries = await this.cachedFS.readdir(BACKENDS_DIR);
      const jsonEntries = entries.filter((e: string) => e.endsWith('.json'));

      // Parallelize readFile + stat for all descriptor files
      const readResults = await Promise.all(
        jsonEntries.map(async (entry: string) => {
          const filePath = `${BACKENDS_DIR}/${entry}`;
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
        log.log(`[DEDUP-DIAG] item id=${item.desc.id} type=${item.desc.type} dedupKey=${key} mtime=${item.mtime} rawOptions=${JSON.stringify(item.desc.options)}`);
        const existing = seen.get(key);
        if (existing) {
          if (item.mtime < existing.mtime) {
            // New one is older — keep it, mark the existing as duplicate
            log.log(`[DEDUP-DIAG] DUPLICATE: new id=${item.desc.id} (older) keeps key, dropping existing=${existing.desc.id}`);
            duplicates.push(existing.desc.id);
            seen.set(key, item);
          } else {
            // Existing is older (or same time) — keep existing, mark new as duplicate
            log.log(`[DEDUP-DIAG] DUPLICATE: new id=${item.desc.id} dropped, kept=${existing.desc.id}`);
            duplicates.push(item.desc.id);
          }
        } else {
          seen.set(key, item);
        }
      }

      log.log(`[DEDUP-DIAG] dedup summary: keptKeys=${[...seen.keys()].length} duplicates=${JSON.stringify(duplicates)}`);

      if (duplicates.length > 0) {
        log.log(
          `[ConfigRepo] readAllBackendDescriptors: removing ${duplicates.length} duplicate(s): ${duplicates.join(', ')}`,
        );
        for (const dupId of duplicates) {
          const descPath = this.backendFilePath(dupId);

          // 1. Delete the descriptor file on ALL known replicas directly.
          //    This is critical: if we only write a tombstone + delete locally,
          //    the sync engine will see "remote has file, local doesn't" and
          //    copy it back — re-creating the duplicate in an infinite loop.
          //    By deleting on all replicas NOW, both sides are clean.
          for (const [replicaId, replica] of this.replicaBackends) {
            try {
              await replica.instance.unlink(descPath);
              log.log(`[DEDUP-DIAG] removed dup ${dupId} from replica ${replicaId}`);
            } catch (e) { /* not on this replica */ log.log(`[DEDUP-DIAG] remove dup ${dupId} from replica ${replicaId} failed/skipped: ${String(e)}`); }
            await this.unlinkVersionSidecar(replica.instance, descPath);
          }
          log.log(`[DEDUP-DIAG] replicaBackends available during removal: ${[...this.replicaBackends.keys()].join(',') || '(none)'}`);

          // 2. Create a tombstone + delete the local file.
          //    The tombstone ensures late-joining replicas also delete the file.
          try {
            await this.deleteFile(descPath);
          } catch {
            // deleteFile might fail if called before sync engine is set up
            // (e.g. during createConfigRepo's tempRepo phase). Fall back to plain unlink.
            await this.removeBackendDescriptor(dupId);
          }
        }
      }

      return Array.from(seen.values()).map(i => i.desc);
    } catch (e) {
      log.error(`[DEDUP-DIAG] readAllBackendDescriptors threw, returning []:`, e);
      return []; // Directory doesn't exist yet
    }
  }

  /** Write a single backend descriptor as .meta/backends/{id}.json */
  async writeBackendDescriptor(desc: BackendDescriptor): Promise<void> {
    const path = this.backendFilePath(desc.id);
    await this.ensureDir(path);
    const bytes = new TextEncoder().encode(JSON.stringify(desc, null, 2));
    await this.cachedFS.writeFile(path, bytes);

    const author = `${this.appId}/${this.nodeId}`;
    const version = await incrementVersion(this.fullFS, path, bytes, author);
    await this.writeVersionSidecar(path, version);
  }

  /** Remove a single backend descriptor file + its version sidecar */
  async removeBackendDescriptor(id: string): Promise<void> {
    const path = this.backendFilePath(id);
    try { await this.cachedFS.unlink(path); } catch { /* already gone */ }
    await this.unlinkVersionSidecar(this.cachedFS, path);
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

    // Create backend instance
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

    // Register conflict handler
    const conflictHandler: SyncEventHandler = (event: SyncEvent) => {
      this.handleConflict(event);
    };
    this.syncEngine.on(pair.pairId, 'conflict', conflictHandler);

    log.log(`[ConfigRepo] addBackend: ${id} (${type}) added, sync pair=${pair.pairId}`);

    // Trigger initial sync FIRST (pulls remote-only files, pushes local files).
    // Then start watching. If we watch before syncing, buildInitialSnapshots()
    // caches a merged snapshot without copying, causing syncAll() to skip.
    await this.syncMetaToReplicas();
    this.syncEngine.watch(pair.pairId);
  }

  async removeBackend(id: string): Promise<void> {
    this.assertNotDisposed();

    if (id === LOCAL_IDB_BACKEND_ID) {
      throw new Error('Cannot remove the local IndexedDB primary backend');
    }

    const replica = this.replicaBackends.get(id);
    const descPath = this.backendFilePath(id);

    if (replica) {
      // Backend is actively registered — full cleanup path.
      // 1. Delete the descriptor file on the remote backend DIRECTLY.
      //    This must happen BEFORE removing the sync pair, because once the
      //    sync pair is gone, we can no longer reach the remote through the
      //    normal sync flow. Without this, the remote keeps the file and
      //    another backend's sync pair would pull it back.
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
      try {
        await this.deleteFile(descPath);
      } catch {
        await this.removeBackendDescriptor(id);
      }
    }

    // 6. Trigger sync on remaining pairs to propagate the tombstone.
    //    The tombstone must reach all remaining backends so they don't
    //    re-introduce the deleted descriptor from their snapshots.
    //    schedulePostDeleteSync() (called by deleteFile above) handles this,
    //    but we also trigger it here to ensure it runs even if deleteFile's
    //    timer hasn't fired yet.
    this.schedulePostDeleteSync();

    log.log(`[ConfigRepo] removeBackend: ${id} removed (tombstone written, remote cleaned)`);
  }

  // -----------------------------------------------------------------------
  // IConfigRepo — Group Type
  // -----------------------------------------------------------------------

  /** Write the group-type marker file if it doesn't exist. */
  async ensureGroupType(type: SyncGroupType): Promise<void> {
    this.assertNotDisposed();
    try {
      const existing = await this.cachedFS.readFile(GROUP_TYPE_FILE, 'utf-8');
      const current = (existing as string).trim();
      if (current && current !== type) {
        log.warn(`[ConfigRepo] group-type already set to "${current}", ignoring request to set "${type}"`);
        return;
      }
    } catch {
      // File doesn't exist — write it
    }
    await this.ensureDir(GROUP_TYPE_FILE);
    await this.cachedFS.writeFile(GROUP_TYPE_FILE, new TextEncoder().encode(type));
    log.log(`[ConfigRepo] group-type set to "${type}"`);
  }

  /** Read the group-type marker. Returns null if not set. */
  async getGroupType(): Promise<SyncGroupType | null> {
    this.assertNotDisposed();
    try {
      const raw = await this.cachedFS.readFile(GROUP_TYPE_FILE, 'utf-8');
      const type = (raw as string).trim() as SyncGroupType;
      if (type === 'config-sync' || type === 'data-sync') return type;
      return null;
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // IConfigRepo — App Data Groups (data-sync groups)
  // -----------------------------------------------------------------------

  /** Path for a single app data group descriptor: .meta/app-data-groups/{appId}/{id}.json */
  private appDataGroupFilePath(id: string): string {
    return `${APP_DATA_GROUPS_DIR}/${this.appId}/${id}.json`;
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

  async createAppDataGroup(
    id: string,
    backends: AppDataBackendDescriptor[],
  ): Promise<AppDataGroup> {
    this.assertNotDisposed();

    if (this.appDataGroups.has(id)) {
      throw new Error(`App data group "${id}" already exists. Use removeAppDataGroup() first.`);
    }

    log.log(`[ConfigRepo] createAppDataGroup: creating "${id}" with ${backends.length} backend(s)`);

    // Resolve account fields for each backend
    const resolvedBackends: AppDataBackendDescriptor[] = [];
    for (const desc of backends) {
      const mergedOptions = await this.resolveAppDataBackendOptions(desc);
      resolvedBackends.push({ ...desc, options: mergedOptions });
    }

    // Create the data-sync group implementation
    const group = new AppDataGroupImpl(
      id,
      this.appId,
      resolvedBackends,
      this.pollIntervalMs,
      this,
    );
    await group.init();

    // Save descriptor to .meta/app-data-groups/{appId}/{id}.json
    const descriptor: AppDataGroupDescriptor = {
      id,
      groupType: 'data-sync',
      backends: resolvedBackends,
    };
    const descPath = this.appDataGroupFilePath(id);
    await this.ensureDir(descPath);
    const bytes = new TextEncoder().encode(JSON.stringify(descriptor, null, 2));
    await this.cachedFS.writeFile(descPath, bytes);

    const author = `${this.appId}/${this.nodeId}`;
    const version = await incrementVersion(this.fullFS, descPath, bytes, author);
    await this.writeVersionSidecar(descPath, version);

    this.appDataGroups.set(id, group);
    log.log(`[ConfigRepo] createAppDataGroup: "${id}" created`);

    return group;
  }

  /**
   * Rewrite an app data group's descriptor (e.g. after addBackend/removeBackend)
   * into .meta/app-data-groups/{appId}/{id}.json, keeping config-sync as the
   * authoritative source of the data group's backend topology (FR2.3).
   */
  async updateAppDataGroupDescriptor(id: string, backends: AppDataBackendDescriptor[]): Promise<void> {
    this.assertNotDisposed();
    const descriptor: AppDataGroupDescriptor = {
      id,
      groupType: 'data-sync',
      backends,
    };
    const descPath = this.appDataGroupFilePath(id);
    await this.ensureDir(descPath);
    const bytes = new TextEncoder().encode(JSON.stringify(descriptor, null, 2));
    await this.cachedFS.writeFile(descPath, bytes);
    const author = `${this.appId}/${this.nodeId}`;
    const version = await incrementVersion(this.fullFS, descPath, bytes, author);
    await this.writeVersionSidecar(descPath, version);
  }

  async getAppDataGroup(id: string): Promise<AppDataGroup> {
    this.assertNotDisposed();

    // Return cached instance if available
    const cached = this.appDataGroups.get(id);
    if (cached) return cached;

    // Load from descriptor
    const descPath = this.appDataGroupFilePath(id);
    try {
      const raw = await this.cachedFS.readFile(descPath);
      const descriptor = JSON.parse(new TextDecoder().decode(toUint8Array(raw))) as AppDataGroupDescriptor;
      const group = new AppDataGroupImpl(
        id,
        this.appId,
        descriptor.backends,
        this.pollIntervalMs,
        this,
      );
      await group.init();
      this.appDataGroups.set(id, group);
      return group;
    } catch {
      throw new Error(`App data group "${id}" not found`);
    }
  }

  async listAppDataGroups(): Promise<AppDataGroupDescriptor[]> {
    this.assertNotDisposed();
    const dir = `${APP_DATA_GROUPS_DIR}/${this.appId}`;
    try {
      const entries = await this.cachedFS.readdir(dir);
      const descriptors: AppDataGroupDescriptor[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          const raw = await this.cachedFS.readFile(`${dir}/${entry}`);
          const desc = JSON.parse(new TextDecoder().decode(toUint8Array(raw)));
          if (desc.id && desc.groupType === 'data-sync') {
            descriptors.push(desc);
          }
        } catch { /* skip corrupt */ }
      }
      return descriptors;
    } catch {
      return [];
    }
  }

  async removeAppDataGroup(id: string): Promise<void> {
    this.assertNotDisposed();

    const group = this.appDataGroups.get(id);
    if (group) {
      await group.dispose();
      this.appDataGroups.delete(id);
    }

    const descPath = this.appDataGroupFilePath(id);
    try { await this.cachedFS.unlink(descPath); } catch { /* already gone */ }
    await this.unlinkVersionSidecar(this.cachedFS, descPath);
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
  fs: any;

  private syncEngine: ZenFSSync;
  private localFS: BackendInstance;
  private dataBackends: Map<string, { instance: any; syncable: SyncableFS; pairId: string; desc: AppDataBackendDescriptor }> = new Map();
  private disposed = false;

  constructor(
    groupId: string,
    appId: string,
    backends: AppDataBackendDescriptor[],
    pollIntervalMs: number | undefined,
    parent: ConfigRepo,
  ) {
    this.groupId = groupId;
    this.appId = appId;
    this.parent = parent;
    this.syncEngine = new ZenFSSync();
    this.localFS = null as any;
    this.fs = null as any;
    this._backends = backends;
    this._pollIntervalMs = pollIntervalMs;
  }

  private parent: ConfigRepo;
  private _backends: AppDataBackendDescriptor[];
  private _pollIntervalMs?: number;

  async init(): Promise<void> {
    // Create local primary backend (Folder on Node, IndexedDB on browser)
    try {
      const localPrimary = await resolveLocalPrimary(this.appId, 'data');
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
    this.fs = createChrootFS(this.localFS, '/');

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
          },
          '/',
        );
        this.dataBackends.set(desc.id, { instance, syncable, pairId: pair.pairId, desc });
        // NOTE: Don't watch yet — sync first, then watch (same pattern as ConfigRepo)
        log.log(`[AppDataGroup:${this.groupId}] backend ${desc.id} (${desc.type}) connected, pair=${pair.pairId}`);
      } catch (err: any) {
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

    // Persist the deduplicated backend list so the duplicate is gone for good
    // (otherwise it would reappear on the next load).
    if (removed.length > 0) {
      try {
        await this.parent.updateAppDataGroupDescriptor(this.groupId, this._backends);
      } catch (err) {
        log.warn(`[AppDataGroup:${this.groupId}] dedupe: failed to persist deduplicated backends:`, err);
      }
    }
  }

  getSyncStatuses(): Map<string, SyncPairStatus> {
    return this.syncEngine.getStatusAll();
  }

  async flush(): Promise<SyncResult[]> {
    const results = await this.syncEngine.syncAll();
    return Array.from(results.values());
  }

  async addBackend(
    id: string,
    type: string,
    options: Record<string, unknown>,
    description?: string,
  ): Promise<void> {
    if (this.disposed) throw new Error('DataSyncGroup has been disposed');
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
      },
      '/',
    );

    const desc: AppDataBackendDescriptor = { id, type, options, description, createdAt: Date.now() };
    this.dataBackends.set(id, { instance, syncable, pairId: pair.pairId, desc });
    log.log(`[AppDataGroup:${this.groupId}] addBackend: ${id} (${type}) connected, pair=${pair.pairId}`);

    // Initial sync FIRST, then watch (same pattern as ConfigRepo.addBackend)
    try {
      await this.syncEngine.sync(pair.pairId);
    } catch (err) {
      log.warn(`[AppDataGroup:${this.groupId}] addBackend: initial sync failed for ${id}:`, err);
    }
    this.syncEngine.watch(pair.pairId);

    // Write the updated backend list back into config-sync's app-data-groups (FR2.3).
    await this.parent.updateAppDataGroupDescriptor(this.groupId, this.listBackends());
  }

  async removeBackend(id: string): Promise<void> {
    if (this.disposed) throw new Error('DataSyncGroup has been disposed');
    const backend = this.dataBackends.get(id);
    if (!backend) {
      throw new Error(`Backend "${id}" not found in data group "${this.groupId}"`);
    }

    this.syncEngine.removePair(backend.pairId);
    this.dataBackends.delete(id);

    // Write the updated backend list back into config-sync's app-data-groups (FR2.3).
    await this.parent.updateAppDataGroupDescriptor(this.groupId, this.listBackends());

    if (backend.instance?.dispose) {
      await backend.instance.dispose();
    }

    log.log(`[AppDataGroup:${this.groupId}] removeBackend: ${id} removed`);
  }

  listBackends(): AppDataBackendDescriptor[] {
    return Array.from(this.dataBackends.values()).map(b => b.desc);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
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
  // Step 2b: Write group-type = "config-sync" (if not already set)
  // -------------------------------------------------------------------
  try {
    const groupTypeBytes = new TextEncoder().encode('config-sync');
    // Check if already exists
    try {
      await primaryInstance.readFile(`${META_DIR}/group-type`);
    } catch {
      await primaryInstance.writeFile(`${META_DIR}/group-type`, groupTypeBytes);
      log.log(`[createConfigRepo] group-type set to "config-sync"`);
    }
  } catch (err: any) {
    log.warn(`[createConfigRepo] Failed to write group-type:`, err.message);
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
  log.log(`[DEDUP-DIAG] createConfigRepo after readAllBackendDescriptors: allBackends=${allBackends.map(b => b.id).join(',')}`);

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
