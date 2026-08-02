/**
 * Tests for backend deduplication fixes:
 * 1. Stable key: same options with different key ordering should be detected as duplicate
 * 2. addBackend rejects duplicate configurations (same type+options, different ID)
 * 3. createConfigRepo skips writing duplicate descriptors (needs persistent mock)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo, ConfigRepo } from '../config-repo';
import type { BackendDescriptor } from '../types';

// --- Persistent mock IndexedDB for cross-connection tests ---

const persistentStores = new Map<string, Map<string, Uint8Array>>();

function createPersistentMock(storeName: string): BackendInstance {
  let store = persistentStores.get(storeName);
  if (!store) {
    store = new Map();
    persistentStores.set(storeName, store);
  }

  return {
    async readFile(path: string, ...args: any[]) {
      const data = store!.get(path);
      if (!data) throw new Error(`ENOENT: ${path}`);
      if (args[0] === 'utf-8') return new TextDecoder().decode(data);
      return data;
    },
    async writeFile(path: string, data: string | Uint8Array | ArrayBuffer) {
      const bytes = data instanceof Uint8Array ? data
        : data instanceof ArrayBuffer ? new Uint8Array(data)
        : new TextEncoder().encode(data);
      store!.set(path, bytes);
    },
    async readdir(path: string) {
      const prefix = path.endsWith('/') ? path : path + '/';
      const entries = new Set<string>();
      for (const key of store!.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const firstSlash = rest.indexOf('/');
          entries.add(firstSlash === -1 ? rest : rest.slice(0, firstSlash));
        }
      }
      if (path === '/') {
        for (const key of store!.keys()) {
          const trimmed = key.replace(/^\//, '');
          const firstSlash = trimmed.indexOf('/');
          entries.add(firstSlash === -1 ? trimmed : trimmed.slice(0, firstSlash));
        }
      }
      return Array.from(entries);
    },
    async stat(path: string) {
      const data = store!.get(path);
      if (data) return { mode: 0o100644, size: data.byteLength, mtimeMs: Date.now() };
      const prefix = path.endsWith('/') ? path : path + '/';
      for (const key of store!.keys()) {
        if (key.startsWith(prefix) || key.startsWith(path + '/')) {
          return { mode: 0o040000, size: 0, mtimeMs: Date.now() };
        }
      }
      throw new Error(`ENOENT: ${path}`);
    },
    async exists(path: string) {
      if (store!.has(path)) return true;
      const prefix = path.endsWith('/') ? path : path + '/';
      for (const key of store!.keys()) {
        if (key.startsWith(prefix) || key.startsWith(path + '/')) return true;
      }
      return false;
    },
    async mkdir(path: string) { /* no-op */ },
    async unlink(path: string) { store!.delete(path); },
    async rmdir(path: string) { /* no-op */ },
    async dispose() { /* keep store for cross-connection persistence */ },
  };
}

// --- Shared mock backend for sync tests (simulates a remote storage) ---

const sharedMockStores = new Map<string, Map<string, Uint8Array>>();

function createSharedMockBackend(storeKey: string): BackendInstance {
  let store = sharedMockStores.get(storeKey);
  if (!store) {
    store = new Map();
    sharedMockStores.set(storeKey, store);
  }

  return {
    async readFile(path: string, ...args: any[]) {
      const data = store!.get(path);
      if (!data) throw new Error(`ENOENT: ${path}`);
      if (args[0] === 'utf-8') return new TextDecoder().decode(data);
      return data;
    },
    async writeFile(path: string, data: string | Uint8Array | ArrayBuffer) {
      const bytes = data instanceof Uint8Array ? data
        : data instanceof ArrayBuffer ? new Uint8Array(data)
        : new TextEncoder().encode(data);
      store!.set(path, bytes);
    },
    async readdir(path: string) {
      const prefix = path.endsWith('/') ? path : path + '/';
      const entries = new Set<string>();
      for (const key of store!.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const firstSlash = rest.indexOf('/');
          entries.add(firstSlash === -1 ? rest : rest.slice(0, firstSlash));
        }
      }
      if (path === '/') {
        for (const key of store!.keys()) {
          const trimmed = key.replace(/^\//, '');
          const firstSlash = trimmed.indexOf('/');
          entries.add(firstSlash === -1 ? trimmed : trimmed.slice(0, firstSlash));
        }
      }
      return Array.from(entries);
    },
    async stat(path: string) {
      const data = store!.get(path);
      if (data) return { mode: 0o100644, size: data.byteLength, mtimeMs: Date.now() };
      const prefix = path.endsWith('/') ? path : path + '/';
      for (const key of store!.keys()) {
        if (key.startsWith(prefix) || key.startsWith(path + '/')) {
          return { mode: 0o040000, size: 0, mtimeMs: Date.now() };
        }
      }
      throw new Error(`ENOENT: ${path}`);
    },
    async exists(path: string) {
      if (store!.has(path)) return true;
      const prefix = path.endsWith('/') ? path : path + '/';
      for (const key of store!.keys()) {
        if (key.startsWith(prefix) || key.startsWith(path + '/')) return true;
      }
      return false;
    },
    async mkdir(path: string) { /* no-op */ },
    async unlink(path: string) { store!.delete(path); },
    async rmdir(path: string) { /* no-op */ },
    async dispose() { /* keep store for cross-connection persistence */ },
  };
}

