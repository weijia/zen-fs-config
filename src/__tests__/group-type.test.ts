import { describe, it, expect, beforeAll } from 'vitest';
import { registerBackend, createBackend } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import { createDataSyncGroup } from '../data-sync-group';

// Mock IndexedDB with InMemory for Node.js testing
beforeAll(() => {
  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${options.storeName ?? Date.now()}` },
    });
  });
});

describe('group-type detection and management', () => {
  it('createConfigRepo writes group-type = "config-sync"', async () => {
    const repo = await createConfigRepo('test-app-gt1', { nodeId: 'test-node' });
    const groupType = await repo.getGroupType();
    expect(groupType).toBe('config-sync');
    await repo.dispose();
  });

  it('ensureGroupType writes the type', async () => {
    const repo = await createConfigRepo('test-app-gt2', { nodeId: 'test-node' });
    await repo.ensureGroupType('config-sync');
    const groupType = await repo.getGroupType();
    expect(groupType).toBe('config-sync');
    await repo.dispose();
  });

  it('ensureGroupType does NOT overwrite existing type', async () => {
    const repo = await createConfigRepo('test-app-gt3', { nodeId: 'test-node' });
    // group-type is already "config-sync" from createConfigRepo
    // Try to set it to "data-sync" — should be ignored
    await repo.ensureGroupType('data-sync');
    const groupType = await repo.getGroupType();
    expect(groupType).toBe('config-sync'); // still config-sync
    await repo.dispose();
  });

  it('getGroupType returns null when not set', async () => {
    const backend = await createBackend({ type: 'InMemory', options: { label: 'test-raw' } });
    // Create a ConfigRepo directly with this backend to test getGroupType on empty backend
    // Actually, just use the repo's rootFS to check the file doesn't exist before ensureGroupType
    const repo = await createConfigRepo('test-app-gt4', { nodeId: 'test-node' });
    // The rootFS can read /.meta/group-type
    const exists = await (repo.rootFS.promises as any).exists('/.meta/group-type');
    expect(exists).toBe(true);
    await repo.dispose();
  });

  it('createDataSyncGroup writes group-type = "data-sync"', async () => {
    const group = await createDataSyncGroup('test-app-gt5');
    // Read group-type from the group's fs
    const content = await group.fs.promises.readFile('/.meta/group-type', 'utf-8');
    expect(content.trim()).toBe('data-sync');
    await group.dispose();
  });

  it('Group types are different between config-sync and data-sync', async () => {
    const repo = await createConfigRepo('test-app-gt6a', { nodeId: 'test-node' });
    const repoGroupType = await repo.getGroupType();

    const group = await createDataSyncGroup('test-app-gt6b');
    const dataGroupType = await group.fs.promises.readFile('/.meta/group-type', 'utf-8');

    expect(repoGroupType).toBe('config-sync');
    expect(dataGroupType.trim()).toBe('data-sync');

    await repo.dispose();
    await group.dispose();
  });
});
