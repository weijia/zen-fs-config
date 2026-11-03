import { describe, it, expect, beforeAll } from 'vitest';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';

// ---------------------------------------------------------------------------
// 数据同步组 ↔ 配置同步组隔离
//
// 数据组与配置组可能共用同一个远端账号（甚至同一个根目录）。配置树
// （`.meta/`、`nodes/`、`shared/`）属于配置同步组，数据组的双向同步必须
// 完全跳过这些路径：既不推送，也不拉取。
// ---------------------------------------------------------------------------

let remote: BackendInstance;

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
  it('never pushes or pulls config-only paths (.meta / nodes / shared)', async () => {
    const repo = await createConfigRepo('isolation-app', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('isolation-group', [
      { id: 'audit-1', type: 'AuditBackend', options: { label: 'shared-remote' } },
    ]);

    // 模拟数据组本地树里混入了配置同步组的内容
    await group.fs.promises.mkdir('/.meta', { recursive: true });
    await group.fs.promises.writeFile('/.meta/config-marker.txt', 'config');
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
    expect(await exists(remote, '/nodes/n1.txt')).toBe(false);
    expect(await exists(remote, '/shared/s1.txt')).toBe(false);

    await repo.dispose();
  });

  it('does not pull config-only paths from a shared remote root', async () => {
    const repo = await createConfigRepo('isolation-app-pull', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('isolation-pull', [
      { id: 'audit-2', type: 'AuditBackend', options: { label: 'shared-remote' } },
    ]);

    // 远端根目录上放着配置同步组的内容
    if (!(await remote.exists('/.meta'))) await remote.mkdir('/.meta');
    await remote.writeFile('/.meta/config-marker.txt', 'config-from-remote');
    if (!(await remote.exists('/struct'))) await remote.mkdir('/struct');
    await remote.writeFile('/struct/remote-data.txt', 'remote-data');

    await group.flush();

    // 正常数据可被拉取
    expect(await exists(group.fs, '/struct/remote-data.txt')).toBe(true);
    // 配置内容不得进入数据组
    expect(await exists(group.fs, '/.meta/config-marker.txt')).toBe(false);

    await repo.dispose();
  });
});
