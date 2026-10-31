import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @zenfs/core so wrapZenFSFileSystem returns a controllable isolated FS.
// The factory does not reference any outer-scope variables, so vitest's
// hoisting of vi.mock() is safe.
vi.mock('@zenfs/core', () => ({
  resolveMountConfig: vi.fn(),
  InMemory: class FakeInMemory {},
}));

import {
  backendToSyncableFS,
  zenfsPromisesToSyncableFS,
  cachedFSToSyncableFS,
} from '../adapters';
import { wrapZenFSFileSystem } from '../backend-registry';
import { resolveMountConfig } from '@zenfs/core';

// ---------------------------------------------------------------------------
// Mock factory helpers (fresh mocks per test → no cross-test contamination)
// ---------------------------------------------------------------------------

/** A minimal BackendInstance mock. Extra methods can be injected via overrides. */
function createMockBackend(overrides: Record<string, any> = {}): any {
  return {
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mode: 0o100644, size: 0, mtimeMs: 0 }),
    mkdir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
    rmdir: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** A minimal fs.promises-style mock. */
function createMockPromises(overrides: Record<string, any> = {}): any {
  return {
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
    utimes: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mode: 0o100644, size: 0, mtimeMs: 0 }),
    mkdir: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** A minimal CachedFileSystem mock. */
function createMockCached(overrides: Record<string, any> = {}): any {
  return {
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(new Uint8Array()),
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mode: 0o100644, size: 0, mtimeMs: 0 }),
    mkdir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

