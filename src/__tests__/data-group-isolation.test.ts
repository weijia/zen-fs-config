import { describe, it, expect, beforeAll } from 'vitest';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';

// ---------------------------------------------------------------------------
// 数据同步组 ↔ 配置同步组隔离
//
// 数据组与配置组可能共用同一个远端账号（甚至同一个根目录）。配置专属目录
// （`.config/`、`nodes/`、`shared/`）属于配置同步组，数据组的双向同步必须
// 完全跳过这些路径：既不推送，也不拉取。
//
// `.meta/` 已改为通用同步元数据区（tombstones / versions / conflicts），会
// 参与数据组同步；但数据组 fs 视图通过 hiddenPrefixes 隐藏 `.meta` 与
// `.config`（隐藏 ≠ 不同步）。
// ---------------------------------------------------------------------------

let remote: BackendInstance;
let memA: BackendInstance;
let memB: BackendInstance;

beforeAll(async () => {
  // config repo 的本地 primary 固定使用 IndexedDB；Node 下用 InMemory 顶替
  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${options.storeName ?? Date.now()}` },
    });
  });

  // 可控远端：同一实例被数据组后端复用，便于事后检查实际收到的文件
  remote = await createBackend({
    type: 'InMemory',
    options: { label: `isolation-remote-${Date.now()}` },
  });
  registerBackend('AuditBackend', async () => remote, {
    type: 'AuditBackend',
    label: 'Audit',
    icon: '\u{1F9EA}',
    fields: [],
    defaultOptions: {},
    identityFields: ['label'],
  });

  // 两个独立后端：每次 createBackend 都新建实例，用于验证「本地 ↔ 各后端」
  const meta = (type: string) => ({
    type,
    label: type,
    icon: '\u{1F9EA}',
    fields: [],
    defaultOptions: {},
    identityFields: ['label'],
  });
  registerBackend('MemA', async () => {
    memA = await createBackend({ type: 'InMemory', options: { label: `memA-${Date.now()}-${Math.random()}` } });
    return memA;
  }, meta('MemA'));
  registerBackend('MemB', async () => {
    memB = await createBackend({ type: 'InMemory', options: { label: `memB-${Date.now()}-${Math.random()}` } });
    return memB;
  }, meta('MemB'));

  // 写入必定失败的后端：读/列目录正常，writeFile 抛错（模拟远端不可写）
  registerBackend('MemBroken', async () => {
    const inner = await createBackend({ type: 'InMemory', options: { label: `broken-${Date.now()}` } });
    return {
      readFile: inner.readFile.bind(inner),
      readdir: inner.readdir.bind(inner),
      stat: inner.stat.bind(inner),
      exists: inner.exists.bind(inner),
      mkdir: inner.mkdir.bind(inner),
      unlink: inner.unlink.bind(inner),
      rmdir: inner.rmdir.bind(inner),
      writeFile: async () => {
        throw new Error('backend offline');
      },
    } satisfies BackendInstance;
  }, meta('MemBroken'));
});

// 不同后端的 fs 形态不完全一致：可能是 node:fs 风格（顶层 stat），也可能是
// chroot fs（只有 promises.stat），这里统一通过 stat 判定存在性。
async function exists(fs: any, path: string): Promise<boolean> {
  const api = fs.promises ?? fs;
  try {
    await api.stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('data group sync isolation', () => {
  it('hides metadata from the data-group fs and never pushes config-only paths', async () => {
    const repo = await createConfigRepo('isolation-app', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('isolation-group', [
      { id: 'audit-1', type: 'AuditBackend', options: { label: 'shared-remote' } },
    ]);

    // `.meta/` 与 `.config/` 属于视图隐藏区域：应用不得直接读写
    await expect(
      group.fs.promises.writeFile('/.meta/config-marker.txt', 'config'),
    ).rejects.toThrow();
    await expect(
      group.fs.promises.writeFile('/.config/config-marker.txt', 'config'),
    ).rejects.toThrow();

    // 配置专属（未隐藏但被 filter 排除）：可以写，但不会同步到数据组远端
    await group.fs.promises.mkdir('/nodes', { recursive: true });
    await group.fs.promises.writeFile('/nodes/n1.txt', 'node');
    await group.fs.promises.mkdir('/shared', { recursive: true });
    await group.fs.promises.writeFile('/shared/s1.txt', 'shared');
    // 正常的数据内容
    await group.fs.promises.mkdir('/struct', { recursive: true });
    await group.fs.promises.writeFile('/struct/data.txt', 'data');

    await group.flush();

    // 数据内容照常上传（不破坏原有的上传能力）
    expect(await exists(remote, '/struct/data.txt')).toBe(true);
    // 配置内容一个都不许出现在数据组远端
    expect(await exists(remote, '/.meta/config-marker.txt')).toBe(false);
    expect(await exists(remote, '/.config/config-marker.txt')).toBe(false);
    expect(await exists(remote, '/nodes/n1.txt')).toBe(false);
    expect(await exists(remote, '/shared/s1.txt')).toBe(false);

    await repo.dispose();
  });

  it('does not pull config-only paths from a shared remote root', async () => {
    const repo = await createConfigRepo('isolation-app-pull', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('isolation-pull', [
      { id: 'audit-2', type: 'AuditBackend', options: { label: 'shared-remote' } },
    ]);

    // 远端根目录上放着配置同步组的专属内容
    if (!(await remote.exists('/.config'))) await remote.mkdir('/.config');
    await remote.writeFile('/.config/config-marker.txt', 'config-from-remote');
    if (!(await remote.exists('/struct'))) await remote.mkdir('/struct');
    await remote.writeFile('/struct/remote-data.txt', 'remote-data');

    await group.flush();

    // 正常数据可被拉取
    expect(await exists(group.fs, '/struct/remote-data.txt')).toBe(true);
    // 配置专属内容不进入数据组视图
    expect(await exists(group.fs, '/.config/config-marker.txt')).toBe(false);

    await repo.dispose();
  });
});

// ---------------------------------------------------------------------------
// 一个 data-sync 组里的多个后端：本地是唯一 source，每个后端各一条 pair，
// 后端之间没有直接 pair。语义 = 本地内容镜像到所有后端；某后端失败不影响其它。
// ---------------------------------------------------------------------------
describe('multiple backends in one data group', () => {
  it('mirrors local writes to every backend with one pair per backend', async () => {
    const repo = await createConfigRepo('multi-backend-app', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('mirror-group', [
      { id: 'a', type: 'MemA', options: { label: 'a' } },
      { id: 'b', type: 'MemB', options: { label: 'b' } },
    ]);

    await group.fs.promises.mkdir('/struct', { recursive: true });
    await group.fs.promises.writeFile('/struct/shared.txt', 'hello');
    await group.flush();

    // 两个后端都收到同一份内容
    expect(await exists(memA, '/struct/shared.txt')).toBe(true);
    expect(await exists(memB, '/struct/shared.txt')).toBe(true);
    // 只有两条 pair（本地↔A、本地↔B），不存在 A↔B 的直接 pair
    expect(group.getSyncStatuses().size).toBe(2);

    await repo.dispose();
  });

  it('propagates a backend-only file to the other backend via the local tree', async () => {
    const repo = await createConfigRepo('multi-backend-propagate', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('propagate-group', [
      { id: 'a', type: 'MemA', options: { label: 'a' } },
      { id: 'b', type: 'MemB', options: { label: 'b' } },
    ]);

    // 只写后端 A，本地与 B 都没有
    await memA.writeFile('/struct/only-a.txt', 'from-a');
    await group.flush(); // A → 本地
    expect(await exists(group.fs, '/struct/only-a.txt')).toBe(true);

    await group.flush(); // 本地 → B（下一轮同步）
    expect(await exists(memB, '/struct/only-a.txt')).toBe(true);

    await repo.dispose();
  });

  it('keeps syncing other backends when one backend write fails', async () => {
    const repo = await createConfigRepo('multi-backend-failure', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('failure-group', [
      { id: 'ok', type: 'MemA', options: { label: 'ok' } },
      { id: 'bad', type: 'MemBroken', options: { label: 'bad' } },
    ]);

    await group.fs.promises.mkdir('/struct', { recursive: true });
    await group.fs.promises.writeFile('/struct/ok.txt', 'ok');
    await group.flush(); // 不应抛错

    expect(await exists(memA, '/struct/ok.txt')).toBe(true);

    await repo.dispose();
  });
});
