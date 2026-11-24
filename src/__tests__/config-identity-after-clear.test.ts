/**
 * 「清空本地配置组 → 重新接入后端」这条路径上的身份判定。
 *
 * 现场问题：清除本页同步组配置后（本地 `.meta/group.json` 与后端缓存都没了），
 * 再加一个远端根，卡片上出现「配置同步组 ID 冲突」，而且明明空组却冒出一个
 * 新实例 ID。根因是身份候选只遍历 `backendDescriptorCache` —— 首次 connect 时
 * 该缓存还没 hydrate，于是把「没读」当成「哪里都没身份」，凭空生成 UUID 落盘，
 * 紧接着和远端已有的 instanceId 比对，必然 instance-mismatch。
 *
 * 这里锁住三件事：
 *   1. 远端根已有身份时，清空本地后接入必须沿用该值，不生成、不冲突；
 *   2. 已注册的根一个都读不到时，不生成也不落盘（不能靠猜顶掉远端身份）；
 *   3. 远端确实是空仓库时，仍然由本组生成一次并认领（新设备首连不能被挡住）。
 *
 * 注意：Folder 后端实例会缓存文件树，跨实例观察必须每次重开，否则读到的是旧快照。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import { readGroupDescriptor, writeGroupDescriptor } from '../group-meta';

const REMOTE_ID = '77777777-7777-4777-8777-777777777777';

beforeAll(() => {
  // 模拟一个「能建实例、但根读不到」的后端（权限/网络失败）。
  registerBackend(
    'BrokenRemote',
    async () => {
      const inst: any = await createBackend({ type: 'InMemory', options: { label: 'broken-remote' } });
      inst.readFile = async () => {
        throw new Error('EACCES: permission denied');
      };
      return inst;
    },
    {
      type: 'BrokenRemote',
      label: 'Broken remote',
      icon: 'B',
      fields: [],
      defaultOptions: {},
    } as any,
  );
});

function tmpDir(tag: string): string {
  return path.join(os.tmpdir(), `zen-fs-config-clear-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

/** 每次都用新实例访问同一目录，避免 Folder 的文件树缓存掩盖别处的写入。 */
async function withFolder<T>(dir: string, fn: (inst: any) => Promise<T>): Promise<T> {
  const inst: any = await createBackend({ type: 'Folder', options: { path: dir, label: `probe-${Date.now()}` } });
  try {
    return await fn(inst);
  } finally {
    try { await inst.dispose?.(); } catch { /* best effort */ }
  }
}

async function remoteIdentity(dir: string): Promise<string | undefined> {
  return withFolder(dir, async (inst) => (await readGroupDescriptor(inst))?.instanceId);
}

async function localIdentity(dir: string): Promise<string | undefined> {
  return remoteIdentity(dir);
}

describe('config group identity after clearing the local store', () => {
  it('远端根已有身份时沿用远端值，不生成新 UUID、不产生冲突', async () => {
    const remoteDir = tmpDir('remote-a');
    await withFolder(remoteDir, (inst) =>
      writeGroupDescriptor(inst, { schemaVersion: 2, kind: 'config', id: 'config', instanceId: REMOTE_ID }),
    );

    // 本地主存储是一个空目录 —— 等价于「清除本页同步组配置」之后的状态。
    const localDir = tmpDir('local-a');
    const repo: any = await createConfigRepo('clear-a', {
      nodeId: 'na',
      folderPath: localDir,
      backendInfo: { type: 'Folder', options: { path: remoteDir, label: 'cfg-a' } },
    });
    await repo.whenReplicasReady?.();

    // 关键断言：沿用远端身份，而不是凭空造一个再判冲突。
    expect(repo.getGroupInstanceId()).toBe(REMOTE_ID);
    expect(repo.listBackendConflicts()).toEqual([]);
    expect(repo.listSkippedBackends()).toEqual([]);

    expect(await localIdentity(localDir)).toBe(REMOTE_ID);
    // 远端没有被改写（还是一个值）
    expect(await remoteIdentity(remoteDir)).toBe(REMOTE_ID);

    await repo.dispose();
  });

  it('已注册的根一个都读不到时不生成也不落盘，冲突原因如实上报', async () => {
    const localDir = tmpDir('local-b');
    const repo: any = await createConfigRepo('clear-b', {
      nodeId: 'nb',
      folderPath: localDir,
      backendInfo: { type: 'BrokenRemote', options: {} },
    });
    await repo.whenReplicasReady?.();

    // 没有任何候选可读 → 不允许凭空分配身份
    expect(repo.getGroupInstanceId()).toBeUndefined();
    expect(await localIdentity(localDir)).toBeUndefined();

    const conflicts = repo.listBackendConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].local.instanceId).toBeUndefined();
    expect(['unreadable', 'local-unset']).toContain(conflicts[0].conflict);

    await repo.dispose();
  });

  it('远端是空仓库时仍由本组生成一次身份并认领（新设备首连不受影响）', async () => {
    const remoteDir = tmpDir('remote-c');

    const localDir = tmpDir('local-c');
    const repo: any = await createConfigRepo('clear-c', {
      nodeId: 'nc',
      folderPath: localDir,
      backendInfo: { type: 'Folder', options: { path: remoteDir, label: 'cfg-c' } },
    });
    await repo.whenReplicasReady?.();

    const assigned = repo.getGroupInstanceId();
    expect(assigned).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(repo.listBackendConflicts()).toEqual([]);
    // 空仓库被本组认领：远端也拿到了同一个身份。
    expect(await remoteIdentity(remoteDir)).toBe(assigned);

    await repo.dispose();
  });
});
