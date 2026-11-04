import { describe, it, expect, beforeAll } from 'vitest';
import { registerBackend, createBackend } from '../backend-registry';
import { createConfigRepo } from '../config-repo';

// ---------------------------------------------------------------------------
// Mock IndexedDB (browser-only) with InMemory, plus an auth-style backend that
// refuses to be created without a token — this mirrors the Gitee case.
// ---------------------------------------------------------------------------
beforeAll(() => {
  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${options.storeName ?? Date.now()}` },
    });
  });

  registerBackend('AuthBackend', async (options) => {
    if (!options.token) {
      throw new Error('Missing required option: token');
    }
    return createBackend({
      type: 'InMemory',
      options: { label: `auth-${options.token}` },
    });
  });
});

describe('replaceAppDataGroupBackend', () => {
  it('keeps the backend id, rewrites options and keeps the pair count', async () => {
    const repo = await createConfigRepo('test-replace-app1', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('data-replace-1', [
      { id: 'b1', type: 'InMemory', options: { label: 'old' } },
      { id: 'b2', type: 'InMemory', options: { label: 'other' } },
    ]);
    expect(group.getSyncStatuses().size).toBe(2);

    const updated = await repo.replaceAppDataGroupBackend(
      'data-replace-1',
      'b1',
      'InMemory',
      { label: 'new-target' },
    );

    expect(updated.groupId).toBe('data-replace-1');
    expect(updated.getSyncStatuses().size).toBe(2);
    const desc = (await repo.listAppDataGroups())[0];
    expect(desc.backends.find((b) => b.id === 'b1')?.options).toEqual({ label: 'new-target' });
    expect(desc.backends.find((b) => b.id === 'b2')?.options).toEqual({ label: 'other' });
    await repo.dispose();
  });

  it('turns a failed backend into a working pair once its token is supplied', async () => {
    const repo = await createConfigRepo('test-replace-app2', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('data-replace-2', [
      { id: 'gitee-missing-token', type: 'AuthBackend', options: {} },
    ]);
    expect(group.getSyncStatuses().size).toBe(0);
    expect(group.getBackendSyncStates().get('gitee-missing-token')?.error).toBeTruthy();

    const updated = await repo.replaceAppDataGroupBackend(
      'data-replace-2',
      'gitee-missing-token',
      'AuthBackend',
      { token: 'test-token-value' },
    );

    expect(updated.getSyncStatuses().size).toBe(1);
    expect(updated.getBackendSyncStates().get('gitee-missing-token')?.pairId).toBeTruthy();
    expect(updated.getBackendSyncStates().get('gitee-missing-token')?.error).toBeFalsy();
    await repo.dispose();
  });

  it('leaves the old descriptor and live pair intact when new parameters are invalid', async () => {
    const repo = await createConfigRepo('test-replace-app3', { nodeId: 'test-node' });
    const group = await repo.createAppDataGroup('data-replace-3', [
      { id: 'b3', type: 'InMemory', options: { label: 'keep-me' } },
    ]);
    expect(group.getSyncStatuses().size).toBe(1);

    await expect(repo.replaceAppDataGroupBackend(
      'data-replace-3',
      'b3',
      'AuthBackend',
      {},
    )).rejects.toThrow('Missing required option: token');

    // The live group and its pair were never disposed.
    expect(group.getSyncStatuses().size).toBe(1);
    const desc = (await repo.listAppDataGroups())[0];
    expect(desc.backends[0]).toMatchObject({ id: 'b3', type: 'InMemory', options: { label: 'keep-me' } });
    await repo.dispose();
  });
});

describe('replaceBackend (config-sync group)', () => {
  it('keeps one pair for the same id while swapping options', async () => {
    const repo = await createConfigRepo('test-replace-config1', { nodeId: 'test-node' });
    await repo.addBackend('cb1', 'InMemory', { label: 'old-config-target' });
    expect(repo.getSyncStatuses().size).toBe(1);

    await repo.replaceBackend('cb1', 'InMemory', { label: 'new-config-target' });

    expect(repo.getSyncStatuses().size).toBe(1);
    const meta = await repo.getBackends();
    const backends = meta?.backends ?? [];
    const cb1 = backends.find((b) => b.id === 'cb1');
    expect(cb1?.options).toEqual({ label: 'new-config-target' });
    await repo.dispose();
  });

  it('leaves the existing backend untouched when the new options are invalid', async () => {
    const repo = await createConfigRepo('test-replace-config2', { nodeId: 'test-node' });
    await repo.addBackend('cb2', 'InMemory', { label: 'keep-config-target' });

    await expect(repo.replaceBackend('cb2', 'AuthBackend', {})).rejects.toThrow(
      'Missing required option: token',
    );

    expect(repo.getSyncStatuses().size).toBe(1);
    const meta = await repo.getBackends();
    const cb2 = (meta?.backends ?? []).find((b) => b.id === 'cb2');
    expect(cb2?.options).toEqual({ label: 'keep-config-target' });
    await repo.dispose();
  });
});
