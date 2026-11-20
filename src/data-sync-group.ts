/**
 * zen-fs-config — Standalone Data-Sync Group
 *
 * A data-sync group provides direct file system access for app data,
 * without the config-sync meta layer. It can be used standalone or
 * referenced by a config-sync group via createAppDataGroup().
 */

import {
  ZenFSSync,
  SyncDirection,
  type SyncableFS,
  type SyncPairStatus,
  type SyncResult,
} from 'zen-fs-sync';
import type {
  AppDataGroup,
  BackendDescriptor,
  BackendSyncState,
  ConflictArchive,
  SyncGroupFeatures,
  TombstoneMeta,
  BackendConflictInfo,
  BackendConflictResolution,
  BackendConflictResolutionResult,
  IdentityCandidate,
  SetGroupInstanceIdOptions,
  SetGroupInstanceIdResult,
} from './types';
import { backendToSyncableFS } from './adapters';
import { createBackend, type BackendInstance } from './backend-registry';
import { resolveLocalPrimary } from './folder-backend';
import { createChrootFS } from './context-fs';
import { createLogger } from './logger';
import {
  CONFIG_DIR,
  DATA_GROUP_DEFAULT_FEATURES,
  META_DIR,
  TombstoneStore,
  VersionStore,
  isDeletableLegacyMetaPath,
  ConflictStore,
  normalizeTombstonePath,
  purgeTombstonedTree,
  readGroupDescriptor,
  writeGroupDescriptor,
} from './group-meta';
import {
  bindRemoteGroupIdentity,
  isValidGroupInstanceId,
  newGroupInstanceId,
} from './group-identity';
import { purgeMtimeSidecars, type PurgeMtimeOptions, type MtimePurgeResult } from './mtime-cleanup';
import { purgeKeepFiles, type PurgeKeepOptions, type KeepPurgeResult } from './keep-cleanup';

const log = createLogger('data-sync-group');

const GROUP_TYPE_FILE = `${META_DIR}/group-type`;
const BACKENDS_DIR = `${META_DIR}/backends`;

// ---------------------------------------------------------------------------
// DataSyncGroup — standalone implementation
// ---------------------------------------------------------------------------

/**
 * A standalone data-sync group.
 *
 * Creates a local InMemory (or IndexedDB in browser) primary backend,
 * sets up bi-directional sync with each registered data backend, and
 * provides direct fs access for reading/writing data files.
 */
export class DataSyncGroup implements AppDataGroup {
  readonly groupId: string;
  readonly appId: string;
  readonly kind = 'data' as const;
  readonly features: SyncGroupFeatures = DATA_GROUP_DEFAULT_FEATURES;
  name?: string;
  fs: any;

  private syncEngine: ZenFSSync;
  private localFS: BackendInstance;
  private dataBackends: Map<string, { instance: any; syncable: SyncableFS; pairId: string; desc: BackendDescriptor }> = new Map();
  private disposed = false;
  /** 组实例身份 —— 同步边界（见 `group-identity.ts`）。 */
  private instanceId?: string;
  /** 因归属其他同步组而被跳过的后端 id → 原因。 */
  private skippedBackends = new Map<string, string>();

  /** `.meta/` stores (deprecated standalone path keeps the same layout). */
  private tombstones: TombstoneStore;
  private versions: VersionStore;
  private conflicts: ConflictStore;

  constructor(
    appId: string,
    groupId: string,
    localFS: BackendInstance,
  ) {
    this.appId = appId;
    this.groupId = groupId;
    this.syncEngine = new ZenFSSync();
    this.localFS = localFS;
    this.fs = createChrootFS(localFS, '/');
    this.tombstones = new TombstoneStore(localFS, `local:${groupId}`);
    this.versions = new VersionStore(localFS, `${appId}/${groupId}`);
    this.conflicts = new ConflictStore(localFS, appId, groupId, this.versions);
  }

  // -----------------------------------------------------------------------
  // Unified SyncGroupHandle — common capabilities
  // -----------------------------------------------------------------------

  async rename(name: string): Promise<void> {
    this.name = name.trim();
  }

