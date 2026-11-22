/**
 * onSyncEvent：把 pair 的 `sync:end` / `sync:error` 暴露给调用方。
 * 覆盖：配置组事件字段、取消订阅、数据组同样有事件且 groupKind 正确。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { connect } from '../connect';
import type { SyncGroupSyncEvent } from '../types';

function tmpDir(tag: string): string {
  return path.join(os.tmpdir(), `zf-sync-evt-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

beforeAll(() => {
  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${options.storeName ?? Date.now()}` },
    });
  });

  // 带 config-sync 标记（marked），让 connect 不必走空库询问。
  registerBackend('EvtMarked', async () => {
    const backend: BackendInstance = await createBackend({
      type: 'InMemory',
      options: { label: `evt-marked-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
    });
    await backend.mkdir('/.meta');
    await backend.writeFile('/.meta/group-type', new TextEncoder().encode('config-sync'));
    return backend;
  });

  registerBackend('EvtPlain', async () => {
    return createBackend({
      type: 'InMemory',
      options: { label: `evt-plain-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` },
    });
  });
});

describe('onSyncEvent', () => {
  it('配置组：flush 后收到 sync:end，字段带 backendId / pairId / groupKind', async () => {
    const result = await connect(`evt-a-${Date.now()}`, {
      backendInfo: { type: 'EvtMarked', options: {} },
      groupType: 'config-sync',
      folderPath: tmpDir('a'),
      nodeId: 'n',
    });

    const events: SyncGroupSyncEvent[] = [];
    const unsubscribe = (result.repo as any).onSyncEvent((e: SyncGroupSyncEvent) => events.push(e));
    expect(typeof unsubscribe).toBe('function');

    result.repo!.setConfig('/x', { a: 1 });
    await result.repo!.flush();

    const end = events.find((e) => e.type === 'sync:end');
    expect(end).toBeTruthy();
    expect(end!.groupKind).toBe('config');
    expect(end!.groupId).toBe('config');
    expect(end!.backendId).toBe('EvtMarked-replica');
    expect(end!.pairId).toBeTruthy();
    expect(end!.result).toBeTruthy();
    expect(end!.timestamp).toBeGreaterThan(0);

    unsubscribe();
    const countBefore = events.length;
    await result.repo!.flush();
    expect(events.length).toBe(countBefore);

    await result.repo!.dispose();
  });

  it('数据组：事件 groupKind 为 data，groupId 是数据组 id', async () => {
    const result = await connect(`evt-b-${Date.now()}`, {
      groupType: 'config-sync',
      folderPath: tmpDir('b'),
      nodeId: 'n',
    });

    const group = await result.repo!.createAppDataGroup('dg', [
      { id: 'dg-backend', type: 'EvtPlain', options: {} },
    ]);

    const events: SyncGroupSyncEvent[] = [];
    (group as any).onSyncEvent((e: SyncGroupSyncEvent) => events.push(e));
    await group.fs.promises.writeFile('/a.txt', 'hello');
    await group.flush();

    expect(events.length).toBeGreaterThan(0);
    const end = events.find((e) => e.type === 'sync:end');
    expect(end).toBeTruthy();
    expect(end!.groupKind).toBe('data');
    expect(end!.groupId).toBe('dg');
    expect(end!.backendId).toBe('dg-backend');

    await result.repo!.dispose();
  });
});
