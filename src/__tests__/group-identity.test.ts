/**
 * Group identity — the sync boundary.
 *
 * Requirement: 每个同步组有唯一实例身份；**不同的同步组之间不能同步**。
 * 实现上不靠路径隔离，而是「连接远端前先比对远端 `.meta/group.json` 的
 * `instanceId`，不一致就不建立同步对」。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import { readGroupDescriptor, writeGroupDescriptor } from '../group-meta';
import {
  bindRemoteGroupIdentity,
  isValidGroupInstanceId,
  newGroupInstanceId,
} from '../group-identity';
import {
  serializeAppDataGroupDescriptor,
  serializeGroupDescriptor,
} from '../canonical-json';
import type { AppDataGroup } from '../types';

const localStores = new Map<string, BackendInstance>();
const remotes = new Map<string, BackendInstance>();

beforeAll(() => {
  process.env.ZEN_FS_CONFIG_HOME = path.join(os.tmpdir(), `zen-fs-config-identity-${Date.now()}`);

  registerBackend('IndexedDB', async (options) => {
    const key = String((options as any).storeName ?? 'default');
    let inst = localStores.get(key);
    if (!inst) {
      inst = await createBackend({ type: 'InMemory', options: { label: `local-${key}` } });
      localStores.set(key, inst);
    }
    return inst;
  });

  registerBackend(
    'IdentityRemote',
    async (options) => {
      const key = String((options as any).label ?? 'default');
      let inst = remotes.get(key);
      if (!inst) {
        inst = await createBackend({ type: 'InMemory', options: { label: `remote-${key}` } });
        remotes.set(key, inst);
      }
      return inst;
    },
    {
      type: 'IdentityRemote',
      label: 'Identity remote',
      icon: 'I',
      fields: [],
      defaultOptions: {},
      identityFields: ['label'],
    } as any,
  );
});

async function freshRemote(label: string): Promise<BackendInstance> {
  const key = `${label}-${Math.random().toString(36).slice(2)}`;
  const inst = await createBackend({ type: 'InMemory', options: { label: key } });
  return inst;
}

/** 通过注册的 `IdentityRemote` 取到与 repo 实际使用同一个 InMemory 实例。 */
async function registeredRemote(label: string): Promise<BackendInstance> {
  return createBackend({ type: 'IdentityRemote', options: { label } });
}

