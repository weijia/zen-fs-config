import { describe, it, expect, afterEach } from 'vitest';
import {
  localSyncStoreNames,
  purgeLocalSyncConfig,
  deleteIndexedDbStore,
} from '../local-purge';

/**
 * 清除本页同步组配置：只删该 appId 的库，绝不误伤其它 appId。
 */

interface FakeRequest {
  onsuccess?: () => void;
  onerror?: () => void;
  onblocked?: () => void;
  error?: Error;
}

function makeFakeIdb(names: string[], opts: { blocked?: string[] } = {}) {
  const deleted: string[] = [];
  const idb = {
    deleteDatabase(name: string): FakeRequest {
      const req: FakeRequest = {};
      setTimeout(() => {
        if (opts.blocked?.includes(name)) {
          req.onblocked?.();
          return; // 不 success，模拟被占用后超时
        }
        deleted.push(name);
        req.onsuccess?.();
      }, 0);
      return req;
    },
    databases: async () => names.map((name) => ({ name })),
  };
  return { idb, deleted };
}

function makeFakeStorage(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key(i: number) { return Array.from(map.keys())[i] ?? null; },
    getItem(k: string) { return map.has(k) ? map.get(k)! : null; },
    removeItem(k: string) { map.delete(k); },
    setItem(k: string, v: string) { map.set(k, v); },
    remaining: () => Object.fromEntries(map),
  };
}

afterEach(() => {
  delete (globalThis as any).indexedDB;
  delete (globalThis as any).localStorage;
});

describe('localSyncStoreNames', () => {
  it('配置组 + default 数据组 + 每个 groupId 各一个库', () => {
    expect(localSyncStoreNames('golf')).toEqual([
      'zen-fs-config-config-golf',
      'zen-fs-config-data-golf',
    ]);
    expect(localSyncStoreNames('golf', ['remote-storage'])).toEqual([
      'zen-fs-config-config-golf',
      'zen-fs-config-data-golf',
      'zen-fs-config-data-golf-remote-storage',
    ]);
  });
});

describe('purgeLocalSyncConfig', () => {
  it('删除该 appId 的全部库，不碰别的 appId', async () => {
    const fake = makeFakeIdb([
      'zen-fs-config-config-golf',
      'zen-fs-config-data-golf',
      'zen-fs-config-data-golf-remote-storage',
      'zen-fs-config-data-golf-old-group',
      'zen-fs-config-config-other',
      'zen-fs-config-data-other',
      'unrelated-db',
    ]);
    (globalThis as any).indexedDB = fake.idb;
    const storage = makeFakeStorage({
      'zenfs-config-ui:backend': '{}',
      'zen-fs-config:rebuild-data-store:golf:remote-storage': '{}',
      keep: '1',
    });
    (globalThis as any).localStorage = storage;

    const result = await purgeLocalSyncConfig('golf', {
      extraStorageKeys: ['zenfs-config-ui:backend'],
    });

    expect(fake.deleted.sort()).toEqual([
      'zen-fs-config-config-golf',
      'zen-fs-config-data-golf',
      'zen-fs-config-data-golf-old-group',
      'zen-fs-config-data-golf-remote-storage',
    ]);
    expect(result.databases.every((d) => d.deleted)).toBe(true);
    expect(result.removedStorageKeys).toEqual(['zenfs-config-ui:backend']);
    expect(storage.remaining()).toEqual({
      'zen-fs-config:rebuild-data-store:golf:remote-storage': '{}',
      keep: '1',
    });
  });

  it('被其它标签页占用时如实返回 blocked，而不是假报成功', async () => {
    const fake = makeFakeIdb(
      ['zen-fs-config-config-golf', 'zen-fs-config-data-golf'],
      { blocked: ['zen-fs-config-config-golf'] },
    );
    (globalThis as any).indexedDB = fake.idb;

    const result = await purgeLocalSyncConfig('golf', { timeoutMs: 50 });
    const blocked = result.databases.find((d) => d.storeName === 'zen-fs-config-config-golf');
    expect(blocked?.deleted).toBe(false);
    expect(blocked?.blocked).toBe(true);
    expect(result.databases.find((d) => d.storeName === 'zen-fs-config-data-golf')?.deleted).toBe(true);
  });

  it('没有 IndexedDB 时返回 unsupported', async () => {
    const result = await purgeLocalSyncConfig('golf');
    expect(result.unsupported).toBe(true);
    expect(result.databases).toEqual([]);
  });

  it('deleteIndexedDbStore 在无 IndexedDB 时直接返回 unsupported', async () => {
    const result = await deleteIndexedDbStore('x');
    expect(result.unsupported).toBe(true);
    expect(result.deleted).toBe(false);
  });
});
