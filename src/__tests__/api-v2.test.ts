/**
 * Public V2 API tests:
 * - connectV2 reuses legacy connect() and caches one connection per topology
 * - getDefaultDataGroup selects an existing group, not only id === "default"
 * - default creation is deferred until a config pull has completed
 * - DataGroup.addBackend is idempotent and rejects cross-group endpoint reuse
 * - DataGroup.onSyncEvent forwards start/end from the underlying data group
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { connectV2, getUiConnection, BackendEndpointConflictError, DataGroupNotFoundError } from '../api-v2';
import { writeGroupDescriptor } from '../group-meta';
import type { DataGroupSyncEvent } from '../api-v2';

const remotes = new Map<string, BackendInstance>();

function tmp(tag: string): string {
  return path.join(
    os.tmpdir(),
    `zf-v2-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
}

function appId(tag: string): string {
  return `v2-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

beforeAll(() => {
  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${options.storeName ?? Date.now()}` },
    });
  });

  registerBackend(
    'MemRemoteV2',
    async (options) => {
      const key = String((options as any).label ?? 'default');
      let instance = remotes.get(key);
      if (!instance) {
        instance = await createBackend({
          type: 'InMemory',
          options: { label: `mem-v2-${key}` },
        });
        remotes.set(key, instance);
      }
      return instance;
    },
    {
      type: 'MemRemoteV2',
      label: 'In-memory V2 remote',
      icon: 'M',
      fields: [],
      defaultOptions: {},
      identityFields: ['label'],
    } as any,
  );
});

describe('connectV2 / AppRepo', () => {
  it('same appId + options share one AppRepo; getUiConnection returns the raw connection', async () => {
    const id = appId('cache');
    const first = await connectV2(id, { nodeId: 'n' });
    const second = await connectV2(id, { nodeId: 'n' });
    expect(first).toBe(second);

    const connection = getUiConnection(first);
    expect(connection.appId).toBe(id);
    expect(connection.repo).toBeDefined();
    await connection.repo!.dispose();
  });

  it('uses an existing non-default group instead of creating "default"', async () => {
    const id = appId('existing');
    const repo = await connectV2(id, { nodeId: 'n' });
    const connection = getUiConnection(repo);
    await connection.repo!.createAppDataGroup('alpha', [
      { id: 'alpha-backend', type: 'InMemory', options: { label: 'alpha' } },
    ]);

    const group = await repo.getDefaultDataGroup();
    expect(group.id).toBe('alpha');
    expect((await connection.repo!.listAppDataGroups()).map((g) => g.id)).toEqual(['alpha']);
    await connection.repo!.dispose();
  });

  it('creates a local default only when the config repo has no groups', async () => {
    const id = appId('create');
    const repo = await connectV2(id, { nodeId: 'n' });
    const group = await repo.getDefaultDataGroup();
    expect(group.id).toBe('default');

    const connection = getUiConnection(repo);
    expect((await connection.repo!.listAppDataGroups()).map((g) => g.id)).toEqual([
      'default',
    ]);
    await connection.repo!.dispose();
  });

  it('waits for the initial config pull before choosing the remote default group', async () => {
    const id = appId('pull');
    const label = `pull-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const remote: any = await createBackend({
      type: 'InMemory',
      options: { label: `remote-${label}` },
    });
    remotes.set(label, remote);

    await writeGroupDescriptor(remote, {
      schemaVersion: 2,
      kind: 'config',
      id: 'config',
      instanceId: '11111111-1111-4111-8111-111111111111',
    });
    await remote.mkdir('/.config');
    await remote.mkdir('/.config/app-data-groups');
    await remote.mkdir(`/.config/app-data-groups/${id}`);
    await remote.writeFile(
      `/.config/app-data-groups/${id}/default.json`,
      new TextEncoder().encode(
        JSON.stringify(
          {
            id: 'default',
            groupType: 'data-sync',
            name: 'Remote Group',
            instanceId: '22222222-2222-4222-8222-222222222222',
            backends: [],
          },
          null,
          2,
        ),
      ),
    );

    const repo = await connectV2(id, {
      nodeId: 'n',
      folderPath: tmp('pull-local'),
      backendInfo: { type: 'MemRemoteV2', options: { label } },
    });

    const group = await repo.getDefaultDataGroup();
    expect(group.id).toBe('default');
    const connection = getUiConnection(repo);
    const live = await connection.repo!.getAppDataGroup('default');
    expect(live.name).toBe('Remote Group');
    await connection.repo!.dispose();
  });
});

describe('AppRepo group selection', () => {
  it('lists existing groups and loads one by id without changing the default', async () => {
    const id = appId('select');
    const repo = await connectV2(id, { nodeId: 'n' });
    const connection = getUiConnection(repo);
    await connection.repo!.createAppDataGroup('alpha', [
      { id: 'alpha-backend', type: 'InMemory', options: { label: 'alpha' } },
    ]);
    await connection.repo!.createAppDataGroup('beta', []);

    const infos = await repo.listDataGroups();
    expect(infos.map((group) => group.id).sort()).toEqual(['alpha', 'beta']);
    expect(infos.find((group) => group.id === 'alpha')).toMatchObject({
      id: 'alpha',
      name: 'alpha',
      hasRemote: true,
    });
    expect(infos.find((group) => group.id === 'beta')).toMatchObject({
      id: 'beta',
      hasRemote: false,
    });

    const beta = await repo.getDataGroup('beta');
    expect(beta.id).toBe('beta');
    expect(await repo.getDataGroup('beta')).toBe(beta);

    const defaultGroup = await repo.getDefaultDataGroup();
    expect(defaultGroup.id).toBe('alpha');
    await expect(repo.getDataGroup('missing')).rejects.toBeInstanceOf(
      DataGroupNotFoundError,
    );
    await connection.repo!.dispose();
  });
});

describe('DataGroup.addBackend', () => {
  it('is idempotent for the same id or endpoint and adds a distinct endpoint once', async () => {
    const id = appId('add');
    const repo = await connectV2(id, { nodeId: 'n' });
    const group = await repo.getDefaultDataGroup();

    const first = await group.addBackend({
      id: 'primary',
      type: 'InMemory',
      options: { label: 'data-a' },
    });
    expect(first).toEqual({ backendId: 'primary', addedBackend: true });

    const sameId = await group.addBackend({
      id: 'primary',
      type: 'InMemory',
      options: { label: 'data-b' },
    });
    expect(sameId).toEqual({ backendId: 'primary', addedBackend: false });

    const sameEndpoint = await group.addBackend({
      type: 'InMemory',
      options: { label: 'data-a' },
    });
    expect(sameEndpoint).toEqual({ backendId: 'primary', addedBackend: false });

    const second = await group.addBackend({
      id: 'secondary',
      type: 'InMemory',
      options: { label: 'data-c' },
    });
    expect(second.addedBackend).toBe(true);

    const connection = getUiConnection(repo);
    const live = await connection.repo!.getAppDataGroup(group.id);
    expect(live.listDeclaredBackends().map((b) => b.id).sort()).toEqual([
      'primary',
      'secondary',
    ]);
    await connection.repo!.dispose();
  });

  it('rejects the same endpoint in another data group', async () => {
    const id = appId('conflict');
    const repo = await connectV2(id, { nodeId: 'n' });
    const group = await repo.getDefaultDataGroup();
    const connection = getUiConnection(repo);

    await connection.repo!.createAppDataGroup('other', [
      { id: 'other-backend', type: 'InMemory', options: { label: 'shared' } },
    ]);

    await expect(
      group.addBackend({ type: 'InMemory', options: { label: 'shared' } }),
    ).rejects.toBeInstanceOf(BackendEndpointConflictError);
    await connection.repo!.dispose();
  });
});

describe('DataGroup.flush / deleteFile', () => {
  it('flushes immediately and returns one pair result; deleteFile removes through tombstone path', async () => {
    const id = appId('flush');
    const repo = await connectV2(id, { nodeId: 'n' });
    const group = await repo.getDefaultDataGroup();
    await group.addBackend({
      id: 'flush-target',
      type: 'InMemory',
      options: { label: 'flush-target' },
    });

    await group.fs.promises.writeFile('/flush-a.txt', 'a');
    const results = await group.flush();
    expect(results.length).toBe(1);
    expect(results[0]!.pairId).toBeTruthy();
    expect(results[0]!.filesCreated).toBeGreaterThanOrEqual(0);

    await group.deleteFile('/flush-a.txt');
    await expect(group.fs.promises.stat('/flush-a.txt')).rejects.toBeTruthy();

    const connection = getUiConnection(repo);
    await connection.repo!.dispose();
  });
});

describe('DataGroup.onSyncEvent', () => {
  it('forwards sync:start and sync:end for a data-group pair', async () => {
    const id = appId('event');
    const repo = await connectV2(id, { nodeId: 'n' });
    const group = await repo.getDefaultDataGroup();
    const connection = getUiConnection(repo);

    await group.addBackend({
      id: 'events',
      type: 'InMemory',
      options: { label: 'events' },
    });

    const events: DataGroupSyncEvent[] = [];
    const unsubscribe = group.onSyncEvent((event) => events.push(event));

    await group.fs.promises.writeFile('/a.txt', 'hello');
    const live = await connection.repo!.getAppDataGroup(group.id);
    await live.flush();

    const start = events.find((event) => event.type === 'sync:start');
    const end = events.find((event) => event.type === 'sync:end');
    expect(start).toBeTruthy();
    expect(end).toBeTruthy();
    expect(start!.backendId).toBe('events');
    expect(end && end.type === 'sync:end' ? end.result.filesCreated : -1).toBeGreaterThanOrEqual(0);

    unsubscribe();
    const before = events.length;
    await live.flush();
    expect(events.length).toBe(before);
    await connection.repo!.dispose();
  });
});