/** A minimal isolated ZenFS FileSystem mock (the object resolveMountConfig resolves to). */
function createMockIsolatedFS(overrides: Record<string, any> = {}): any {
  return {
    stat: vi.fn().mockResolvedValue({ size: 0, mode: 0o100644, mtimeMs: 0 }),
    read: vi.fn().mockResolvedValue(0),
    write: vi.fn().mockResolvedValue(0),
    exists: vi.fn().mockResolvedValue(true),
    mkdir: vi.fn().mockResolvedValue(undefined),
    createFile: vi.fn().mockResolvedValue(undefined),
    touch: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    unlink: vi.fn().mockResolvedValue(undefined),
    rmdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. backendToSyncableFS
// ---------------------------------------------------------------------------

describe('backendToSyncableFS', () => {
  describe('writeFileWithMtime', () => {
    it('calls backend.writeFile with mtime option when backend does not have writeFileWithMtime', async () => {
      const backend = createMockBackend();
      const adapter = backendToSyncableFS(backend);

      await (adapter as any).writeFileWithMtime('/test.txt', 'data', 1700000000000);

      expect(backend.writeFile).toHaveBeenCalledWith('/test.txt', 'data', { mtime: 1700000000000 });
    });

    it('passes through to backend.writeFileWithMtime when backend has it', async () => {
      const backend = createMockBackend({
        writeFileWithMtime: vi.fn().mockResolvedValue(undefined),
      });
      const adapter = backendToSyncableFS(backend);

      await (adapter as any).writeFileWithMtime('/test.txt', 'data', 1700000000000);

      expect(backend.writeFileWithMtime).toHaveBeenCalledWith('/test.txt', 'data', 1700000000000);
      // The static fallback (backend.writeFile with options) must NOT run.
      expect(backend.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('createSnapshot passthrough', () => {
    it('passes through createSnapshot when backend has it', async () => {
      const backend = createMockBackend({
        createSnapshot: vi.fn().mockResolvedValue({ entries: [] }),
      });
      const adapter = backendToSyncableFS(backend);

      expect(typeof (adapter as any).createSnapshot).toBe('function');

      await (adapter as any).createSnapshot('/root', undefined);
      expect(backend.createSnapshot).toHaveBeenCalledWith('/root', undefined);
    });

    it('does not add createSnapshot when backend lacks it', () => {
      const backend = createMockBackend();
      const adapter = backendToSyncableFS(backend);

      expect((adapter as any).createSnapshot).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// 2. zenfsPromisesToSyncableFS
// ---------------------------------------------------------------------------

describe('zenfsPromisesToSyncableFS', () => {
  describe('writeFileWithMtime', () => {
    it('writes file and then calls utimes', async () => {
      const promises = createMockPromises();
      const adapter = zenfsPromisesToSyncableFS(promises);

      await (adapter as any).writeFileWithMtime('/test.txt', 'data', 1700000000000);

      expect(promises.writeFile).toHaveBeenCalledWith('/test.txt', 'data');
      const expectedTime = new Date(1700000000000);
      expect(promises.utimes).toHaveBeenCalledWith('/test.txt', expectedTime, expectedTime);

      // utimes must be called AFTER writeFile
      const writeFileOrder = promises.writeFile.mock.invocationCallOrder[0];
      const utimesOrder = promises.utimes.mock.invocationCallOrder[0];
      expect(utimesOrder).toBeGreaterThan(writeFileOrder);
    });

    it('does not throw when utimes fails', async () => {
      const promises = createMockPromises({
        utimes: vi.fn().mockRejectedValue(new Error('utimes not supported')),
      });
      const adapter = zenfsPromisesToSyncableFS(promises);

      // Should resolve without throwing despite utimes rejection.
      await expect(
        (adapter as any).writeFileWithMtime('/test.txt', 'data', 1700000000000),
      ).resolves.toBeUndefined();

      // writeFile must still have been called.
      expect(promises.writeFile).toHaveBeenCalledWith('/test.txt', 'data');
      expect(promises.utimes).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// 3. cachedFSToSyncableFS
// ---------------------------------------------------------------------------

describe('cachedFSToSyncableFS', () => {
  describe('writeFileWithMtime', () => {
    it('calls cached.writeFile with mtime option', async () => {
      const cached = createMockCached();
      const adapter = cachedFSToSyncableFS(cached);

      await (adapter as any).writeFileWithMtime('/test.txt', 'data', 1700000000000);

      expect(cached.writeFile).toHaveBeenCalledWith('/test.txt', 'data', { mtime: 1700000000000 });
    });
  });
});

// ---------------------------------------------------------------------------
// 4. wrapZenFSFileSystem passthrough (backend-registry)
// ---------------------------------------------------------------------------

describe('wrapZenFSFileSystem passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes through createSnapshot when isolated FS has it', async () => {
    const isolatedFS = createMockIsolatedFS({
      createSnapshot: vi.fn().mockResolvedValue({ entries: [] }),
    });
    vi.mocked(resolveMountConfig).mockResolvedValue(isolatedFS);

    const backend = await wrapZenFSFileSystem({});

    expect(typeof (backend as any).createSnapshot).toBe('function');
    await (backend as any).createSnapshot('/root', undefined);
    expect(isolatedFS.createSnapshot).toHaveBeenCalledWith('/root', undefined);
  });

  it('passes through writeFileWithMtime when isolated FS has it', async () => {
    const isolatedFS = createMockIsolatedFS({
      writeFileWithMtime: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(resolveMountConfig).mockResolvedValue(isolatedFS);

    const backend = await wrapZenFSFileSystem({});

    expect(typeof (backend as any).writeFileWithMtime).toBe('function');
    await (backend as any).writeFileWithMtime('/test.txt', 'data', 1700000000000);
    expect(isolatedFS.writeFileWithMtime).toHaveBeenCalledWith('/test.txt', 'data', 1700000000000);
  });

  it('does not add createSnapshot or writeFileWithMtime when isolated FS lacks them', async () => {
    const isolatedFS = createMockIsolatedFS();
    vi.mocked(resolveMountConfig).mockResolvedValue(isolatedFS);

    const backend = await wrapZenFSFileSystem({});

    expect((backend as any).createSnapshot).toBeUndefined();
    expect((backend as any).writeFileWithMtime).toBeUndefined();
  });

  it('passes through shouldSync when isolated FS has it (regression: Gitee/RemoteStorage remote-change polling)', async () => {
    const isolatedFS = createMockIsolatedFS({
      shouldSync: vi.fn().mockResolvedValue(false),
    });
    vi.mocked(resolveMountConfig).mockResolvedValue(isolatedFS);

    const backend = await wrapZenFSFileSystem({});

    // 契约：底层实现了 shouldSync，包装后的 BackendInstance 必须仍然具备，
    // 否则 backendToSyncableFS / wrapWithCache 的 typeof 探测摸不到，
    // zen-fs-sync 的远端变更轮询通道会静默失效。
    expect(typeof (backend as any).shouldSync).toBe('function');

    await (backend as any).shouldSync();
    expect(isolatedFS.shouldSync).toHaveBeenCalled();

    // 转发结果必须保留（true / false 语义不能被吞掉）
    await expect((backend as any).shouldSync()).resolves.toBe(false);
    isolatedFS.shouldSync = vi.fn().mockResolvedValue(true);
    await expect((backend as any).shouldSync()).resolves.toBe(true);
  });

  it('does not add shouldSync when isolated FS lacks it', async () => {
    const isolatedFS = createMockIsolatedFS();
    vi.mocked(resolveMountConfig).mockResolvedValue(isolatedFS);

    const backend = await wrapZenFSFileSystem({});

    expect((backend as any).shouldSync).toBeUndefined();
  });

  it('contract: every optional capability present on the isolated FS survives wrapping', async () => {
    // 白名单抄写式包装的历史 bug：漏抄一个可选能力 → 下游 typeof 探测
    // 永远摸不到 → 同步引擎静默降级。此测试对全部可选能力做整体断言，
    // 新增能力时请同步加进 OPTIONAL_CAPABILITIES。
    const OPTIONAL_CAPABILITIES = [
      'shouldSync',
      'createSnapshot',
      'writeFileWithMtime',
    ] as const;

    const overrides: Record<string, any> = {};
    for (const cap of OPTIONAL_CAPABILITIES) {
      overrides[cap] = vi.fn().mockResolvedValue(undefined);
    }
    const isolatedFS = createMockIsolatedFS(overrides);
    vi.mocked(resolveMountConfig).mockResolvedValue(isolatedFS);

    const backend = await wrapZenFSFileSystem({});

    for (const cap of OPTIONAL_CAPABILITIES) {
      expect(typeof (backend as any)[cap], `capability "${cap}" must survive wrapping`).toBe('function');
    }
  });
});
