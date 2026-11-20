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

  it('没有标记、也没有描述符时仍然是「新根」，按调用方要求初始化', async () => {
    const label = `a2-${Math.random().toString(36).slice(2, 8)}`;
    const result = await connect(`auth-a2-${label}`, { backendInfo: remote(label) as any, groupType: 'config-sync' });
    expect(result.groupType).toBe('config-sync');
  });
});

describe('B. 数据组的根不能被初始化为配置组', () => {
  it('本地主根已被声明为 kind=data 时，createConfigRepo 抛错且不再盖章', async () => {
    const appId = `auth-b-${Math.random().toString(36).slice(2, 8)}`;
    const seed = await createConfigRepo(appId, { nodeId: 'seed' });
    await seed.rootFS.promises.writeFile(
      '/.meta/group.json',
      JSON.stringify({
        schemaVersion: 2, kind: 'data', id: 'remote-storage', instanceId: 'd25103f3-cdd4-401c-8bba-aaf3aaa99318',
      }),
    );
    // 模拟「标记被删掉」的现场：只剩描述符
    await seed.rootFS.promises.unlink('/.config/group-type').catch(() => {});
    await seed.rootFS.promises.unlink('/.meta/group-type').catch(() => {});
    const rootFS = seed.rootFS;
    await seed.dispose();

    await expect(
      createConfigRepo(appId, { nodeId: 'after-delete' }),
    ).rejects.toThrow(/声明为数据组/);

    expect(await readOrNull(rootFS, '/.config/group-type')).toBeNull();
    expect(await readOrNull(rootFS, '/.meta/group-type')).toBeNull();
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
});
