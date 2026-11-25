import { describe, it, expect, beforeEach } from 'vitest';
import {
  listDataGroupCandidates,
  resolveDataGroup,
  ensureDataGroup,
  getPreferredDataGroupId,
  setPreferredDataGroupId,
  groupHasPath,
  isLocalBackendType,
  DATA_GROUP_PREFERENCE_PREFIX,
  type DataGroupSource,
} from '../data-group-selection';
import type { AppDataGroup, AppDataBackendDescriptor } from '../types';

// ---------------------------------------------------------------------------
// 数据组选择（从 onenav 上移到库的公共逻辑）
//   · 候选枚举：hasData / hasRemote / backendTypes / localStore / 排序
//   · 解析顺序：本机偏好 → 有数据 → 唯一远端 → 单候选，其余返回 null
//   · ensure：零描述符才补建 default；有描述符但加载失败绝不建
// ---------------------------------------------------------------------------

interface FakeGroupOptions {
  remote?: boolean;
  backendTypes?: string[];
  /** 组内 fs 上存在的目录（用于 hasData 判定） */
  dirs?: string[];
}

function fakeGroup(id: string, opts: FakeGroupOptions = {}): AppDataGroup {
  const backendTypes = opts.backendTypes ?? (opts.remote ? ['RemoteStorage'] : []);
  const backends: AppDataBackendDescriptor[] = backendTypes.map((type, i) => ({
    id: `b${i}`,
    type,
    options: {},
  }));
  const dirs = new Set(opts.dirs ?? []);
  return {
    groupId: id,
    appId: 'demo',
    kind: 'data',
    name: id,
    features: {},
    fs: {
      promises: {
        readdir: async (path: string) => {
          if (!dirs.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return ['.keep'];
        },
      },
    },
    listBackends: () => backends,
    listDeclaredBackends: () => backends,
  } as unknown as AppDataGroup;
}

function fakeRepo(groups: Record<string, AppDataGroup | Error>, opts: { descriptors?: any[]; createFails?: boolean } = {}) {
  const descriptors = opts.descriptors ?? Object.keys(groups).map((id) => ({ id, groupType: 'data-sync', backends: [] }));
  const created: string[] = [];
  const repo = {
    appId: 'demo',
    created,
    listAppDataGroups: async () => {
      if (opts.descriptors === null) throw new Error('descriptor unreadable');
      return descriptors;
    },
    getAppDataGroup: async (id: string) => {
      const g = groups[id];
      if (g instanceof Error) throw g;
      if (!g) throw new Error(`group "${id}" not found`);
      return g;
    },
    createAppDataGroup: async (id: string) => {
      if (opts.createFails) throw new Error('create failed');
      created.push(id);
      const g = fakeGroup(id);
      groups[id] = g;
      return g;
    },
  };
  return repo as unknown as DataGroupSource & { created: string[] };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

beforeEach(() => {
  // 库默认读的是全局 localStorage；测试里显式传 storage
});

describe('候选枚举', () => {
  it('计算 hasRemote / backendTypes / localStore / hasData 并按「有数据 → 有远端」排序', async () => {
    const groups = {
      empty: fakeGroup('empty'),
      remoteOnly: fakeGroup('remoteOnly', { remote: true }),
      withData: fakeGroup('withData', { remote: true, dirs: ['/golf'] }),
    };
    const repo = fakeRepo(groups);
    const out = await listDataGroupCandidates(repo, 'demo', { path: '/golf' });

    expect(out.map((c) => c.id)).toEqual(['withData', 'remoteOnly', 'empty']);
    expect(out[0].hasData).toBe(true);
    expect(out[1].hasData).toBe(false);
    expect(out[2].hasRemote).toBe(false);
    expect(out[1].backendTypes).toEqual(['RemoteStorage']);
    expect(out[0].localStore).toBe('zen-fs-config-data-demo-withData');
    expect(out[2].localStore).toBe('zen-fs-config-data-demo-empty');
  });

  it('本地后端不算远端；groupHasPath 读不到当空', async () => {
    expect(isLocalBackendType('IndexedDB')).toBe(true);
    expect(isLocalBackendType('RemoteStorage')).toBe(false);
    expect(await groupHasPath(fakeGroup('x', { dirs: ['/a'] }), '/a')).toBe(true);
    expect(await groupHasPath(fakeGroup('x'), '/a')).toBe(false);
  });
});

describe('解析顺序', () => {
  it('本机偏好组优先', async () => {
    const groups = {
      first: fakeGroup('first', { remote: true }),
      second: fakeGroup('second', { remote: true, dirs: ['/golf'] }),
    };
    const storage = memoryStorage();
    setPreferredDataGroupId('demo', 'first', { storage });
    const repo = fakeRepo(groups);

    const picked = await resolveDataGroup(repo, 'demo', { path: '/golf', preference: { storage } });
    expect((picked as any).groupId).toBe('first');
  });

  it('没有偏好时选「组里确实有数据」的那个', async () => {
    const groups = {
      empty: fakeGroup('empty', { remote: true }),
      withData: fakeGroup('withData', { dirs: ['/golf'] }),
    };
    const repo = fakeRepo(groups);
    const picked = await resolveDataGroup(repo, 'demo', { path: '/golf' });
    expect((picked as any).groupId).toBe('withData');
  });

  it('多个远端组且无法判定时返回 null（不静默择一）', async () => {
    const groups = {
      a: fakeGroup('a', { remote: true }),
      b: fakeGroup('b', { remote: true }),
    };
    const repo = fakeRepo(groups);
    expect(await resolveDataGroup(repo, 'demo', { path: '/golf' })).toBeNull();
  });

  it('只有一个候选时直接用', async () => {
    const repo = fakeRepo({ only: fakeGroup('only') });
    const picked = await resolveDataGroup(repo, 'demo', { path: '/golf' });
    expect((picked as any).groupId).toBe('only');
  });
});

describe('ensureDataGroup', () => {
  it('零描述符时补建本机默认组，并标记 created', async () => {
    const repo = fakeRepo({}, { descriptors: [] });
    const result = await ensureDataGroup(repo, 'demo', { path: '/golf' });
    expect(repo.created).toEqual(['default']);
    expect(result.created).toBe(true);
    expect((result.group as any).groupId).toBe('default');
    expect(result.descriptorsUnavailable).toBe(false);
  });

  it('有描述符但加载失败时不建 default', async () => {
    const repo = fakeRepo({ broken: new Error('backend offline') }, {
      descriptors: [{ id: 'broken', groupType: 'data-sync', backends: [] }],
    });
    const result = await ensureDataGroup(repo, 'demo', { path: '/golf' });
    expect(repo.created).toEqual([]);
    expect(result.group).toBeNull();
    expect(result.descriptorsUnavailable).toBe(true);
  });

  it('描述符读不到时不建 default', async () => {
    const repo = fakeRepo({}, { descriptors: null as any });
    const result = await ensureDataGroup(repo, 'demo', { path: '/golf' });
    expect(repo.created).toEqual([]);
    expect(result.descriptorsUnavailable).toBe(true);
  });

  it('已有组时按解析规则返回，不创建', async () => {
    const repo = fakeRepo({ keep: fakeGroup('keep', { remote: true }) });
    const result = await ensureDataGroup(repo, 'demo', { path: '/golf' });
    expect(repo.created).toEqual([]);
    expect(result.created).toBe(false);
    expect((result.group as any).groupId).toBe('keep');
  });
});

describe('本机偏好', () => {
  it('写入用新前缀，读取可兼容旧产品前缀', () => {
    const storage = memoryStorage();
    setPreferredDataGroupId('golf', 'remotestorage-mvz9hqsa', { storage });
    expect(storage.map.get(`${DATA_GROUP_PREFERENCE_PREFIX}golf`)).toBe('remotestorage-mvz9hqsa');

    const legacy = memoryStorage();
    legacy.setItem('onenav:data-group:golf', 'default');
    expect(
      getPreferredDataGroupId('golf', {
        storage: legacy,
        readPrefixes: [DATA_GROUP_PREFERENCE_PREFIX, 'onenav:data-group:'],
      }),
    ).toBe('default');
  });

  it('null 清除偏好', () => {
    const storage = memoryStorage();
    setPreferredDataGroupId('golf', 'x', { storage });
    setPreferredDataGroupId('golf', null, { storage });
    expect(getPreferredDataGroupId('golf', { storage })).toBeNull();
  });
});
