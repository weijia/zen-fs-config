import { describe, it, expect, beforeAll } from 'vitest';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';

// ---------------------------------------------------------------------------
// 数据组「后端 → 同步对」的一一对应关系
//
// 旧行为：init() 里 createBackend 失败只写日志，descriptor 仍留在列表里，
// 于是卡片列出 2 个后端、却只有 1 条 pair，用户无法看出是哪个后端失败。
//
// 新行为：getBackendSyncStates() 为每个 descriptor 记录 pairId 或 error，
// 失败的 descriptor 可被 removeBackend 移除（不会因“没有实例”而报 not found）。
// ---------------------------------------------------------------------------

const stores = new Map<string, BackendInstance>();

beforeAll(() => {
  (globalThis as any).indexedDB = {};
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
  registerBackend('MirrorA', async () => createBackend({ type: 'InMemory', options: { label: `a-${Date.now()}` } }), meta('MirrorA'));
  registerBackend('MirrorB', async () => createBackend({ type: 'InMemory', options: { label: `b-${Date.now()}` } }), meta('MirrorB'));
});

describe('data group backend → pair mapping', () => {
  it('records an error for a backend that cannot be created, keeping its descriptor', async () => {
    const repo = await createConfigRepo('states-app-1', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('mixed', [
      { id: 'ok', type: 'MirrorA', options: { label: 'ok' } },
      { id: 'broken', type: 'NoSuchBackend', options: {} },
    ]);

    const states = group.getBackendSyncStates();
    expect(states.size).toBe(2);
    expect(states.get('ok')?.pairId).toBeTruthy();
    expect(states.get('ok')?.error).toBeUndefined();
    expect(states.get('broken')?.pairId).toBeUndefined();
    expect(states.get('broken')?.error?.message).toContain('Unknown backend type');
    expect(group.getSyncStatuses().size).toBe(1);
  });

  it('creates one pair per distinct backend and reports no error', async () => {
    const repo = await createConfigRepo('states-app-2', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('two', [
      { id: 'a', type: 'MirrorA', options: { label: 'a' } },
      { id: 'b', type: 'MirrorB', options: { label: 'b' } },
    ]);

    const states = group.getBackendSyncStates();
    expect(states.size).toBe(2);
    expect(states.get('a')?.pairId).toBeTruthy();
    expect(states.get('b')?.pairId).toBeTruthy();
    expect([...states.values()].every((s) => !s.error)).toBe(true);
    expect(group.getSyncStatuses().size).toBe(2);
  });

  it('lets removeBackend drop a descriptor that never got a pair', async () => {
    const repo = await createConfigRepo('states-app-3', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('cleanup', [
      { id: 'ok', type: 'MirrorA', options: { label: 'ok' } },
      { id: 'broken', type: 'NoSuchBackend', options: {} },
    ]);

    await expect(group.removeBackend('broken')).resolves.toBeUndefined();

    const states = group.getBackendSyncStates();
    expect(states.has('broken')).toBe(false);
    expect(states.get('ok')?.pairId).toBeTruthy();
    expect(group.listBackends().map((b) => b.id)).toEqual(['ok']);
    expect(group.getSyncStatuses().size).toBe(1);
  });

  it('deduplicates identical endpoints and keeps a single pair/state', async () => {
    const repo = await createConfigRepo('states-app-4', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('dupe', [
      { id: 'dup-1', type: 'MirrorA', options: { label: 'same' } },
      { id: 'dup-2', type: 'MirrorA', options: { label: 'same' } },
    ]);

    expect(group.getSyncStatuses().size).toBe(1);
    expect(group.getBackendSyncStates().size).toBe(1);
    expect(group.listBackends().map((b) => b.id)).toEqual(['dup-1']);
  });
});
