/**
 * Tombstone GC safety — never drop a tombstone while a replica still holds
 * the deleted path.
 *
 * Background: tombstones used to be GC'd as soon as *some* sync cycle had run.
 * A RemoteStorage/Gitee replica that still had only the `.keep` placeholders
 * of a deleted directory would then look like "new remote content" on the next
 * pull, and the empty directory reappeared locally.
 *
 * The rules under test:
 * 1. GC only when every replica confirms the path is gone.
 * 2. While a tombstone exists, a path that shows up again on a replica is
 *    deleted again (`.keep` / `.keep.mtime` included) — never pulled locally.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import { encodeMetaPath } from '../group-meta';

const localStores = new Map<string, BackendInstance>();

beforeAll(() => {
  process.env.ZEN_FS_CONFIG_HOME = path.join(os.tmpdir(), `zen-fs-config-tombstone-gc-${Date.now()}`);

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
    'DirRemote',
    async (options) =>
      createBackend({
        type: 'InMemory',
        options: { label: `tombstone-gc-${String((options as any).label ?? 'default')}` },
      }),
    {
      type: 'DirRemote',
      label: 'Dir remote',
      icon: 'D',
      fields: [],
      defaultOptions: {},
      identityFields: ['label'],
    } as any,
  );
});

async function exists(fs: any, p: string): Promise<boolean> {
  const api = fs.promises ?? fs;
  try {
    await api.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function mkdirp(fs: any, p: string): Promise<void> {
  let current = '';
  for (const part of p.split('/').filter(Boolean)) {
    current += `/${part}`;
    try {
      await fs.promises.mkdir(current);
    } catch (err: any) {
      if (err?.code !== 'EEXIST' && !/exists/i.test(String(err?.message ?? ''))) throw err;
    }
  }
}

function tombstonePath(dir: string, filePath: string): string {
  return `${dir}/${encodeMetaPath(filePath)}.json`;
}

/** Replica that still holds every path and refuses every delete. */
function makeStuckReplica() {
  return {
    exists: async () => true,
    stat: async () => ({ mode: 0o100644, isDirectory: () => false }),
    readdir: async () => [],
    unlink: async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    },
    rmdir: async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    },
  };
}

async function runTombstonePipeline(repo: any): Promise<void> {
  await repo.processTombstonesPublic();
  await repo.updateTombstoneConfirmations();
  await repo.gcTombstones();
  repo.invalidateTombstoneCache();
}

