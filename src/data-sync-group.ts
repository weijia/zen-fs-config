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
import type { AppDataGroup, BackendDescriptor } from './types';
import { backendToSyncableFS } from './adapters';
import { createBackend, type BackendInstance } from './backend-registry';
import { createChrootFS } from './context-fs';
import { createLogger } from './logger';

const log = createLogger('data-sync-group');

const META_DIR = '/.meta';
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
  fs: any;

  private syncEngine: ZenFSSync;
  private localFS: BackendInstance;
  private dataBackends: Map<string, { instance: any; syncable: SyncableFS; pairId: string; desc: BackendDescriptor }> = new Map();
  private disposed = false;

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

  async flush(): Promise<SyncResult[]> {
    const results = await this.syncEngine.syncAll();
    return Array.from(results.values());
  }

  listBackends(): BackendDescriptor[] {
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
}

/**
 * Create a standalone data-sync group.
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

  // Step 1: Create local primary backend
  const localFS = await createBackend({
    type: 'InMemory',
    options: { label: `data-sync-${appId}-${Date.now()}` },
  });

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
