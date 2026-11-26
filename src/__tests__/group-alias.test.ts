/**
 * Shared data root aliases (`.meta/aliases/{instanceId}.json`).
 *
 * 目标：多个 appId / groupId / instanceId 的数据组可以显式加入同一个远端根，
 * 各自保留身份；canonical 组不被改写，非成员仍然被拒绝。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import {
  readGroupAlias,
  readGroupAliases,
  readGroupDescriptor,
  writeGroupAlias,
  writeGroupDescriptor,
} from '../group-meta';
import {
  bindRemoteGroupIdentityDetailed,
  resolveRemoteIdentity,
} from '../group-identity';
import { newGroupInstanceId } from '../group-identity';
import type { AppDataGroup, GroupAliasDescriptor } from '../types';

const remotes = new Map<string, BackendInstance>();

beforeAll(() => {
  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `alias-idb-${(options as { storeName?: string }).storeName ?? Math.random()}` },
    });
  });

  registerBackend(
    'AliasRemote',
    async (options) => {
      const label = String((options as any).label ?? 'default');
      let inst = remotes.get(label);
      if (!inst) {
        inst = await createBackend({ type: 'InMemory', options: { label: `remote-${label}` } });
        remotes.set(label, inst);
      }
      return inst;
    },
    {
      type: 'AliasRemote',
      label: 'Alias remote',
      icon: 'A',
      fields: [],
      defaultOptions: {},
      identityFields: ['label'],
    } as any,
  );
});

async function freshRemote(): Promise<BackendInstance> {
  return createBackend({ type: 'InMemory', options: { label: `alias-${Math.random().toString(36).slice(2)}` } });
}

function alias(id: string, instanceId: string, appId?: string): GroupAliasDescriptor {
  return { schemaVersion: 2, kind: 'data', id, instanceId, ...(appId ? { appId } : {}) };
}

describe('shared-root alias files', () => {
  it('别名让不同 id / instanceId 的组命中同一个根，非成员仍然冲突', async () => {
    const remote = await freshRemote();
    const canonical = newGroupInstanceId();
    const member = newGroupInstanceId();
    await writeGroupDescriptor(remote, {
      schemaVersion: 2,
      kind: 'data',
      id: 'calendar:Gitee-replica',
      instanceId: canonical,
    });
    await writeGroupAlias(remote, alias('golf:Gitee-replica', member, 'golf'));

    const joined = await bindRemoteGroupIdentityDetailed(remote, {
      kind: 'data',
      id: 'golf:Gitee-replica',
      instanceId: member,
      appId: 'golf',
    });
    expect(joined.state).toBe('match');
    expect(joined.matchedVia).toBe('alias');

    const outsider = await bindRemoteGroupIdentityDetailed(remote, {
      kind: 'data',
      id: 'kids-point:Gitee-replica',
      instanceId: newGroupInstanceId(),
      appId: 'kids-point',
    });
    expect(outsider.state).toBe('conflict');
    expect(outsider.conflict).toBe('id-mismatch');
  });

  it('join-shared-root 只写 alias，不改远端 group.json', async () => {
    const remote = await freshRemote();
    const canonical = newGroupInstanceId();
    await writeGroupDescriptor(remote, {
      schemaVersion: 2,
      kind: 'data',
      id: 'calendar:Gitee-replica',
      instanceId: canonical,
    });
    const before = new TextDecoder().decode(await remote.readFile('/.meta/group.json'));

    const member = newGroupInstanceId();
    const result = await resolveRemoteIdentity(remote, {
      kind: 'data',
      id: 'golf:Gitee-replica',
      instanceId: member,
      appId: 'golf',
    }, 'join-shared-root');

    expect(result.ok).toBe(true);
    expect(result.aliasInstanceId).toBe(member);
    const after = new TextDecoder().decode(await remote.readFile('/.meta/group.json'));
    expect(after).toBe(before);
    expect((await readGroupDescriptor(remote))?.instanceId).toBe(canonical);

    const stored = await readGroupAlias(remote, member);
    expect(stored).toMatchObject({
      kind: 'data',
      id: 'golf:Gitee-replica',
      instanceId: member,
      appId: 'golf',
    });
  });

  it('alias 写入幂等；同一 instanceId 不允许改挂到另一个组', async () => {
    const remote = await freshRemote();
    const instanceId = newGroupInstanceId();
    const value = alias('calendar:Gitee-replica', instanceId, 'calendar');

    expect(await writeGroupAlias(remote, value)).toBe(true);
    expect(await writeGroupAlias(remote, value)).toBe(false);
    await expect(writeGroupAlias(remote, alias('golf:Gitee-replica', instanceId, 'golf'))).rejects.toThrow(
      /already belongs to data group/,
    );
  });

  it('两个成员先后加入不会互相覆盖（一实例一文件）', async () => {
    const remote = await freshRemote();
    const a = alias('calendar:Gitee-replica', newGroupInstanceId(), 'calendar');
    const b = alias('golf:Gitee-replica', newGroupInstanceId(), 'golf');

    expect(await writeGroupAlias(remote, a)).toBe(true);
    expect(await writeGroupAlias(remote, b)).toBe(true);

    const all = await readGroupAliases(remote);
    expect(all.map((x) => x.instanceId).sort()).toEqual([a.instanceId, b.instanceId].sort());
    expect(all.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('AppDataGroup shared-root flow', () => {
  it('第二个组保留冲突，确认 join 后重新打开能建立同步对', async () => {
    const remoteLabel = `shared-${Math.random().toString(36).slice(2)}`;
    const repoA = await createConfigRepo('alias-app-a', { nodeId: 'a', cache: false });
    const groupA = await repoA.createAppDataGroup('gA', [
      { id: 'bA', type: 'AliasRemote', options: { label: remoteLabel } },
    ], { allowSharedRoot: true });
    expect(groupA.getGroupInstanceId()).toBeTruthy();
    const remote = await createBackend({ type: 'AliasRemote', options: { label: remoteLabel } });
    expect((await readGroupDescriptor(remote))?.id).toBe('gA');

    const repoB = await createConfigRepo('alias-app-b', { nodeId: 'b', cache: false });
    const groupB: AppDataGroup = await repoB.createAppDataGroup('gB', [
      { id: 'bB', type: 'AliasRemote', options: { label: remoteLabel } },
    ], { allowSharedRoot: true });

    const conflicts = groupB.listBackendConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].canJoinSharedRoot).toBe(true);
    expect(groupB.getBackendSyncStates().size).toBe(0);

    const instanceB = groupB.getGroupInstanceId();
    expect(instanceB).toBeTruthy();
    const joined = await groupB.resolveBackendConflict('bB', 'join-shared-root');
    expect(joined.ok).toBe(true);
    expect(joined.aliasInstanceId).toBe(instanceB);
    expect((await readGroupAlias(remote, instanceB!))?.id).toBe('gB');

    await groupB.dispose();
    (repoB as any).appDataGroups.delete('gB');

    const reopened = await repoB.getAppDataGroup('gB');
    await reopened.whenBackendsReady?.();
    expect(reopened.listSkippedBackends()).toHaveLength(0);
    expect(reopened.getBackendSyncStates().size).toBe(1);
    // canonical 仍是 A 的 id / instance，没有被 B 覆盖。
    const canonical = await readGroupDescriptor(remote);
    expect(canonical?.id).toBe('gA');
    expect(canonical?.instanceId).toBe(groupA.getGroupInstanceId());

    await reopened.dispose();
    await groupA.dispose();
    await repoA.dispose();
    await repoB.dispose();
  });
});
