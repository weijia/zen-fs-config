/**
 * 第二阶段：应用数据组后端从 `<groupId>.json` 里的 `backends` 数组，拆成
 * `/.config/app-data-groups/<appId>/backends/<backendId>.json`（一文件一端点）。
 *
 * 关键约束：
 * - 描述符只留组元信息，不写 `backends`；
 * - 同一组不同端点 → 两个文件，互不覆盖；
 * - 文件内带 `groupId`，平铺目录靠它区分归属；
 * - 删除后端 = 删文件 + 写墓碑；
 * - 旧描述符数组在首次读取时迁移成文件。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerBackend, createBackend } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import type { AppDataGroupDescriptor } from '../types';

const APP = 'backend-files-app';
const DESC_PATH = `/.config/app-data-groups/${APP}/g1.json`;
const BACKENDS_DIR = `/.config/app-data-groups/${APP}/backends`;

beforeAll(() => {
  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${(options as { storeName?: string }).storeName ?? Date.now()}` },
    });
  });
});

async function readJson(repo: any, path: string): Promise<any> {
  const raw = await (repo as any).cachedFS.readFile(path);
  return JSON.parse(new TextDecoder().decode(raw));
}

async function listDir(repo: any, path: string): Promise<string[]> {
  try {
    return await (repo as any).cachedFS.readdir(path);
  } catch {
    return [];
  }
}

describe('应用数据组后端独立文件', () => {
  it('描述符不含 backends，每个端点一个文件且带 groupId', async () => {
    const repo = await createConfigRepo(APP, { nodeId: 'n1' });
    await repo.createAppDataGroup('g1', [
      { id: 'b1', type: 'InMemory', options: { label: 'store-1' } },
      { id: 'b2', type: 'InMemory', options: { label: 'store-2' } },
    ]);

    const desc = await readJson(repo, DESC_PATH);
    expect(desc.id).toBe('g1');
    expect(desc.backends).toBeUndefined();

    const entries = (await listDir(repo, BACKENDS_DIR)).filter((e) => e.endsWith('.json')).sort();
    expect(entries).toEqual(['b1.json', 'b2.json']);
    for (const entry of entries) {
      const file = await readJson(repo, `${BACKENDS_DIR}/${entry}`);
      expect(file.groupId).toBe('g1');
      expect(file.options).toBeTruthy();
    }

    // 运行时 API 仍能拿到合并后的拓扑（列表来自文件，不是描述符数组）。
    const group = await repo.getAppDataGroup('g1');
    expect(group.listDeclaredBackends().map((b) => b.id).sort()).toEqual(['b1', 'b2']);

    await repo.dispose();
  });

  it('动态加第二个端点只多一个文件，描述符字节不变', async () => {
    const repo = await createConfigRepo(APP, { nodeId: 'n2' });
    const group = await repo.createAppDataGroup('g1', [
      { id: 'b1', type: 'InMemory', options: { label: 'store-1' } },
    ]);
    const before = await (repo as any).cachedFS.readFile(DESC_PATH);

    await group.addBackend('b2', 'InMemory', { label: 'store-2' });

    const after = await (repo as any).cachedFS.readFile(DESC_PATH);
    expect(new TextDecoder().decode(after)).toBe(new TextDecoder().decode(before));
    const entries = (await listDir(repo, BACKENDS_DIR)).filter((e) => e.endsWith('.json')).sort();
    expect(entries).toEqual(['b1.json', 'b2.json']);

    await repo.dispose();
  });

  it('删除后端会删掉自己的文件并写墓碑', async () => {
    const repo = await createConfigRepo(APP, { nodeId: 'n3' });
    const group = await repo.createAppDataGroup('g1', [
      { id: 'b1', type: 'InMemory', options: { label: 'store-1' } },
      { id: 'b2', type: 'InMemory', options: { label: 'store-2' } },
    ]);
    await group.removeBackend('b2');

    expect((await listDir(repo, BACKENDS_DIR)).filter((e) => e.endsWith('.json'))).toEqual(['b1.json']);
    const tombstones = await listDir(repo, '/.meta/tombstones');
    expect(tombstones.some((e) => e.includes('backends__b2'))).toBe(true);

    await repo.dispose();
  });

  it('旧描述符里的 backends 数组首次读取时迁移成文件，并回写去掉数组', async () => {
    const repo = await createConfigRepo(APP, { nodeId: 'n4' });
    const legacy: AppDataGroupDescriptor & { backends: any[] } = {
      id: 'g1',
      groupType: 'data-sync',
      backends: [
        { id: 'old-1', type: 'InMemory', options: { label: 'old-store-1' } },
        { id: 'old-2', type: 'InMemory', options: { label: 'old-store-2' } },
      ],
    };
    await (repo as any).ensureDir(DESC_PATH);
    await (repo as any).cachedFS.writeFile(
      DESC_PATH,
      new TextEncoder().encode(JSON.stringify(legacy, null, 2)),
    );

    const group = await repo.getAppDataGroup('g1');
    expect(group.listDeclaredBackends().map((b) => b.id).sort()).toEqual(['old-1', 'old-2']);

    const migrated = await readJson(repo, DESC_PATH);
    expect(migrated.backends).toBeUndefined();
    const files = (await listDir(repo, BACKENDS_DIR)).filter((e) => e.endsWith('.json')).sort();
    expect(files).toEqual(['old-1.json', 'old-2.json']);
    const file = await readJson(repo, `${BACKENDS_DIR}/old-1.json`);
    expect(file.groupId).toBe('g1');

    await repo.dispose();
  });

  it('新建组用组 id 当占位后端 id 时，改成端点指纹（跨节点同名文件）', async () => {
    const repoA = await createConfigRepo('deterministic-app', { nodeId: 'a' });
    const repoB = await createConfigRepo('deterministic-app', { nodeId: 'b' });
    const endpoint = { id: 'default', type: 'InMemory', options: { label: 'same-store' } };

    await repoA.createAppDataGroup('default', [endpoint]);
    await repoB.createAppDataGroup('default', [{ ...endpoint }]);

    const entriesA = (await listDir(repoA, '/.config/app-data-groups/deterministic-app/backends'))
      .filter((e) => e.endsWith('.json'));
    const entriesB = (await listDir(repoB, '/.config/app-data-groups/deterministic-app/backends'))
      .filter((e) => e.endsWith('.json'));
    expect(entriesA).toHaveLength(1);
    expect(entriesA).toEqual(entriesB);
    expect(entriesA[0]).not.toBe('default.json');
    expect(entriesA[0]).toMatch(/^InMemory-[0-9a-f]{10}\.json$/);

    await repoA.dispose();
    await repoB.dispose();
  });
});
