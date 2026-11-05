/**
 * Canonical serialization + data-group self-description (`.meta/backends/`).
 *
 * Covers the guarantees required by SYNC-GROUP-UNIFICATION §4.4/§4.5:
 * - `serialize(parse(bytes)) === bytes` (round-trip idempotence);
 * - two different construction orders produce identical bytes;
 * - identical projections are never written twice (no sync churn);
 * - `.meta/group.json` never carries `updatedAt`;
 * - `.meta/backends/{id}.json` is authoritative, lazily backfilled from the
 *   config group's bootstrap descriptor, tombstone-first on conflict;
 * - backend ids cannot escape the directory.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import {
  assertValidBackendId,
  backendMetaFilePath,
  readBackendMetaDescriptors,
  readGroupDescriptor,
  writeBackendMetaDescriptor,
  writeGroupDescriptor,
} from '../group-meta';
import {
  serializeAppDataGroupDescriptor,
  serializeBackendDescriptor,
  serializeGroupDescriptor,
} from '../canonical-json';
import { resolveLocalPrimary } from '../folder-backend';

const localStores = new Map<string, BackendInstance>();
const remotes = new Map<string, BackendInstance>();

beforeAll(() => {
  process.env.ZEN_FS_CONFIG_HOME = path.join(os.tmpdir(), `zen-fs-config-selfdesc-${Date.now()}`);

  registerBackend('IndexedDB', async (options) => {
    const key = String((options as any).storeName ?? 'default');
    let inst = localStores.get(key);
    if (!inst) {
      inst = await createBackend({ type: 'InMemory', options: { label: `local-${key}` } });
      localStores.set(key, inst);
    }
    return inst;
  });

  registerBackend(
    'SelfDescRemote',
    async (options) => {
      const key = String((options as any).label ?? 'default');
      let inst = remotes.get(key);
      if (!inst) {
        inst = await createBackend({ type: 'InMemory', options: { label: `remote-${key}` } });
        remotes.set(key, inst);
      }
      return inst;
    },
    {
      type: 'SelfDescRemote',
      label: 'Self-desc remote',
      icon: 'S',
      fields: [],
      defaultOptions: {},
      identityFields: ['label'],
    } as any,
  );
});

function decode(raw: any): string {
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

async function exists(fs: any, p: string): Promise<boolean> {
  const api = fs.promises ?? fs;
  try {
    await api.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** In-memory backend + write counter, for "identical projection → zero writes". */
async function countingFS(): Promise<{ fs: any; writes: () => number }> {
  const inner = await createBackend({ type: 'InMemory', options: { label: `count-${Math.random()}` } });
  let writes = 0;
  const wrapped = {
    readFile: (p: string) => inner.readFile(p),
    writeFile: (p: string, data: any) => {
      writes += 1;
      return inner.writeFile(p, data);
    },
    readdir: (p: string) => inner.readdir(p),
    mkdir: (p: string) => inner.mkdir(p),
    unlink: (p: string) => inner.unlink(p),
    exists: (p: string) => inner.exists(p),
  };
  return { fs: wrapped, writes: () => writes };
}

describe('canonical serializer', () => {
  it('is byte-idempotent: serialize(parse(bytes)) === bytes', () => {
    const bytes = serializeAppDataGroupDescriptor({
      id: 'g1',
      groupType: 'data-sync',
      name: '组 A',
      features: { versions: false, tombstones: true },
      backends: [
        { id: 'b2', type: 'T', options: { z: 1, a: { y: 2, b: 1 } }, createdAt: 200 },
        { id: 'b1', type: 'T', options: { k: 1 } },
      ],
    } as any);
    expect(serializeAppDataGroupDescriptor(JSON.parse(bytes))).toBe(bytes);
  });

  it('is order-independent and sorts backends by id / options recursively', () => {
    const a = serializeBackendDescriptor({
      id: 'x',
      type: 'T',
      options: { b: 1, a: { d: 2, c: 3 } },
    });
    const b = serializeBackendDescriptor({
      id: 'x',
      type: 'T',
      options: { a: { c: 3, d: 2 }, b: 1 },
    });
    expect(a).toBe(b);

    const parsed = JSON.parse(
      serializeAppDataGroupDescriptor({
        id: 'g',
        groupType: 'data-sync',
        backends: [
          { id: 'zz', type: 'T', options: { b: 1, a: 2 } },
          { id: 'aa', type: 'T', options: {} },
        ],
      }),
    );
    expect(parsed.backends.map((x: any) => x.id)).toEqual(['aa', 'zz']);
    expect(Object.keys(parsed.backends[1].options)).toEqual(['a', 'b']);
  });

  it('never writes updatedAt into group.json', () => {
    const bytes = serializeGroupDescriptor({
      schemaVersion: 2,
      kind: 'data',
      id: 'g',
      updatedAt: 1234567890,
    } as any);
    expect(bytes.includes('updatedAt')).toBe(false);
  });
});

