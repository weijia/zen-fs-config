/**
 * 第一期：确定性组身份（UUID v5）+ 配置组 profile。
 *
 * 锁住的不变式：
 * - D1 同一 `kind + 输入` 永远算出同一个身份，且是合法 UUID；
 * - D2 配置组按 `profile`（缺省 `config`）派生，数据组按 `appId + groupId` 派生；
 * - D3 本地只有 IndexedDB、一个后端都没接时**不分配**身份；
 * - D4 接入空远端根时按 profile 派生并认领，另一台设备随后读到的是同一个值；
 * - D5 远端已有历史随机身份时**沿用**它，不改写。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import { connect } from '../connect';
import { readGroupDescriptor, writeGroupDescriptor } from '../group-meta';
import { deriveGroupInstanceId, isValidGroupInstanceId } from '../group-identity';

const localStores = new Map<string, BackendInstance>();
const remotes = new Map<string, BackendInstance>();

beforeAll(() => {
  process.env.ZEN_FS_CONFIG_HOME = path.join(os.tmpdir(), `zen-fs-config-detid-${Date.now()}`);

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
    'DetRemote',
    async (options) => {
      const key = String((options as any).label ?? 'default');
      let inst = remotes.get(key);
      if (!inst) {
        inst = await createBackend({ type: 'InMemory', options: { label: `det-remote-${key}` } });
        remotes.set(key, inst);
      }
      return inst;
    },
    {
      type: 'DetRemote',
      label: 'Deterministic remote',
      icon: 'D',
      fields: [],
      defaultOptions: {},
      identityFields: ['label'],
    } as any,
  );
});

const LEGACY_ID = '99999999-9999-4999-8999-999999999999';

describe('deriveGroupInstanceId', () => {
  it('同输入稳定、跨输入不同、形态合法', () => {
    const a = deriveGroupInstanceId('config', { profile: 'config' });
    const b = deriveGroupInstanceId('config', { profile: 'config' });
    const c = deriveGroupInstanceId('config', { profile: 'team' });
    const d = deriveGroupInstanceId('data', { appId: 'onenav', groupId: 'default' });
    const e = deriveGroupInstanceId('data', { appId: 'golf', groupId: 'default' });

    expect(a).toBe(b);
    expect(new Set([a, c, d, e]).size).toBe(4);
    for (const id of [a, c,d, e]) expect(isValidGroupInstanceId(id)).toBe(true);
    expect(a).not.toBe(LEGACY_ID);
  });

  it('数据组区分应用，配置组不受 appId 影响', () => {
    expect(deriveGroupInstanceId('config', { profile: 'config', appId: 'a' })).toBe(
      deriveGroupInstanceId('config', { profile: 'config', appId: 'b' }),
    );
    expect(deriveGroupInstanceId('data', { appId: 'a', groupId: 'default' })).not.toBe(
      deriveGroupInstanceId('data', { appId: 'b', groupId: 'default' }),
    );
  });
});

describe('config group identity (phase 1)', () => {
  it('本地无后端时不分配身份', async () => {
    const repo: any = await createConfigRepo('det-local', { nodeId: 'n1', idbStoreName: 'det-local' });
    expect(await repo.ensureGroupInstanceId()).toBe('');
    expect(repo.getGroupInstanceId()).toBeUndefined();
    await repo.dispose();
  });

  it('空远端按 profile 派生，另一台设备得到同一个身份', async () => {
    const backendInfo = { type: 'DetRemote', options: { label: 'shared-empty' } };

    const first = await connect('app-one', {
      idbStoreName: 'det-device-1',
      nodeId: 'd1',
      profile: 'shared',
      backendInfo,
      initGroupType: 'config-sync',
      deferReplicaSetup: false,
    });
    const firstId = (first.repo as any)!.getGroupInstanceId();
    expect(isValidGroupInstanceId(firstId)).toBe(true);
    expect(firstId).toBe(deriveGroupInstanceId('config', { profile: 'shared' }));

    const remote = await createBackend({ type: 'DetRemote', options: { label: 'shared-empty' } });
    expect((await readGroupDescriptor(remote))?.instanceId).toBe(firstId);
    await (first.repo as any)!.dispose();

    const second = await connect('app-two', {
      idbStoreName: 'det-device-2',
      nodeId: 'd2',
      profile: 'shared',
      backendInfo,
      deferReplicaSetup: false,
    });
    expect((second.repo as any)!.getGroupInstanceId()).toBe(firstId);
    await (second.repo as any)!.dispose();
  });

  it('远端已有历史随机身份时沿用，不改写', async () => {
    const backendInfo = { type: 'DetRemote', options: { label: 'legacy-root' } };
    const remote = await createBackend({ type: 'DetRemote', options: { label: 'legacy-root' } });
    await writeGroupDescriptor(remote, {
      schemaVersion: 2,
      kind: 'config',
      id: 'config',
      instanceId: LEGACY_ID,
    });

    const result = await connect('app-three', {
      idbStoreName: 'det-device-3',
      nodeId: 'd3',
      profile: 'config',
      backendInfo,
      deferReplicaSetup: false,
    });
    expect((result.repo as any)!.getGroupInstanceId()).toBe(LEGACY_ID);
    expect((await readGroupDescriptor(remote))?.instanceId).toBe(LEGACY_ID);
    await (result.repo as any)!.dispose();
  });
});

describe('增量接入后端（第一期）', () => {
  it('配置组：纯本地新建 → 加第一个后端 → 按 profile 派生并认领远端', async () => {
    const repo: any = await createConfigRepo('cfg-flow', {
      nodeId: 'cf1',
      idbStoreName: 'cfg-flow',
      profile: 'team',
    });
    // 新建时一个后端都没有：不分配身份
    expect(repo.getGroupInstanceId()).toBeUndefined();

    await repo.addBackend('cfg-r1', 'DetRemote', { label: 'cfg-flow-root' });

    const expected = deriveGroupInstanceId('config', { profile: 'team' });
    expect(repo.getGroupInstanceId()).toBe(expected);
    const remote = await createBackend({ type: 'DetRemote', options: { label: 'cfg-flow-root' } });
    expect((await readGroupDescriptor(remote))?.instanceId).toBe(expected);
    await repo.dispose();
  });

  it('配置组：本地纯新建 → 加一个已有历史身份的远端 → 沿用远端值', async () => {
    const remote = await createBackend({ type: 'DetRemote', options: { label: 'cfg-legacy-add' } });
    await writeGroupDescriptor(remote, {
      schemaVersion: 2,
      kind: 'config',
      id: 'config',
      instanceId: LEGACY_ID,
    });
    const repo: any = await createConfigRepo('cfg-legacy-add', {
      nodeId: 'cf2',
      idbStoreName: 'cfg-legacy-add',
    });
    await repo.addBackend('cfg-r2', 'DetRemote', { label: 'cfg-legacy-add' });
    expect(repo.getGroupInstanceId()).toBe(LEGACY_ID);
    expect((await readGroupDescriptor(remote))?.instanceId).toBe(LEGACY_ID);
    await repo.dispose();
  });

  it('数据组：新建时无后端不分配 → 加第一个后端 → 按 appId+groupId 派生并认领', async () => {
    const repo: any = await createConfigRepo('data-flow', { nodeId: 'df1', idbStoreName: 'data-flow' });
    const group: any = await repo.createAppDataGroup('lonely', []);
    await group.whenBackendsReady?.();
    // 没有后端：不分配身份
    expect(group.getGroupInstanceId()).toBeUndefined();

    await group.addBackend('d1', 'DetRemote', { label: 'data-lonely-root' });
    await group.whenBackendsReady?.();

    const expected = deriveGroupInstanceId('data', { appId: 'data-flow', groupId: 'lonely' });
    expect(group.getGroupInstanceId()).toBe(expected);
    const remote = await createBackend({ type: 'DetRemote', options: { label: 'data-lonely-root' } });
    expect((await readGroupDescriptor(remote))?.instanceId).toBe(expected);
    await repo.dispose();
  });

  it('数据组：同名 default 在不同应用下身份不同；同组再加后端身份不变', async () => {
    const repoA: any = await createConfigRepo('app-a', { nodeId: 'a1', idbStoreName: 'app-a' });
    const repoB: any = await createConfigRepo('app-b', { nodeId: 'b1', idbStoreName: 'app-b' });

    const a: any = await repoA.createAppDataGroup('default', [
      { id: 'a-r1', type: 'DetRemote', options: { label: 'app-a-default' } },
    ]);
    const b: any = await repoB.createAppDataGroup('default', [
      { id: 'b-r1', type: 'DetRemote', options: { label: 'app-b-default' } },
    ]);
    await a.flush();
    await b.flush();

    const idA = a.getGroupInstanceId();
    const idB = b.getGroupInstanceId();
    expect(idA).toBe(deriveGroupInstanceId('data', { appId: 'app-a', groupId: 'default' }));
    expect(idB).toBe(deriveGroupInstanceId('data', { appId: 'app-b', groupId: 'default' }));
    expect(idA).not.toBe(idB);

    // 同一组再加第二个后端：身份保持不变，并认领到新根
    await a.addBackend('a-r2', 'DetRemote', { label: 'app-a-default-2' });
    expect(a.getGroupInstanceId()).toBe(idA);
    const remote2 = await createBackend({ type: 'DetRemote', options: { label: 'app-a-default-2' } });
    expect((await readGroupDescriptor(remote2))?.instanceId).toBe(idA);

    await repoA.dispose();
    await repoB.dispose();
  });
});
