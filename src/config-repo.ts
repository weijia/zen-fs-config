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
import { createBackend, mergeAccountFields, getAccountFields, type BackendInstance } from './backend-registry';
import { versionPathFor, incrementVersion, writeVersion, readVersion } from './version';
import type { VersionMeta } from './types';

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
 * Generate a dedup key for a backend descriptor.
 * Two backends with the same type + options (regardless of key ordering) produce the same key.
 */
function backendDedupKey(desc: BackendDescriptor): string {
  return `${desc.type}:${stableOptionsKey(desc.options)}`;
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
      console.error(`[zen-fs-config] Failed to persist ${fullPath}:`, err);
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

    console.log(`[ConfigRepo] deleteFile: ${normalizedPath} (tombstone at ${tombstonePath})`);
    // Invalidate cache — a new tombstone was written
    this.invalidateTombstoneCache();
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

    console.log(`[ConfigRepo] processTombstones: ${tombstones.length} tombstone(s)`);

    for (const tombstone of tombstones) {
      const tVersionPath = versionPathFor(tombstone.path);

      // Delete on primary (in case it was re-created)
      if (await this.safeExists(this.cachedFS, tombstone.path)) {
        try { await this.cachedFS.unlink(tombstone.path); } catch { /* race */ }
      }
      if (tVersionPath && await this.safeExists(this.cachedFS, tVersionPath)) {
        try { await this.cachedFS.unlink(tVersionPath); } catch { /* race */ }
      }

      // Delete on all replicas
      for (const [replicaId, replica] of this.replicaBackends) {
        // Check existence before unlink — avoids wasteful DELETE requests
        // on remote backends (RemoteStorage, Gitee, WebDAV) when the file
        // was already deleted on a previous sync cycle.
        if (await this.safeExists(replica.instance, tombstone.path)) {
          try {
            await replica.instance.unlink(tombstone.path);
            console.log(`[ConfigRepo] tombstone ${tombstone.path}: deleted on ${replicaId}`);
          } catch { /* race — file removed between exists and unlink */ }
        }
        if (tVersionPath && await this.safeExists(replica.instance, tVersionPath)) {
          try {
            await replica.instance.unlink(tVersionPath);
          } catch { /* race */ }
        }
      }
    }
  }

  /**
   * Safe existence check — returns false on any error instead of throwing.
   * Used by processTombstones to avoid unnecessary unlink() calls.
   */
  private async safeExists(fs: any, path: string): Promise<boolean> {
    try {
      if (typeof fs.exists === 'function') {
        return await fs.exists(path);
      }
      // Fallback: try stat() — if it throws, the file doesn't exist
      await fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Public wrapper for processTombstones — used by createConfigRepo. */
  async processTombstonesPublic(): Promise<void> {
    await this.processTombstones();
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
   * After sync: mark each tombstone as confirmed by all replica backends.
   */
  private async updateTombstoneConfirmations(): Promise<void> {
    const tombstones = await this.readTombstones();
    if (tombstones.length === 0) return;

    // Get all backend IDs from backends.json
    const backendsMeta = await this.getBackends();
    const allBackendIds = backendsMeta?.backends.map(b => b.id) ?? [this.primaryBackendId];

    for (const tombstone of tombstones) {
      const tombstonePath = `${DELETIONS_DIR}/${tombstoneFileName(tombstone.path)}`;
      // Add all replica IDs that we just synced with
      for (const replicaId of this.replicaBackends.keys()) {
        if (!tombstone.confirmedBy.includes(replicaId)) {
          tombstone.confirmedBy.push(replicaId);
        }
      }
      // Write updated tombstone back
      try {
        await this.cachedFS.writeFile(
          tombstonePath,
          new TextEncoder().encode(JSON.stringify(tombstone, null, 2)),
        );
      } catch { /* ignore write error */ }
    }

    console.log(`[ConfigRepo] updateTombstoneConfirmations: ${tombstones.length} tombstone(s) updated`);
    // Invalidate cache — tombstones were modified (confirmedBy updated)
    this.invalidateTombstoneCache();
  }

  /**
   * GC: remove tombstones where all backends in backends.json have confirmed.
   */
  private async gcTombstones(): Promise<void> {
    const tombstones = await this.readTombstones();
    if (tombstones.length === 0) return;

    const backendsMeta = await this.getBackends();
    const allBackendIds = backendsMeta?.backends.map(b => b.id) ?? [this.primaryBackendId];

    for (const tombstone of tombstones) {
      const allConfirmed = allBackendIds.every(id => tombstone.confirmedBy.includes(id));
      if (allConfirmed) {
        const tombstonePath = `${DELETIONS_DIR}/${tombstoneFileName(tombstone.path)}`;
        try {
          await this.cachedFS.unlink(tombstonePath);
          console.log(`[ConfigRepo] gcTombstones: removed ${tombstonePath} (all ${allBackendIds.length} backends confirmed)`);
        } catch { /* already gone */ }
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
      console.log(
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
    this.disposed = true;
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
    console.log(`[ConfigRepo] setupSync: ${backends.length} backends, primary=${primaryBackendId} pollInterval=${pollIntervalMs ?? 'default'}ms`);

    for (const desc of backends) {
      if (desc.id === primaryBackendId) continue;
      if ((desc as any).enabled === false) {
        console.log(`[ConfigRepo] Skipping disabled replica: ${desc.id}`);
        continue;
      }
      console.log(`[ConfigRepo] Creating replica backend: id=${desc.id}, type=${desc.type}`);
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
          console.log(`[ConfigRepo] Replica ${desc.id} wrapped with CachedFileSystem (store=${this.cacheOptions.storeType ?? 'IdbCacheStore'})`);
        }

        const syncable = backendToSyncableFS(fsInstance, `${desc.type}(${desc.id})`);

        // Create sync pair
        const pair = this.syncEngine.addPair(
          this.fullFS,
          syncable,
          {
            direction: SyncDirection.BiDirectional,
            conflictStrategy: 'source-wins' as any,
            pollIntervalMs,
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

        console.log(`[ConfigRepo] Replica ${desc.id} created, sync pair=${pair.pairId}`);
      } catch (err: any) {
        console.error(`[ConfigRepo] Failed to create replica ${desc.id} (${desc.type}):`, err);
      }
    }

    console.log(`[ConfigRepo] setupSync complete. Replicas:`, Array.from(this.replicaBackends.keys()));
    console.log(`[ConfigRepo] Sync statuses:`, this.getSyncStatuses());
  }

  // -----------------------------------------------------------------------
  // Internal — Persistence
  // -----------------------------------------------------------------------

  /** Write version sidecar for a config file (no-op for .version files). */
  private async writeVersionSidecar(configPath: string, version: VersionMeta): Promise<void> {
    const vPath = versionPathFor(configPath);
    if (!vPath) return;
    await this.ensureDir(vPath);
    await writeVersion(this.fullFS, vPath, version);
  }

  /** Delete version sidecar on a backend (no-op for .version files). */
  private async unlinkVersionSidecar(fs: any, configPath: string): Promise<void> {
    const vPath = versionPathFor(configPath);
    if (!vPath) return;
    try { await fs.unlink(vPath); } catch { /* no version sidecar */ }
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
      for (const filePath of files) {
        try {
          const raw = await this.cachedFS.readFile(filePath);
          const data = this.serializer.deserialize(toUint8Array(raw), filePath);
          this.configCache.set(filePath, data);
        } catch {
          // Skip unreadable files
        }
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
        console.error('[zen-fs-config] Conflict handler error:', err);
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
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          const fullPath = current === '/' ? `/${entry}` : `${current}/${entry}`;
          try {
            const stat = await this.cachedFS.stat(fullPath);
            if (stat.mode !== undefined && (stat.mode & 0o40000) === 0o40000) {
              stack.push(fullPath);
            } else {
              results.push(fullPath);
            }
          } catch {
            // Skip entries that can't be stated
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
      // Collect descriptor + file mtime for dedup
      const items: { desc: BackendDescriptor; mtime: number }[] = [];
      const corruptFiles: string[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
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
            items.push({ desc, mtime });
          } else {
            // Valid JSON but missing required fields — treat as corrupt
            console.warn(`[ConfigRepo] Backend descriptor ${entry} is missing id/type fields, marking for cleanup`);
            corruptFiles.push(filePath);
          }
        } catch (parseErr) {
          // JSON.parse failed — the file is corrupted.
          // This was the root cause of the "duplicate RemoteStorage backend" issue:
          // a corrupted .json file could never be parsed, so it was never recognized
          // as a duplicate, never got tombstoned, and kept being re-synced from remote.
          // Now we proactively delete corrupted files on all replicas + create a tombstone.
          console.warn(`[ConfigRepo] Backend descriptor ${entry} has corrupted JSON: ${parseErr}. Marking for cleanup.`);
          corruptFiles.push(filePath);
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
        console.log(
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
            await this.removeBackendDescriptor(dupId);
          }
        }
      }

      return Array.from(seen.values()).map(i => i.desc);
    } catch {
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
        type: 'IndexedDB',
        options: { storeName: '' }, // actual storeName is internal
        description: 'Local IndexedDB primary (implicit)',
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
    console.log(`[ConfigRepo] addBackend: creating ${id} (${type})...`);
    const instance = await createBackend({ type, options });
    const syncable = backendToSyncableFS(instance, `${type}(${id})`);

    // Save descriptor
    const desc: BackendDescriptor = { id, type, options, description };
    await this.writeBackendDescriptor(desc);

    // Register as replica
    const pair = this.syncEngine.addPair(
      this.fullFS,
      syncable,
      {
        direction: SyncDirection.BiDirectional,
        conflictStrategy: 'source-wins' as any,
      },
      '/',
    );

    this.replicaBackends.set(id, { instance, syncable, pairId: pair.pairId });

    // Register conflict handler
    const conflictHandler: SyncEventHandler = (event: SyncEvent) => {
      this.handleConflict(event);
    };
    this.syncEngine.on(pair.pairId, 'conflict', conflictHandler);

    console.log(`[ConfigRepo] addBackend: ${id} (${type}) added, sync pair=${pair.pairId}`);

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
    if (!replica) {
      throw new Error(`Backend "${id}" is not a registered replica`);
    }

    // 1. Delete the descriptor file on the remote backend DIRECTLY.
    //    This must happen BEFORE removing the sync pair, because once the
    //    sync pair is gone, we can no longer reach the remote through the
    //    normal sync flow. Without this, the remote keeps the file and
    //    another backend's sync pair would pull it back.
    const descPath = this.backendFilePath(id);
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
    console.log(`[ConfigRepo] removeBackend: sync pair ${replica.pairId} removed`);

    // 4. Remove from replica map
    this.replicaBackends.delete(id);

    // 5. Dispose backend instance
    if (replica.instance?.dispose) {
      await replica.instance.dispose();
    }

    console.log(`[ConfigRepo] removeBackend: ${id} removed (tombstone written, remote cleaned)`);
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
        console.warn(`[ConfigRepo] group-type already set to "${current}", ignoring request to set "${type}"`);
        return;
      }
    } catch {
      // File doesn't exist — write it
    }
    await this.ensureDir(GROUP_TYPE_FILE);
    await this.cachedFS.writeFile(GROUP_TYPE_FILE, new TextEncoder().encode(type));
    console.log(`[ConfigRepo] group-type set to "${type}"`);
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

    console.log(`[ConfigRepo] createAppDataGroup: creating "${id}" with ${backends.length} backend(s)`);

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
    console.log(`[ConfigRepo] createAppDataGroup: "${id}" created`);

    return group;
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
    console.log(`[ConfigRepo] removeAppDataGroup: "${id}" removed`);
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
    pollIntervalMs?: number,
  ) {
    this.groupId = groupId;
    this.appId = appId;
    this.syncEngine = new ZenFSSync();
    this.localFS = null as any;
    this.fs = null as any;
    this._backends = backends;
    this._pollIntervalMs = pollIntervalMs;
  }

  private _backends: AppDataBackendDescriptor[];
  private _pollIntervalMs?: number;

  async init(): Promise<void> {
    // Create local primary backend (InMemory for simplicity in tests/Node, IndexedDB in browser)
    try {
      this.localFS = await createBackend({
        type: 'InMemory',
        options: { label: `data-group-${this.groupId}-${Date.now()}` },
      });
    } catch {
      throw new Error(`Failed to create local primary for data group "${this.groupId}"`);
    }

    const localSyncable = backendToSyncableFS(this.localFS, `local(${this.groupId})`);
    this.fs = createChrootFS(this.localFS, '/');

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
        console.log(`[AppDataGroup:${this.groupId}] backend ${desc.id} (${desc.type}) connected, pair=${pair.pairId}`);
      } catch (err: any) {
        console.error(`[AppDataGroup:${this.groupId}] Failed to create backend ${desc.id} (${desc.type}):`, err);
      }
    }

    // Initial sync — pull data from remote backends (before watching)
    try {
      await this.syncEngine.syncAll();
    } catch (err) {
      console.warn(`[AppDataGroup:${this.groupId}] Initial sync failed:`, err);
    }

    // Now start watching — snapshots will reflect the synced state
    this.syncEngine.watchAll();
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

    console.log(`[AppDataGroup:${this.groupId}] addBackend: creating ${id} (${type})...`);
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

    const desc: AppDataBackendDescriptor = { id, type, options, description };
    this.dataBackends.set(id, { instance, syncable, pairId: pair.pairId, desc });
    console.log(`[AppDataGroup:${this.groupId}] addBackend: ${id} (${type}) connected, pair=${pair.pairId}`);

    // Initial sync FIRST, then watch (same pattern as ConfigRepo.addBackend)
    try {
      await this.syncEngine.sync(pair.pairId);
    } catch (err) {
      console.warn(`[AppDataGroup:${this.groupId}] addBackend: initial sync failed for ${id}:`, err);
    }
    this.syncEngine.watch(pair.pairId);
  }

  async removeBackend(id: string): Promise<void> {
    if (this.disposed) throw new Error('DataSyncGroup has been disposed');
    const backend = this.dataBackends.get(id);
    if (!backend) {
      throw new Error(`Backend "${id}" not found in data group "${this.groupId}"`);
    }

    this.syncEngine.removePair(backend.pairId);
    this.dataBackends.delete(id);

    if (backend.instance?.dispose) {
      await backend.instance.dispose();
    }

    console.log(`[AppDataGroup:${this.groupId}] removeBackend: ${id} removed`);
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
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
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
  // Step 1: Create IndexedDB as the local primary backend (always)
  // -------------------------------------------------------------------
  const idbStoreName = options.idbStoreName || `zen-fs-config-${appId}`;
  console.log(`[createConfigRepo] Creating IndexedDB primary (store: ${idbStoreName})...`);

  const primaryInstance = await createBackend({
    type: 'IndexedDB',
    options: { storeName: idbStoreName },
  });

  const cachedFS = primaryInstance;

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
    console.log(`[createConfigRepo] /.meta/ ready`);
  } catch (err: any) {
    console.error(`[createConfigRepo] Failed to ensure /.meta/:`, err.message);
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
      console.log(`[createConfigRepo] group-type set to "config-sync"`);
    }
  } catch (err: any) {
    console.warn(`[createConfigRepo] Failed to write group-type:`, err.message);
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
    console.log(`[createConfigRepo] Migrating ${oldBackendsMeta.backends.length} backend(s) from backends.json to individual files...`);
    await tempRepo.ensureDir(`${BACKENDS_DIR}/.keep`);
    for (const desc of oldBackendsMeta.backends) {
      // Skip the local IndexedDB primary — it's implicit, not stored
      if (desc.id === LOCAL_IDB_BACKEND_ID || desc.type === 'IndexedDB') {
        console.log(`[createConfigRepo] Skipping local backend ${desc.id} during migration`);
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
    console.log(`[createConfigRepo] Migration complete`);
  }

  // -------------------------------------------------------------------
  // Step 5: If backendInfo is provided, add as replica (if not present)
  // -------------------------------------------------------------------
  if (options.backendInfo) {
    const replicaId = options.primaryBackendId || `${options.backendInfo.type}-replica`;
    const allBackends = await tempRepo.readAllBackendDescriptors();
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
      console.log(`[createConfigRepo] Added replica backend: ${replicaId} (${options.backendInfo.type})`);
    } else if (dupConfig) {
      console.log(`[createConfigRepo] Replica with same config already registered as "${dupConfig.id}", skipping`);
    } else {
      console.log(`[createConfigRepo] Replica ${replicaId} already registered`);
    }
  }

  // -------------------------------------------------------------------
  // Step 6: Read all backends (replicas only, local-idb is implicit)
  // -------------------------------------------------------------------
  const allBackends = await tempRepo.readAllBackendDescriptors();
  console.log(`[createConfigRepo] Replica backends: ${allBackends.map(b => b.id).join(', ') || '(none)'}`);

  // -------------------------------------------------------------------
  // Step 7: Determine nodeId
  // nodeId is the caller's responsibility to persist (e.g. localStorage).
  // We no longer read/write /nodes/.node-id to avoid sync conflicts.
  // -------------------------------------------------------------------
  let nodeId = options.nodeId;
  if (!nodeId) {
    nodeId = `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[createConfigRepo] Generated nodeId: ${nodeId}`);
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

  // Load config cache from local IndexedDB (fast, no network)
  await repo.load();

  // Step 8b: Initial sync + dedup cycle.
  // setupSync creates sync pairs WITHOUT calling watch() (to avoid
  // buildInitialSnapshots caching a stale merged snapshot). Now we:
  //   1. unwatchAll() — safety: ensures no stale snapshots (no-op if never watched)
  //   2. syncAll() — full bidirectional sync, pulls remote-only files to local
  //   3. readAllBackendDescriptors() — dedup any duplicates pulled from remote
  //   4. processTombstones() — delete deduped files on all replicas
  //   5. watchAll() — start monitoring for future changes
  if (repo.replicaCount > 0) {
    console.log('[createConfigRepo] Initial sync + dedup cycle...');
    await repo.initialSyncAndDedup();
  }

  // Sync to replicas in the background — watchers are already running,
  // so this just speeds up the initial push. Don't block the caller.
  repo.syncMetaToReplicas().catch((err) => {
    console.error('[createConfigRepo] background syncMetaToReplicas failed:', err);
  });

  return repo;
}