describe('idempotent metadata writes', () => {
  it('writes group.json once, then zero writes; reads ignore legacy updatedAt', async () => {
    const { fs, writes } = await countingFS();
    const descriptor = {
      schemaVersion: 2 as const,
      kind: 'data' as const,
      id: 'g-idem',
      name: '组',
      features: { tombstones: true },
    };
    await writeGroupDescriptor(fs as any, descriptor);
    expect(writes()).toBe(1);
    await writeGroupDescriptor(fs as any, descriptor);
    expect(writes()).toBe(1);

    // Legacy file with a deprecated timestamp → read side strips it.
    await fs.writeFile(
      '/.meta/group.json',
      new TextEncoder().encode(
        JSON.stringify({ schemaVersion: 1, kind: 'data', id: 'g-idem', updatedAt: 42 }, null, 2),
      ),
    );
    const read = await readGroupDescriptor(fs as any);
    expect(read && 'updatedAt' in read).toBe(false);
  });

  it('writes a backend descriptor once and merges createdAt by min (stable)', async () => {
    const { fs, writes } = await countingFS();
    const desc = { id: 'b1', type: 'T', options: { a: 1 }, createdAt: 200 };
    expect(await writeBackendMetaDescriptor(fs as any, desc)).toBe(true);
    expect(await writeBackendMetaDescriptor(fs as any, desc)).toBe(false);
    // A peer with an *older* timestamp must not cause a rewrite war.
    expect(await writeBackendMetaDescriptor(fs as any, { ...desc, createdAt: 100 })).toBe(true);
    expect(await writeBackendMetaDescriptor(fs as any, { ...desc, createdAt: 300 })).toBe(false);
    const stored = JSON.parse(decode(await fs.readFile(backendMetaFilePath('b1'))));
    expect(stored.createdAt).toBe(100);
    expect(writes()).toBe(2);
  });

  it('rejects backend ids that would escape .meta/backends', () => {
    for (const bad of ['', 'a/b', 'a\\b', '..', '../x']) {
      expect(() => assertValidBackendId(bad)).toThrow();
    }
    expect(() => assertValidBackendId('ok-1')).not.toThrow();
  });
});

