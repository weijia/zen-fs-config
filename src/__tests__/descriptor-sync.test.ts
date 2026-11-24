import { describe, it, expect, beforeAll, vi } from 'vitest';
import { registerBackend, createBackend } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import type { AppDataGroupDescriptor } from '../types';

// Node 里没有 IndexedDB：把本地主存储改成 InMemory，其余行为不变（同 app-data-group.test.ts）。
beforeAll(() => {
  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${(options as { storeName?: string }).storeName ?? Date.now()}` },
    });
  });
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('引导副本（.config/app-data-groups）与数据组拓扑保持一致', () => {
  it('addBackend 后描述符立刻写入，并触发一次配置组 flush', async () => {
    const repo = await createConfigRepo('test-desc-app1', { nodeId: 'node-1' });
    const group = await repo.createAppDataGroup('g1', [
      { id: 'b1', type: 'InMemory', options: { label: 'store-1' } },
    ]);

    const flushSpy = vi.spyOn(repo as any, 'flush');

    await group.addBackend('b2', 'InMemory', { label: 'store-2' });
    // 不 await：推送是「下一轮事件循环」触发的
    await tick(60);

    const desc = await (repo as any).readAppDataGroupDescriptor('g1');
    expect(desc.backends.map((b: { id: string }) => b.id).sort()).toEqual(['b1', 'b2']);
    expect(flushSpy).toHaveBeenCalled();

    await repo.dispose();
  });

  it('removeBackend 后描述符同步删掉该后端', async () => {
    const repo = await createConfigRepo('test-desc-app2', { nodeId: 'node-1' });
    const group = await repo.createAppDataGroup('g2', [
      { id: 'b1', type: 'InMemory', options: { label: 'store-a' } },
      { id: 'b2', type: 'InMemory', options: { label: 'store-b' } },
    ]);
    await group.removeBackend('b2');

    const desc = await (repo as any).readAppDataGroupDescriptor('g2');
    expect(desc.backends.map((b: { id: string }) => b.id)).toEqual(['b1']);

    await repo.dispose();
  });

  it('描述符与 .meta/backends 权威列表漂移时，getAppDataGroup 自愈回刷', async () => {
    // 这个用例需要**真正持久**的本地主存储（两次 getAppDataGroup 读同一个库），
    // 因此把 Node 默认的 InMemory 本地主存储换成临时目录里的 Folder。
    const os = await import('node:os');
    const path = await import('node:path');
    const home = path.join(os.tmpdir(), `zen-fs-desc-${Date.now()}`);
    const prevHome = process.env.ZEN_FS_CONFIG_HOME;
    process.env.ZEN_FS_CONFIG_HOME = home;
    try {
      const repo = await createConfigRepo('test-desc-app3', { nodeId: 'node-1' });
      const group = await repo.createAppDataGroup('g3', [
        { id: 'real-1', type: 'InMemory', options: { label: 'store-real' } },
      ]);
      expect(group.groupId).toBe('g3');
      // 等后台远端段完成：实例身份落进 .meta/group.json，本地库从此固定。
      await (group as any).whenBackendsReady?.();

      // 模拟「历史上改过后端但没回刷」：只改描述符里的 backends，其余（instanceId
      // 等身份字段）保持原样，因为真实漂移是后端清单落后，不是换了一个组。
      const existing: AppDataGroupDescriptor = await (repo as any).readAppDataGroupDescriptor('g3');
      const stale: AppDataGroupDescriptor = {
        ...existing,
        backends: [{ id: 'stale-9', type: 'InMemory', options: { label: 'store-old' } }],
      };
      await (repo as any).writeAppDataGroupDescriptorFile('g3', stale);

      // 丢弃缓存实例，模拟下次打开应用重新 getAppDataGroup
      (repo as any).appDataGroups.delete('g3');
      await repo.getAppDataGroup('g3');

      const desc = await (repo as any).readAppDataGroupDescriptor('g3');
      expect(desc.backends.map((b: { id: string }) => b.id)).toEqual(['real-1']);

      await repo.dispose();
    } finally {
      if (prevHome === undefined) delete process.env.ZEN_FS_CONFIG_HOME;
      else process.env.ZEN_FS_CONFIG_HOME = prevHome;
      await (await import('node:fs/promises')).rm(home, { recursive: true, force: true });
    }
  });

  it('本地还没有权威拓扑（新设备首连）时，不拿空列表覆盖描述符', async () => {
    const repo = await createConfigRepo('test-desc-app4', { nodeId: 'node-1' });
    const descriptor: AppDataGroupDescriptor = {
      id: 'g4',
      groupType: 'data-sync',
      backends: [{ id: 'from-bootstrap', type: 'InMemory', options: { label: 'store-boot' } }],
    };
    await (repo as any).writeAppDataGroupDescriptorFile('g4', descriptor);

    const group = await repo.getAppDataGroup('g4');
    // 引导副本被回填进数据组自己的 .meta/backends：声明列表非空，描述符不该被清空
    expect(group.listDeclaredBackends().map((b) => b.id)).toEqual(['from-bootstrap']);
    const desc = await (repo as any).readAppDataGroupDescriptor('g4');
    expect(desc.backends.map((b: { id: string }) => b.id)).toEqual(['from-bootstrap']);

    await repo.dispose();
  });
});