// Register MockShared backend for sync tests
beforeAll(() => {
  registerBackend('MockShared', async (options) => {
    return createSharedMockBackend(options.storeKey as string);
  });
});

// Mock IndexedDB: use persistent mock for same storeName, InMemory otherwise
let persistentStoreCounter = 0;
beforeAll(() => {
  registerBackend('IndexedDB', async (options) => {
    const storeName = options.storeName as string;
    if (storeName && storeName.startsWith('persistent-')) {
      return createPersistentMock(storeName);
    }
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${storeName ?? Date.now()}` },
    });
  });
});

describe('Backend deduplication — stable key ordering', () => {
  it('detects duplicate backends with same options but different key order', async () => {
    const repo = await createConfigRepo('test-dedup-keyorder', { nodeId: 'test-node' }) as ConfigRepo;

    const opts1 = { token: 'abc', owner: 'user', repo: 'my-repo' };
    const opts2 = { owner: 'user', token: 'abc', repo: 'my-repo' };

    await repo.writeBackendDescriptor({ id: 'gitee-1', type: 'Gitee', options: opts1 as any });
    await new Promise(r => setTimeout(r, 10));
    await repo.writeBackendDescriptor({ id: 'gitee-2', type: 'Gitee', options: opts2 as any });

    const result = await repo.readAllBackendDescriptors();
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('gitee-1');

    await repo.dispose();
  });

  it('detects duplicate backends with nested objects in different key order', async () => {
    const repo = await createConfigRepo('test-dedup-nested', { nodeId: 'test-node' }) as ConfigRepo;

    const opts1 = { config: { branch: 'main', repo: 'data' }, token: 'abc' };
    const opts2 = { token: 'abc', config: { repo: 'data', branch: 'main' } };

    await repo.writeBackendDescriptor({ id: 'b1', type: 'TestType', options: opts1 as any });
    await new Promise(r => setTimeout(r, 10));
    await repo.writeBackendDescriptor({ id: 'b2', type: 'TestType', options: opts2 as any });

    const result = await repo.readAllBackendDescriptors();
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('b1');

    await repo.dispose();
  });

  it('does NOT deduplicate backends with actually different options', async () => {
    const repo = await createConfigRepo('test-dedup-diff', { nodeId: 'test-node' }) as ConfigRepo;

    await repo.writeBackendDescriptor({
      id: 'gitee-prod', type: 'Gitee',
      options: { token: 'abc', owner: 'user', repo: 'prod-repo' } as any,
    });
    await repo.writeBackendDescriptor({
      id: 'gitee-dev', type: 'Gitee',
      options: { token: 'abc', owner: 'user', repo: 'dev-repo' } as any,
    });

    const result = await repo.readAllBackendDescriptors();
    expect(result.length).toBe(2);

    await repo.dispose();
  });
});

describe('addBackend — duplicate configuration rejection', () => {
  it('rejects adding a backend with same type+options but different ID', async () => {
    const repo = await createConfigRepo('test-add-dup', { nodeId: 'test-node' }) as ConfigRepo;

    await repo.addBackend('gitee-prod', 'InMemory', { label: 'shared-store' });

    await expect(
      repo.addBackend('gitee-backup', 'InMemory', { label: 'shared-store' }),
    ).rejects.toThrow(/same configuration as existing backend "gitee-prod"/);

    await repo.dispose();
  });

  it('rejects adding a backend with same type+options but different key order', async () => {
    const repo = await createConfigRepo('test-add-dup-order', { nodeId: 'test-node' }) as ConfigRepo;

    await repo.addBackend('b1', 'InMemory', { label: 'store', maxSize: 100 });

    await expect(
      repo.addBackend('b2', 'InMemory', { maxSize: 100, label: 'store' }),
    ).rejects.toThrow(/same configuration as existing backend "b1"/);

    await repo.dispose();
  });

  it('allows adding backends with same type but different options', async () => {
    const repo = await createConfigRepo('test-add-diff', { nodeId: 'test-node' }) as ConfigRepo;

    await repo.addBackend('mem-1', 'InMemory', { label: 'store-a' });
    await repo.addBackend('mem-2', 'InMemory', { label: 'store-b' });

    const backends = await repo.readAllBackendDescriptors();
    expect(backends.length).toBe(2);

    await repo.dispose();
  });
});

describe('createConfigRepo — duplicate prevention on connect', () => {
  it('does not create duplicate descriptor when connecting with same config but different ID', async () => {
    const appId = 'test-connect-dedup';
    const storeName = `persistent-${appId}-${++persistentStoreCounter}`;

    // First connection: creates a replica with ID 'gitee-prod'
    const repo1 = await createConfigRepo(appId, {
      idbStoreName: storeName,
      backendInfo: { type: 'InMemory', options: { label: 'shared-store' } },
      primaryBackendId: 'gitee-prod',
      nodeId: 'node-1',
    }) as ConfigRepo;

    const backends1 = await repo1.readAllBackendDescriptors();
    expect(backends1.length).toBe(1);
    expect(backends1[0].id).toBe('gitee-prod');

    await repo1.dispose();

    // Second connection: SAME backend config but different (default) ID
    const repo2 = await createConfigRepo(appId, {
      idbStoreName: storeName,
      backendInfo: { type: 'InMemory', options: { label: 'shared-store' } },
      nodeId: 'node-2',
    }) as ConfigRepo;

    const backends2 = await repo2.readAllBackendDescriptors();
    expect(backends2.length).toBe(1);
    expect(backends2[0].id).toBe('gitee-prod');

    await repo2.dispose();
  });

  it('does not create duplicate when key order differs in options', async () => {
    const appId = 'test-connect-dedup-order';
    const storeName = `persistent-${appId}-${++persistentStoreCounter}`;

    // First connection with options in one order
    const repo1 = await createConfigRepo(appId, {
      idbStoreName: storeName,
      backendInfo: { type: 'InMemory', options: { label: 'store', maxSize: 200 } },
      primaryBackendId: 'mem-1',
      nodeId: 'node-1',
    }) as ConfigRepo;

    await repo1.dispose();

    // Second connection with same options in different key order
    const repo2 = await createConfigRepo(appId, {
      idbStoreName: storeName,
      backendInfo: { type: 'InMemory', options: { maxSize: 200, label: 'store' } },
      primaryBackendId: 'mem-2',
      nodeId: 'node-2',
    }) as ConfigRepo;

    const backends = await repo2.readAllBackendDescriptors();
    expect(backends.length).toBe(1);
    expect(backends[0].id).toBe('mem-1');

    await repo2.dispose();
  });
});

describe('readAllBackendDescriptors — corrupted JSON cleanup', () => {
  it('detects and removes corrupted backend descriptor files (malformed JSON)', async () => {
    const appId = 'test-corrupt-json-cleanup';
    const idbStore = `persistent-${appId}`;

    const repo = await createConfigRepo(appId, {
      idbStoreName: idbStore,
      nodeId: 'node-1',
    }) as ConfigRepo;

    // Write a valid backend descriptor
    await repo.writeBackendDescriptor({
      id: 'valid-backend',
      type: 'InMemory',
      options: { label: 'test-store' },
    });

    // Manually write a CORRUPTED descriptor file (malformed JSON with trailing garbage)
    // This simulates the real-world issue found in the Gitee configs repository where
    // remotestorage.json had trailing garbage '}步"' after the closing brace.
    const corruptContent = '{"id":"corrupt-rs","type":"RemoteStorage","options":{"href":"https://storage.example.com/","token":"abc","basePath":"/configs"}}garbage';
    const localStore = persistentStores.get(idbStore)!;
    localStore.set('/.meta/backends/corrupt-rs.json', new TextEncoder().encode(corruptContent));

    // readAllBackendDescriptors should detect the corrupted file and clean it up
    const result = await repo.readAllBackendDescriptors();

    // Only the valid backend should remain
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('valid-backend');

    // The corrupted file should have been deleted locally
    expect(localStore.has('/.meta/backends/corrupt-rs.json')).toBe(false);

    // A tombstone should have been created for the corrupted file
    const deletedEntries = await repo.rootFS.promises.readdir('/.meta/.deleted').catch(() => []);
    const corruptTombstone = deletedEntries.find((f: string) => f.includes('corrupt-rs'));
    expect(corruptTombstone).toBeDefined();

    await repo.dispose();
  });

  it('detects and removes descriptors missing required id/type fields', async () => {
    const appId = 'test-missing-fields-cleanup';
    const idbStore = `persistent-${appId}`;

    const repo = await createConfigRepo(appId, {
      idbStoreName: idbStore,
      nodeId: 'node-1',
    }) as ConfigRepo;

    // Write a valid backend descriptor
    await repo.writeBackendDescriptor({
      id: 'good-backend',
      type: 'InMemory',
      options: { label: 'good-store' },
    });

    // Write a descriptor file with valid JSON but missing 'type' field
    const incompleteContent = JSON.stringify({
      id: 'incomplete-backend',
      options: { label: 'some-store' },
      // missing "type" field
    }, null, 2);
    const localStore = persistentStores.get(idbStore)!;
    localStore.set('/.meta/backends/incomplete-backend.json', new TextEncoder().encode(incompleteContent));

    const result = await repo.readAllBackendDescriptors();

    // Only the valid backend should remain
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('good-backend');

    // The incomplete file should have been deleted
    expect(localStore.has('/.meta/backends/incomplete-backend.json')).toBe(false);

    await repo.dispose();
  });

  it('corrupted file does not reappear after flush (tombstone prevents re-sync)', async () => {
    const appId = 'test-corrupt-no-resync';
    const sharedStoreKey = `shared-${appId}-${Date.now()}`;
    const idbStore = `persistent-${appId}`;

    // Create a repo with a MockShared backend
    const repo = await createConfigRepo(appId, {
      idbStoreName: idbStore,
      backendInfo: { type: 'MockShared', options: { storeKey: sharedStoreKey } },
      primaryBackendId: 'rs-1',
      nodeId: 'node-1',
    }) as ConfigRepo;

    await new Promise(r => setTimeout(r, 100));
    await repo.flush();

    // Manually inject a corrupted descriptor into the REMOTE store
    const remoteStore = sharedMockStores.get(sharedStoreKey)!;
    const corruptContent = '{"id":"corrupt-rs","type":"MockShared","options":{"storeKey":"' + sharedStoreKey + '"}}TRAILING_GARBAGE';
    remoteStore.set('/.meta/backends/corrupt-rs.json', new TextEncoder().encode(corruptContent));
    remoteStore.set('/.meta/backends/.corrupt-rs.json.version', new TextEncoder().encode(
      JSON.stringify({ version: 1, hash: 'fake', author: 'remote', timestamp: Date.now() }),
    ));

    // Flush — sync will pull the corrupted file from remote,
    // then readAllBackendDescriptors (called in post-sync dedup) should detect and clean it
    await repo.flush();

    // The corrupted file should be gone from local
    const localStore = persistentStores.get(idbStore)!;
    expect(localStore.has('/.meta/backends/corrupt-rs.json')).toBe(false);

    // The corrupted file should also be gone from remote (deleted by dedup cleanup)
    expect(remoteStore.has('/.meta/backends/corrupt-rs.json')).toBe(false);

    // Flush again to make sure it doesn't come back
    await repo.flush();
    expect(localStore.has('/.meta/backends/corrupt-rs.json')).toBe(false);
    expect(remoteStore.has('/.meta/backends/corrupt-rs.json')).toBe(false);

    // Only rs-1 should remain
    const backends = await repo.readAllBackendDescriptors();
    expect(backends.length).toBe(1);
    expect(backends[0].id).toBe('rs-1');

    await repo.dispose();
  });
});

describe('dedup during createConfigRepo — survives sync re-introduction', () => {
  it('two identical backends on remote: createConfigRepo deduplicates and sync does not bring back the deleted one', async () => {
    const appId = 'test-dedup-survives-sync';
    const sharedStoreKey = `shared-${appId}-${Date.now()}`;
    const idbStore = `persistent-${appId}`;

    // Phase 1: Create a repo with one MockShared backend "rs-1"
    // This pushes rs-1.json to the shared remote store.
    const repo1 = await createConfigRepo(appId, {
      idbStoreName: idbStore,
      backendInfo: { type: 'MockShared', options: { storeKey: sharedStoreKey } },
      primaryBackendId: 'rs-1',
      nodeId: 'node-1',
    }) as ConfigRepo;

    await new Promise(r => setTimeout(r, 100));
    await repo1.flush();
    await repo1.dispose();

    // Phase 2: Manually write a SECOND descriptor with same config but different ID
    // directly into the shared store, simulating a pre-existing duplicate.
    const remoteStore = sharedMockStores.get(sharedStoreKey)!;
    const rs2Desc = JSON.stringify({
      id: 'rs-2',
      type: 'MockShared',
      options: { storeKey: sharedStoreKey },
    }, null, 2);
    remoteStore.set('/.meta/backends/rs-2.json', new TextEncoder().encode(rs2Desc));
    // Also add a version sidecar like writeBackendDescriptor would
    remoteStore.set('/.meta/backends/.rs-2.json.version', new TextEncoder().encode(
      JSON.stringify({ version: 1, hash: 'fake', author: 'test', timestamp: Date.now() }),
    ));

    // Verify both exist on remote
    expect(remoteStore.has('/.meta/backends/rs-1.json')).toBe(true);
    expect(remoteStore.has('/.meta/backends/rs-2.json')).toBe(true);

    // Phase 3: Reconnect. createConfigRepo will:
    //   Step 6: readAllBackendDescriptors → dedup (rs-1 and rs-2 have same config)
    //   Step 8: setupSync (only surviving backend gets a sync pair)
    //   syncMetaToReplicas → flush → processTombstones + syncAll
    //
    // The key question: does the deleted duplicate (rs-2) survive the sync,
    // or does syncAll bring it back from remote?
    const repo2 = await createConfigRepo(appId, {
      idbStoreName: idbStore,
      nodeId: 'node-2',
    }) as ConfigRepo;

    // Wait for background sync
    await new Promise(r => setTimeout(r, 200));

    // Check: only ONE backend should exist
    const backends = await repo2.readAllBackendDescriptors();
    expect(backends.length).toBe(1);

    // Check: rs-2 should NOT exist on remote anymore
    // (processTombstones should have deleted it via rs-1's sync pair)
    expect(remoteStore.has('/.meta/backends/rs-2.json')).toBe(false);

    // Check: rs-2 should NOT exist on local either
    expect(persistentStores.get(idbStore)!.has('/.meta/backends/rs-2.json')).toBe(false);

    // Flush again to make sure it doesn't come back
    await repo2.flush();
    expect(remoteStore.has('/.meta/backends/rs-2.json')).toBe(false);
    expect(persistentStores.get(idbStore)!.has('/.meta/backends/rs-2.json')).toBe(false);

    await repo2.dispose();
  });
});

describe('removeBackend — tombstone-based deletion', () => {
  it('creates a tombstone file when removing a backend (not plain unlink)', async () => {
    const appId = 'test-remove-tombstone';
    const sharedStoreKey = `shared-${appId}-${Date.now()}`;

    const repo = await createConfigRepo(appId, {
      idbStoreName: `persistent-${appId}`,
      backendInfo: { type: 'MockShared', options: { storeKey: sharedStoreKey } },
      primaryBackendId: 'rs-1',
      nodeId: 'node-1',
    }) as ConfigRepo;

    // Wait for background sync to settle
    await new Promise(r => setTimeout(r, 100));
    await repo.flush();

    // Verify the backend exists
    const before = await repo.readAllBackendDescriptors();
    expect(before.length).toBe(1);
    expect(before[0].id).toBe('rs-1');

    // Remove it
    await repo.removeBackend('rs-1');

    // Check that a tombstone file was created in /.meta/.deleted/
    const deletedDir = '/.meta/.deleted';
    const entries = await repo.rootFS.promises.readdir(deletedDir);
    const tombstoneFiles = entries.filter((f: string) => f.includes('rs-1'));
    expect(tombstoneFiles.length).toBeGreaterThan(0);

    await repo.dispose();
  });

  it('deleted backend descriptor does not reappear after flush (tombstone prevents re-sync)', async () => {
    const appId = 'test-remove-no-resync';
    const sharedStoreKey = `shared-${appId}-${Date.now()}`;

    const repo = await createConfigRepo(appId, {
      idbStoreName: `persistent-${appId}`,
      backendInfo: { type: 'MockShared', options: { storeKey: sharedStoreKey } },
      primaryBackendId: 'rs-1',
      nodeId: 'node-1',
    }) as ConfigRepo;

    // Wait for initial sync to push descriptor to remote
    await new Promise(r => setTimeout(r, 100));
    await repo.flush();

    // Verify descriptor exists on remote (shared store)
    const remoteStore = sharedMockStores.get(sharedStoreKey)!;
    const remoteDescPath = '/.meta/backends/rs-1.json';
    expect(remoteStore.has(remoteDescPath)).toBe(true);

    // Remove the backend — should write tombstone
    await repo.removeBackend('rs-1');

    // Flush — processTombstones should delete on remote, then sync
    await repo.flush();

    // The descriptor should be gone from remote too (tombstone propagated)
    expect(remoteStore.has(remoteDescPath)).toBe(false);

    // And it should NOT come back after another flush
    await repo.flush();
    expect(remoteStore.has(remoteDescPath)).toBe(false);

    await repo.dispose();
  });

  it('deleted backend does not reappear when another backend syncs to the same remote', async () => {
    const appId = 'test-remove-dual-sync';
    const sharedStoreKey = `shared-${appId}-${Date.now()}`;
    const idbStore = `persistent-${appId}`;

    // Create repo with a MockShared backend "rs-1"
    const repo = await createConfigRepo(appId, {
      idbStoreName: idbStore,
      backendInfo: { type: 'MockShared', options: { storeKey: sharedStoreKey } },
      primaryBackendId: 'rs-1',
      nodeId: 'node-1',
    }) as ConfigRepo;

    await new Promise(r => setTimeout(r, 100));
    await repo.flush();

    // Manually write a SECOND descriptor with the same config but different ID.
    // This simulates a duplicate that existed from before the dedup fix.
    // We write it directly to bypass addBackend's duplicate check.
    await repo.writeBackendDescriptor({
      id: 'rs-2',
      type: 'MockShared',
      options: { storeKey: sharedStoreKey },
    });

    // Flush — this now includes post-sync dedup, which will detect rs-1 and
    // rs-2 as duplicates and remove rs-2 (keeping rs-1, the older one).
    // So after flush, only rs-1 should exist on remote.
    await repo.flush();

    // Verify: rs-1 exists, rs-2 was deduped
    const remoteStore = sharedMockStores.get(sharedStoreKey)!;
    expect(remoteStore.has('/.meta/backends/rs-1.json')).toBe(true);
    expect(remoteStore.has('/.meta/backends/rs-2.json')).toBe(false);

    // Now remove rs-1 via removeBackend (uses deleteFile → tombstone)
    await repo.removeBackend('rs-1');

    // Flush — tombstone should propagate to remote
    await repo.flush();

    await repo.dispose();

    // Reconnect — no backends should remain
    const repo2 = await createConfigRepo(appId, {
      idbStoreName: idbStore,
      nodeId: 'node-2',
    }) as ConfigRepo;

    await new Promise(r => setTimeout(r, 100));
    await repo2.flush();

    // rs-1 should NOT exist on remote (tombstone propagated)
    expect(remoteStore.has('/.meta/backends/rs-1.json')).toBe(false);

    // rs-2 was already deduped, so it should not exist either
    expect(remoteStore.has('/.meta/backends/rs-2.json')).toBe(false);

    // No backends should remain
    const backends = await repo2.readAllBackendDescriptors();
    expect(backends.length).toBe(0);

    await repo2.dispose();
  });
});
