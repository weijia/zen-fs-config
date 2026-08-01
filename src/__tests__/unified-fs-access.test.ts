/**
 * Verification test: unified fs access for data storage
 *
 * Scenario 1: Connect to a config-sync group (no data-sync group set up).
 *   → Use repo.fs (chroot to /{appId}/) to write data files.
 *   → Files should be synced via config-sync group's sync pairs.
 *
 * Scenario 2: Connect to a data-sync group directly.
 *   → Use dataGroup.fs (chroot to /) to write data files.
 *   → Files should be synced via data-sync group's sync pairs.
 *
 * The user's expectation: both scenarios should expose the same fs interface
 * for data read/write.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { connect } from '../connect';
import { createConfigRepo } from '../config-repo';
import { createDataSyncGroup } from '../data-sync-group';

// ---------------------------------------------------------------------------
// Mock IndexedDB with InMemory for Node.js testing
// (same pattern as app-data-group.test.ts)
// ---------------------------------------------------------------------------
beforeAll(() => {
  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${options.storeName ?? Date.now()}` },
    });
  });
});

// --- Test mock backend (InMemory-based, shared between tests) ---

const mockStores = new Map<string, Map<string, Uint8Array>>();

function createMockBackend(storeKey: string): BackendInstance {
  let store = mockStores.get(storeKey);
  if (!store) {
    store = new Map();
    mockStores.set(storeKey, store);
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
          if (firstSlash === -1) {
            entries.add(rest);
          } else {
            entries.add(rest.slice(0, firstSlash));
          }
        }
      }
      if (path === '/') {
        for (const key of store!.keys()) {
          const trimmed = key.replace(/^\//, '');
          const firstSlash = trimmed.indexOf('/');
          if (firstSlash === -1) {
            entries.add(trimmed);
          } else {
            entries.add(trimmed.slice(0, firstSlash));
          }
        }
      }
      return Array.from(entries);
    },
    async stat(path: string) {
      const data = store!.get(path);
      if (data) {
        return { mode: 0o100644, size: data.byteLength, mtimeMs: Date.now() };
      }
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
    async mkdir(path: string) { /* no-op for mock */ },
    async unlink(path: string) { store!.delete(path); },
    async rmdir(path: string) { /* no-op for mock */ },
    async dispose() { /* keep store for cross-test verification */ },
  };
}

// Register mock backend
registerBackend('MockShared', async (options) => {
  const storeKey = options.storeKey as string;
  return createMockBackend(storeKey);
}, {
  type: 'MockShared',
  label: 'MockShared',
  icon: '🧪',
  fields: [{ key: 'storeKey', label: 'Store Key', type: 'text' }],
  defaultOptions: { storeKey: '' },
});

