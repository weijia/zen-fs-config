import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import { connect } from '../connect';
import type { ConnectResult } from '../types';

// ---------------------------------------------------------------------------
// Mock IndexedDB with InMemory for Node.js testing
//
// createConfigRepo() always creates an IndexedDB primary backend, but
// @zenfs/dom (which provides IndexedDB) is browser-only and not available
// under Node.js. We re-register the "IndexedDB" type to delegate to the
// built-in InMemory backend so the full connect() flow can run in vitest.
// ---------------------------------------------------------------------------
beforeAll(() => {
  registerBackend('IndexedDB', async (options) => {
    return createBackend({
      type: 'InMemory',
      options: { label: `mock-idb-${options.storeName ?? Date.now()}` },
    });
  });

  // -------------------------------------------------------------------------
  // Custom "remote" backend types
  //
  // Each factory wraps a fresh InMemory instance and pre-writes
  // /.meta/group-type so connect()'s detectGroupType() reads a known value,
  // simulating an already-initialized remote backend.
  // -------------------------------------------------------------------------
  registerBackend('SharedInMemory', async () => {
    const backend: BackendInstance = await createBackend({
      type: 'InMemory',
      options: { label: 'shared' },
    });
    // Pre-write group-type to simulate an existing config-sync backend.
    await backend.mkdir('/.meta');
    await backend.writeFile('/.meta/group-type', new TextEncoder().encode('config-sync'));
    return backend;
  });

  registerBackend('SharedDataSync', async () => {
    const backend: BackendInstance = await createBackend({
      type: 'InMemory',
      options: { label: 'shared-ds' },
    });
    // Pre-write group-type to simulate an existing data-sync backend.
    await backend.mkdir('/.meta');
    await backend.writeFile('/.meta/group-type', new TextEncoder().encode('data-sync'));
    return backend;
  });

  registerBackend('MismatchBackend', async () => {
    const backend: BackendInstance = await createBackend({
      type: 'InMemory',
      options: { label: 'mismatch' },
    });
    // Pre-write config-sync so a request for data-sync triggers a mismatch.
    await backend.mkdir('/.meta');
    await backend.writeFile('/.meta/group-type', new TextEncoder().encode('config-sync'));
    return backend;
  });
});

