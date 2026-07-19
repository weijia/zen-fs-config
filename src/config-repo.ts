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
  SyncRulesMeta,
  SyncRule,
  BackendDescriptor,
  ConflictArchive,
  ConflictInfo,
} from './types';
import { createSerializerChain, configKeyToFilePath } from './serializer';
import { createChrootFS } from './context-fs';
import type { PathAwareSerializer } from './serializer';
import { backendToSyncableFS, cachedFSToSyncableFS } from './adapters';
import { createBackend } from './backend-registry';
import { versionPathFor, incrementVersion, writeVersion, readVersion } from './version';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const META_DIR = '/.meta';
const BACKENDS_FILE = `${META_DIR}/backends.json`;
const SYNC_RULES_FILE = `${META_DIR}/sync-rules.json`;
const CONFLICTS_DIR = `${META_DIR}/.conflicts`;
const NODES_DIR = '/nodes';
const SHARED_DIR = '/shared';
const NODE_ID_FILE = `${NODES_DIR}/.node-id`;

// ---------------------------------------------------------------------------
// Minimal async FS interface for internal use
// ---------------------------------------------------------------------------

interface MinimalAsyncFS {
  readFile(path: string, ...args: any[]): Promise<any>;
  writeFile(path: string, data: any, options?: any): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<any>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: any): Promise<any>;
  unlink(path: string): Promise<void>;
  rmdir?(path: string): Promise<void>;
  rename?(oldPath: string, newPath: string): Promise<void>;
}

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
  private replicaBackends: Map<string, { instance: any; syncable: SyncableFS }>;
  private onConflictCallback?: (conflict: ConflictInfo) => Promise<unknown | null>;
  private disposed = false;
  private configCache = new Map<string, unknown>();

  constructor(
    appId: string,
    nodeId: string,
    cachedFS: MinimalAsyncFS,
    serializer: PathAwareSerializer,
    onConflict?: (conflict: ConflictInfo) => Promise<unknown | null>,
  ) {
    this.appId = appId;
    this.nodeId = nodeId;
    this.cachedFS = cachedFS;
    this.serializer = serializer;
    this.syncEngine = new ZenFSSync();
    this.replicaBackends = new Map();
    this.onConflictCallback = onConflict;

    this.fullFS = cachedFSToSyncableFS(cachedFS);
    this.fs = createChrootFS(cachedFS, `/${appId}`);
    // rootFS = no chroot, so admin UI can browse /.meta/, /shared/, /nodes/, etc.
    this.rootFS = createChrootFS(cachedFS, '/');
  }

  // -----------------------------------------------------------------------
  // IConfigRepo — Load
  // -----------------------------------------------------------------------

  async load(rawConfig?: string): Promise<void> {
    this.assertNotDisposed();

    if (rawConfig) {
      const data = JSON.parse(rawConfig);
      if (data.backends) {
        await this.writeMetaFile(BACKENDS_FILE, {
          version: 1,
          backends: data.backends,
        } as BackendsMeta);
      }
      if (data.syncRules) {
        await this.writeMetaFile(SYNC_RULES_FILE, {
          version: 1,
          rules: data.syncRules,
        } as SyncRulesMeta);
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
    const resultsMap = await this.syncEngine.syncAll();
    return Array.from(resultsMap.values());
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

    const archivePath = `${CONFLICTS_DIR}/${conflictId}`;
    try {
      const raw = await this.cachedFS.readFile(archivePath);
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

      archive.resolvedContent = mergedContent;
      await this.cachedFS.writeFile(
        archivePath,
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
        if (!entry.endsWith('.json')) continue;
        try {
          const raw = await this.cachedFS.readFile(`${CONFLICTS_DIR}/${entry}`);
          const archive = JSON.parse(
            new TextDecoder().decode(toUint8Array(raw)),
          );
          archives.push(archive);
        } catch {
          // Skip invalid files
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
    return archives.sort((a, b) => a.timestamp - b.timestamp);
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
    rules: SyncRule[],
    backends: BackendDescriptor[],
    primaryBackendId: string,
  ): Promise<void> {
    console.log(`[ConfigRepo] setupSync: ${backends.length} backends, primary=${primaryBackendId}`);
    console.log(`[ConfigRepo] setupSync: rules=`, JSON.stringify(rules, null, 2));

    for (const desc of backends) {
      if (desc.id === primaryBackendId) continue;
      console.log(`[ConfigRepo] Creating replica backend: id=${desc.id}, type=${desc.type}`);
      try {
        const instance = await createBackend(desc);
        const syncable = backendToSyncableFS(instance);
        this.replicaBackends.set(desc.id, { instance, syncable });
        console.log(`[ConfigRepo] Replica ${desc.id} created successfully`);
      } catch (err: any) {
        console.error(`[ConfigRepo] Failed to create replica ${desc.id} (${desc.type}):`, err);
      }
    }

    console.log(`[ConfigRepo] Available replicas:`, Array.from(this.replicaBackends.keys()));

    for (const rule of rules) {
      if (rule.direction === 'none') continue;
      if (!rule.replicas?.length) {
        console.log(`[ConfigRepo] Skipping rule ${rule.prefix}: no replicas`);
        continue;
      }

      const zenSyncDirection =
        rule.direction === 'bi-directional'
          ? SyncDirection.BiDirectional
          : SyncDirection.OneWay;

      for (const replicaId of rule.replicas) {
        if (replicaId === primaryBackendId) continue;

        const replica = this.replicaBackends.get(replicaId);
        if (!replica) {
          console.warn(`[ConfigRepo] Skipping pair ${replicaId}: replica not found (available: ${Array.from(this.replicaBackends.keys()).join(', ')})`);
          continue;
        }

        const pair = this.syncEngine.addPair(
          this.fullFS,
          replica.syncable,
          {
            direction: zenSyncDirection,
            conflictStrategy: rule.conflictStrategy as any,
            filter: {
              includePrefixes: [rule.prefix],
            },
          },
          '/',
        );

        console.log(`[ConfigRepo] Sync pair added: pairId=${pair.pairId}, prefix=${rule.prefix}, dir=${rule.direction}, replica=${replicaId}`);

        // Register conflict handler using the pair's pairId (string)
        const conflictHandler: SyncEventHandler = (event: SyncEvent) => {
          this.handleConflict(event, rule);
        };
        this.syncEngine.on(pair.pairId, 'conflict', conflictHandler);

        // Start watching
        this.syncEngine.watch(pair.pairId);
      }
    }

    console.log(`[ConfigRepo] setupSync complete. Sync statuses:`, this.getSyncStatuses());
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

  private async handleConflict(event: SyncEvent, _rule: SyncRule): Promise<void> {
    const conflict = event.conflict;
    if (!conflict) return;

    const archive: ConflictArchive = {
      conflictPath: conflict.path,
      timestamp: event.timestamp,
      sourceAuthor: `${this.appId}/${this.nodeId}`,
      targetAuthor: 'unknown',
      sourceContent: this.tryParse(conflict.sourceContent),
      targetContent: this.tryParse(conflict.targetContent),
      sourceVersion: 0,
      targetVersion: 0,
      resolvedStrategy: conflict.resolvedWith as any,
    };

    try {
      const srcVer = await readVersion(this.fullFS, versionPathFor(conflict.path));
      if (srcVer) archive.sourceVersion = srcVer.version;
    } catch { /* ignore */ }

    const archiveFileName = `${event.timestamp}_${conflict.path.replace(/\//g, '_')}.conflict.json`;
    const archivePath = `${CONFLICTS_DIR}/${archiveFileName}`;

    await this.ensureDir(archivePath);
    await this.cachedFS.writeFile(
      archivePath,
      new TextEncoder().encode(JSON.stringify(archive, null, 2)),
    );

    if (this.onConflictCallback) {
      const info: ConflictInfo = {
        conflictId: archiveFileName,
        path: conflict.path,
        sourceAuthor: archive.sourceAuthor,
        targetAuthor: archive.targetAuthor,
        sourceContent: archive.sourceContent,
        targetContent: archive.targetContent,
      };
      try {
        const customMerge = await this.onConflictCallback(info);
        if (customMerge !== null && customMerge !== undefined) {
          await this.resolveConflict(archiveFileName, customMerge);
        }
      } catch (err) {
        console.error('[zen-fs-config] Conflict handler error:', err);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal — File System Helpers
  // -----------------------------------------------------------------------

  private async ensureDir(filePath: string): Promise<void> {
    const parts = filePath.split('/').filter(Boolean);
    parts.pop();
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      const exists = await this.fullFS.exists(current);
      console.log(`[ensureDir] ${current} exists=${exists}`);
      if (!exists) {
        try {
          console.log(`[ensureDir] mkdir(${current})`);
          await this.fullFS.mkdir(current);
          console.log(`[ensureDir] mkdir(${current}) OK`);
        } catch (err: any) {
          console.error(`[ensureDir] mkdir(${current}) FAILED:`, err.message);
          // Directory might already exist due to race
        }
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
            if (stat.isDirectory()) {
              stack.push(fullPath);
            } else if (stat.isFile()) {
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

  async writeMetaFile(path: string, data: BackendsMeta | SyncRulesMeta): Promise<void> {
    console.log(`[writeMetaFile] ${path}, ensuring dir...`);
    await this.ensureDir(path);
    console.log(`[writeMetaFile] ${path}, writing ${JSON.stringify(data).length} bytes...`);
    await this.cachedFS.writeFile(
      path,
      new TextEncoder().encode(JSON.stringify(data, null, 2)),
    );
    console.log(`[writeMetaFile] ${path} done`);
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
  // IConfigRepo — Meta file access (no chroot)
  // -----------------------------------------------------------------------

  async getBackends(): Promise<BackendsMeta | null> {
    this.assertNotDisposed();
    return this.readMetaFile<BackendsMeta>(BACKENDS_FILE);
  }

  async updateBackends(meta: BackendsMeta): Promise<void> {
    this.assertNotDisposed();
    await this.writeMetaFile(BACKENDS_FILE, meta);
  }

  async getSyncRules(): Promise<SyncRulesMeta | null> {
    this.assertNotDisposed();
    return this.readMetaFile<SyncRulesMeta>(SYNC_RULES_FILE);
  }

  async updateSyncRules(meta: SyncRulesMeta): Promise<void> {
    this.assertNotDisposed();
    await this.writeMetaFile(SYNC_RULES_FILE, meta);
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
  options: ConfigRepoOptions,
): Promise<IConfigRepo> {
  // -------------------------------------------------------------------
  // Step 1: Connect to primary backend
  // -------------------------------------------------------------------
  const primaryInstance = await createBackend({
    type: options.backendInfo.type,
    options: options.backendInfo.options,
  });

  // -------------------------------------------------------------------
  // Step 2: Wrap with zen-fs-cache
  // -------------------------------------------------------------------
  const zenCache = await import('zen-fs-cache');

  let cacheStore: any;
  const storeType = options.cache?.storeType ?? 'MemoryCacheStore';
  if (storeType === 'IdbCacheStore') {
    cacheStore = new zenCache.IdbCacheStore(options.cache?.storePrefix);
  } else {
    cacheStore = new zenCache.MemoryCacheStore();
  }

  const cachedFS = new zenCache.CachedFileSystem(
    primaryInstance as any,
    cacheStore,
    {
      ttlMs: options.cache?.ttlMs ?? 0,
    },
  );

  // Ensure /.meta/ directory exists before wrapping in cache.
  // On a fresh backend the directory may not exist yet, and
  // CachedFileSystem.mkdir → BackendInstance.mkdir may have issues.
  try {
    const metaExists = await primaryInstance.exists(META_DIR);
    console.log(`[createConfigRepo] /.meta/ exists: ${metaExists}`);
    if (!metaExists) {
      console.log(`[createConfigRepo] Creating /.meta/ via primaryInstance...`);
      await primaryInstance.mkdir(META_DIR);
      console.log(`[createConfigRepo] /.meta/ created`);
    }
  } catch (err: any) {
    console.error(`[createConfigRepo] Failed to ensure /.meta/:`, err.message);
  }

  // -------------------------------------------------------------------
  // Step 3: Read or create .meta/backends.json
  // -------------------------------------------------------------------
  const tempRepo = new ConfigRepo(
    appId, '', cachedFS, createSerializerChain(), undefined,
  );

  let backendsMeta = await tempRepo.readMetaFile<BackendsMeta>(BACKENDS_FILE);

  if (!backendsMeta) {
    if (options.bootstrap) {
      backendsMeta = {
        version: 1,
        backends: options.bootstrap.backends,
      };
      console.log(`[createConfigRepo] First init: using bootstrap backends: ${backendsMeta.backends.map(b => b.id).join(', ')}`);
    } else {
      backendsMeta = {
        version: 1,
        backends: [
          {
            id: options.primaryBackendId,
            type: options.backendInfo.type,
            options: options.backendInfo.options,
          },
        ],
      };
    }
  } else {
    console.log(`[createConfigRepo] Reconnect: using stored backends: ${backendsMeta.backends.map(b => b.id).join(', ')}`);
  }

  const hasPrimary = backendsMeta.backends.some(
    (b) => b.id === options.primaryBackendId,
  );
  if (!hasPrimary) {
    backendsMeta.backends.unshift({
      id: options.primaryBackendId,
      type: options.backendInfo.type,
      options: options.backendInfo.options,
    });
  }

  await tempRepo.writeMetaFile(BACKENDS_FILE, backendsMeta);

  // -------------------------------------------------------------------
  // Step 4: Read or create .meta/sync-rules.json
  // -------------------------------------------------------------------
  let syncRulesMeta = await tempRepo.readMetaFile<SyncRulesMeta>(SYNC_RULES_FILE);

  if (!syncRulesMeta) {
    if (options.bootstrap) {
      syncRulesMeta = {
        version: 1,
        rules: options.bootstrap.syncRules,
      };
      console.log(`[createConfigRepo] First init: using bootstrap syncRules: ${syncRulesMeta.rules.length} rules`);
    } else {
      syncRulesMeta = {
        version: 1,
        rules: [
          {
            prefix: `/${appId}/`,
            direction: 'one-way',
            conflictStrategy: 'source-wins' as any,
            replicas: backendsMeta.backends.map((b) => b.id),
          },
          {
            prefix: `${SHARED_DIR}/`,
            direction: 'bi-directional',
            conflictStrategy: 'merge' as any,
            replicas: backendsMeta.backends.map((b) => b.id),
          },
          { prefix: `${NODES_DIR}/`, direction: 'none' },
          { prefix: `${META_DIR}/`, direction: 'none' },
        ],
      };
    }
  }
  
  // On reconnect, log what we loaded
  if (syncRulesMeta) {
    console.log(`[createConfigRepo] Reconnect: using stored syncRules: ${syncRulesMeta.rules.length} rules`);
  }

  await tempRepo.writeMetaFile(SYNC_RULES_FILE, syncRulesMeta);

  // -------------------------------------------------------------------
  // Step 5: Determine nodeId
  // -------------------------------------------------------------------
  let nodeId = options.nodeId;
  if (!nodeId) {
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
      await cachedFS.writeFile(
        NODE_ID_FILE,
        new TextEncoder().encode(nodeId),
      );
    } catch {
      // Best effort
    }
  }

  // -------------------------------------------------------------------
  // Step 6: Create ConfigRepo and set up sync
  // -------------------------------------------------------------------
  const serializer = createSerializerChain(options.serializer);
  const repo = new ConfigRepo(
    appId,
    nodeId,
    cachedFS,
    serializer,
    options.onConflict,
  );

  await repo.setupSync(
    syncRulesMeta.rules,
    backendsMeta.backends,
    options.primaryBackendId,
  );

  await repo.load();

  return repo;
}