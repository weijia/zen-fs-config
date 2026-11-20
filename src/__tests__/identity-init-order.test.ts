/**
 * 组实例身份（`instanceId`）的初始化顺序 —— GROUP-IDENTITY-INIT.zh-CN.md §3/§6
 *
 * 核心不变式：
 * - I1 身份必须先**读**后**定**：只有 local / bootstrap / 远端三处都为空时才生成一次 UUID；
 * - I2 `kind` / `id` 不同是硬边界，永不参与身份裁决、永不改写；
 * - I3 候选互相矛盾时**不静默择一**，只标 `identityUnsettled` 等用户裁决；
 * - I4 任何远端 `group.json` 的改写只能由 `setGroupInstanceId()`（用户触发）发起，
 *      且逐根回报结果。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import { readGroupDescriptor, writeGroupDescriptor } from '../group-meta';
import { isValidGroupInstanceId } from '../group-identity';
import type { AppDataGroup } from '../types';

const localStores = new Map<string, BackendInstance>();
const remotes = new Map<string, BackendInstance>();

beforeAll(() => {
  process.env.ZEN_FS_CONFIG_HOME = path.join(os.tmpdir(), `zen-fs-config-idinit-${Date.now()}`);

  registerBackend('IndexedDB', async (options) => {
    const key = String((options as any).storeName ?? 'default');
    let inst = localStores.get(key);
    if (!inst) {
      inst = await createBackend({ type: 'InMemory', options: { label: `local-${key}` } });
      localStores.set(key, inst);
    }
    return inst;
  });

  // 共享远端：按 label 复用同一个 InMemory 实例，便于跨 repo 生命周期模拟“同一台服务器”。
  registerBackend(
    'IdRemote',
    async (options) => {
      const key = String((options as any).label ?? 'default');
      let inst = remotes.get(key);
      if (!inst) {
        inst = await createBackend({ type: 'InMemory', options: { label: `id-remote-${key}` } });
        remotes.set(key, inst);
      }
      return inst;
    },
    {
      type: 'IdRemote',
      label: 'Identity remote',
      icon: 'I',
      fields: [],
      defaultOptions: {},
      identityFields: ['label'],
    } as any,
  );
});

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

async function seedRemoteIdentity(
  label: string,
  descriptor: { kind: 'data' | 'config'; id: string; instanceId: string },
): Promise<void> {
  const inst = await createBackend({ type: 'IdRemote', options: { label } });
  remotes.set(label, inst);
  await writeGroupDescriptor(inst, { schemaVersion: 2, ...descriptor });
}

async function remoteIdentity(label: string): Promise<string | undefined> {
  const inst = remotes.get(label);
  if (!inst) return undefined;
  const desc = await readGroupDescriptor(inst);
  return desc?.instanceId;
}

async function localDescriptor(group: AppDataGroup) {
  return readGroupDescriptor((group as any).localFS);
}

describe('身份初始化顺序', () => {
  it('空世界只生成一次 UUID，并在重开后沿用（不再生成）', async () => {
    const repo1 = await createConfigRepo('idinit-empty', { nodeId: 'e1' });
    const g1 = await repo1.createAppDataGroup('g-empty', [
      { id: 'r1', type: 'IdRemote', options: { label: 'empty-1' } },
    ]);
    await g1.flush();

    const id1 = g1.getGroupInstanceId();
    expect(id1 && isValidGroupInstanceId(id1)).toBe(true);
    expect(await remoteIdentity('empty-1')).toBe(id1);
    expect(g1.isIdentityUnsettled?.()).toBe(false);
    await repo1.dispose();

    const repo2 = await createConfigRepo('idinit-empty', { nodeId: 'e2' });
    const g2 = await repo2.getAppDataGroup('g-empty');
    expect(g2.getGroupInstanceId()).toBe(id1);
    expect((await localDescriptor(g2))?.instanceId).toBe(id1);
    // 重开也没有改写远端
    expect(await remoteIdentity('empty-1')).toBe(id1);
    expect(g2.isIdentityUnsettled?.()).toBe(false);
    await repo2.dispose();
  });

  it('远端根已有身份时，新建/重开都沿用它，不生成新 UUID', async () => {
    await seedRemoteIdentity('pre-1', { kind: 'data', id: 'g-pre', instanceId: UUID_A });

    const repo = await createConfigRepo('idinit-pre', { nodeId: 'p1' });
    const group = await repo.createAppDataGroup('g-pre', [
      { id: 'r1', type: 'IdRemote', options: { label: 'pre-1' } },
    ]);
    expect(group.getGroupInstanceId()).toBe(UUID_A);
    expect(group.isIdentityUnsettled?.()).toBe(false);
    expect((await localDescriptor(group))?.instanceId).toBe(UUID_A);
    expect(await remoteIdentity('pre-1')).toBe(UUID_A);
    await repo.dispose();
  });

  it('引导副本优先于本地描述符；两者不一致时只记录，不静默收敛', async () => {
    const repo1 = await createConfigRepo('idinit-boot', { nodeId: 'b1' });
    const g1 = await repo1.createAppDataGroup('g-boot', [
      { id: 'r1', type: 'IdRemote', options: { label: 'boot-1' } },
    ]);
    const localFS = (g1 as any).localFS;
    // 模拟“本地 `.meta/group.json` 被别的环境写成了另一个值”
    await writeGroupDescriptor(localFS, {
      schemaVersion: 2,
      kind: 'data',
      id: 'g-boot',
      instanceId: UUID_B,
    });
    const bootstrapId = g1.getGroupInstanceId()!;
    await repo1.dispose();

    const repo2 = await createConfigRepo('idinit-boot', { nodeId: 'b2' });
    const g2 = await repo2.getAppDataGroup('g-boot');
    expect(g2.getGroupInstanceId()).toBe(bootstrapId);
    expect(g2.isIdentityUnsettled?.()).toBe(true);

    const sources = g2.getIdentityCandidates().map((c) => c.source);
    expect(sources).toContain('bootstrap');
    expect(sources).toContain('local');
    expect(new Set(g2.getIdentityCandidates().map((c) => c.instanceId)).size).toBeGreaterThan(1);
    // 远端根没有被任何一方改写
    expect(await remoteIdentity('boot-1')).toBe(bootstrapId);
    await repo2.dispose();
  });

  it('一组两根各持不同身份 → 标记待裁决，且不自动改写任何根', async () => {
    const repo1 = await createConfigRepo('idinit-two', { nodeId: 't1' });
    const g1 = await repo1.createAppDataGroup('g-two', [
      { id: 'r1', type: 'IdRemote', options: { label: 'two-1' } },
      { id: 'r2', type: 'IdRemote', options: { label: 'two-2' } },
    ]);
    await g1.flush();
    const original = g1.getGroupInstanceId()!;
    await repo1.dispose();

    // 外部（另一台机器 / 另一环境）把第二个根写成了别的身份
    await seedRemoteIdentity('two-2', { kind: 'data', id: 'g-two', instanceId: UUID_C });

    const repo2 = await createConfigRepo('idinit-two', { nodeId: 't2' });
    const g2 = await repo2.getAppDataGroup('g-two');
    expect(g2.getGroupInstanceId()).toBe(original);
    expect(g2.isIdentityUnsettled?.()).toBe(true);

    const remoteCandidates = g2.getIdentityCandidates().filter((c) => c.source === 'remote');
    expect(remoteCandidates.map((c) => c.instanceId).sort()).toEqual([original, UUID_C].sort());
    expect(remoteCandidates.map((c) => c.backendId).sort()).toEqual(['r1', 'r2']);

    // 未裁决前，两个根都保持原样
    expect(await remoteIdentity('two-1')).toBe(original);
    expect(await remoteIdentity('two-2')).toBe(UUID_C);
    await repo2.dispose();
  });

  it('setGroupInstanceId(rewriteRoots) 逐根汇报，并把同 kind/id 的根统一', async () => {
    const repo1 = await createConfigRepo('idinit-set', { nodeId: 's1' });
    const g1 = await repo1.createAppDataGroup('g-set', [
      { id: 'r1', type: 'IdRemote', options: { label: 'set-1' } },
      { id: 'r2', type: 'IdRemote', options: { label: 'set-2' } },
    ]);
    await g1.flush();
    const original = g1.getGroupInstanceId()!;
    await repo1.dispose();

    await seedRemoteIdentity('set-2', { kind: 'data', id: 'g-set', instanceId: UUID_C });

    const repo2 = await createConfigRepo('idinit-set', { nodeId: 's2' });
    const g2 = await repo2.getAppDataGroup('g-set');
    expect(g2.isIdentityUnsettled?.()).toBe(true);

    // 用户选远端那个值
    const result = await g2.setGroupInstanceId(UUID_C, { rewriteRoots: true });
    expect(result.ok).toBe(true);
    expect(result.instanceId).toBe(UUID_C);
    expect(result.roots.map((r) => [r.backendId, r.ok, r.before]).sort()).toEqual(
      [
        ['r1', true, original],
        ['r2', true, UUID_C],
      ].sort(),
    );
    expect(await remoteIdentity('set-1')).toBe(UUID_C);
    expect(await remoteIdentity('set-2')).toBe(UUID_C);
    expect(g2.getGroupInstanceId()).toBe(UUID_C);
    expect(g2.isIdentityUnsettled?.()).toBe(false);
    await repo2.dispose();

    // 重开后一致、无待裁决
    const repo3 = await createConfigRepo('idinit-set', { nodeId: 's3' });
    const g3 = await repo3.getAppDataGroup('g-set');
    expect(g3.getGroupInstanceId()).toBe(UUID_C);
    expect(g3.isIdentityUnsettled?.()).toBe(false);
    await repo3.dispose();
  });

  it('kind / id 不同的根属于硬边界：身份改写一律拒绝', async () => {
    const repo1 = await createConfigRepo('idinit-bound', { nodeId: 'h1' });
    const g1 = await repo1.createAppDataGroup('g-bound', [
      { id: 'r1', type: 'IdRemote', options: { label: 'bound-1' } },
      { id: 'r2', type: 'IdRemote', options: { label: 'bound-2' } },
    ]);
    await g1.flush();
    const original = g1.getGroupInstanceId()!;
    await repo1.dispose();

    // 第二个根其实是另一个组（id 不同）——绝不能被“统一”掉
    await seedRemoteIdentity('bound-2', { kind: 'data', id: 'other-group', instanceId: UUID_B });

    const repo2 = await createConfigRepo('idinit-bound', { nodeId: 'h2' });
    const g2 = await repo2.getAppDataGroup('g-bound');
    const result = await g2.setGroupInstanceId(UUID_C, { rewriteRoots: true });

    expect(result.ok).toBe(true);
    const r2 = result.roots.find((r) => r.backendId === 'r2')!;
    expect(r2.ok).toBe(false);
    expect(r2.reason ?? '').toContain('另一个组');
    expect(await remoteIdentity('bound-2')).toBe(UUID_B);
    const r1 = result.roots.find((r) => r.backendId === 'r1')!;
    expect(r1.ok).toBe(true);
    expect(r1.before).toBe(original);
    expect(await remoteIdentity('bound-1')).toBe(UUID_C);
    await repo2.dispose();
  });

  it('非法 UUID 被拒绝，且不触碰任何根', async () => {
    const repo = await createConfigRepo('idinit-bad', { nodeId: 'x1' });
    const group = await repo.createAppDataGroup('g-bad', [
      { id: 'r1', type: 'IdRemote', options: { label: 'bad-1' } },
    ]);
    const original = group.getGroupInstanceId()!;
    const result = await group.setGroupInstanceId('not-a-uuid', { rewriteRoots: true });
    expect(result.ok).toBe(false);
    expect(result.roots).toEqual([]);
    expect(group.getGroupInstanceId()).toBe(original);
    expect(await remoteIdentity('bad-1')).toBe(original);
    await repo.dispose();
  });

  it('只改本组、不改远端时应逐根汇报 before 并保持远端不变', async () => {
    const repo1 = await createConfigRepo('idinit-local', { nodeId: 'l1' });
    const g1 = await repo1.createAppDataGroup('g-local', [
      { id: 'r1', type: 'IdRemote', options: { label: 'local-1' } },
    ]);
    await g1.flush();
    await repo1.dispose();

    const repo2 = await createConfigRepo('idinit-local', { nodeId: 'l2' });
    const g2 = await repo2.getAppDataGroup('g-local');
    const before = g2.getGroupInstanceId()!;
    const result = await g2.setGroupInstanceId(UUID_B);
    expect(result.ok).toBe(true);
    expect(result.roots).toEqual([]);
    expect((await localDescriptor(g2))?.instanceId).toBe(UUID_B);
    expect(await remoteIdentity('local-1')).toBe(before);
    await repo2.dispose();
  });

  it('没有任何后端的新建组不预置身份：instanceId 留空且不写进 group.json', async () => {
    const repo = await createConfigRepo('idinit-nobackend', { nodeId: 'n1' });
    const group = await repo.createAppDataGroup('g-nobackend', []);
    expect(group.getGroupInstanceId()).toBeUndefined();
    expect(group.getIdentityCandidates()).toEqual([]);

    const desc = await localDescriptor(group);
    expect(desc?.kind).toBe('data');
    expect(desc?.id).toBe('g-nobackend');
    expect(desc?.instanceId).toBeUndefined();
    expect('instanceId' in (desc as any)).toBe(false);
    await repo.dispose();

    // 重开也不“补”一个身份
    const repo2 = await createConfigRepo('idinit-nobackend', { nodeId: 'n2' });
    const g2 = await repo2.getAppDataGroup('g-nobackend');
    expect(g2.getGroupInstanceId()).toBeUndefined();
    await repo2.dispose();
  });

  it('空组接入第一个「已有身份」的根时直接沿用该值，不生成也不冲突', async () => {
    const repo1 = await createConfigRepo('idinit-adopt-late', { nodeId: 'q1' });
    await repo1.createAppDataGroup('g-late', []);
    await repo1.dispose();

    await seedRemoteIdentity('late-1', { kind: 'data', id: 'g-late', instanceId: UUID_A });

    const repo2 = await createConfigRepo('idinit-adopt-late', { nodeId: 'q2' });
    const group = await repo2.createAppDataGroup('g-late', [
      { id: 'r1', type: 'IdRemote', options: { label: 'late-1' } },
    ]);

    expect(group.getGroupInstanceId()).toBe(UUID_A);
    expect(group.isIdentityUnsettled?.()).toBe(false);
    expect(group.listBackendConflicts()).toEqual([]);
    expect((await localDescriptor(group))?.instanceId).toBe(UUID_A);
    expect(await remoteIdentity('late-1')).toBe(UUID_A);
    await repo2.dispose();
  });
});
