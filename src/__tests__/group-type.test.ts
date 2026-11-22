import { describe, it, expect, beforeAll } from 'vitest';
import { registerBackend, createBackend } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import { createDataSyncGroup } from '../data-sync-group';

// Mock IndexedDB with InMemory for Node.js testing
beforeAll(() => {
  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${options.storeName ?? Date.now()}` },
    });
  });
});

async function exists(repo: any, path: string): Promise<boolean> {
  return (repo.rootFS.promises as any).exists(path);
}

describe('group-type marker is no longer written', () => {
  it('createConfigRepo 不写 /.config/group-type 与 /.meta/group-type', async () => {
    const repo = await createConfigRepo('test-app-gt1', { nodeId: 'test-node' });
    expect(await exists(repo, '/.config/group-type')).toBe(false);
    expect(await exists(repo, '/.meta/group-type')).toBe(false);
    // 类型改由统一描述符承载；标记缺失时 getGroupType() 返回 null
    expect(await repo.getGroupType()).toBe(null);
    // 初始化本身不预置身份：group.json 由身份流程 / ensureGroupType 写
    expect(await exists(repo, '/.meta/group.json')).toBe(false);
    await repo.dispose();
  });

  it('ensureGroupType 只确保描述符，不写任何标记', async () => {
    const repo = await createConfigRepo('test-app-gt2', { nodeId: 'test-node' });
    await repo.ensureGroupType('config-sync');
    expect(await exists(repo, '/.config/group-type')).toBe(false);
    expect(await exists(repo, '/.meta/group-type')).toBe(false);
    expect(await repo.getGroupType()).toBe(null);
    expect(await exists(repo, '/.meta/group.json')).toBe(true);
    await repo.dispose();
  });

  it('ensureGroupType 不会把 data-sync 写进配置组', async () => {
    const repo = await createConfigRepo('test-app-gt3', { nodeId: 'test-node' });
    await repo.ensureGroupType('data-sync');
    expect(await exists(repo, '/.config/group-type')).toBe(false);
    const descriptor = JSON.parse(
      (await (repo.rootFS.promises as any).readFile('/.meta/group.json', 'utf-8')) as string,
    );
    expect(descriptor.kind).toBe('config');
    await repo.dispose();
  });

  it('遗留的 /.meta/group-type 仍可被 getGroupType() 读到（兼容旧根）', async () => {
    const repo = await createConfigRepo('test-app-gt4', { nodeId: 'test-node' });
    await (repo.rootFS.promises as any).writeFile(
      '/.meta/group-type',
      new TextEncoder().encode('config-sync'),
    );
    expect(await repo.getGroupType()).toBe('config-sync');
    await repo.dispose();
  });

  it('遗留标记会被 ensureGroupType 清掉', async () => {
    const repo = await createConfigRepo('test-app-gt5', { nodeId: 'test-node' });
    await (repo.rootFS.promises as any).writeFile(
      '/.meta/group-type',
      new TextEncoder().encode('config-sync'),
    );
    await repo.ensureGroupType('config-sync');
    expect(await exists(repo, '/.meta/group-type')).toBe(false);
    await repo.dispose();
  });

  it('createDataSyncGroup 不再写 /.meta/group-type', async () => {
    const group = await createDataSyncGroup('test-app-gt6');
    const fs = (group as any).fs?.promises ?? (group as any).fs;
    let markerExisted = false;
    try {
      await fs.readFile('/.meta/group-type', 'utf-8');
      markerExisted = true;
    } catch {
      markerExisted = false;
    }
    expect(markerExisted).toBe(false);
    await group.dispose();
  });
});