  /**
   * Delete with a tombstone. Standalone groups have no sync hooks, so the
   * tombstoned path is also removed directly on every connected backend.
   */
  async deleteFile(path: string): Promise<void> {
    if (this.disposed) throw new Error('DataSyncGroup has been disposed');
    const normalized = normalizeTombstonePath(path);
    if (
      normalized === META_DIR ||
      normalized === CONFIG_DIR ||
      normalized.startsWith(`${CONFIG_DIR}/`) ||
      (normalized.startsWith(`${META_DIR}/`) && !isDeletableLegacyMetaPath(normalized))
    ) {
      throw new Error(`Cannot delete metadata path "${normalized}"`);
    }

    // 目录：一条目录墓碑代替逐文件墓碑，应用时按树清理（含隐藏占位）。
    const isDirectory = await this.isDirectoryPath(normalized);
    const tombstone: TombstoneMeta = {
      path: normalized,
      deletedAt: Date.now(),
      deletedBy: `local:${this.groupId}`,
      confirmedBy: [`local:${this.groupId}`],
      ...(isDirectory ? { type: 'directory' as const } : {}),
    };
    await this.tombstones.write(tombstone);

    for (const target of [this.localFS, ...Array.from(this.dataBackends.values()).map(b => b.instance)]) {
      if (isDirectory) {
        await purgeTombstonedTree(target, normalized);
      } else {
        try { await target.unlink(normalized); } catch { /* already gone */ }
      }
    }
    if (!isDirectory) await this.versions.remove(normalized);
  }

  /** stat-based directory check that tolerates backends without stat(). */
  private async isDirectoryPath(p: string): Promise<boolean> {
    try {
      const st = await this.localFS.stat?.(p);
      if (!st) return false;
      if (typeof st.isDirectory === 'function') return st.isDirectory();
      const mode = Number(st.mode ?? 0);
      return mode > 0 && (mode & 0o170000) === 0o040000;
    } catch {
      return false;
    }
  }

  listConflicts(): Promise<ConflictArchive[]> {
    return this.conflicts.list();
  }

