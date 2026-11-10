import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import type { IConfigRepo } from '../types';
import {
  LocalStorageUnavailableError,
  dataGroupLocalStoreName,
  deleteDataGroupLocalStore,
  isLocalStorageUnavailableError,
  summarizeError,
} from '../errors';

/**
 * 本地数据组存储损坏的可识别性：
 * - NotReadableError / EIO 必须被识别为「本地存储不可用」，而不是普通错误；
 * - init() 包装错误时必须保留原始 cause（name / code / message）；
 * - 只删除该数据组独占的库名，绝不碰配置仓的库。
 */

function notReadable(message = 'Data lost due to missing file. Affected record should be considered irrecoverable') {
  const err = new Error(message);
  err.name = 'NotReadableError';
  return err;
}

describe('isLocalStorageUnavailableError', () => {
  it('识别 NotReadableError 与 EIO', () => {
    expect(isLocalStorageUnavailableError(notReadable())).toBe(true);
    expect(isLocalStorageUnavailableError(Object.assign(new Error('io'), { code: 'EIO' }))).toBe(true);
  });

  it('识别 cause 链里的原始错误', () => {
    const wrapped = new Error('Failed to create local primary', { cause: notReadable() });
    expect(isLocalStorageUnavailableError(wrapped)).toBe(true);
    const double = new Error('outer', { cause: wrapped });
    expect(isLocalStorageUnavailableError(double)).toBe(true);
  });

  it('普通错误不算本地存储不可用', () => {
    expect(isLocalStorageUnavailableError(new Error('descriptor read failed'))).toBe(false);
    expect(isLocalStorageUnavailableError(Object.assign(new Error('nf'), { code: 'ENOENT' }))).toBe(false);
    expect(isLocalStorageUnavailableError(null)).toBe(false);
  });
});

describe('dataGroupLocalStoreName', () => {
  it('default 组沿用旧库名，其它组按 groupId 隔离', () => {
    expect(dataGroupLocalStoreName('app', 'default')).toBe('zen-fs-config-data-app');
    expect(dataGroupLocalStoreName('app', 'g1')).toBe('zen-fs-config-data-app-g1');
    expect(dataGroupLocalStoreName('dir-struct-gen', 'default')).toBe('zen-fs-config-data-dir-struct-gen');
  });
});

describe('AppDataGroupImpl.init() 错误包装', () => {
  let repo: IConfigRepo;
  const appId = 'broken-store-app';

  beforeAll(async () => {
    // 强制走浏览器分支；配置仓仍能正常建立，只有数据组库抛 NotReadableError。
    (globalThis as any).indexedDB = {};
    registerBackend('IndexedDB', async (options) => {
      const name = String(options.storeName ?? 'default');
      if (name.startsWith('zen-fs-config-data-')) throw notReadable();
      return createBackend({ type: 'InMemory', options: { label: `idb:${name}` } });
    });
    repo = await createConfigRepo(appId, { nodeId: 'test-node' });
  });

  afterAll(async () => {
    await repo.dispose();
  });

  it('抛出可识别的 LocalStorageUnavailableError，并保留原始 cause', async () => {
    let caught: unknown;
    try {
      await repo.createAppDataGroup('broken', []);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LocalStorageUnavailableError);
    const err = caught as LocalStorageUnavailableError;
    expect(err.code).toBe('LOCAL_STORAGE_UNAVAILABLE');
    expect(err.groupId).toBe('broken');
    expect(err.storeName).toBe(`zen-fs-config-data-${appId}-broken`);
    expect(err.appId).toBe(appId);
    // 原始错因必须可见，而不是只剩一句概括
    const cause = summarizeError(err.cause);
    expect(cause.name).toBe('NotReadableError');
    expect(cause.message).toContain('Data lost due to missing file');
    expect(err.message).toContain('NotReadableError');
    expect(isLocalStorageUnavailableError(err)).toBe(true);
  });
});

describe('deleteDataGroupLocalStore', () => {
  const originalIdb = (globalThis as any).indexedDB;

  afterAll(() => {
    (globalThis as any).indexedDB = originalIdb;
  });

  it('只删除数据组独占库，并回报成功', async () => {
    const calls: string[] = [];
    (globalThis as any).indexedDB = {
      deleteDatabase(name: string) {
        calls.push(name);
        const req: any = {};
        setTimeout(() => req.onsuccess?.(), 0);
        return req;
      },
    };
    const result = await deleteDataGroupLocalStore('app', 'g1');
    expect(result).toMatchObject({ storeName: 'zen-fs-config-data-app-g1', deleted: true, blocked: false });
    expect(calls).toEqual(['zen-fs-config-data-app-g1']);
  });

  it('被其它连接阻塞时返回 blocked，并提示关闭其它页面', async () => {
    (globalThis as any).indexedDB = {
      deleteDatabase() {
        const req: any = {};
        setTimeout(() => req.onblocked?.(), 0);
        return req;
      },
    };
    const result = await deleteDataGroupLocalStore('app', 'g1', { timeoutMs: 20 });
    expect(result.deleted).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.error).toContain('其它页面');
  });

  it('无 IndexedDB 环境返回 unsupported', async () => {
    (globalThis as any).indexedDB = undefined;
    const result = await deleteDataGroupLocalStore('app', 'g1');
    expect(result.unsupported).toBe(true);
    expect(result.deleted).toBe(false);
  });
});