describe('tombstone GC safety', () => {
  it('keeps the tombstone when one of two replicas still holds the path', async () => {
    const appId = 'tomb-gc-stuck';
    const repo = await createConfigRepo(appId, { nodeId: 'n-stuck' });
    await repo.addBackend('replica-clean', 'DirRemote', { label: 'tomb-gc-stuck-clean' });

    await mkdirp(repo.rootFS, `/${appId}/stuck`);
    await repo.rootFS.promises.writeFile(`/${appId}/stuck/a.txt`, 'a');

    await repo.deleteFile(`/${appId}/stuck`);

    // Second replica: deletion always fails, so the path stays present.
    (repo as any).replicaBackends.set('replica-stuck', { instance: makeStuckReplica() });

    await runTombstonePipeline(repo);

    // Both the file tombstone and the `.keep` placeholders must survive:
    // pulling the replica's leftovers back would resurrect the directory.
    for (const target of [`/${appId}/stuck/a.txt`, `/${appId}/stuck/.keep`, `/${appId}/stuck/.keep.mtime`]) {
      expect(
        await exists(repo.rootFS, tombstonePath('/.meta/tombstones', target)),
      ).toBe(true);
    }

    await repo.dispose();
  });

  it('removes the tombstone once every replica confirms the path is gone', async () => {
    const appId = 'tomb-gc-clean';
    const repo = await createConfigRepo(appId, { nodeId: 'n-clean' });
    await repo.addBackend('replica-a', 'DirRemote', { label: 'tomb-gc-clean-a' });
    await repo.addBackend('replica-b', 'DirRemote', { label: 'tomb-gc-clean-b' });

    await mkdirp(repo.rootFS, `/${appId}/clean`);
    await repo.rootFS.promises.writeFile(`/${appId}/clean/a.txt`, 'a');

    await repo.deleteFile(`/${appId}/clean`);

    await runTombstonePipeline(repo);

    for (const target of [`/${appId}/clean/a.txt`, `/${appId}/clean/.keep`, `/${appId}/clean/.keep.mtime`]) {
      expect(
        await exists(repo.rootFS, tombstonePath('/.meta/tombstones', target)),
      ).toBe(false);
    }

    await repo.dispose();
  });

  it('re-deletes a path that reappears on a replica while the tombstone exists', async () => {
    const appId = 'tomb-gc-reappear';
    const repo = await createConfigRepo(appId, { nodeId: 'n-reappear' });
    await repo.addBackend('replica-rs', 'DirRemote', { label: 'tomb-gc-reappear' });
    const replica = (repo as any).replicaBackends.get('replica-rs').instance;
    await mkdirp(repo.rootFS, `/${appId}/revive`);
    await repo.rootFS.promises.writeFile(`/${appId}/revive/a.txt`, 'a');

    await repo.deleteFile(`/${appId}/revive`);

    // The replica copy lags behind: it still has the file and the `.keep`
    // placeholders (only-`.keep` directories are the real-world case).
    try { await replica.mkdir(`/${appId}/revive`); } catch { /* exists */ }
    await replica.writeFile(`/${appId}/revive/a.txt`, 'a');
    await replica.writeFile(`/${appId}/revive/.keep`, '\n');
    await replica.writeFile(`/${appId}/revive/.keep.mtime`, '{"mtime":1}');
    expect(await exists(replica, `/${appId}/revive/.keep`)).toBe(true);

    // A full cycle: tombstone pass deletes the leftovers before sync runs,
    // and the sync filter keeps the deleted paths (and their now-empty
    // directory) out of the comparison.
    await repo.flush();

    expect(await exists(replica, `/${appId}/revive/a.txt`)).toBe(false);
    expect(await exists(replica, `/${appId}/revive/.keep`)).toBe(false);
    expect(await exists(replica, `/${appId}/revive/.keep.mtime`)).toBe(false);

    // Nothing was pulled back into the local primary.
    expect(await exists(repo.rootFS, `/${appId}/revive`)).toBe(false);
    expect(await exists(repo.rootFS, `/${appId}/revive/a.txt`)).toBe(false);

    await repo.dispose();
  });

  it('never unlinks a sidecar whose data file still exists (repeated writes stay idempotent)', async () => {
    const appId = 'tomb-gc-live-sidecar';
    const repo = await createConfigRepo(appId, { nodeId: 'n-live-sidecar' });
    await repo.addBackend('replica-sidecar', 'DirRemote', { label: 'tomb-gc-live-sidecar' });

    const dir = `/${appId}/.config/app-data-groups/demo`;
    const descPath = `${dir}/default.json`;
    const sidecarPath = `${descPath}.mtime`;
    await mkdirp(repo.rootFS, dir);
    await repo.rootFS.promises.writeFile(descPath, '{"a":1}');
    await repo.rootFS.promises.writeFile(sidecarPath, '1');

    // 遗留墓碑指向“仍在用”的 sidecar：旧行为会在每轮同步里 DELETE 后再重建。
    await (repo as any).writeTombstoneFor(sidecarPath);

    const replica = (repo as any).replicaBackends.get('replica-sidecar').instance;
    // 副本上数据文件同样存在（真实场景：描述符已同步到副本）。
    try { await replica.mkdir(dir); } catch { /* exists */ }
    await replica.writeFile(descPath, '{"a":1}');
    await replica.writeFile(sidecarPath, '1');
    const unlinked: string[] = [];
    const origUnlink = replica.unlink.bind(replica);
    replica.unlink = async (p: string) => { unlinked.push(p); return origUnlink(p); };

    // 连续两轮：每轮都重写同一描述符与同一 sidecar，不得产生任何 unlink。
    for (let round = 0; round < 2; round++) {
      await repo.rootFS.promises.writeFile(descPath, '{"a":1}');
      await repo.rootFS.promises.writeFile(sidecarPath, '1');
      await runTombstonePipeline(repo);
    }

    expect(unlinked).toEqual([]);
    // 数据文件仍在 → 墓碑被确认后 GC，不再每轮触发删除。
    expect(
      await exists(repo.rootFS, tombstonePath('/.meta/tombstones', sidecarPath)),
    ).toBe(false);
    expect(await exists(repo.rootFS, sidecarPath)).toBe(true);
    expect(await exists(repo.rootFS, descPath)).toBe(true);

    await repo.dispose();
  });

  it('still removes a sidecar whose data file is gone', async () => {
    const appId = 'tomb-gc-orphan-sidecar';
    const repo = await createConfigRepo(appId, { nodeId: 'n-orphan-sidecar' });
    await repo.addBackend('replica-orphan', 'DirRemote', { label: 'tomb-gc-orphan-sidecar' });

    const dir = `/${appId}/.config/app-data-groups/orphan`;
    const descPath = `${dir}/default.json`;
    const sidecarPath = `${descPath}.mtime`;
    await mkdirp(repo.rootFS, dir);
    await repo.rootFS.promises.writeFile(descPath, '{"a":1}');
    await repo.rootFS.promises.writeFile(sidecarPath, '1');
    await (repo as any).writeTombstoneFor(sidecarPath);
    // 数据文件已真的没了 —— 此时侧车是孤儿，必须删掉。
    await repo.rootFS.promises.unlink(descPath);

    const replica = (repo as any).replicaBackends.get('replica-orphan').instance;
    const unlinked: string[] = [];
    const origUnlink = replica.unlink.bind(replica);
    replica.unlink = async (p: string) => { unlinked.push(p); return origUnlink(p); };

    await runTombstonePipeline(repo);

    expect(unlinked).toContain(sidecarPath);
    expect(await exists(repo.rootFS, sidecarPath)).toBe(false);

    await repo.dispose();
  });

  it('still removes `.keep.mtime` placeholders of a deleted directory', async () => {
    const appId = 'tomb-gc-keep-sidecar';
    const repo = await createConfigRepo(appId, { nodeId: 'n-keep-sidecar' });
    await repo.addBackend('replica-keep', 'DirRemote', { label: 'tomb-gc-keep-sidecar' });

    await mkdirp(repo.rootFS, `/${appId}/keep`);
    await repo.rootFS.promises.writeFile(`/${appId}/keep/a.txt`, 'a');
    await repo.deleteFile(`/${appId}/keep`);

    // `.keep` 是目录占位，不是“仍在用的数据文件”：它的 sidecar 仍须被清除。
    const replica = (repo as any).replicaBackends.get('replica-keep').instance;
    try { await replica.mkdir(`/${appId}/keep`); } catch { /* exists */ }
    await replica.writeFile(`/${appId}/keep/.keep`, '\n');
    await replica.writeFile(`/${appId}/keep/.keep.mtime`, '1');

    await repo.flush();

    expect(await exists(replica, `/${appId}/keep/.keep`)).toBe(false);
    expect(await exists(replica, `/${appId}/keep/.keep.mtime`)).toBe(false);

    await repo.dispose();
  });
});
