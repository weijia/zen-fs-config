import { describe, it, expect, beforeAll } from 'vitest';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';

// ---------------------------------------------------------------------------
// 远端根归属（2026-11-25 线上重复建组的回归）
//
// 症状：描述符列表读空（面板显示「暂无数据同步组」）时，应用又建了一个
// `default` 之外的数据组，后端参数与既有组完全相同 —— 两个组指向同一个远端
// 目录，各自认为自己是主人，同步时互相改写 `.meta/group.json` / 版本 / 墓碑。
//
// 根因：`assertNoSharedRemote` 只比对**配置仓描述符**，描述符丢了就等于「没有
// 别的组」，校验静默放行。修复后创建/换后端时会真读一次目标根上的
// `.meta/group.json`（这才是归属的权威记录），有主或读不到都拒绝。
// ---------------------------------------------------------------------------

/** 写入某个远端根的 `.meta/group.json`，模拟「别的组的根」。 */
async function seedGroupDescriptor(
  instance: BackendInstance,
  identity: { kind: 'data' | 'config'; id: string; instanceId?: string },
): Promise<void> {
  const fs = (instance as any).promises ?? instance;
  await fs.mkdir('/.meta', { recursive: true });
  const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, ...identity }));
  await fs.writeFile('/.meta/group.json', bytes);
}

beforeAll(async () => {
  // Node 环境没有 IndexedDB：本地 primary 用 InMemory 顶替
  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${options.storeName ?? Date.now()}` },
    });
  });

  const meta = (type: string, label: string) => ({
    type,
    label,
    icon: '\u{1F9EA}',
    fields: [],
    defaultOptions: {},
    identityFields: ['label'],
  });

  // 按 label 复用同一个远端实例：同 label = 同一个远端根，便于跨组观测
  const roots = new Map<string, BackendInstance>();
  registerBackend('SharedRemote', async (options) => {
    const label = String(options.label ?? '');
    let instance = roots.get(label);
    if (!instance) {
      instance = await createBackend({
        type: 'InMemory',
        options: { label: `root-${label}-${Math.random()}` },
      });
      roots.set(label, instance);
    }
    return instance!;
  }, meta('SharedRemote', 'SharedRemote'));

  // 读取必定失败（模拟 5xx / 网络故障），用于验证 fail-closed
  registerBackend('FlakyRemote', async () => {
    const inner = await createBackend({
      type: 'InMemory',
      options: { label: `flaky-${Date.now()}-${Math.random()}` },
    });
    const fs = (inner as any).promises ?? inner;
    return {
      readFile: async (path: string, ...rest: any[]) => {
        if (/\.meta\/group\.json$/.test(String(path))) {
          throw new Error('HTTP 500 backend exploded');
        }
        return (fs.readFile as any)(path, ...rest);
      },
      readdir: fs.readdir.bind(fs),
      stat: fs.stat.bind(fs),
      exists: fs.exists.bind(fs),
      mkdir: fs.mkdir.bind(fs),
      unlink: fs.unlink.bind(fs),
      rmdir: fs.rmdir.bind(fs),
      writeFile: fs.writeFile.bind(fs),
    } satisfies BackendInstance;
  }, meta('FlakyRemote', 'FlakyRemote'));
});

describe('远端根归属校验', () => {
  it('远端根已被别的数据组占用时拒绝创建（与描述符列表无关）', async () => {
    // 别人（另一台设备 / 已丢失描述符的旧组）占着这个根，本地描述符一条都没有
    const ghostRoot = await createBackend({ type: 'SharedRemote', options: { label: 'ghost-root' } });
    await seedGroupDescriptor(ghostRoot, {
      kind: 'data',
      id: 'ghost',
      instanceId: '11111111-2222-4333-8444-555555555555',
    });

    const repo = await createConfigRepo('ownership-app-a', { nodeId: 'test-node' });
    await expect(
      repo.createAppDataGroup('newbie', [
        { id: 'r1', type: 'SharedRemote', options: { label: 'ghost-root' } },
      ]),
    ).rejects.toThrow(/已被数据组「ghost」/);

    // 拒绝发生在写任何描述符之前：组不该被登记
    expect(await repo.listAppDataGroups()).toHaveLength(0);
    await repo.dispose();
  });

  it('空远端根照常创建，并认领身份', async () => {
    const repo = await createConfigRepo('ownership-app-b', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('fresh', [
      { id: 'r1', type: 'SharedRemote', options: { label: 'fresh-root' } },
    ]);
    expect(group.getGroupInstanceId()).toBeTruthy();
    expect((await repo.listAppDataGroups()).map((d) => d.id)).toContain('fresh');
    await repo.dispose();
  });

  it('远端 group.json 读不到（非 404）时 fail-closed，拒绝创建', async () => {
    const repo = await createConfigRepo('ownership-app-c', { nodeId: 'test-node' });
    await expect(
      repo.createAppDataGroup('blind', [
        { id: 'r1', type: 'FlakyRemote', options: { label: 'flaky-root' } },
      ]),
    ).rejects.toThrow(/无法判断该远端目录是否已被其它同步组占用/);
    expect(await repo.listAppDataGroups()).toHaveLength(0);
    await repo.dispose();
  });

  it('把已有组换到别人的根上时拒绝，并保留原后端参数', async () => {
    const repo = await createConfigRepo('ownership-app-d', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('mine', [
      { id: 'r1', type: 'SharedRemote', options: { label: 'mine-root' } },
    ]);
    expect(group).toBeTruthy();

    const otherRoot = await createBackend({ type: 'SharedRemote', options: { label: 'other-root' } });
    await seedGroupDescriptor(otherRoot, {
      kind: 'data',
      id: 'other',
    });

    await expect(
      repo.replaceAppDataGroupBackend('mine', 'r1', 'SharedRemote', { label: 'other-root' }),
    ).rejects.toThrow(/已被数据组「other」占用/);

    // 回滚/未改动：组仍挂在原来的根上
    const live = await repo.getAppDataGroup('mine');
    expect(live.listDeclaredBackends().map((b) => b.id)).toContain('r1');
    expect((live.listDeclaredBackends()[0].options as any).label).toBe('mine-root');
    await repo.dispose();
  });
});