  async resolveConflict(conflictId: string, mergedContent: unknown): Promise<void> {
    const content = typeof mergedContent === 'string'
      ? mergedContent
      : JSON.stringify(mergedContent, null, 2);
    await this.conflicts.resolve(conflictId, content);
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

  getGroupInstanceId(): string | undefined {
    return this.instanceId;
  }

  listSkippedBackends(): { backendId: string; reason: string }[] {
    return Array.from(this.skippedBackends, ([backendId, reason]) => ({ backendId, reason }));
  }

  /** 已弃用的独立数据组：只保留兼容实现，不提供冲突对齐动作。 */
  listBackendConflicts(): BackendConflictInfo[] {
    return Array.from(this.skippedBackends, ([backendId, reason]) => ({
      backendId,
      reason,
      remote: null,
      local: { kind: 'data', id: this.groupId, instanceId: this.instanceId },
      canAdoptRemoteInstance: false,
      canRewriteRemoteIdentity: false,
    }));
  }

  async resolveBackendConflict(
    _backendId: string,
    mode: BackendConflictResolution,
  ): Promise<BackendConflictResolutionResult> {
    return {
      mode,
      ok: false,
      reason: '独立的 createDataSyncGroup 已弃用：请通过配置组（IConfigRepo）管理数据组后再对齐身份',
    };
  }

  /** 已弃用路径：独立数据组只在本地描述符里有一个候选，没有人群对齐能力。 */
  getIdentityCandidates(): IdentityCandidate[] {
    if (!this.instanceId) return [];
    return [{ source: 'local', instanceId: this.instanceId, rootCount: 1, kind: 'data', id: this.groupId }];
  }

  /** 已弃用路径：只写本地 `group.json`，不改写任何远端根。 */
  async setGroupInstanceId(
    instanceId: string,
    _options: SetGroupInstanceIdOptions = {},
  ): Promise<SetGroupInstanceIdResult> {
    if (!isValidGroupInstanceId(instanceId)) {
      return { ok: false, reason: '不是合法的 UUID v4', roots: [] };
    }
    this.instanceId = instanceId;
    await writeGroupDescriptor(this.localFS, {
      schemaVersion: 2,
      kind: 'data',
      id: this.groupId,
      instanceId,
      ...(this.name ? { name: this.name } : {}),
      features: this.features,
    });
    return { ok: true, instanceId, roots: [] };
  }

  /**
   * 读取 / 分配本组实例身份，并写入 `/.meta/group.json`。
   * 缺失时不生成随机值：先在本地描述符里找，仍没有就生成一次并固定。
   */
  private async ensureIdentity(): Promise<string> {
    if (this.instanceId) return this.instanceId;
    let existing = null as Awaited<ReturnType<typeof readGroupDescriptor>>;
    try {
      existing = await readGroupDescriptor(this.localFS);
    } catch { /* absent */ }
    const known = isValidGroupInstanceId(existing?.instanceId) ? existing!.instanceId : undefined;
    this.instanceId = known ?? newGroupInstanceId();
    if (!known) {
      await writeGroupDescriptor(this.localFS, {
        schemaVersion: 2,
        kind: 'data',
        id: this.groupId,
        instanceId: this.instanceId,
        ...(this.name ? { name: this.name } : {}),
        features: this.features,
      });
    }
    return this.instanceId;
  }

  /**
   * Add a data backend and set up bi-directional sync.
   */
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

    log(`addBackend: creating ${id} (${type})...`);
    const instance = await createBackend({ type, options });

    // 同步边界：远端根属于另一个同步组 → 不建同步对。
    try {
      const identity = await this.ensureIdentity();
      const state = await bindRemoteGroupIdentity(instance, {
        kind: 'data',
        id: this.groupId,
        instanceId: identity,
        ...(this.name ? { name: this.name } : {}),
        features: this.features,
      });
      if (state === 'conflict') {
        this.skippedBackends.set(id, '远端根属于另一个同步组（instanceId 不一致），已跳过该后端');
        try { await (instance as any).dispose?.(); } catch { /* best effort */ }
        log(`addBackend: ${id} skipped — remote root belongs to another sync group`);
        return;
      }
    } catch (err) {
      this.skippedBackends.set(id, `归属校验失败：${(err as Error)?.message ?? String(err)}`);
      try { await (instance as any).dispose?.(); } catch { /* best effort */ }
      log(`addBackend: ${id} skipped — ownership check failed:`, err);
      return;
    }

    const syncable = backendToSyncableFS(instance, `${type}(${id})`);

    const localSyncable = backendToSyncableFS(this.localFS, `local(${this.groupId})`);
    const pair = this.syncEngine.addPair(
      localSyncable,
      syncable,
      {
        direction: SyncDirection.BiDirectional,
        conflictStrategy: 'source-wins' as any,
      },
      '/',
    );

    this.dataBackends.set(id, { instance, syncable, pairId: pair.pairId, desc: { id, type, options, description } });
    this.syncEngine.watch(pair.pairId);
    log(`addBackend: ${id} (${type}) connected, pair=${pair.pairId}`);

    // Save descriptor
    await this.saveBackendDescriptor(id, type, options, description);

    // Initial sync
    try {
      await this.syncEngine.sync(pair.pairId);
    } catch (err) {
      log(`addBackend: initial sync failed for ${id}:`, err);
    }
  }

  /**
   * Remove a data backend.
   */
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

    // Remove descriptor file
    try {
      await this.localFS.unlink(`${BACKENDS_DIR}/${id}.json`);
    } catch { /* already gone */ }

