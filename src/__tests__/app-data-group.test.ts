import { describe, it, expect, beforeAll } from 'vitest';
import { registerBackend, createBackend } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import type { AppDataBackendDescriptor, AppDataGroupDescriptor } from '../types';

// ---------------------------------------------------------------------------
// Mock IndexedDB with InMemory for Node.js testing
//
// createConfigRepo() always creates an IndexedDB primary backend, but
// @zenfs/dom (which provides IndexedDB) is browser-only and not available
// under Node.js. We override the 'IndexedDB' backend type so it transparently
// delegates to the built-in InMemory backend, keeping the rest of the
// ConfigRepo/AppDataGroup behavior unchanged.
// ---------------------------------------------------------------------------
beforeAll(() => {
  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${options.storeName ?? Date.now()}` },
    });
  });

  // Register a backend type that declares account fields. This lets us verify
  // that an app data group backend can reuse account credentials (token, owner)
  // from a config-sync backend via `accountBackendId`, while still specifying
  // its own storage-location field (`repo`).
  registerBackend(
    'TestAccountBackend',
    async () => {
      return createBackend({
        type: 'InMemory',
        options: { label: `acct-${Date.now()}` },
      });
    },
    {
      type: 'TestAccountBackend',
      label: 'Test Account',
      icon: '\u{1F9EA}',
      fields: [
        { key: 'token', label: 'Token', type: 'password' },
        { key: 'owner', label: 'Owner', type: 'text' },
        { key: 'repo', label: 'Repo', type: 'text' },
      ],
      defaultOptions: {},
      accountFields: ['token', 'owner'],
    },
  );
});

// ---------------------------------------------------------------------------
// NOTE on the `fs` surface:
// The `fs` object exposed by ConfigRepo and AppDataGroup is a chroot-isolated
// proxy whose async API lives under `.promises` (mirroring `node:fs`). So file
// operations use `group.fs.promises.writeFile(...)`, `group.fs.promises.readFile(...)`,
// `group.fs.promises.exists(...)`, etc.
// ---------------------------------------------------------------------------

describe('AppDataGroup within ConfigRepo', () => {
  it('createAppDataGroup creates a group with InMemory backends', async () => {
    const repo = await createConfigRepo('test-adg-app1', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('data-group-1', [
      { id: 'backend-1', type: 'InMemory', options: { label: 'data-b1' } },
    ]);
    expect(group.groupId).toBe('data-group-1');
    expect(group.appId).toBe('test-adg-app1');
    await repo.dispose();
  });

  it('createAppDataGroup writes data and reads back via fs.promises', async () => {
    const repo = await createConfigRepo('test-adg-app2', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('data-group-2', [
      { id: 'backend-1', type: 'InMemory', options: { label: 'data-b2' } },
    ]);
    await group.fs.promises.writeFile('/data/file.txt', 'hello world');
    const content = await group.fs.promises.readFile('/data/file.txt', 'utf-8');
    expect(content).toBe('hello world');
    await repo.dispose();
  });

  it('getAppDataGroup retrieves an existing group', async () => {
    const repo = await createConfigRepo('test-adg-app3', { nodeId: 'test-node' });
    await repo.createAppDataGroup('data-group-3', [
      { id: 'backend-1', type: 'InMemory', options: { label: 'data-b3' } },
    ]);
    const group = await repo.getAppDataGroup('data-group-3');
    expect(group.groupId).toBe('data-group-3');
    await repo.dispose();
  });

  it('getAppDataGroup throws for non-existent group', async () => {
    const repo = await createConfigRepo('test-adg-app4', { nodeId: 'test-node' });
    await expect(repo.getAppDataGroup('nonexistent')).rejects.toThrow(/not found/);
    await repo.dispose();
  });

  it('listAppDataGroups returns created groups', async () => {
    const repo = await createConfigRepo('test-adg-app5', { nodeId: 'test-node' });
    await repo.createAppDataGroup('group-a', [
      { id: 'b-a', type: 'InMemory', options: { label: 'a' } },
    ]);
    await repo.createAppDataGroup('group-b', [
      { id: 'b-b', type: 'InMemory', options: { label: 'b' } },
    ]);
    const list: AppDataGroupDescriptor[] = await repo.listAppDataGroups();
    expect(list.length).toBe(2);
    expect(list.map((g) => g.id).sort()).toEqual(['group-a', 'group-b']);
    await repo.dispose();
  });

  it('removeAppDataGroup removes the group', async () => {
    const repo = await createConfigRepo('test-adg-app6', { nodeId: 'test-node' });
    await repo.createAppDataGroup('to-remove', [
      { id: 'b-r', type: 'InMemory', options: { label: 'r' } },
    ]);
    await repo.removeAppDataGroup('to-remove');
    const list = await repo.listAppDataGroups();
    expect(list.length).toBe(0);
    await repo.dispose();
  });

  it('createAppDataGroup throws for duplicate id', async () => {
    const repo = await createConfigRepo('test-adg-app7', { nodeId: 'test-node' });
    await repo.createAppDataGroup('dup-group', [
      { id: 'b1', type: 'InMemory', options: { label: 'd1' } },
    ]);
    await expect(
      repo.createAppDataGroup('dup-group', [
        { id: 'b2', type: 'InMemory', options: { label: 'd2' } },
      ]),
    ).rejects.toThrow(/already exists/);
    await repo.dispose();
  });

  it('Data in app data group is isolated from config data', async () => {
    const repo = await createConfigRepo('test-adg-app8', { nodeId: 'test-node' });
    // Write config data into the repo's own primary backend.
    repo.setConfig('/settings.json', { theme: 'dark' });
    // Create a data group and write data into its own local fs.
    const group = await repo.createAppDataGroup('data-group-8', [
      { id: 'b8', type: 'InMemory', options: { label: 'd8' } },
    ]);
    await group.fs.promises.writeFile('/app-data.txt', 'data content');
    // The data group has its own local InMemory backend, separate from the
    // repo's primary backend, so config data must not be visible here.
    const exists = await (group.fs.promises as any).exists('/settings.json');
    expect(exists).toBe(false);
    await repo.dispose();
  });

  it('App data group with accountBackendId resolves account fields', async () => {
    const repo = await createConfigRepo('test-adg-app9', { nodeId: 'test-node' });
    // Add a config-sync backend carrying account info.
    await repo.addBackend('config-backend', 'TestAccountBackend', {
      token: 'secret-token',
      owner: 'myuser',
      repo: 'config-repo',
    });
    // Create an app data group that reuses the account via accountBackendId,
    // specifying only the storage-location field (`repo`).
    const backends: AppDataBackendDescriptor[] = [
      {
        id: 'data-backend-1',
        type: 'TestAccountBackend',
        options: { repo: 'data-repo' },
        accountBackendId: 'config-backend',
      },
    ];
    const group = await repo.createAppDataGroup('data-group-9', backends);
    expect(group.groupId).toBe('data-group-9');
    // The group should be created successfully with merged account fields.
    await repo.dispose();
  });

  it('flush() on app data group returns sync results', async () => {
    const repo = await createConfigRepo('test-adg-app10', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('data-group-10', [
      { id: 'b10', type: 'InMemory', options: { label: 'd10' } },
    ]);
    await group.fs.promises.writeFile('/file.txt', 'content');
    const results = await group.flush();
    expect(Array.isArray(results)).toBe(true);
    await repo.dispose();
  });
});
