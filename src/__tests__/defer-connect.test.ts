/**
 * deferReplicaSetup：connect() 只做探测 + 本地初始化，副本建对放后台。
 * - 返回时 `replicasPending=true`、`replicaCount=0`；
 * - `whenReplicasReady()` 给出 ready / skipped / failed；
 * - 冲突不再抛给 connect，而是出现在 `skipped` 里。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { connect } from '../connect';

function tmpDir(tag: string): string {
  return path.join(os.tmpdir(), `zf-defer-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

beforeAll(() => {
  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${options.storeName ?? Date.now()}` },
    });
  });

  // 只有 group-type 标记（marked）：没有 group.json，会被认领。
  registerBackend('DeferMarked', async () => {
    const backend: BackendInstance = await createBackend({
      type: 'InMemory',
      options: { label: `defer-marked-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
    });
    await backend.mkdir('/.meta');
    await backend.writeFile('/.meta/group-type', new TextEncoder().encode('config-sync'));
    return backend;
  });

  // 已被别的组占用：group.json 带一个与本端不同的 instanceId → conflict。
  registerBackend('DeferConflict', async () => {
    const backend: BackendInstance = await createBackend({
      type: 'InMemory',
      options: { label: `defer-conflict-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
    });
    await backend.mkdir('/.meta');
    await backend.writeFile(
      '/.meta/group.json',
      new TextEncoder().encode(JSON.stringify({
        schemaVersion: 2,
        kind: 'config',
        id: 'config',
        instanceId: crypto.randomUUID(),
      })),
    );
    return backend;
  });
});

describe('deferReplicaSetup', () => {
  it('返回时只有本地仓，副本在后台就绪', async () => {
    const result = await connect(`defer-a-${Date.now()}`, {
      backendInfo: { type: 'DeferMarked', options: {} },
      groupType: 'config-sync',
      deferReplicaSetup: true,
      folderPath: tmpDir('a'),
      nodeId: 'n',
    });

    expect(result.groupType).toBe('config-sync');
    expect(result.replicasPending).toBe(true);
    expect((result.repo as any).replicaCount).toBe(0);
    expect(result.whenReplicasReady).toBeTruthy();

    const summary = await result.whenReplicasReady!;
    expect(summary.ready).toContain('DeferMarked-replica');
    expect(summary.failed).toEqual([]);
    expect((result.repo as any).replicaCount).toBe(1);

    await result.repo!.dispose();
  });

  it('归属冲突不抛给 connect，落在 skipped 里', async () => {
    const result = await connect(`defer-b-${Date.now()}`, {
      backendInfo: { type: 'DeferConflict', options: {} },
      groupType: 'config-sync',
      deferReplicaSetup: true,
      folderPath: tmpDir('b'),
      nodeId: 'n',
    });

    // connect 本身成功返回（本地仓可用）。
    expect(result.replicasPending).toBe(true);
    const summary = await result.whenReplicasReady!;
    expect(summary.ready).toEqual([]);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0].backendId).toBe('DeferConflict-replica');
    expect((result.repo as any).replicaCount).toBe(0);

    await result.repo!.dispose();
  });

  it('dispose 会等待后台建对，不挂到已销毁的引擎上', async () => {
    const result = await connect(`defer-c-${Date.now()}`, {
      backendInfo: { type: 'DeferMarked', options: {} },
      groupType: 'config-sync',
      deferReplicaSetup: true,
      folderPath: tmpDir('c'),
      nodeId: 'n',
    });

    // 不 await whenReplicasReady，直接 dispose。
    await result.repo!.dispose();
    const summary = await result.whenReplicasReady!;
    expect(summary.ready.length + summary.skipped.length).toBe(1);
  });
});
