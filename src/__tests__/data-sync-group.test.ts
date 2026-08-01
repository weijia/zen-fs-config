import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDataSyncGroup, DataSyncGroup } from '../data-sync-group';
import { createBackend, registerBackend, type BackendInstance } from '../backend-registry';

// ---------------------------------------------------------------------------
// Mock "remote" backend type
//
// Wraps the built-in InMemory backend so tests can keep a reference to the
// instance the sync engine actually talks to. The latest created instance is
// captured in `lastCreatedBackend`, letting us assert what got synced.
// ---------------------------------------------------------------------------
let lastCreatedBackend!: BackendInstance;

registerBackend('MockRemote', async (options) => {
  lastCreatedBackend = await createBackend({
    type: 'InMemory',
    options: { label: `mock-${Date.now()}` },
  });
  return lastCreatedBackend;
});

// ---------------------------------------------------------------------------
// NOTE on the `fs` surface:
// `group.fs` is a chroot-isolated proxy whose async API lives under
// `group.fs.promises` (mirroring the `node:fs` module shape: top-level *Sync
// stubs + a `promises` namespace). So file operations use
// `group.fs.promises.writeFile(...)`, `group.fs.promises.readFile(...)`, etc.
// ---------------------------------------------------------------------------

describe('DataSyncGroup (standalone)', () => {
  let group: DataSyncGroup;

  beforeEach(async () => {
    group = await createDataSyncGroup('test-app');
  });

  afterEach(async () => {
    // dispose() is idempotent — it no-ops if already disposed — so this is
    // safe even for tests that dispose the group themselves.
    await group.dispose();
  });

  // -------------------------------------------------------------------------
  // 1. Local-only group creation
  // -------------------------------------------------------------------------
  describe('createDataSyncGroup (local-only)', () => {
    it('returns a DataSyncGroup with the expected metadata', () => {
      expect(group).toBeInstanceOf(DataSyncGroup);
      expect(group.appId).toBe('test-app');
      expect(group.groupId.startsWith('data-test-app-')).toBe(true);
      expect(group.fs).toBeDefined();
    });

    it('writes the data-sync group-type marker under /.meta', async () => {
      const content = await group.fs.promises.readFile('/.meta/group-type', 'utf-8');
      expect(content).toBe('data-sync');
    });
  });

  // -------------------------------------------------------------------------
  // 2. File operations via fs
  // -------------------------------------------------------------------------
  describe('fs file operations', () => {
    it('can write, read, and check existence of a file', async () => {
      await group.fs.promises.writeFile('/data/test.txt', 'hello');

      const content = await group.fs.promises.readFile('/data/test.txt', 'utf-8');
      expect(content).toBe('hello');

      expect(await (group.fs.promises as any).exists('/data/test.txt')).toBe(true);
    });

    it('reports false for missing files', async () => {
      expect(await (group.fs.promises as any).exists('/data/does-not-exist.txt')).toBe(false);
    });

    it('can create directories and list their contents', async () => {
      await group.fs.promises.mkdir('/docs');
      await group.fs.promises.writeFile('/docs/a.txt', 'a');

      const entries = await group.fs.promises.readdir('/docs');
      expect(entries).toContain('a.txt');
    });

    it('can delete files via unlink', async () => {
      await group.fs.promises.writeFile('/data/temp.txt', 'temp');
      expect(await (group.fs.promises as any).exists('/data/temp.txt')).toBe(true);

      await group.fs.promises.unlink('/data/temp.txt');
      expect(await (group.fs.promises as any).exists('/data/temp.txt')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 3. addBackend
  // -------------------------------------------------------------------------
  describe('addBackend', () => {
    it('registers a sync pair for a built-in InMemory backend', async () => {
      await group.addBackend('backend-1', 'InMemory', { label: 'test-b1' });

      const statuses = group.getSyncStatuses();
      expect(statuses.size).toBeGreaterThanOrEqual(1);
    });

    it('propagates locally-written data to the remote backend after flush', async () => {
      await group.addBackend('backend-1', 'MockRemote', { label: 'test-b1' });

      // A sync pair should now be registered.
      expect(group.getSyncStatuses().size).toBeGreaterThanOrEqual(1);

      // Write locally, then flush to push changes to the remote backend.
      await group.fs.promises.writeFile('/data/synced.txt', 'synced-data');
      await group.flush();

      // The MockRemote factory captured the created backend instance.
      expect(lastCreatedBackend).toBeDefined();
      expect(await lastCreatedBackend.exists('/data/synced.txt')).toBe(true);

      const remoteContent = await lastCreatedBackend.readFile('/data/synced.txt', 'utf-8');
      expect(remoteContent).toBe('synced-data');
    });

    it('throws when adding a backend with a duplicate id', async () => {
      await group.addBackend('backend-1', 'InMemory', { label: 'first' });

      await expect(
        group.addBackend('backend-1', 'InMemory', { label: 'second' }),
      ).rejects.toThrow(/already exists/);
    });
  });

  // -------------------------------------------------------------------------
  // 4. flush() returns sync results
  // -------------------------------------------------------------------------
  describe('flush', () => {
    it('returns an array of SyncResult after syncing', async () => {
      await group.addBackend('backend-1', 'MockRemote', { label: 'test-b1' });
      await group.fs.promises.writeFile('/data/flush-test.txt', 'flush-content');

      const results = await group.flush();

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(1);

      const result = results[0];
      expect(result).toBeDefined();
      expect(result.pairId).toBeDefined();
      expect(result.filesCreated + result.filesUpdated).toBeGreaterThanOrEqual(1);
    });

    it('returns an empty array when there are no backends', async () => {
      const results = await group.flush();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 5. dispose() prevents further operations
  // -------------------------------------------------------------------------
  describe('dispose', () => {
    it('prevents addBackend after disposal', async () => {
      await group.dispose();

      await expect(
        group.addBackend('backend-1', 'InMemory', { label: 'too-late' }),
      ).rejects.toThrow(/disposed/);
    });

    it('is idempotent — a second dispose does not throw', async () => {
      await group.dispose();
      await expect(group.dispose()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 6. removeBackend
  // -------------------------------------------------------------------------
  describe('removeBackend', () => {
    it('removes the backend and its sync pair', async () => {
      await group.addBackend('backend-1', 'MockRemote', { label: 'test-b1' });

      const before = group.getSyncStatuses().size;
      expect(before).toBeGreaterThanOrEqual(1);

      await group.removeBackend('backend-1');

      const after = group.getSyncStatuses().size;
      expect(after).toBeLessThan(before);
      expect(after).toBe(0);
    });

    it('throws when removing an unknown backend', async () => {
      await expect(group.removeBackend('does-not-exist')).rejects.toThrow(/not found/);
    });
  });
});
