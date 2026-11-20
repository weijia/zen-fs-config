/**
 * GROUP-TYPE-AUTHORITY — 身份标记 vs 描述符的权威关系。
 *
 * 背景（线上真实事故）：删掉 `golf-admin` 根上的 `.meta/group-type` 后，约 90 秒
 * 又被写回 `config-sync`。原因是两处实现叠加：
 *   1. `createConfigRepo` 每次都在本地主根补写 legacy `.meta/group-type`，
 *      配置组同步把这枚标记推到各个远端根；
 *   2. 类型探测只认标记文件，标记缺失就当成「全新后端」，完全不看 `.meta/group.json`。
 *
 * 这里锁住三条不变式：
 *   A. 探测：没有标记但描述符声明 kind=data → 判为 data-sync，不当成新根。
 *   B. 初始化：描述符声明 kind=data 的根上，拒绝初始化配置组（抛错，不写任何标记）。
 *   C. 写入：只写新布局 `.config/group-type`，legacy `.meta/group-type` 不再生成。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import { connect } from '../connect';

const remotes = new Map<string, any>();

beforeAll(() => {
  process.env.ZEN_FS_CONFIG_HOME = path.join(os.tmpdir(), `zen-fs-config-authority-${Date.now()}`);
  registerBackend(
    'AuthorityRemote',
    async (options) => {
      const key = String((options as any).label ?? 'default');
      let inst = remotes.get(key);
      if (!inst) {
        inst = await createBackend({ type: 'InMemory', options: { label: `authority-${key}` } });
        remotes.set(key, inst);
      }
      return inst;
    },
    {
      type: 'AuthorityRemote',
      label: 'Authority',
      icon: 'A',
      fields: [],
      defaultOptions: {},
      identityFields: ['label'],
    } as any,
  );
});

function remote(label: string) {
  return { type: 'AuthorityRemote', options: { label } };
}

function decode(raw: any): string {
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

async function readOrNull(fsLike: any, p: string): Promise<string | null> {
  try {
    return decode(await fsLike.promises.readFile(p)).trim();
  } catch {
    return null;
  }
}

describe('A. 探测以描述符为准', () => {
  it('没有标记、描述符 kind=data 时判为 data-sync（要求 config-sync 会报不匹配）', async () => {
    const label = `a-${Math.random().toString(36).slice(2, 8)}`;
    const backend = await createBackend(remote(label) as any);
    await backend.mkdir('/.meta', { recursive: true });
    await backend.writeFile(
      '/.meta/group.json',
      JSON.stringify({
        schemaVersion: 2, kind: 'data', id: 'remote-storage', instanceId: 'c5b50d9d-0174-4599-ba20-239d32375de2',
      }),
    );

    await expect(
      connect(`auth-a-${label}`, { backendInfo: remote(label) as any, groupType: 'config-sync' }),
    ).rejects.toThrow(/Group type mismatch/);
  });

  it('描述符 kind=data、标记却被写成 config-sync 时，仍按 data-sync 判定（描述符优先）', async () => {
    const label = `a3-${Math.random().toString(36).slice(2, 8)}`;
    const backend = await createBackend(remote(label) as any);
    await backend.mkdir('/.meta', { recursive: true });
    await backend.writeFile(
      '/.meta/group.json',
      JSON.stringify({
        schemaVersion: 2, kind: 'data', id: 'remote-storage', instanceId: 'd25103f3-cdd4-401c-8bba-aaf3aaa99318',
      }),
    );
    await backend.mkdir('/.config', { recursive: true });
    await backend.writeFile('/.config/group-type', 'config-sync');

    await expect(
      connect(`auth-a3-${label}`, { backendInfo: remote(label) as any, groupType: 'config-sync' }),
    ).rejects.toThrow(/Group type mismatch/);
  });

  it('没有标记、也没有描述符时仍然是「新根」，按调用方要求初始化', async () => {
    const label = `a2-${Math.random().toString(36).slice(2, 8)}`;
    const result = await connect(`auth-a2-${label}`, { backendInfo: remote(label) as any, groupType: 'config-sync' });
    expect(result.groupType).toBe('config-sync');
  });
});

describe('B. 本地主根的描述符被污染时就地纠正', () => {
  it('本地主根的 .meta/group.json 写着 kind=data 时，启动把它改回 config 并保留 instanceId', async () => {
    const appId = `auth-b-${Math.random().toString(36).slice(2, 8)}`;
    const seed = await createConfigRepo(appId, { nodeId: 'seed' });
    // 模拟「配置组把一台数据组根的 .meta/group.json 同步进来」的污染现场
    await seed.rootFS.promises.writeFile(
      '/.meta/group.json',
      JSON.stringify({
        schemaVersion: 2, kind: 'data', id: 'remote-storage', instanceId: 'd25103f3-cdd4-401c-8bba-aaf3aaa99318',
      }),
    );
    await seed.dispose();

    const repo = await createConfigRepo(appId, { nodeId: 'after-pollution' });
    const descriptor = JSON.parse(decode(await repo.rootFS.promises.readFile('/.meta/group.json')));
    expect(descriptor.kind).toBe('config');
    expect(descriptor.id).toBe('config');
    // 只纠正 kind/id：instanceId 属于身份，换身份必须由用户拍板，
    // 初始化阶段不得顺手派生新 UUID（那会给远端根引入第三个值）。
    expect(descriptor.instanceId).toBe('d25103f3-cdd4-401c-8bba-aaf3aaa99318');
    expect(await readOrNull(repo.rootFS, '/.config/group-type')).toBe('config-sync');
    expect(await readOrNull(repo.rootFS, '/.meta/group-type')).toBeNull();
    await repo.dispose();
  });
});

describe('C. 只写新布局标记', () => {
  it('新根初始化只生成 .config/group-type，不再补 legacy .meta/group-type', async () => {
    const appId = `auth-c-${Math.random().toString(36).slice(2, 8)}`;
    const repo = await createConfigRepo(appId, { nodeId: 'c' });

    expect(await readOrNull(repo.rootFS, '/.config/group-type')).toBe('config-sync');
    expect(await readOrNull(repo.rootFS, '/.meta/group-type')).toBeNull();

    await repo.dispose();
  });

  it('旧布局遗留的 .meta/group-type 在下次启动时被清掉（不再被同步推回远端）', async () => {
    const appId = `auth-d-${Math.random().toString(36).slice(2, 8)}`;
    const seed = await createConfigRepo(appId, { nodeId: 'seed' });
    await seed.rootFS.promises.writeFile('/.meta/group-type', 'config-sync');
    await seed.dispose();

    const repo = await createConfigRepo(appId, { nodeId: 'next' });
    expect(await readOrNull(repo.rootFS, '/.meta/group-type')).toBeNull();
    expect(await readOrNull(repo.rootFS, '/.config/group-type')).toBe('config-sync');
    await repo.dispose();
  });
});
