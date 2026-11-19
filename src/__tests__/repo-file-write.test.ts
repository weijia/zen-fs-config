/**
 * `repo.writeRepoFile()` — 根级文件写入必须落在真实路径。
 *
 * 背景：admin 的 Files 页曾用 `repo.setConfig("/.config/...")` 保存配置仓根级
 * 文件，路径被拼成 `/admin/.config/...`（app 载荷分区），读的位置完全没变，
 * 表现为「保存成功但文件没改」。这里把正确的落点与版本边车固定下来。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import { versionPathFor } from '../version';
import { encodeMetaPath } from '../group-meta';

const localStores = new Map<string, any>();

beforeAll(() => {
  process.env.ZEN_FS_CONFIG_HOME = path.join(os.tmpdir(), `zen-fs-config-repo-file-${Date.now()}`);

  registerBackend('IndexedDB', async (options) => {
    const key = String((options as any).storeName ?? 'default');
    let inst = localStores.get(key);
    if (!inst) {
      inst = await createBackend({ type: 'InMemory', options: { label: `local-${key}` } });
      localStores.set(key, inst);
    }
    return inst;
  });
});

async function exists(fs: any, p: string): Promise<boolean> {
  const api = fs.promises ?? fs;
  try {
    await api.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(fs: any, p: string): Promise<string> {
  const raw = await (fs.promises ?? fs).readFile(p);
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw as any);
}

describe('writeRepoFile', () => {
  it('写根级路径的真实位置，不产生 /{appId}/.config 影子文件', async () => {
    const appId = 'repo-file-write';
    const repo = await createConfigRepo(appId, { nodeId: 'n-repo-file' });

    const target = '/.config/app-data-groups/demo-app/default.json';
    const text = JSON.stringify({ id: 'default', groupType: 'data-sync', backends: [] }, null, 2);
    await repo.writeRepoFile(target, text);

    expect(await readText(repo.rootFS, target)).toBe(text);
    expect(await exists(repo.rootFS, `/${appId}/.config/app-data-groups/demo-app/default.json`)).toBe(false);

    await repo.dispose();
  });

  it('同时更新 .version 边车（作者为 appId/nodeId）', async () => {
    const appId = 'repo-file-version';
    const repo = await createConfigRepo(appId, { nodeId: 'n-version' });

    const target = '/.meta/app-data-groups/demo-app/default.json';
    await repo.writeRepoFile(target, '{"a":1}');

    const sidecar = versionPathFor(target)!;
    expect(await exists(repo.rootFS, sidecar)).toBe(true);

    const meta = JSON.parse(await readText(repo.rootFS, sidecar));
    expect(meta.author).toBe(`${appId}/n-version`);
    expect(meta.version).toBeGreaterThanOrEqual(1);

    // 再写一次：内容变化 → 版本号递增。
    await repo.writeRepoFile(target, '{"a":2}');
    const meta2 = JSON.parse(await readText(repo.rootFS, sidecar));
    expect(meta2.version).toBeGreaterThan(meta.version);

    await repo.dispose();
  });

  it('重写已删除的文件路径会撤销墓碑（不再被排除表挡住）', async () => {
    const appId = 'repo-file-revive';
    const repo = await createConfigRepo(appId, { nodeId: 'n-revive' });
    const target = '/shared/revive.txt';
    const tombstone = `/.meta/tombstones/${encodeMetaPath(target)}.json`;

    await repo.writeRepoFile(target, 'v1');
    await repo.deleteFile(target);
    expect(await exists(repo.rootFS, tombstone)).toBe(true);
    expect(await exists(repo.rootFS, target)).toBe(false);

    await repo.writeRepoFile(target, 'v2');
    expect(await readText(repo.rootFS, target)).toBe('v2');
    expect(await exists(repo.rootFS, tombstone)).toBe(false);

    await repo.dispose();
  });

  it('写入被删目录的子路径会撤销祖先目录墓碑', async () => {
    const appId = 'repo-file-revive-dir';
    const repo = await createConfigRepo(appId, { nodeId: 'n-revive-dir' });
    const dir = '/shared/tree';
    const tombstone = `/.meta/tombstones/${encodeMetaPath(dir)}.json`;

    await repo.writeRepoFile(`${dir}/a.txt`, 'a');
    await repo.deleteFile(dir);
    expect(await exists(repo.rootFS, tombstone)).toBe(true);

    await repo.writeRepoFile(`${dir}/b.txt`, 'b');
    expect(await readText(repo.rootFS, `${dir}/b.txt`)).toBe('b');
    expect(await exists(repo.rootFS, tombstone)).toBe(false);

    await repo.dispose();
  });

  it('数据组组 fs 写入同样撤销墓碑', async () => {
    const appId = 'repo-file-adg';
    const repo = await createConfigRepo(appId, { nodeId: 'n-adg' });
    const group = await repo.createAppDataGroup('g-revive', [
      { id: 'b-1', type: 'InMemory', options: { label: 'g-revive' } },
    ]);
    const target = '/data/revive.txt';

    await group.fs.promises.writeFile(target, 'v1');
    await group.fs.promises.unlink(target);
    const before = await (group as any).tombstones.list();
    expect(before.some((t: any) => t.path === target)).toBe(true);

    await group.fs.promises.writeFile(target, 'v2');
    const after = await (group as any).tombstones.list();
    expect(after.some((t: any) => t.path === target)).toBe(false);
    expect(await group.fs.promises.readFile(target, 'utf-8')).toBe('v2');

    await repo.dispose();
  });
});
