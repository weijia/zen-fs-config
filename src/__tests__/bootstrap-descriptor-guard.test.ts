/**
 * 引导副本（`.config/app-data-groups/{appId}/{id}.json`）守卫：
 * 「0 个后端」的空副本不允许覆盖远端既有的真实拓扑。
 *
 * 背景：本页「清除同步组配置」后本地库被重建，应用先建一个只有隐式本地存储的
 * 空 default 组并写下 `backends: []`；配置组后端一接上，首轮双向同步以本地为准，
 * 空副本就把远端登记抹平了（2026-11-24 线上 Gitee configs 实际发生）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import { writeGroupDescriptor } from '../group-meta';

const remoteStores = new Map<string, BackendInstance>();
const GROUP_ID = 'probe';
const DESC_PATH = `/.config/app-data-groups/probe/${GROUP_ID}.json`;

function tmp(tag: string): string {
  return path.join(
    os.tmpdir(),
    `zf-guard-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
}

async function mkdirp(fs: any, dirs: string[]): Promise<void> {
  for (const dir of dirs) await fs.mkdir(dir);
}

/** 远端：已经登记好一份「有 2 个后端」的拓扑。 */
async function seedRemote(
  tag: string,
  instanceId: string,
): Promise<{ label: string; backends: any[] }> {
  const label = `guard-${tag}-${Date.now()}`;
  const remote: any = await createBackend({ type: 'MemRemote', options: { label } });
  remoteStores.set(label, remote);
  await writeGroupDescriptor(remote, {
    schemaVersion: 2,
    kind: 'config',
    id: 'config',
    instanceId,
  });
  const backends = [
    { id: 'gitee-real', type: 'Folder', options: { path: tmp(`real-${tag}`) }, description: '', createdAt: 1 },
    { id: 'rs-real', type: 'Folder', options: { path: tmp(`rs-${tag}`) }, description: '', createdAt: 2 },
  ];
  await mkdirp(remote, ['/.config', '/.config/app-data-groups', '/.config/app-data-groups/probe']);
  await remote.writeFile(
    DESC_PATH,
    new TextEncoder().encode(JSON.stringify({ id: GROUP_ID, groupType: 'data-sync', backends }, null, 2)),
  );
  return { label, backends };
}

async function readRemoteDescriptor(label: string): Promise<any> {
  const inst: any = remoteStores.get(label)!;
  const raw = await inst.readFile(DESC_PATH);
  return JSON.parse(new TextDecoder().decode(raw));
}

async function readLocalDescriptor(localDir: string): Promise<any> {
  const fs: any = await createBackend({ type: 'Folder', options: { path: localDir } });
  try {
    const raw = await fs.readFile(DESC_PATH);
    return JSON.parse(new TextDecoder().decode(raw));
  } finally {
    await fs.dispose?.();
  }
}

beforeAll(() => {
  registerBackend(
    'MemRemote',
    async (options) => {
      const key = String((options as any).label ?? 'default');
      let inst = remoteStores.get(key);
      if (!inst) {
        inst = await createBackend({ type: 'InMemory', options: { label: `mem-remote-${key}` } });
        remoteStores.set(key, inst);
      }
      return inst;
    },
    {
      type: 'MemRemote',
      label: 'Mem remote',
      icon: 'M',
      fields: [],
      defaultOptions: {},
      identityFields: ['label'],
    } as any,
  );
});

describe('引导副本守卫：空副本不覆盖远端拓扑', () => {
  it('启动时读到的空副本被远端拓扑覆盖（远端保持不变）', async () => {
    const { label, backends } = await seedRemote('stale', 'aaaaaaaa-1111-4111-8111-111111111111');

    const localDir = tmp('stale-local');
    const local: any = await createBackend({ type: 'Folder', options: { path: localDir, label: 'seed' } });
    await mkdirp(local, ['/.config', '/.config/app-data-groups', '/.config/app-data-groups/probe']);
    await local.writeFile(
      DESC_PATH,
      new TextEncoder().encode(JSON.stringify({ id: GROUP_ID, groupType: 'data-sync', backends: [] }, null, 2)),
    );
    await local.dispose?.();

    const repo: any = await createConfigRepo('probe', {
      nodeId: 'n1',
      folderPath: localDir,
      backendInfo: { type: 'MemRemote', options: { label } },
    });
    await repo.whenReplicasReady();
    await repo.flush();

    expect((await readRemoteDescriptor(label)).backends.map((b: any) => b.id)).toEqual([
      'gitee-real',
      'rs-real',
    ]);
    const healed = await readLocalDescriptor(localDir);
    expect(healed.backends.map((b: any) => b.id)).toEqual(['gitee-real', 'rs-real']);
    expect(healed.backends.length).toBe(backends.length);
    await repo.dispose();
  });

  it('应用新建的空组（createAppDataGroup(id, [])）不会把远端抹成空', async () => {
    const { label } = await seedRemote('create', 'bbbbbbbb-2222-4222-8222-222222222222');
    const localDir = tmp('create-local');

    const repo: any = await createConfigRepo('probe', {
      nodeId: 'n2',
      folderPath: localDir,
      backendInfo: { type: 'MemRemote', options: { label } },
    });
    await repo.whenReplicasReady();
    await repo.createAppDataGroup(GROUP_ID, []);
    await repo.flush();

    expect((await readRemoteDescriptor(label)).backends.map((b: any) => b.id)).toEqual([
      'gitee-real',
      'rs-real',
    ]);
    await repo.dispose();
  });

  it('本会话内显式清空后端仍会推送空副本（保留用户真实意图）', async () => {
    const { label } = await seedRemote('explicit', 'cccccccc-3333-4333-8333-333333333333');
    const localDir = tmp('explicit-local');

    const repo: any = await createConfigRepo('probe', {
      nodeId: 'n3',
      folderPath: localDir,
      backendInfo: { type: 'MemRemote', options: { label } },
    });
    await repo.whenReplicasReady();
    await repo.createAppDataGroup(GROUP_ID, []);
    await repo.updateAppDataGroupDescriptor(GROUP_ID, []);
    await repo.flush();

    expect((await readRemoteDescriptor(label)).backends).toEqual([]);
    await repo.dispose();
  });
});
