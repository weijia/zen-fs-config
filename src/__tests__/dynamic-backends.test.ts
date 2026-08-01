import { describe, it, expect, beforeAll } from 'vitest';
import { createConfigRepo } from '../config-repo';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';

// Mock IndexedDB with InMemory for Node.js testing
beforeAll(() => {
  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${options.storeName ?? Date.now()}` },
    });
  });

  // Register a backend type with accountFields for account reuse tests
  registerBackend('TestAccountBackend', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `acct-${options.label ?? Date.now()}` },
    });
  }, {
    type: 'TestAccountBackend',
    label: 'Test Account',
    icon: '🧪',
    fields: [
      { key: 'token', label: 'Token', type: 'password' },
      { key: 'owner', label: 'Owner', type: 'text' },
      { key: 'repo', label: 'Repo', type: 'text' },
    ],
    defaultOptions: {},
    accountFields: ['token', 'owner'],
  });
});

describe('dynamic backend management in AppDataGroup', () => {
  it('addBackend dynamically adds a backend to an existing group', async () => {
    const repo = await createConfigRepo('test-dyn-app1', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('group-1', [
      { id: 'b1', type: 'InMemory', options: { label: 'initial' } },
    ]);

    // Initially 1 backend
    let backends = group.listBackends();
    expect(backends.length).toBe(1);
    expect(backends[0].id).toBe('b1');

    // Add a second backend dynamically
    await group.addBackend('b2', 'InMemory', { label: 'added-dynamically' });

    backends = group.listBackends();
    expect(backends.length).toBe(2);
    expect(backends.map(b => b.id).sort()).toEqual(['b1', 'b2']);

    await repo.dispose();
  });

  it('addBackend sets up sync and data propagates to the new backend', async () => {
    const repo = await createConfigRepo('test-dyn-app2', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('group-2', [
      { id: 'b1', type: 'InMemory', options: { label: 'initial-2' } },
    ]);

    // Write data before adding the second backend
    await group.fs.promises.writeFile('/before.txt', 'data-before');

    // Add a second backend dynamically
    await group.addBackend('b2', 'InMemory', { label: 'added-2' });

    // Flush to sync data to both backends
    await group.flush();

    // Write more data after adding
    await group.fs.promises.writeFile('/after.txt', 'data-after');
    await group.flush();

    // Both files should exist in local fs
    expect(await (group.fs.promises as any).exists('/before.txt')).toBe(true);
    expect(await (group.fs.promises as any).exists('/after.txt')).toBe(true);

    await repo.dispose();
  });

  it('addBackend throws for duplicate id', async () => {
    const repo = await createConfigRepo('test-dyn-app3', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('group-3', [
      { id: 'existing', type: 'InMemory', options: { label: 'existing' } },
    ]);

    await expect(
      group.addBackend('existing', 'InMemory', { label: 'duplicate' }),
    ).rejects.toThrow(/already exists/);

    await repo.dispose();
  });

  it('removeBackend removes a backend from the group', async () => {
    const repo = await createConfigRepo('test-dyn-app4', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('group-4', [
      { id: 'b1', type: 'InMemory', options: { label: 'b1' } },
      { id: 'b2', type: 'InMemory', options: { label: 'b2' } },
    ]);

    expect(group.listBackends().length).toBe(2);

    await group.removeBackend('b2');
    expect(group.listBackends().length).toBe(1);
    expect(group.listBackends()[0].id).toBe('b1');

    await repo.dispose();
  });

  it('removeBackend throws for non-existent id', async () => {
    const repo = await createConfigRepo('test-dyn-app5', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('group-5', [
      { id: 'b1', type: 'InMemory', options: { label: 'b1' } },
    ]);

    await expect(group.removeBackend('nonexistent')).rejects.toThrow(/not found/);

    await repo.dispose();
  });

  it('listBackends returns descriptors with id, type, options', async () => {
    const repo = await createConfigRepo('test-dyn-app6', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('group-6', [
      { id: 'b1', type: 'InMemory', options: { label: 'b1' }, description: 'first' },
    ]);

    const backends = group.listBackends();
    expect(backends[0].id).toBe('b1');
    expect(backends[0].type).toBe('InMemory');
    expect(backends[0].options).toBeDefined();

    await repo.dispose();
  });

  it('getSyncStatuses reflects added backends', async () => {
    const repo = await createConfigRepo('test-dyn-app7', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('group-7', [
      { id: 'b1', type: 'InMemory', options: { label: 'b1' } },
    ]);

    let statuses = group.getSyncStatuses();
    expect(statuses.size).toBe(1);

    await group.addBackend('b2', 'InMemory', { label: 'b2' });
    statuses = group.getSyncStatuses();
    expect(statuses.size).toBe(2);

    await group.removeBackend('b1');
    statuses = group.getSyncStatuses();
    expect(statuses.size).toBe(1);

    await repo.dispose();
  });
});

describe('listAccountBackends', () => {
  it('returns only backends with accountFields declared', async () => {
    const repo = await createConfigRepo('test-acct-app1', { nodeId: 'test-node' });

    // Add a backend with accountFields
    await repo.addBackend('gitee-config', 'TestAccountBackend', {
      token: 'my-token',
      owner: 'my-user',
      repo: 'config-repo',
    });

    // Add a backend without accountFields (InMemory)
    await repo.addBackend('memory-cache', 'InMemory', {
      label: 'cache',
    });

    const accountBackends = await repo.listAccountBackends();

    // Should only include the TestAccountBackend, not InMemory
    expect(accountBackends.length).toBe(1);
    expect(accountBackends[0].id).toBe('gitee-config');
    expect(accountBackends[0].type).toBe('TestAccountBackend');

    await repo.dispose();
  });

  it('returns empty array when no backends have accountFields', async () => {
    const repo = await createConfigRepo('test-acct-app2', { nodeId: 'test-node' });

    // Only add InMemory (no accountFields)
    await repo.addBackend('memory-only', 'InMemory', { label: 'mem' });

    const accountBackends = await repo.listAccountBackends();
    expect(accountBackends.length).toBe(0);

    await repo.dispose();
  });

  it('returns empty array when no replica backends exist', async () => {
    const repo = await createConfigRepo('test-acct-app3', { nodeId: 'test-node' });

    const accountBackends = await repo.listAccountBackends();
    expect(accountBackends.length).toBe(0);

    await repo.dispose();
  });

  it('account backend can be used as accountBackendId in createAppDataGroup', async () => {
    const repo = await createConfigRepo('test-acct-app4', { nodeId: 'test-node' });

    // Add a config-sync backend with account info
    await repo.addBackend('gitee-acct', 'TestAccountBackend', {
      token: 'secret-token',
      owner: 'my-user',
      repo: 'config-repo',
    });

    // List available account backends
    const accountBackends = await repo.listAccountBackends();
    expect(accountBackends.length).toBe(1);

    // Use it as accountBackendId for a data-sync group
    const group = await repo.createAppDataGroup('data-group', [
      {
        id: 'data-backend',
        type: 'TestAccountBackend',
        options: { repo: 'data-repo' }, // only storage location
        accountBackendId: 'gitee-acct', // reuse token + owner
      },
    ]);

    expect(group.groupId).toBe('data-group');
    expect(group.listBackends().length).toBe(1);

    await repo.dispose();
  });
});