    log(`removeBackend: ${id} removed`);
  }

  getSyncStatuses(): Map<string, SyncPairStatus> {
    return this.syncEngine.getStatusAll();
  }

  getBackendSyncStates(): Map<string, BackendSyncState> {
    const out = new Map<string, BackendSyncState>();
    for (const [id, b] of this.dataBackends) {
      out.set(id, { backendId: id, pairId: b.pairId });
    }
    return out;
  }

  async flush(): Promise<SyncResult[]> {
    const results = await this.syncEngine.syncAll();
    return Array.from(results.values());
  }

  listBackends(): BackendDescriptor[] {
    return Array.from(this.dataBackends.values()).map(b => b.desc);
  }

  /**
   * 旧版独立数据组没有 `.meta/backends/` 权威副本，声明列表等同已连接视图。
   * @deprecated 新代码请使用 `ConfigRepo.createAppDataGroup()`。
   */
  listDeclaredBackends(): BackendDescriptor[] {
    return this.listBackends();
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
    log(`disposed`);
  }

  // -----------------------------------------------------------------------
  // Internal — used by the factory function
  // -----------------------------------------------------------------------

  /**
   * Register a pre-created backend instance with the sync engine.
   * Used internally by createDataSyncGroup() to avoid double-creating backends.
   */
  _registerBackend(
    id: string,
    instance: BackendInstance,
    syncable: SyncableFS,
    pollIntervalMs?: number,
  ): string {
    const localSyncable = backendToSyncableFS(this.localFS, `local(${this.groupId})`);
    const pair = this.syncEngine.addPair(
      localSyncable,
      syncable,
      {
        direction: SyncDirection.BiDirectional,
        conflictStrategy: 'source-wins' as any,
        pollIntervalMs,
      },
      '/',
    );
    this.dataBackends.set(id, { instance, syncable, pairId: pair.pairId, desc: { id, type: instance.constructor?.name || 'unknown', options: {} } });
    this.syncEngine.watch(pair.pairId);
    return pair.pairId;
  }

  /** Run syncAll on the internal engine. */
  async _syncAll(): Promise<void> {
    await this.syncEngine.syncAll();
  }

  /** Get the number of registered data backends. */
  get _backendCount(): number {
    return this.dataBackends.size;
  }

  // -----------------------------------------------------------------------
  // Internal — descriptor persistence
  // -----------------------------------------------------------------------

  private async saveBackendDescriptor(
    id: string,
    type: string,
    options: Record<string, unknown>,
    description?: string,
  ): Promise<void> {
    const desc: BackendDescriptor = { id, type, options, description };
    const path = `${BACKENDS_DIR}/${id}.json`;
    await this.ensureDir(path);
    const bytes = new TextEncoder().encode(JSON.stringify(desc, null, 2));
    await this.localFS.writeFile(path, bytes);
  }

  private async ensureDir(filePath: string): Promise<void> {
    const parts = filePath.split('/').filter(Boolean);
    parts.pop();
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      try {
        await this.localFS.mkdir(current);
      } catch { /* already exists */ }
    }
  }
}

// ---------------------------------------------------------------------------
// createDataSyncGroup — Factory Function
// ---------------------------------------------------------------------------

export interface DataSyncGroupOptions {
  /** Connection info for the initial data backend. */
  backendInfo?: {
    type: string;
    options: Record<string, unknown>;
  };
  /** ID for the initial data backend. Default: auto-generated. */
  primaryBackendId?: string;
  /** Node identifier (for logging). */
  nodeId?: string;
  /** Sync polling interval in ms. */
  pollIntervalMs?: number;
  /**
   * Directory for the local primary backend on Node.js. Only applies on
   * Node.js (the local primary is otherwise InMemory); ignored in browsers.
   * Defaults to `$ZEN_FS_CONFIG_HOME` (or `~/.zen-fs-config`) when omitted.
   */
  folderPath?: string;
}

/**
 * Create a standalone data-sync group.
 *
 * @deprecated Data-sync groups are now always managed by a config-sync group
 * via `ConfigRepo.createAppDataGroup()` — there is no standalone top-level
 * entry (decision A in REQUIREMENTS.md §8). `connect()` no longer uses this;
 * kept only for backwards-compatible callers / tests. Prefer
 * `ConfigRepo.createAppDataGroup()`.
 *
 * 1. Connects to the user-provided backend
 * 2. Reads /.meta/group-type to verify it's a data-sync group (or new)
 * 3. Creates a local primary (InMemory in Node.js)
 * 4. Sets up bi-directional sync with all data backends
 * 5. Returns a DataSyncGroup handle with direct fs access
 */