describe('connect() — unified entry point', () => {
  // -------------------------------------------------------------------------
  // Case 1: No backendInfo — defaults to config-sync
  // -------------------------------------------------------------------------
  it('connect with no backendInfo defaults to config-sync and creates a default data group', async () => {
    const result: ConnectResult = await connect('test-conn-app1', { nodeId: 'test-node' });
    expect(result.groupType).toBe('config-sync');
    expect(result.repo).toBeDefined();
    // Data groups are always managed by config-sync: a default data group is created.
    expect(result.dataGroup).toBeDefined();
    await result.dataGroup!.dispose();
    await result.repo!.dispose();
  });

  // -------------------------------------------------------------------------
  // Case 2: No backendInfo + groupType="data-sync"
  // -------------------------------------------------------------------------
  it('connect with no backendInfo and groupType="data-sync"', async () => {
    const result: ConnectResult = await connect('test-conn-app2', {
      groupType: 'data-sync',
      nodeId: 'test-node',
    });
    expect(result.groupType).toBe('data-sync');
    expect(result.dataGroup).toBeDefined();
    // Even when targeting a data group, config-sync always anchors it.
    expect(result.repo).toBeDefined();
    await result.dataGroup!.dispose();
    await result.repo!.dispose();
  });

  // -------------------------------------------------------------------------
  // Case 3: No backendInfo + explicit groupType="config-sync"
  // -------------------------------------------------------------------------
  it('connect with no backendInfo and groupType="config-sync" (explicit)', async () => {
    const result: ConnectResult = await connect('test-conn-app3', {
      groupType: 'config-sync',
      nodeId: 'test-node',
    });
    expect(result.groupType).toBe('config-sync');
    expect(result.repo).toBeDefined();
    await result.repo!.dispose();
  });

  // -------------------------------------------------------------------------
  // Case 4: backendInfo on a brand-new backend (no group-type) → config-sync
  // -------------------------------------------------------------------------
  it('connect with backendInfo on a new backend (no group-type) defaults to config-sync', async () => {
    const result: ConnectResult = await connect('test-conn-app4', {
      backendInfo: { type: 'InMemory', options: { label: 'remote-new' } },
      nodeId: 'test-node',
    });
    expect(result.groupType).toBe('config-sync');
    expect(result.repo).toBeDefined();
    await result.repo!.dispose();
  });

  // -------------------------------------------------------------------------
  // Case 5: backendInfo on a new backend + groupType="data-sync"
  // -------------------------------------------------------------------------
  it('connect with backendInfo on a new backend and groupType="data-sync"', async () => {
    const result: ConnectResult = await connect('test-conn-app5', {
      backendInfo: { type: 'InMemory', options: { label: 'remote-new-2' } },
      groupType: 'data-sync',
      nodeId: 'test-node',
    });
    expect(result.groupType).toBe('data-sync');
    expect(result.dataGroup).toBeDefined();
    await result.dataGroup!.dispose();
  });

  // -------------------------------------------------------------------------
  // Case 6: backendInfo on an existing config-sync backend
  // -------------------------------------------------------------------------
  it('connect with backendInfo on existing config-sync backend', async () => {
    const result: ConnectResult = await connect('test-conn-app6', {
      backendInfo: { type: 'SharedInMemory', options: {} },
      nodeId: 'test-node',
    });
    expect(result.groupType).toBe('config-sync');
    expect(result.repo).toBeDefined();
    await result.repo!.dispose();
  });

  // -------------------------------------------------------------------------
  // Case 7: backendInfo on an existing data-sync backend
  // -------------------------------------------------------------------------
  it('connect with backendInfo on existing data-sync backend', async () => {
    const result: ConnectResult = await connect('test-conn-app7', {
      backendInfo: { type: 'SharedDataSync', options: {} },
      nodeId: 'test-node',
    });
    expect(result.groupType).toBe('data-sync');
    expect(result.dataGroup).toBeDefined();
    await result.dataGroup!.dispose();
  });

  // -------------------------------------------------------------------------
  // Case 8: group type mismatch throws
  // -------------------------------------------------------------------------
  it('connect throws on group type mismatch', async () => {
    await expect(
      connect('test-conn-app8', {
        backendInfo: { type: 'MismatchBackend', options: {} },
        groupType: 'data-sync',
        nodeId: 'test-node',
      }),
    ).rejects.toThrow(/mismatch/i);
  });

  // -------------------------------------------------------------------------
  // Case 9: nodeId is passed through to the config-sync repo
  // -------------------------------------------------------------------------
  it('connect passes nodeId through to config-sync', async () => {
    const result: ConnectResult = await connect('test-conn-app9', {
      nodeId: 'my-custom-node',
    });
    expect(result.repo!.nodeId).toBe('my-custom-node');
    await result.repo!.dispose();
  });

  // -------------------------------------------------------------------------
  // Case 10: result.groupType carries the correct string values
  // -------------------------------------------------------------------------
  it('connect result has correct groupType string values', async () => {
    const configResult: ConnectResult = await connect('test-conn-app10a', { nodeId: 'n' });
    expect(configResult.groupType).toBe('config-sync');
    await configResult.repo!.dispose();

    const dataResult: ConnectResult = await connect('test-conn-app10b', {
      groupType: 'data-sync',
      nodeId: 'n',
    });
    expect(dataResult.groupType).toBe('data-sync');
    await dataResult.dataGroup!.dispose();
  });

  // -------------------------------------------------------------------------
  // Case 11: no backendInfo recovers persisted data groups instead of
  // recreating default. dir-struct connects without backendInfo, so the
  // default group must NOT be reset back to empty on every connect.
  // -------------------------------------------------------------------------
  it('connect with no backendInfo recovers persisted data groups instead of recreating default', async () => {
    const appId = 'test-conn-recover';
    const dir = path.join(os.tmpdir(), `zfct-recover-${Date.now()}`);
    // Pre-create a persisted default data group WITH a backend in a separate
    // repo (persistent Folder primary). If connect() blindly recreated default
    // with [], the backend below would be lost.
    const prep = await createConfigRepo(appId, { nodeId: 'prep', folderPath: dir });
    await prep.createAppDataGroup('default', [
      { id: 'g1', type: 'InMemory', options: { label: 'keep' } },
    ]);
    await prep.dispose();

    // Connect without backendInfo: must RECOVER the persisted default (backend
    // g1 kept), NOT recreate it as an empty group.
    const second = await connect(appId, { nodeId: 'n2', folderPath: dir });
    const ids = (await second.repo!.listAppDataGroups()).map((g) => g.id);
    expect(ids).toContain('default');
    const dg = await second.repo!.getAppDataGroup('default');
    expect(dg.listBackends().map((b) => b.id)).toEqual(['g1']);
    expect(second.dataGroup).toBeDefined();
    await second.dataGroup!.dispose();
    await second.repo!.dispose();
  });
});
