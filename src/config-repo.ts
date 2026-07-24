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
} from './types';
import { createSerializerChain, configKeyToFilePath } from './serializer';
import { createChrootFS } from './context-fs';
import type { PathAwareSerializer } from './serializer';
import { backendToSyncableFS } from './adapters';
import { createBackend, type BackendInstance } from './backend-registry';
import { versionPathFor, incrementVersion, writeVersion, readVersion } from './version';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const META_DIR = '/.meta';
const BACKENDS_FILE = `${META_DIR}/backends.json`; // Legacy single-file format (pre-0.4.0)
const BACKENDS_DIR = `${META_DIR}/backends`;       // New: one JSON file per backend
const CONFLICTS_DIR = `${META_DIR}/.conflicts`;
const DELETIONS_DIR = `${META_DIR}/.deleted`;
const NODES_DIR = '/nodes';
const SHARED_DIR = '/shared';
const NODE_ID_FILE = `${NODES_DIR}/.node-id`;

/** Fixed ID for the local IndexedDB primary backend. */
const LOCAL_IDB_BACKEND_ID = 'local-idb';

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
  private onConflictCallback?: (conflict: ConflictInfo) => Promise<unknown | null>;
  private disposed = false;
  private configCache = new Map<string, unknown>();
  private readonly primaryBackendId: string;

  constructor(
    appId: string,
    nodeId: string,
    primaryBackendId: string,
    cachedFS: MinimalAsyncFS,
    serializer: PathAwareSerializer,
    onConflict?: (conflict: ConflictInfo) => Promise<unknown | null>,
  ) {
    this.appId = appId;
    this.nodeId = nodeId;
    this.primaryBackendId = primaryBackendId;
    this.cachedFS = cachedFS;
    this.serializer = serializer;
    this.syncEngine = new ZenFSSync();
    this.replicaBackends = new Map();
    this.onConflictCallback = onConflict;

    this.fullFS = backendToSyncableFS(cachedFS, primaryBackendId);
    this.fs = createChrootFS(cachedFS, `/${appId}`);
    // rootFS = no chroot, so admin UI can browse /.meta/, /shared/, /nodes/, etc.
    this.rootFS = createChrootFS(cachedFS, '/');
  }

  /** Full path to this node's directory on the primary backend. */
  get nodePath(): string {
    return `/nodes/${this.nodeId}`;
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
    // 3. Update tombstone confirmations + GC
    await this.updateTombstoneConfirmations();
    await this.gcTombstones();
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
    try {
      await this.cachedFS.unlink(versionPath);
    } catch { /* no version file */ }

    console.log(`[ConfigRepo] deleteFile: ${normalizedPath} (tombstone at ${tombstonePath})`);
  }

  /**
   * Read all tombstones from the primary backend.
   */
  private async readTombstones(): Promise<TombstoneMeta[]> {
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
      return tombstones;
    } catch {
      return []; // DELETIONS_DIR doesn't exist yet
    }
  }

  /**
   * Before sync: for each tombstone, delete the actual file on all replicas.
   * This prevents bi-directional sync from copying the file back.
   */
  private async processTombstones(): Promise<void> {
    const tombstones = await this.readTombstones();
    if (tombstones.length === 0) return;

    console.log(`[ConfigRepo] processTombstones: ${tombstones.length} tombstone(s)`);

    for (const tombstone of tombstones) {
      // Delete on primary (in case it was re-created)
      try { await this.cachedFS.unlink(tombstone.path); } catch { /* already gone */ }
      try { await this.cachedFS.unlink(versionPathFor(tombstone.path)); } catch { /* no version */ }

      // Delete on all replicas
      for (const [replicaId, replica] of this.replicaBackends) {
        try {
          await replica.instance.unlink(tombstone.path);
        } catch { /* not on this replica */ }
        try {
          await replica.instance.unlink(versionPathFor(tombstone.path));
        } catch { /* no version */ }
        console.log(`[ConfigRepo] tombstone ${tombstone.path}: deleted on ${replicaId}`);
      }
    }
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
      await writeVersion(this.fullFS, versionPathFor(configPath), version);

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
    this.configCache.clear();
  }

  // -----------------------------------------------------------------------
  // Internal — Setup
  // -----------------------------------------------------------------------

  async setupSync(
    backends: BackendDescriptor[],
    primaryBackendId: string,
  ): Promise<void> {
    console.log(`[ConfigRepo] setupSync: ${backends.length} backends, primary=${primaryBackendId}`);

    for (const desc of backends) {
      if (desc.id === primaryBackendId) continue;
      if ((desc as any).enabled === false) {
        console.log(`[ConfigRepo] Skipping disabled replica: ${desc.id}`);
        continue;
      }
      console.log(`[ConfigRepo] Creating replica backend: id=${desc.id}, type=${desc.type}`);
      try {
        const instance = await createBackend(desc);
        const syncable = backendToSyncableFS(instance, `${desc.type}(${desc.id})`);

        // Create sync pair
        const pair = this.syncEngine.addPair(
          this.fullFS,
          syncable,
          {
            direction: SyncDirection.BiDirectional,
            conflictStrategy: 'source-wins' as any,
          },
          '/',
        );

        this.replicaBackends.set(desc.id, { instance, syncable, pairId: pair.pairId });

        // Register conflict handler
        const conflictHandler: SyncEventHandler = (event: SyncEvent) => {
          this.handleConflict(event);
        };
        this.syncEngine.on(pair.pairId, 'conflict', conflictHandler);
        this.syncEngine.watch(pair.pairId);

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

  private async persistConfig(fullPath: string, bytes: Uint8Array): Promise<void> {
    await this.ensureDir(fullPath);
    await this.cachedFS.writeFile(fullPath, bytes);

    const author = `${this.appId}/${this.nodeId}`;
    const version = await incrementVersion(this.fullFS, fullPath, bytes, author);
    await this.ensureDir(versionPathFor(fullPath));
    await writeVersion(this.fullFS, versionPathFor(fullPath), version);
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
      const srcVer = await readVersion(this.fullFS, versionPathFor(conflict.path));
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
    await this.ensureDir(versionPathFor(path));
    await writeVersion(this.fullFS, versionPathFor(path), version);
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

  /** Read all backend descriptors from .meta/backends/*.json */
  async readAllBackendDescriptors(): Promise<BackendDescriptor[]> {
    try {
      const entries = await this.cachedFS.readdir(BACKENDS_DIR);
      const descriptors: BackendDescriptor[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          const raw = await this.cachedFS.readFile(`${BACKENDS_DIR}/${entry}`);
          descriptors.push(JSON.parse(new TextDecoder().decode(toUint8Array(raw))));
        } catch { /* skip corrupt file */ }
      }
      return descriptors;
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
    await this.ensureDir(versionPathFor(path));
    await writeVersion(this.fullFS, versionPathFor(path), version);
  }

  /** Remove a single backend descriptor file + its version sidecar */
  async removeBackendDescriptor(id: string): Promise<void> {
    const path = this.backendFilePath(id);
    try { await this.cachedFS.unlink(path); } catch { /* already gone */ }
    try { await this.cachedFS.unlink(versionPathFor(path)); } catch { /* no version */ }
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

    // Remove any backend files that are no longer in the list
    const keepIds = new Set(replicas.map(b => b.id));
    const current = await this.readAllBackendDescriptors();
    for (const desc of current) {
      if (!keepIds.has(desc.id)) {
        await this.removeBackendDescriptor(desc.id);
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

    // Check if already exists
    const existing = await this.readAllBackendDescriptors();
    if (existing.some(b => b.id === id)) {
      throw new Error(`Backend "${id}" already exists. Use removeBackend() first.`);
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
    this.syncEngine.watch(pair.pairId);

    console.log(`[ConfigRepo] addBackend: ${id} (${type}) added, sync pair=${pair.pairId}`);

    // Trigger initial sync to pull/push data
    await this.syncMetaToReplicas();
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

    // Stop watching and remove sync pair
    this.syncEngine.removePair(replica.pairId);
    console.log(`[ConfigRepo] removeBackend: sync pair ${replica.pairId} removed`);

    // Remove from replica map
    this.replicaBackends.delete(id);

    // Dispose backend instance
    if (replica.instance?.dispose) {
      await replica.instance.dispose();
    }

    // Remove descriptor file
    await this.removeBackendDescriptor(id);
    console.log(`[ConfigRepo] removeBackend: ${id} removed`);
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
  // Step 3: Create temp repo for meta operations (nodeId not yet known)
  // -------------------------------------------------------------------
  const tempRepo = new ConfigRepo(
    appId, '', LOCAL_IDB_BACKEND_ID, cachedFS, createSerializerChain(), undefined,
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
    try { await cachedFS.unlink(versionPathFor(BACKENDS_FILE)); } catch { /* ignore */ }
    console.log(`[createConfigRepo] Migration complete`);
  }

  // -------------------------------------------------------------------
  // Step 5: If backendInfo is provided, add as replica (if not present)
  // -------------------------------------------------------------------
  if (options.backendInfo) {
    const replicaId = options.primaryBackendId || `${options.backendInfo.type}-replica`;
    const allBackends = await tempRepo.readAllBackendDescriptors();
    const hasReplica = allBackends.some(b => b.id === replicaId);
    if (!hasReplica) {
      await tempRepo.writeBackendDescriptor({
        id: replicaId,
        type: options.backendInfo.type,
        options: options.backendInfo.options,
      });
      console.log(`[createConfigRepo] Added replica backend: ${replicaId} (${options.backendInfo.type})`);
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
  // -------------------------------------------------------------------
  let nodeId = options.nodeId;
  if (!nodeId && typeof process !== 'undefined' && process.env?.NODE_ID) {
    nodeId = process.env.NODE_ID;
  }
  if (!nodeId) {
    try {
      const raw = await cachedFS.readFile(NODE_ID_FILE);
      nodeId = new TextDecoder().decode(toUint8Array(raw)).trim();
    } catch {
      // File doesn't exist
    }
  }
  if (!nodeId) {
    nodeId = `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await cachedFS.writeFile(NODE_ID_FILE, new TextEncoder().encode(nodeId));
    } catch {
      // Best effort
    }
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
  );

  await repo.setupSync(allBackends, LOCAL_IDB_BACKEND_ID);

  // Push .meta/ files to all replicas so topology is available everywhere
  await repo.syncMetaToReplicas();

  await repo.load();

  return repo;
}