export async function createDataSyncGroup(
  appId: string,
  options: DataSyncGroupOptions = {},
): Promise<DataSyncGroup> {
  const groupId = `data-${appId}-${Date.now().toString(36)}`;
  log(`createDataSyncGroup: appId=${appId} groupId=${groupId}`);

  // Step 1: Create local primary backend (Folder on Node, IndexedDB on browser)
  const localPrimary = await resolveLocalPrimary(appId, 'data', {
    folderPath: options.folderPath,
  });
  const localFS = await createBackend(localPrimary);

  // Step 2: Ensure /.meta/ exists and write group-type
  try {
    await localFS.mkdir(META_DIR);
  } catch { /* already exists */ }

  // Step 3: If backendInfo provided, check/create group-type and register backend
  if (options.backendInfo) {
    const remoteBackend = await createBackend({
      type: options.backendInfo.type,
      options: options.backendInfo.options,
    });

    // Check remote group-type
    try {
      const raw = await remoteBackend.readFile(GROUP_TYPE_FILE, 'utf-8');
      const remoteType = (raw as string).trim();
      if (remoteType === 'config-sync') {
        throw new Error(
          `Backend is a config-sync group, not data-sync. Use createConfigRepo() instead.`,
        );
      }
      // If "data-sync", that's fine — we'll read its backends
    } catch (err: any) {
      if (err.message?.includes('config-sync')) throw err;
      // File doesn't exist — write group-type on remote
      try {
        await remoteBackend.writeFile(
          GROUP_TYPE_FILE,
          new TextEncoder().encode('data-sync'),
        );
      } catch (writeErr: any) {
        log(`Could not write group-type on remote: ${writeErr.message}`);
      }
    }

    // Read remote backends (if any)
    let remoteBackendDescs: BackendDescriptor[] = [];
    try {
      const entries = await remoteBackend.readdir(BACKENDS_DIR);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        try {
          const raw = await remoteBackend.readFile(`${BACKENDS_DIR}/${entry}`);
          const desc = JSON.parse(new TextDecoder().decode(raw instanceof Uint8Array ? raw : new Uint8Array(raw)));
          if (desc.id && desc.type) remoteBackendDescs.push(desc);
        } catch { /* skip corrupt */ }
      }
    } catch {
      // No backends dir yet — that's fine
    }

    // Create the group
    const group = new DataSyncGroup(appId, groupId, localFS);

    // Write group-type on local
    try {
      await localFS.writeFile(GROUP_TYPE_FILE, new TextEncoder().encode('data-sync'));
    } catch { /* ignore */ }

    // Add the user-provided backend
    const backendId = options.primaryBackendId || `${options.backendInfo.type}-primary`;
    const desc: BackendDescriptor = {
      id: backendId,
      type: options.backendInfo.type,
      options: options.backendInfo.options,
    };

    // Save descriptor locally
    try {
      await localFS.mkdir(BACKENDS_DIR);
    } catch { /* exists */ }
    await localFS.writeFile(
      `${BACKENDS_DIR}/${backendId}.json`,
      new TextEncoder().encode(JSON.stringify(desc, null, 2)),
    );

    // Setup sync via internal method
    const remoteSyncable = backendToSyncableFS(remoteBackend, `${options.backendInfo.type}(${backendId})`);
    group._registerBackend(backendId, remoteBackend, remoteSyncable, options.pollIntervalMs);

    // Add any additional remote backends
    for (const rdesc of remoteBackendDescs) {
      if (rdesc.id === backendId) continue;
      try {
        const instance = await createBackend({ type: rdesc.type, options: rdesc.options });
        const syncable = backendToSyncableFS(instance, `${rdesc.type}(${rdesc.id})`);
        group._registerBackend(rdesc.id, instance, syncable, options.pollIntervalMs);
      } catch (err) {
        log(`Failed to add remote backend ${rdesc.id}:`, err);
      }
    }

    // Initial sync — pull data from remote
    try {
      await group._syncAll();
    } catch (err) {
      log(`Initial sync failed:`, err);
    }

    log(`createDataSyncGroup: ready with ${group._backendCount} backend(s)`);
    return group;
  }

  // No backendInfo — just local-only group
  const group = new DataSyncGroup(appId, groupId, localFS);
  try {
    await localFS.writeFile(GROUP_TYPE_FILE, new TextEncoder().encode('data-sync'));
  } catch { /* ignore */ }

  log(`createDataSyncGroup: local-only group created`);
  return group;
}
