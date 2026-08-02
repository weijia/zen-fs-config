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
