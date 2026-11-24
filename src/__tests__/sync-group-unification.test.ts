/**
 * SYNC-GROUP-UNIFICATION — model / path / capability tests.
 *
 * Covers:
 * - `.meta/group.json` written by both kinds.
 * - `.meta/backends/` is the only backend descriptor location (`.config/backends/` ignored).
 * - data groups: `.meta` synced, `.config|nodes|shared` filtered, metadata hidden.
 * - tombstone delete survives a restart (no resurrection).
 * - version records, conflict store, purge helpers, failed backend states.
 * - cross-group remote endpoint uniqueness.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import { ConflictStore, VersionStore, encodeMetaPath } from '../group-meta';

const localStores = new Map<string, BackendInstance>();
const remotes = new Map<string, BackendInstance>();

beforeAll(() => {
  // Node local primary becomes a persistent Folder backend, so a second
  // ConfigRepo can read what the first one persisted (restart semantics).
  process.env.ZEN_FS_CONFIG_HOME = path.join(os.tmpdir(), `zen-fs-config-unify-${Date.now()}`);

  // Persistent local primary: same appId → same in-memory store across repos.
  registerBackend('IndexedDB', async (options) => {
    const key = String((options as any).storeName ?? 'default');
    let inst = localStores.get(key);
    if (!inst) {
      inst = await createBackend({ type: 'InMemory', options: { label: `local-${key}` } });
      localStores.set(key, inst);
    }
    return inst;
  });

  registerBackend(
    'UnifyRemote',
    async (options) => {
      const key = String((options as any).label ?? 'default');
      let inst = remotes.get(key);
      if (!inst) {
        inst = await createBackend({ type: 'InMemory', options: { label: `remote-${key}` } });
        remotes.set(key, inst);
      }
      return inst;
    },
    {
      type: 'UnifyRemote',
      label: 'Unify',
      icon: 'U',
      fields: [],
      defaultOptions: {},
      identityFields: ['label'],
    } as any,
  );
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

function decode(raw: any): string {
  if (typeof raw === 'string') return raw;
  return new TextDecoder().decode(raw);
}

async function mkdirp(fs: any, path: string): Promise<void> {
  try {
    await fs.promises.mkdir(path, { recursive: true });
  } catch (err: any) {
    if (err?.code !== 'EEXIST' && !/exists/i.test(String(err?.message ?? ''))) throw err;
  }
}

describe('config-sync group layout', () => {
  it('writes .meta/group.json and config metadata under .config/ (with legacy mirrors)', async () => {
    const repo = await createConfigRepo('unify-config-layout', { nodeId: 'n1' });

    // 初始化不预置身份：一个后端都没接时 `.meta/group.json` 不落盘
    expect(await exists(repo.rootFS, '/.meta/group.json')).toBe(false);

    // 0.9.0: 任何 `group-type` 标记都不再生成，类型只由 `.meta/group.json` 承载
    expect(await exists(repo.rootFS, '/.config/group-type')).toBe(false);
    expect(await exists(repo.rootFS, '/.meta/group-type')).toBe(false);

    await repo.addBackend('cfg-b1', 'UnifyRemote', { label: 'cfg-b1' });
    // 只登记后端不等于「已确定身份」——身份在真正需要时才落盘
    expect(await exists(repo.rootFS, '/.meta/group.json')).toBe(false);
    const instanceId = await (repo as any).ensureGroupInstanceId();
    const descriptor = JSON.parse(decode(await repo.rootFS.promises.readFile('/.meta/group.json')));
    expect(descriptor.kind).toBe('config');
    expect(descriptor.id).toBe('config');
    expect(descriptor.instanceId).toBe(instanceId);
    expect(descriptor.features.configHost).toBe(true);

    // Backend descriptors live in `.meta/backends/` only — `.config/backends/`
    // is no longer read or written.
    expect(await exists(repo.rootFS, '/.meta/backends/cfg-b1.json')).toBe(true);
    expect(await exists(repo.rootFS, '/.config/backends/cfg-b1.json')).toBe(false);

    // Unified handle surface.
    expect(repo.kind).toBe('config');
    expect(repo.features.tombstones).toBe(true);
    expect(repo.listBackends().some((b) => b.id === 'cfg-b1')).toBe(true);
    expect(repo.getBackendSyncStates().size).toBeGreaterThan(0);

    await repo.rename('配置组 A');
    expect(repo.name).toBe('配置组 A');

    await repo.dispose();
  });

  it('reads backend descriptors written directly under .meta/backends', async () => {
    const repo = await createConfigRepo('unify-legacy-read', { nodeId: 'n2' });

    const descriptor = JSON.stringify({ id: 'meta-only', type: 'UnifyRemote', options: { label: 'meta-only' } });
    await mkdirp(repo.rootFS, '/.meta/backends');
    await repo.rootFS.promises.writeFile('/.meta/backends/meta-only.json', new TextEncoder().encode(descriptor));

    const backends = await (repo as any).readAllBackendDescriptors() as Array<{ id: string }>;
    expect(backends.some((b) => b.id === 'meta-only')).toBe(true);
    expect(repo.listBackends().some((b) => b.id === 'meta-only')).toBe(true);

    await repo.dispose();
  });

  it('ignores leftovers in .config/backends', async () => {
    const repo = await createConfigRepo('unify-config-backends-ignored', { nodeId: 'n2b' });

    const stale = JSON.stringify({ id: 'stale-cfg', type: 'UnifyRemote', options: { label: 'stale' } });
    await mkdirp(repo.rootFS, '/.config/backends');
    await repo.rootFS.promises.writeFile('/.config/backends/stale-cfg.json', new TextEncoder().encode(stale));

    const backends = await (repo as any).readAllBackendDescriptors() as Array<{ id: string }>;
    expect(backends.some((b) => b.id === 'stale-cfg')).toBe(false);

    await repo.dispose();
  });

  it('surfaces replica descriptors that failed to connect', async () => {
    const repo = await createConfigRepo('unify-backend-state', {
      nodeId: 'n3',
      backendInfo: { type: 'GhostBackend', options: { label: 'ghost' } } as any,
    });

    // 默认 defer：建对与失败记录都在后台，等它结束再看 backendStates。
    await repo.whenReplicasReady?.();
    const state = repo.getBackendSyncStates().get('GhostBackend-replica');
    expect(state?.error?.message).toBeTruthy();

    await repo.dispose();
  });
});

describe('data-sync group capabilities', () => {
  it('writes .meta/group.json, records versions, and keeps ledgers read-only in fs', async () => {
    const repo = await createConfigRepo('unify-data-meta', { nodeId: 'n4' });
    const group = await repo.createAppDataGroup(
      'g-meta',
      [{ id: 'remote-1', type: 'UnifyRemote', options: { label: 'data-meta' } }],
      { name: '数据组 A', features: { versions: true, conflicts: true } },
    );

    expect(group.kind).toBe('data');
    expect(group.name).toBe('数据组 A');
    expect(group.features.tombstones).toBe(true);
    expect(group.features.versions).toBe(true);

    // `.meta/group.json` 可见（工具需要读实例身份）；改写必须先确认
    const descriptor = await group.fs.promises.readFile('/.meta/group.json', 'utf-8');
    expect(JSON.parse(String(descriptor)).instanceId).toBeTruthy();
    await expect(
      group.fs.promises.writeFile('/.meta/group.json', '{"id":"hijack"}'),
    ).rejects.toThrow(/ECONFIRM|confirm/);
    await expect(
      (group.fs.promises as any).writeFile('/.meta/group.json', descriptor, { confirm: true }),
    ).resolves.toBeUndefined();
    // `.config/` 仍属配置组领域：视图里不存在
    await expect(
      group.fs.promises.readFile('/.config/group-type'),
    ).rejects.toThrow();

    const remote = remotes.get('data-meta')!;
    await mkdirp(group.fs, '/data');
    await group.fs.promises.writeFile('/data/v1.txt', 'hello');
    await group.flush();

    const versionPath = `/.meta/versions/${encodeMetaPath('/data/v1.txt')}.json`;
    expect(await exists(remote, versionPath)).toBe(true);
    expect(await exists(remote, '/.meta/group.json')).toBe(true);
    expect(await group.listConflicts()).toEqual([]);

    await repo.dispose();
  });

  it('deletes with a tombstone that survives a restart (no resurrection)', async () => {
    const repo1 = await createConfigRepo('unify-restart', { nodeId: 'r1' });
    const group1 = await repo1.createAppDataGroup(
      'g-restart',
      [{ id: 'remote-r', type: 'UnifyRemote', options: { label: 'restart' } }],
    );

    const remote = remotes.get('restart')!;
    await mkdirp(group1.fs, '/restart-data');
    await group1.fs.promises.writeFile('/restart-data/gone.txt', 'bye');
    await group1.flush();
    expect(await exists(remote, '/restart-data/gone.txt')).toBe(true);

    await group1.deleteFile('/restart-data/gone.txt');
    await group1.flush();
    expect(await exists(group1.fs, '/restart-data/gone.txt')).toBe(false);
    expect(await exists(remote, '/restart-data/gone.txt')).toBe(false);
    await repo1.dispose();

    // "Restart": new repo instance reading the persisted local Folder store.
    const repo2 = await createConfigRepo('unify-restart', { nodeId: 'r2' });
    const group2 = await repo2.getAppDataGroup('g-restart');
    await group2.flush();

    expect(await exists(group2.fs, '/restart-data/gone.txt')).toBe(false);
    expect(await exists(remote, '/restart-data/gone.txt')).toBe(false);
    await repo2.dispose();
  });

  it('rejects two groups sharing the same remote endpoint', async () => {
    const repo = await createConfigRepo('unify-unique', { nodeId: 'n5' });

    // Config-group backend already uses this endpoint.
    await (repo as any).writeBackendDescriptor({
      id: 'cfg-shared',
      type: 'UnifyRemote',
      options: { label: 'dup-endpoint' },
    });

    await expect(
      repo.createAppDataGroup('g-dup-config', [
        { id: 'x', type: 'UnifyRemote', options: { label: 'dup-endpoint' } },
      ]),
    ).rejects.toThrow(/同一远端/);

    // Two data groups must not share it either.
    await repo.createAppDataGroup('g-owner', [
      { id: 'y', type: 'UnifyRemote', options: { label: 'shared-data-endpoint' } },
    ]);
    await expect(
      repo.createAppDataGroup('g-dup-data', [
        { id: 'z', type: 'UnifyRemote', options: { label: 'shared-data-endpoint' } },
      ]),
    ).rejects.toThrow(/同一远端/);

    await repo.dispose();
  });

  it('purges leaked sidecars / keep files through the unified handle', async () => {
    const repo = await createConfigRepo('unify-purge', { nodeId: 'n6' });
    const group = await repo.createAppDataGroup('g-purge', []);

    await mkdirp(group.fs, '/struct');
    await group.fs.promises.writeFile('/struct/.data.json.mtime', '0');
    await group.fs.promises.writeFile('/struct/collect.keep', '');

    const dry = await group.purgeMtimeSidecars({ dryRun: true });
    expect(dry.removed).toContain('/struct/.data.json.mtime');
    const real = await group.purgeMtimeSidecars();
    expect(real.failed).toEqual([]);
    expect(await exists(group.fs, '/struct/.data.json.mtime')).toBe(false);

    const keep = await group.purgeKeepFiles();
    expect(keep.failed).toEqual([]);

    await repo.dispose();
  });
});

describe('identity file is never content-synced', () => {
  it('配置组与数据组的同步过滤器都固定排除 /.meta/group.json', async () => {
    const repo = await createConfigRepo('unify-excl-filter', { nodeId: 'f1' });
    expect((repo as any).syncFilter.excludePrefixes).toContain('/.meta/group.json');

    const group = await repo.createAppDataGroup('g-excl-filter', []);
    expect((group as any).syncFilter.excludePrefixes).toContain('/.meta/group.json');
    await repo.dispose();
  });

  it('接入后端后同步不会把本地 .meta/group.json 推到副本', async () => {
    const label = `excl-${Math.random().toString(36).slice(2, 8)}`;
    const repo = await createConfigRepo(`unify-excl-${label}`, { nodeId: 'e1' });
    await (repo as any).ensureGroupInstanceId();
    await mkdirp(repo.rootFS, '/data');
    await repo.rootFS.promises.writeFile('/data/note.txt', 'hello');

    await repo.addBackend('cfg-excl', 'UnifyRemote', { label });

    const remote = remotes.get(label)!;
    // 普通内容照常同步
    expect(await exists(remote as any, '/data/note.txt')).toBe(true);
    // 身份文件不动 —— 否则身份就成了「谁最后写谁赢」
    expect(await exists(remote as any, '/.meta/group.json')).toBe(false);

    await repo.dispose();
  });
});

describe('conflict store (data-group metadata)', () => {
  it('archives, lists, reads and resolves conflicts under .meta/conflicts', async () => {
    const fsInst = await createBackend({ type: 'InMemory', options: { label: 'conflict-store' } });
    const versions = new VersionStore(fsInst as any, 'app/node');
    const store = new ConflictStore(fsInst as any, 'app', 'node', versions);

    await fsInst.mkdir('/data');
    await fsInst.writeFile('/data/conflict.txt', 'local');

    const archive = await store.archive(
      { path: '/data/conflict.txt', sourceContent: 'local', targetContent: 'remote' },
      123,
    );
    expect(archive.conflictPath).toBe('/data/conflict.txt');

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].conflictPath).toBe('/data/conflict.txt');

    expect(await store.readBackup('123__data_conflict.txt', 'source')).toBe('local');
    expect(await store.readBackup('123__data_conflict.txt', 'target')).toBe('remote');

    await store.resolve('123__data_conflict.txt', 'merged');
    expect(decode(await fsInst.readFile('/data/conflict.txt'))).toBe('merged');
    expect(await store.readBackup('123__data_conflict.txt', 'resolved')).toBe('merged');
  });
});