describe('data-group self-description', () => {
  it('writes .meta/backends/{id}.json and syncs it to the remote', async () => {
    const repo = await createConfigRepo('selfdesc-write', { nodeId: 'n1' });
    const group = await repo.createAppDataGroup('g-write', [
      { id: 'b1', type: 'SelfDescRemote', options: { label: 'sd-write-1' } },
      { id: 'b2', type: 'SelfDescRemote', options: { label: 'sd-write-2' } },
    ]);

    expect(group.listDeclaredBackends().map((b) => b.id)).toEqual(['b1', 'b2']);
    await group.flush();

    const remote = remotes.get('sd-write-1')!;
    expect(await exists(remote, '/.meta/backends/b1.json')).toBe(true);
    expect(await exists(remote, '/.meta/backends/b2.json')).toBe(true);

    // The config group's bootstrap copy still lists both (long-term guide).
    const descriptor = await repo.listAppDataGroups();
    expect(descriptor[0].backends.map((b) => b.id)).toEqual(['b1', 'b2']);

    await repo.dispose();
  });

  it('removes the authority file with a tombstone and never resurrects it', async () => {
    const repo1 = await createConfigRepo('selfdesc-remove', { nodeId: 'r1' });
    const group1 = await repo1.createAppDataGroup('g-remove', [
      { id: 'keep', type: 'SelfDescRemote', options: { label: 'sd-remove-1' } },
      { id: 'drop', type: 'SelfDescRemote', options: { label: 'sd-remove-2' } },
    ]);
    await group1.flush();

    await group1.removeBackend('drop');
    // The tombstone pass runs while the backend is still paired, so that
    // backend's own remote copy is deleted too.
    const remote = remotes.get('sd-remove-2')!;
    expect(await exists(remote, '/.meta/backends/drop.json')).toBe(false);
    expect(group1.listDeclaredBackends().map((b) => b.id)).toEqual(['keep']);

    // Simulate a stale copy reappearing from a peer that has not synced yet:
    // the tombstone wins and the file is pruned again.
    await (group1 as any).localFS.writeFile(
      backendMetaFilePath('drop'),
      new TextEncoder().encode(JSON.stringify({ id: 'drop', type: 'SelfDescRemote', options: { label: 'sd-remove-2' } })),
    );
    await repo1.dispose();

    const repo2 = await createConfigRepo('selfdesc-remove', { nodeId: 'r2' });
    const group2 = await repo2.getAppDataGroup('g-remove');
    expect(group2.listDeclaredBackends().map((b) => b.id)).toEqual(['keep']);
    expect(await exists((group2 as any).localFS, backendMetaFilePath('drop'))).toBe(false);

    await repo2.dispose();
  });

  it('lazily backfills .meta/backends from the bootstrap descriptor when absent', async () => {
    const repo1 = await createConfigRepo('selfdesc-migrate', { nodeId: 'm1' });
    const group1 = await repo1.createAppDataGroup('g-migrate', [
      { id: 'b1', type: 'SelfDescRemote', options: { label: 'sd-migrate' } },
    ]);
    const localFS = (group1 as any).localFS;
    await localFS.unlink(backendMetaFilePath('b1'));
    await localFS.rmdir('/.meta/backends');
    expect(await readBackendMetaDescriptors(localFS)).toBeNull();
    await repo1.dispose();

    const repo2 = await createConfigRepo('selfdesc-migrate', { nodeId: 'm2' });
    const group2 = await repo2.getAppDataGroup('g-migrate');
    expect(group2.listDeclaredBackends().map((b) => b.id)).toEqual(['b1']);
    expect(await exists((group2 as any).localFS, backendMetaFilePath('b1'))).toBe(true);

    await repo2.dispose();
  });

  it('keeps repeated opens byte-identical (no updatedAt churn)', async () => {
    const repo1 = await createConfigRepo('selfdesc-idem', { nodeId: 'i1' });
    const group1 = await repo1.createAppDataGroup('g-idem', [
      { id: 'b1', type: 'SelfDescRemote', options: { label: 'sd-idem' } },
    ]);
    const localFS = (group1 as any).localFS;
    const groupJson = decode(await localFS.readFile('/.meta/group.json'));
    const backendJson = decode(await localFS.readFile(backendMetaFilePath('b1')));
    await repo1.dispose();

    const repo2 = await createConfigRepo('selfdesc-idem', { nodeId: 'i2' });
    const group2 = await repo2.getAppDataGroup('g-idem');
    expect(decode(await localFS.readFile('/.meta/group.json'))).toBe(groupJson);
    expect(decode(await localFS.readFile(backendMetaFilePath('b1')))).toBe(backendJson);
    expect(groupJson.includes('updatedAt')).toBe(false);

    await repo2.dispose();
  });
});

describe('Node local primary paths', () => {
  it('isolates non-default groups while keeping data/{appId} for default', async () => {
    const def = await resolveLocalPrimary('app-x', 'data', { groupId: 'default' });
    const other = await resolveLocalPrimary('app-x', 'data', { groupId: 'g1' });
    expect(String(def.options.path)).toContain(path.join('data', 'app-x'));
    expect(String(def.options.path)).not.toContain(path.join('data', 'app-x', 'g1'));
    expect(String(other.options.path)).toBe(path.join(String(def.options.path), 'g1'));
  });
});