describe('Unified fs access for data storage', () => {

  // -------------------------------------------------------------------------
  // Scenario 1: Config-sync group, no data-sync group
  // → Use repo.fs to write data files into /{appId}/
  // -------------------------------------------------------------------------

  it('Scenario 1: config-sync group — repo.fs writes data that gets synced', async () => {
    const appId = 'test-unified-config-1';

    // Connect to a config-sync group (local-only, no remote backend)
    const result = await connect(appId, {
      groupType: 'config-sync',
    });

    expect(result.groupType).toBe('config-sync');
    expect(result.repo).toBeDefined();
    expect(result.dataGroup).toBeUndefined();

    const repo = result.repo!;

    // Write a data file using repo.fs (chroot to /{appId}/)
    // This simulates using the config-sync group for data storage
    // when no data-sync group is set up.
    const dataContent = JSON.stringify({ message: 'hello from config-sync' });
    await repo.fs.promises.writeFile('/data/test.json', dataContent);

    // Read it back
    const readBack = await repo.fs.promises.readFile('/data/test.json', 'utf-8');
    expect(readBack).toBe(dataContent);

    // Also verify using setConfig (the high-level API)
    repo.setConfig('/settings', { theme: 'dark' });
    const settings = repo.getConfig('/settings');
    expect(settings).toEqual({ theme: 'dark' });

    // Both fs.writeFile and setConfig write to the same /{appId}/ directory
    // and both are synced via the config-sync group's sync pairs.

    await repo.dispose();
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Data-sync group
  // → Use dataGroup.fs to write data files into /
  // -------------------------------------------------------------------------

  it('Scenario 2: data-sync group — dataGroup.fs writes data that gets synced', async () => {
    const appId = 'test-unified-data-1';

    // Connect to a data-sync group (local-only)
    const result = await connect(appId, {
      groupType: 'data-sync',
    });

    expect(result.groupType).toBe('data-sync');
    expect(result.dataGroup).toBeDefined();
    expect(result.repo).toBeUndefined();

    const dataGroup = result.dataGroup!;

    // Write a data file using dataGroup.fs (chroot to /)
    const dataContent = JSON.stringify({ message: 'hello from data-sync' });
    await dataGroup.fs.promises.writeFile('/data/test.json', dataContent);

    // Read it back
    const readBack = await dataGroup.fs.promises.readFile('/data/test.json', 'utf-8');
    expect(readBack).toBe(dataContent);

    await dataGroup.dispose();
  });

  // -------------------------------------------------------------------------
  // Interface comparison: are repo.fs and dataGroup.fs the same type?
  // -------------------------------------------------------------------------

  it('Interface comparison: both expose fs with the same API shape', async () => {
    const appId1 = 'test-unified-cmp-1';
    const appId2 = 'test-unified-cmp-2';

    const configResult = await connect(appId1, { groupType: 'config-sync' });
    const dataResult = await connect(appId2, { groupType: 'data-sync' });

    const repo = configResult.repo!;
    const dataGroup = dataResult.dataGroup!;

    // Both have .fs property
    expect(repo.fs).toBeDefined();
    expect(dataGroup.fs).toBeDefined();

    // Both have .fs.promises with writeFile and readFile
    expect(typeof repo.fs.promises.writeFile).toBe('function');
    expect(typeof repo.fs.promises.readFile).toBe('function');
    expect(typeof dataGroup.fs.promises.writeFile).toBe('function');
    expect(typeof dataGroup.fs.promises.readFile).toBe('function');

    // Both have flush() and getSyncStatuses()
    expect(typeof repo.flush).toBe('function');
    expect(typeof repo.getSyncStatuses).toBe('function');
    expect(typeof dataGroup.flush).toBe('function');
    expect(typeof dataGroup.getSyncStatuses).toBe('function');

    // DIFFERENCE: repo has setConfig/getConfig, dataGroup does NOT
    expect(typeof repo.setConfig).toBe('function');
    expect(typeof repo.getConfig).toBe('function');
    expect((dataGroup as any).setConfig).toBeUndefined();
    expect((dataGroup as any).getConfig).toBeUndefined();

    // DIFFERENCE: repo has rootFS, dataGroup does NOT
    expect(repo.rootFS).toBeDefined();
    expect((dataGroup as any).rootFS).toBeUndefined();

    // DIFFERENCE: chroot root is different
    // repo.fs is chroot to /{appId1}/ — writing '/data.json' goes to /{appId1}/data.json
    // dataGroup.fs is chroot to / — writing '/data.json' goes to /data.json
    await repo.fs.promises.writeFile('/chroot-test.txt', 'config');
    await dataGroup.fs.promises.writeFile('/chroot-test.txt', 'data');

    // Both can read their own file at the same path '/chroot-test.txt'
    const configRead = await repo.fs.promises.readFile('/chroot-test.txt', 'utf-8');
    const dataRead = await dataGroup.fs.promises.readFile('/chroot-test.txt', 'utf-8');
    expect(configRead).toBe('config');
    expect(dataRead).toBe('data');
    // They are different files despite the same path — different chroot roots!

    await repo.dispose();
    await dataGroup.dispose();
  });

  // -------------------------------------------------------------------------
  // Cross-verification: data written via config-sync repo.fs IS synced
  // to replica backends
  // -------------------------------------------------------------------------

  it('Scenario 1+: config-sync group — data written via repo.fs syncs to replicas', async () => {
    const appId = 'test-unified-config-sync-1';

    // Use a shared mock store so we can verify what landed on the "remote"
    const sharedStoreKey = `shared-config-sync-${Date.now()}`;

    const repo = await createConfigRepo(appId, {
      backendInfo: {
        type: 'MockShared',
        options: { storeKey: sharedStoreKey },
      },
      nodeId: 'test-node',
    });

    // Wait for background syncMetaToReplicas to finish before writing
    // (createConfigRepo fires it non-blocking; if it's still running when
    // we call flush(), the sync pair returns its cached result and skips
    // our new file)
    await new Promise(resolve => setTimeout(resolve, 200));
    await repo.flush();

    // Write a data file via repo.fs (not setConfig, just raw fs)
    await repo.fs.promises.writeFile('/raw-data/note.json', JSON.stringify({
      content: 'raw data via config-sync fs',
    }));

    // Flush to trigger sync
    await repo.flush();

    // Verify the file landed on the remote backend's store
    // The path on the remote should be /{appId}/raw-data/note.json
    const remoteStore = mockStores.get(sharedStoreKey)!;
    const remotePath = `/${appId}/raw-data/note.json`;
    const remoteData = remoteStore.get(remotePath);
    expect(remoteData).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(remoteData)).content).toBe('raw data via config-sync fs');

    await repo.dispose();
  });

  // -------------------------------------------------------------------------
  // Cross-verification: data written via data-sync dataGroup.fs IS synced
  // to replica backends
  // -------------------------------------------------------------------------

  it('Scenario 2+: data-sync group — data written via dataGroup.fs syncs to replicas', async () => {
    const appId = 'test-unified-data-sync-1';

    const sharedStoreKey = `shared-data-sync-${Date.now()}`;

    const dataGroup = await createDataSyncGroup(appId, {
      backendInfo: {
        type: 'MockShared',
        options: { storeKey: sharedStoreKey },
      },
    });

    // Write a data file via dataGroup.fs
    await dataGroup.fs.promises.writeFile('/raw-data/note.json', JSON.stringify({
      content: 'raw data via data-sync fs',
    }));

    // Flush to trigger sync
    await dataGroup.flush();

    // Verify the file landed on the remote backend's store
    // The path on the remote should be /raw-data/note.json (no appId prefix!)
    const remoteStore = mockStores.get(sharedStoreKey)!;
    const remotePath = '/raw-data/note.json';
    const remoteData = remoteStore.get(remotePath);
    expect(remoteData).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(remoteData)).content).toBe('raw data via data-sync fs');

    await dataGroup.dispose();
  });

  // -------------------------------------------------------------------------
  // Summary: path mapping difference
  // -------------------------------------------------------------------------

  it('Path mapping: config-sync prefixes appId, data-sync does not', async () => {
    const appId1 = 'test-path-config';
    const appId2 = 'test-path-data';

    const sharedStoreKey1 = `path-config-${Date.now()}`;
    const sharedStoreKey2 = `path-data-${Date.now()}`;

    const repo = await createConfigRepo(appId1, {
      backendInfo: { type: 'MockShared', options: { storeKey: sharedStoreKey1 } },
      nodeId: 'test-node',
    });

    const dataGroup = await createDataSyncGroup(appId2, {
      backendInfo: { type: 'MockShared', options: { storeKey: sharedStoreKey2 } },
    });

    // Write the same path on both
    await repo.fs.promises.writeFile('/notes/a.json', 'config-note');
    await dataGroup.fs.promises.writeFile('/notes/a.json', 'data-note');

    await repo.flush();
    await dataGroup.flush();

    // On the remote, config-sync stores at /{appId}/notes/a.json
    const configRemote = mockStores.get(sharedStoreKey1)!;
    expect(configRemote.get(`/${appId1}/notes/a.json`)).toBeDefined();

    // data-sync stores at /notes/a.json (no appId prefix)
    const dataRemote = mockStores.get(sharedStoreKey2)!;
    expect(dataRemote.get('/notes/a.json')).toBeDefined();

    // Verify they are at different paths
    expect(configRemote.has('/notes/a.json')).toBe(false);
    expect(dataRemote.has(`/${appId2}/notes/a.json`)).toBe(false);

    await repo.dispose();
    await dataGroup.dispose();
  });
});
