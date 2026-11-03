import { describe, it, expect, beforeAll } from 'vitest';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';

// ---------------------------------------------------------------------------
// 数据组本地主存储的分组隔离
//
// 旧行为：所有数据组共用 zen-fs-config-data-{appId}，导致组 A 写入的文件会
// 出现在组 B 的 source 树里，并被 B 的后端一起推送。
//
// 新行为：default（legacy）组沿用旧 store；其他组使用
// zen-fs-config-data-{appId}-{groupId}。不做任何搬迁/删除，新组从远端回填。
// ---------------------------------------------------------------------------

const stores = new Map<string, BackendInstance>();
let mirrorA: BackendInstance;
let mirrorB: BackendInstance;

beforeAll(() => {
  // 强制 resolveLocalPrimary 走浏览器分支（Node 下没有 indexedDB）
  (globalThis as any).indexedDB = {};
  // 按 storeName 复用同一个实例，模拟真实 IndexedDB：同名 store = 同一份数据
  registerBackend('IndexedDB', async (options) => {
    const name = String(options.storeName ?? 'default');
    let store = stores.get(name);
    if (!store) {
      store = await createBackend({ type: 'InMemory', options: { label: `idb:${name}` } });
      stores.set(name, store);
    }
    return store;
  });

  const meta = (type: string) => ({
    type,
    label: type,
    icon: '\u{1F9EA}',
    fields: [],
    defaultOptions: {},
    identityFields: ['label'],
  });
  registerBackend('MirrorA', async () => {
    mirrorA = await createBackend({ type: 'InMemory', options: { label: `mirrorA-${Date.now()}` } });
    return mirrorA;
  }, meta('MirrorA'));
  registerBackend('MirrorB', async () => {
    mirrorB = await createBackend({ type: 'InMemory', options: { label: `mirrorB-${Date.now()}` } });
    return mirrorB;
  }, meta('MirrorB'));
});

async function exists(fs: any, path: string): Promise<boolean> {
  const api = fs.promises ?? fs;
  try {
    await api.stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('per-group local primary store', () => {
  it('isolates two data groups: each store only contains its own files', async () => {
    const appId = 'store-iso-app';
    const repo = await createConfigRepo(appId, { nodeId: 'test-node' });
    const a = await repo.createAppDataGroup('group-a', []);
    const b = await repo.createAppDataGroup('group-b', []);

    await a.fs.promises.writeFile('/from-a.txt', 'A');
    await b.fs.promises.writeFile('/from-b.txt', 'B');

    // 各自看得见自己的文件
    expect(await exists(a.fs, '/from-a.txt')).toBe(true);
    expect(await exists(b.fs, '/from-b.txt')).toBe(true);
    // 互不串台（这是旧共享 store 下会失败的关键断言）
    expect(await exists(a.fs, '/from-b.txt')).toBe(false);
    expect(await exists(b.fs, '/from-a.txt')).toBe(false);

    // 底层确实是两个不同的 store
    expect(stores.has(`zen-fs-config-data-${appId}-group-a`)).toBe(true);
    expect(stores.has(`zen-fs-config-data-${appId}-group-b`)).toBe(true);

    await repo.dispose();
  });

  it('keeps the legacy/default group on the old store (no migration)', async () => {
    const appId = 'store-legacy-app';
    const repo = await createConfigRepo(appId, { nodeId: 'test-node' });
    const legacy = await repo.createAppDataGroup('default', []);
    const other = await repo.createAppDataGroup('group-new', []);

    await legacy.fs.promises.writeFile('/legacy.txt', 'legacy');
    await other.fs.promises.writeFile('/new.txt', 'new');

    const oldStore = stores.get(`zen-fs-config-data-${appId}`);
    const newStore = stores.get(`zen-fs-config-data-${appId}-group-new`);
    expect(oldStore).toBeTruthy();
    expect(newStore).toBeTruthy();

    // default 的数据落到旧 store；新组文件不在旧 store
    expect(await exists(oldStore!, '/legacy.txt')).toBe(true);
    expect(await exists(oldStore!, '/new.txt')).toBe(false);
    // 新组使用独立 store
    expect(await exists(newStore!, '/new.txt')).toBe(true);
    expect(await exists(newStore!, '/legacy.txt')).toBe(false);

    await repo.dispose();
  });

  it('does not delete local data when a group is removed', async () => {
    const appId = 'store-remove-app';
    const repo = await createConfigRepo(appId, { nodeId: 'test-node' });
    const g = await repo.createAppDataGroup('group-del', []);
    await g.fs.promises.writeFile('/keep.txt', 'keep');
    const store = stores.get(`zen-fs-config-data-${appId}-group-del`);
    expect(store).toBeTruthy();

    await repo.removeAppDataGroup('group-del');

    // 描述符已删除，但本地 store 与数据保留（默认不删用户数据）
    expect(await repo.listAppDataGroups()).toHaveLength(0);
    expect(await exists(store!, '/keep.txt')).toBe(true);

    await repo.dispose();
  });

  it('still mirrors one group to all of its backends', async () => {
    const appId = 'store-mirror-app';
    const repo = await createConfigRepo(appId, { nodeId: 'test-node' });
    const g = await repo.createAppDataGroup('mirror-group', [
      { id: 'ma', type: 'MirrorA', options: { label: 'mirror-a' } },
      { id: 'mb', type: 'MirrorB', options: { label: 'mirror-b' } },
    ]);

    await g.fs.promises.writeFile('/mirror.txt', 'M');
    await g.flush();

    expect(await exists(mirrorA, '/mirror.txt')).toBe(true);
    expect(await exists(mirrorB, '/mirror.txt')).toBe(true);

    await repo.dispose();
  });
});
