/**
 * 配置组身份候选的「现场回读」路径 —— 界面为什么能看到本地与远端的分歧。
 *
 * 背景：同步 getter 只读缓存，而缓存只在「初始化时本地没有身份」才被填充。
 * admin 的实际状态是本地 `6abe8fce…`、两个远端根 `5a529e4a…`，同步 getter
 * 于是只返回一条本地值，卡片按「候选不足 2 组」自己隐藏了 —— 用户看不到
 * 唯一能拍板的地方。这里锁住 `getIdentityCandidatesAsync()` 的行为。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import { writeGroupDescriptor, readGroupDescriptor } from '../group-meta';

const localStores = new Map<string, BackendInstance>();
const remotes = new Map<string, BackendInstance>();

beforeAll(() => {
  process.env.ZEN_FS_CONFIG_HOME = path.join(os.tmpdir(), `zen-fs-config-candid-${Date.now()}`);

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
    'IdRemote',
    async (options) => {
      const key = String((options as any).label ?? 'default');
      let inst = remotes.get(key);
      if (!inst) {
        inst = await createBackend({ type: 'InMemory', options: { label: `id-remote-${key}` } });
        remotes.set(key, inst);
      }
      return inst;
    },
    {
      type: 'IdRemote',
      label: 'Identity remote',
      icon: 'I',
      fields: [],
      defaultOptions: {},
      identityFields: ['label'],
    } as any,
  );
});

const REMOTE_ID = '44444444-4444-4444-8444-444444444444';

describe('config group identity candidates (fresh read)', () => {
  it('本地已定身份时，async 回读仍能带出远端不同的值，并标记待裁决', async () => {
    const repo: any = await createConfigRepo('candid-1', { nodeId: 'c1' });
    const local = await repo.ensureGroupInstanceId();
    expect(local).toBeTruthy();

    // 远端根属于同一个配置组（kind=config · id=config），但身份被别处写成了另一个值
    const inst = await createBackend({ type: 'IdRemote', options: { label: 'cfg-1' } });
    remotes.set('cfg-1', inst);
    await writeGroupDescriptor(inst, {
      schemaVersion: 2,
      kind: 'config',
      id: 'config',
      instanceId: REMOTE_ID,
    });

    // 已注册的后端根（模拟 init 时读到的两个远端：configs 的 gitee / RemoteStorage）
    // 必须真实落盘到 `.meta/backends/`：现场回读认的是磁盘，不是内存缓存。
    await repo.writeBackendDescriptor({ id: 'r1', type: 'IdRemote', options: { label: 'cfg-1' } });

    // 同步 getter 只给缓存 → 只有本地一条
    const syncList = repo.getIdentityCandidates();
    expect(syncList.length).toBe(1);
    expect(syncList[0].instanceId).toBe(local);

    // 现场回读 → 本地 + 远端，两个不同值
    const fresh = await repo.getIdentityCandidatesAsync();
    expect(fresh.map((c: any) => c.instanceId).sort()).toEqual([local!, REMOTE_ID].sort());
    const remoteCandidate = fresh.find((c: any) => c.source === 'remote');
    expect(remoteCandidate?.backendId).toBe('r1');
    expect(fresh.find((c: any) => c.source === 'local')?.instanceId).toBe(local);
    expect(repo.isIdentityUnsettled()).toBe(true);

    // 只是读，没有改写任何一方
    expect(repo.getGroupInstanceId()).toBe(local);
    expect((await readGroupDescriptor(inst))?.instanceId).toBe(REMOTE_ID);

    await repo.dispose();
  });

  it('远端与本地一致时不标记待裁决', async () => {
    const repo: any = await createConfigRepo('candid-2', { nodeId: 'c2' });
    const local = await repo.ensureGroupInstanceId();

    const inst = await createBackend({ type: 'IdRemote', options: { label: 'cfg-2' } });
    remotes.set('cfg-2', inst);
    await writeGroupDescriptor(inst, { schemaVersion: 2, kind: 'config', id: 'config', instanceId: local });
    await repo.writeBackendDescriptor({ id: 'r2', type: 'IdRemote', options: { label: 'cfg-2' } });

    const fresh = await repo.getIdentityCandidatesAsync();
    expect(new Set(fresh.map((c: any) => c.instanceId)).size).toBe(1);
    expect(repo.isIdentityUnsettled()).toBe(false);
    await repo.dispose();
  });
});