describe('group instance id', () => {
  it('is a valid, unique UUID', () => {
    const a = newGroupInstanceId();
    const b = newGroupInstanceId();
    expect(isValidGroupInstanceId(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('rejects anything that is not a UUID', () => {
    expect(isValidGroupInstanceId('')).toBe(false);
    expect(isValidGroupInstanceId('default')).toBe(false);
    expect(isValidGroupInstanceId(undefined)).toBe(false);
    expect(isValidGroupInstanceId(42 as any)).toBe(false);
  });
});

describe('bindRemoteGroupIdentity', () => {
  it('claims an empty remote root and writes the instance id', async () => {
    const remote: any = await freshRemote('empty');
    const identity = { kind: 'data' as const, id: 'g1', instanceId: newGroupInstanceId() };
    expect(await bindRemoteGroupIdentity(remote, identity)).toBe('claimed');
    const desc = await readGroupDescriptor(remote);
    expect(desc?.instanceId).toBe(identity.instanceId);
    expect(desc?.kind).toBe('data');
    expect(desc?.id).toBe('g1');
  });

  it('reports match when the remote already carries the same instance id', async () => {
    const remote: any = await freshRemote('same');
    const identity = { kind: 'data' as const, id: 'g1', instanceId: newGroupInstanceId() };
    await bindRemoteGroupIdentity(remote, identity);
    expect(await bindRemoteGroupIdentity(remote, identity)).toBe('match');
  });

  it('reports conflict for another sync group and never overwrites it', async () => {
    const remote: any = await freshRemote('other');
    const owner = { kind: 'data' as const, id: 'g1', instanceId: newGroupInstanceId() };
    const intruder = { kind: 'data' as const, id: 'g2', instanceId: newGroupInstanceId() };
    await bindRemoteGroupIdentity(remote, owner);
    expect(await bindRemoteGroupIdentity(remote, intruder)).toBe('conflict');
    expect((await readGroupDescriptor(remote))?.instanceId).toBe(owner.instanceId);
  });

  it('treats an unclaimed legacy remote (no instance id) as claimable and keeps its metadata', async () => {
    const remote: any = await freshRemote('legacy');
    await writeGroupDescriptor(remote, {
      schemaVersion: 2,
      kind: 'data',
      id: 'legacy-group',
      name: '老组',
    });
    const identity = { kind: 'data' as const, id: 'g1', instanceId: newGroupInstanceId() };
    expect(await bindRemoteGroupIdentity(remote, identity)).toBe('claimed');
    const desc = await readGroupDescriptor(remote);
    expect(desc?.instanceId).toBe(identity.instanceId);
    expect(desc?.id).toBe('legacy-group'); // 归属变了，显示信息不被覆盖
    expect(desc?.name).toBe('老组');
  });

  it('rejects a remote root of a different group kind', async () => {
    const remote: any = await freshRemote('config-root');
    await writeGroupDescriptor(remote, { schemaVersion: 2, kind: 'config', id: 'config' });
    const identity = { kind: 'data' as const, id: 'g1', instanceId: newGroupInstanceId() };
    expect(await bindRemoteGroupIdentity(remote, identity)).toBe('conflict');
    expect((await readGroupDescriptor(remote))?.instanceId).toBeUndefined();
  });
});

describe('serialization', () => {
  it('keeps instanceId in the fixed field order and round-trips byte-identically', () => {
    const bytes = serializeGroupDescriptor({
      schemaVersion: 2,
      kind: 'data',
      id: 'g1',
      instanceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      name: '组 A',
    });
    expect(JSON.parse(bytes).instanceId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(serializeGroupDescriptor(JSON.parse(bytes))).toBe(bytes);
    // 顺序：schemaVersion, kind, id, instanceId, name
    expect(bytes.indexOf('"instanceId"')).toBeLessThan(bytes.indexOf('"name"'));
    expect(bytes.indexOf('"id"')).toBeLessThan(bytes.indexOf('"instanceId"'));
  });

  it('carries instanceId in the bootstrap descriptor', () => {
    const bytes = serializeAppDataGroupDescriptor({
      id: 'g1',
      groupType: 'data-sync',
      instanceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      backends: [],
    });
    expect(JSON.parse(bytes).instanceId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(serializeAppDataGroupDescriptor(JSON.parse(bytes))).toBe(bytes);
  });
});

describe('sync boundary at the repo level', () => {
  it('两个同步组共用同一个远端时，后到的组不建立同步对', async () => {
    const repoA = await createConfigRepo('app-a', {
      idbStoreName: 'identity-a',
      backendInfo: { type: 'IdentityRemote', options: { label: 'shared-root' } },
      cache: false,
    });
    const repoB = await createConfigRepo('app-b', {
      idbStoreName: 'identity-b',
      backendInfo: { type: 'IdentityRemote', options: { label: 'shared-root' } },
      cache: false,
    });

    // A 先连上 → 认领远端根，写入自己的实例身份。
    const idA = (repoA as any).getGroupInstanceId?.() ?? (await (repoA as any).ensureGroupInstanceId());
    const descA = await readGroupDescriptor(await registeredRemote('shared-root'));
    expect(descA?.instanceId).toBe(idA);

    // B 连同一个远端 → 归属冲突，后端被跳过（没有同步对）。
    const skipped = (repoB as any).listSkippedBackends();
    expect(skipped.length).toBeGreaterThan(0);
    expect((repoB as any).getSyncStatuses().size).toBe(0);

    await repoA.dispose();
    await repoB.dispose();
  });

  it('数据组的引导副本带着实例身份，两个实例身份不同的组不会互相搬运', async () => {
    const remote = registeredRemote;
    const repo = await createConfigRepo('app-c', {
      idbStoreName: 'identity-c',
      cache: false,
    });

    const group: AppDataGroup = await repo.createAppDataGroup('g1', [
      { id: 'r1', type: 'IdentityRemote', options: { label: 'data-root' } },
    ]);
    const instanceId = group.getGroupInstanceId();
    expect(isValidGroupInstanceId(instanceId)).toBe(true);

    // 引导副本（配置组登记）带同一实例身份。
    const boot = await (repo as any).readAppDataGroupDescriptor('g1');
    expect(boot?.instanceId).toBe(instanceId);

    // 远端根已被本组认领。
    expect((await readGroupDescriptor(await remote('data-root')))?.instanceId).toBe(instanceId);

    // 把远端改成“另一个组”的身份 → 重新打开时该后端被跳过。
    await writeGroupDescriptor(await remote('data-root'), {
      schemaVersion: 2,
      kind: 'data',
      id: 'other-group',
      instanceId: newGroupInstanceId(),
    });
    await group.dispose();
    (repo as any).appDataGroups.delete('g1');

    const reopened: AppDataGroup = await repo.getAppDataGroup('g1');
    expect(reopened.listSkippedBackends().length).toBe(1);
    expect(reopened.getBackendSyncStates().size).toBe(0);

    await reopened.dispose();
    await repo.dispose();
  });
});
