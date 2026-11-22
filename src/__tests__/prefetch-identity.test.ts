/**
 * 远端描述符复用：createConfigRepo 收到 `prefetchedRemote`（connect 探测阶段读到的
 * group.json）时，setupSync 的归属校验不应再读一次 —— 整次连接只剩写描述符前的
 * 幂等比对那一次读。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';

let groupJsonReads = 0;
let storeLabel = '';

beforeAll(() => {
  storeLabel = `counting-remote-${Date.now()}`;

  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${options.storeName ?? Date.now()}` },
    });
  });

  registerBackend('CountingRemote', async () => {
    const backend: BackendInstance = await createBackend({
      type: 'InMemory',
      options: { label: storeLabel },
    });
    // 预置老仓库（无 instanceId）：连接时会被认领，从而触发一次描述符写入。
    await backend.mkdir('/.meta');
    await backend.writeFile(
      '/.meta/group.json',
      new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, kind: 'config', id: 'config' })),
    );
    return new Proxy(backend, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'readFile') {
          return (p: string, ...rest: unknown[]) => {
            if (p === '/.meta/group.json') groupJsonReads++;
            return (target as any).readFile(p, ...rest);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as BackendInstance;
  });
});

describe('prefetchedRemote 复用', () => {
  it('提供预取描述符时，归属校验不再读第二次', async () => {
    groupJsonReads = 0;
    const repo = await createConfigRepo(`prefetch-a-${Date.now()}`, {
      backendInfo: { type: 'CountingRemote', options: {} },
      prefetchedRemote: {
        type: 'CountingRemote',
        options: {},
        descriptor: { schemaVersion: 2, kind: 'config', id: 'config' },
      },
      folderPath: path.join(os.tmpdir(), `zf-prefetch-a-${Date.now()}`),
      nodeId: 'n',
    });
    expect((repo as any).replicaCount).toBe(1);
    expect(groupJsonReads).toBe(1); // 只有写描述符前的幂等比对
    await repo.dispose();
  });

  it('没有预取描述符时会多读一次（对照）', async () => {
    groupJsonReads = 0;
    const repo = await createConfigRepo(`prefetch-b-${Date.now()}`, {
      backendInfo: { type: 'CountingRemote', options: {} },
      folderPath: path.join(os.tmpdir(), `zf-prefetch-b-${Date.now()}`),
      nodeId: 'n',
    });
    expect((repo as any).replicaCount).toBe(1);
    expect(groupJsonReads).toBe(2); // 归属校验 + 写前比对
    await repo.dispose();
  });
});
