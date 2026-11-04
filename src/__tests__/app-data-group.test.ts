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

  it('removeAppDataGroup writes a tombstone so the deletion propagates to remote', async () => {
    const repo = await createConfigRepo('test-adg-app6b', { nodeId: 'test-node' });
    await repo.createAppDataGroup('to-remove', [
      { id: 'b', type: 'InMemory', options: { label: 'r' } },
    ]);
    await repo.removeAppDataGroup('to-remove');
    // A tombstone must exist under /.meta/.deleted so sync propagates the
    // deletion to remote replicas (and does not resurrect the group).
    const cachedFS = (repo as any).cachedFS;
    const tombFileName =
      '++meta__app-data-groups__test-adg-app6b__to-remove++json.json';
    const entries = await cachedFS.readdir('/.meta/.deleted');
    if (!entries.includes(tombFileName)) {
      throw new Error('MISSING tombstone, entries=' + JSON.stringify(entries));
    }
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

describe('group display name editing', () => {
  it('renames a data group, keeps its id and does not disturb sync pairs', async () => {
    const repo = await createConfigRepo('test-adg-rename1', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('data-group-r1', [
      { id: 'b-r1', type: 'InMemory', options: { label: 'rename-b1' } },
    ]);
    expect(group.getSyncStatuses().size).toBe(1);

    await repo.updateAppDataGroupName('data-group-r1', '  云端文件  ');

    const list = await repo.listAppDataGroups();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('data-group-r1');
    expect(list[0].name).toBe('云端文件');
    expect(list[0].backends).toHaveLength(1);
    // The live group (and its pair) is untouched.
    expect(group.getSyncStatuses().size).toBe(1);
    await repo.dispose();
  });

  it('keeps the name when the descriptor is rewritten for backend changes', async () => {
    const repo = await createConfigRepo('test-adg-rename2', { nodeId: 'test-node' });
    await repo.createAppDataGroup('data-group-r2', [
      { id: 'b-r2', type: 'InMemory', options: { label: 'rename-b2' } },
    ]);
    await repo.updateAppDataGroupName('data-group-r2', '重命名组');

    // Simulates addBackend/removeBackend rewriting the descriptor.
    const before = (await repo.listAppDataGroups())[0];
    await (repo as any).updateAppDataGroupDescriptor('data-group-r2', before.backends);
    const after = (await repo.listAppDataGroups())[0];
    expect(after.name).toBe('重命名组');
    expect(after.id).toBe('data-group-r2');
    expect(after.backends).toHaveLength(1);
    await repo.dispose();
  });

  it('rejects empty and overlong names without touching the descriptor', async () => {
    const repo = await createConfigRepo('test-adg-rename3', { nodeId: 'test-node' });
    await repo.createAppDataGroup('data-group-r3', [
      { id: 'b-r3', type: 'InMemory', options: { label: 'rename-b3' } },
    ]);

    await expect(repo.updateAppDataGroupName('data-group-r3', '   ')).rejects.toThrow('must not be empty');
    await expect(repo.updateAppDataGroupName('data-group-r3', 'x'.repeat(41))).rejects.toThrow('at most 40');
    await expect(repo.updateAppDataGroupName('missing-group', 'ok')).rejects.toThrow('not found');

    const list = await repo.listAppDataGroups();
    expect(list[0].name).toBeUndefined();
    expect(list[0].backends).toHaveLength(1);
    await repo.dispose();
  });

  it('persists the renamed value for subsequent reads (refresh)', async () => {
    const repo = await createConfigRepo('test-adg-rename4', { nodeId: 'test-node' });
    await repo.createAppDataGroup('data-group-r4', [
      { id: 'b-r4', type: 'InMemory', options: { label: 'rename-b4' } },
    ]);
    await repo.updateAppDataGroupName('data-group-r4', '第一次改名');

    // Every refresh re-reads the descriptor from disk.
    expect((await repo.listAppDataGroups())[0].name).toBe('第一次改名');
    await repo.updateAppDataGroupName('data-group-r4', '第二次改名');
    const refreshed = await repo.listAppDataGroups();
    expect(refreshed[0].name).toBe('第二次改名');
    expect(refreshed[0].id).toBe('data-group-r4');
    await repo.dispose();
  });

  it('cfg-sync group name round-trips and rejects blank names', async () => {
    const repo = await createConfigRepo('test-adg-rename5', { nodeId: 'test-node' });
    expect(await repo.getConfigSyncGroupDescriptor()).toBeNull();

    const saved = await repo.updateConfigSyncGroupDescriptor({ name: '  我的配置组  ' });
    expect(saved.groupType).toBe('config-sync');
    expect(saved.name).toBe('我的配置组');

    const reloaded = await repo.getConfigSyncGroupDescriptor();
    expect(reloaded?.name).toBe('我的配置组');

    await expect(repo.updateConfigSyncGroupDescriptor({ name: '  ' })).rejects.toThrow('must not be empty');
    await repo.dispose();
  });
});
