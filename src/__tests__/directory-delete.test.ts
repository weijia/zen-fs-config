/**
 * Directory deletion — both group kinds.
 *
 * 目录删除只写**一条目录墓碑**（`type: "directory"`），不为树里每个文件各写
 * 一条。应用墓碑时按树清理：递归删除子项、显式删掉隐藏的 `.keep` /
 * `.keep.mtime` 占位，最后 rmdir，因此：
 * - 后端上没有目录条目也不会漏删（按路径逐层清理）；
 * - 远端独有的孩子同样被清理（不依赖本地枚举）；
 * - `.keep` 占位不需要单独的墓碑。
 *
 * Covers both entry points used by consumers:
 * - `repo.deleteFile(dir)` / `group.deleteFile(dir)` (admin UI path)
 * - `fs.unlink(dir)` / `fs.rmdir(dir)` on the chroot views
 */
import { describe, it, expect, beforeAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { registerBackend, createBackend, type BackendInstance } from '../backend-registry';
import { createConfigRepo } from '../config-repo';
import { encodeMetaPath } from '../group-meta';

const localStores = new Map<string, BackendInstance>();

beforeAll(() => {
  process.env.ZEN_FS_CONFIG_HOME = path.join(os.tmpdir(), `zen-fs-config-dir-del-${Date.now()}`);

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
        options: { label: `dir-remote-${String((options as any).label ?? 'default')}` },
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
  // The chroot view does not implement recursive mkdir; create level by level.
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

function tombstonePath(dir: string, targetPath: string): string {
  return `${dir}/${encodeMetaPath(targetPath)}.json`;
}

async function readTombstone(root: any, targetPath: string): Promise<any | null> {
  const p = tombstonePath('/.meta/tombstones', targetPath);
  const api = root.promises ?? root;
  if (!(await exists(root, p))) return null;
  const raw = await api.readFile(p);
  return JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
}

describe('directory deletion', () => {
  it('config-sync group: repo.deleteFile(dir) writes one directory tombstone', async () => {
    const appId = 'dir-del-config';
    const repo = await createConfigRepo(appId, { nodeId: 'n1' });
    const root = repo.rootFS;

    await mkdirp(root, `/${appId}/dir/sub`);
    await root.promises.writeFile(`/${appId}/dir/sub/a.txt`, 'a');
    await root.promises.writeFile(`/${appId}/dir/b.txt`, 'b');

    await repo.deleteFile(`/${appId}/dir`);

    expect(await exists(root, `/${appId}/dir`)).toBe(false);
    expect(await exists(root, `/${appId}/dir/sub/a.txt`)).toBe(false);
    expect(await exists(root, `/${appId}/dir/b.txt`)).toBe(false);

    const tombstone = await readTombstone(root, `/${appId}/dir`);
    expect(tombstone).not.toBeNull();
    expect(tombstone.path).toBe(`/${appId}/dir`);
    expect(tombstone.type).toBe('directory');

    // 不再逐文件/逐 `.keep` 建墓碑。
    for (const child of [`/${appId}/dir/sub/a.txt`, `/${appId}/dir/b.txt`]) {
      expect(await exists(root, tombstonePath('/.meta/tombstones', child))).toBe(false);
    }
    for (const dir of [`/${appId}/dir`, `/${appId}/dir/sub`]) {
      expect(await exists(root, tombstonePath('/.meta/tombstones', `${dir}/.keep`))).toBe(false);
      expect(await exists(root, tombstonePath('/.meta/tombstones', `${dir}/.keep.mtime`))).toBe(false);
    }

    // The legacy `/.meta/.deleted/` archive is no longer written.
    expect(await exists(root, tombstonePath('/.meta/.deleted', `/${appId}/dir`))).toBe(false);

    await repo.dispose();
  });

  it('config-sync group: a directory whose remote copy only has .keep is removed by the directory tombstone', async () => {
    const appId = 'dir-del-keep';
    const repo = await createConfigRepo(appId, { nodeId: 'n-keep' });
    await repo.addBackend('remote-keep', 'DirRemote', { label: 'dir-del-keep' });
    const replica = (repo as any).replicaBackends.get('remote-keep').instance;

    // Local primary has an empty directory (no `.keep` — it is a backend
    // internal, hidden from readdir/snapshots), while the replica still holds
    // the placeholder left by an older eager-mkdir build.
    await mkdirp(repo.rootFS, `/${appId}/only-keep`);
    try { await replica.mkdir(`/${appId}`); } catch { /* already exists */ }
    try { await replica.mkdir(`/${appId}/only-keep`); } catch { /* already exists */ }
    await replica.writeFile(`/${appId}/only-keep/.keep`, '\n');
    await replica.writeFile(`/${appId}/only-keep/.keep.mtime`, '{"mtime":1}');
    expect(await exists(replica, `/${appId}/only-keep/.keep`)).toBe(true);

    await repo.deleteFile(`/${appId}/only-keep`);

    expect(await exists(repo.rootFS, `/${appId}/only-keep`)).toBe(false);
    expect((await readTombstone(repo.rootFS, `/${appId}/only-keep`))?.type).toBe('directory');

    // 目录墓碑按树清理：隐藏占位与目录本身一起消失，不会被拉回。
    await (repo as any).processTombstonesPublic();
    expect(await exists(replica, `/${appId}/only-keep/.keep`)).toBe(false);
    expect(await exists(replica, `/${appId}/only-keep/.keep.mtime`)).toBe(false);
    expect(await exists(replica, `/${appId}/only-keep`)).toBe(false);

    await repo.dispose();
  });

  it('config-sync group: a directory that exists only on a replica is removed by one tombstone', async () => {
    const appId = 'dir-del-remote-only';
    const repo = await createConfigRepo(appId, { nodeId: 'n-ro' });
    await repo.addBackend('remote-only', 'DirRemote', { label: 'dir-del-remote-only' });
    const replica = (repo as any).replicaBackends.get('remote-only').instance;

    // The local primary cache has never seen this tree — this is exactly the
    // shape of `.meta/.deleted/` (archives written by an older build and only
    // present on the backend).
    for (const dir of [`/${appId}`, `/${appId}/remote-only`, `/${appId}/remote-only/nested`]) {
      try { await replica.mkdir(dir); } catch { /* already exists */ }
    }
    await replica.writeFile(`/${appId}/remote-only/a.txt`, 'a');
    await replica.writeFile(`/${appId}/remote-only/nested/b.txt`, 'b');

    expect(await exists(repo.rootFS, `/${appId}/remote-only`)).toBe(false);

    await repo.deleteFile(`/${appId}/remote-only`);

    const tombstone = await readTombstone(repo.rootFS, `/${appId}/remote-only`);
    expect(tombstone?.type).toBe('directory');
    expect(await exists(repo.rootFS, tombstonePath('/.meta/tombstones', `/${appId}/remote-only/a.txt`))).toBe(false);

    // The tombstone is actionable: processing it removes the replica tree.
    await (repo as any).processTombstonesPublic();
    expect(await exists(replica, `/${appId}/remote-only/a.txt`)).toBe(false);
    expect(await exists(replica, `/${appId}/remote-only/nested/b.txt`)).toBe(false);
    expect(await exists(replica, `/${appId}/remote-only`)).toBe(false);

    await repo.dispose();
  });

  it('config-sync group: a replica that cannot enumerate does not turn a directory delete into per-file tombstones', async () => {
    const appId = 'dir-del-broken-replica';
    const repo = await createConfigRepo(appId, { nodeId: 'n-broken' });

    await repo.addBackend('good', 'DirRemote', { label: 'dir-del-good' });
    const good = (repo as any).replicaBackends.get('good').instance;

    // A replica whose readdir throws must not be treated as an empty directory.
    const broken = {
      readdir: async () => { throw new Error('replica unreachable'); },
      stat: async () => { throw new Error('replica unreachable'); },
      exists: async () => true,
      unlink: async () => { throw new Error('replica unreachable'); },
      rmdir: async () => { throw new Error('replica unreachable'); },
    };
    (repo as any).replicaBackends.set('broken', { instance: broken, syncable: null, pairId: 'broken' });

    await mkdirp(repo.rootFS, `/${appId}/mixed`);
    await repo.rootFS.promises.writeFile(`/${appId}/mixed/local.txt`, 'l');
    try { await good.mkdir(`/${appId}`); } catch { /* already exists */ }
    try { await good.mkdir(`/${appId}/mixed`); } catch { /* already exists */ }
    await good.writeFile(`/${appId}/mixed/remote.txt`, 'r');

    await repo.deleteFile(`/${appId}/mixed`);

    // 目录墓碑只有一条，且不依赖任何副本枚举。
    expect((await readTombstone(repo.rootFS, `/${appId}/mixed`))?.type).toBe('directory');
    expect(await exists(repo.rootFS, tombstonePath('/.meta/tombstones', `/${appId}/mixed/local.txt`))).toBe(false);
    expect(await exists(repo.rootFS, tombstonePath('/.meta/tombstones', `/${appId}/mixed/remote.txt`))).toBe(false);

    // 清不干净的副本会让墓碑保留（不能把"清理失败"当成"已删除"）。
    await (repo as any).processTombstonesPublic();
    expect(await exists(repo.rootFS, tombstonePath('/.meta/tombstones', `/${appId}/mixed`))).toBe(true);

    await repo.dispose();
  });

  it('config-sync group: fs.rmdir(dir) on the chroot view is tombstone-aware', async () => {
    const appId = 'dir-del-config-fs';
    const repo = await createConfigRepo(appId, { nodeId: 'n2' });

    await mkdirp(repo.rootFS, `/${appId}/gone/deep`);
    await repo.rootFS.promises.writeFile(`/${appId}/gone/deep/c.txt`, 'c');

    await repo.fs.promises.rmdir('/gone');

    expect(await exists(repo.fs, '/gone')).toBe(false);
    expect((await readTombstone(repo.rootFS, `/${appId}/gone`))?.type).toBe('directory');
    expect(await exists(repo.rootFS, tombstonePath('/.meta/tombstones', `/${appId}/gone/deep/c.txt`))).toBe(false);

    await repo.dispose();
  });

  it('data group: unlink / rmdir on the chroot view write directory tombstones', async () => {
    const repo = await createConfigRepo('dir-del-data', { nodeId: 'n3' });
    const group = await repo.createAppDataGroup('g-dir', [
      { id: 'remote-1', type: 'DirRemote', options: { label: 'dir-del-data' } },
    ]);
    const localFS = (group as any).localFS;

    // Admin deletes a directory through `fs.unlink`.
    await mkdirp(group.fs, '/unlinked/sub');
    await group.fs.promises.writeFile('/unlinked/sub/a.txt', 'a');
    await group.fs.promises.writeFile('/unlinked/b.txt', 'b');
    await group.fs.promises.unlink('/unlinked');

    expect(await exists(group.fs, '/unlinked')).toBe(false);
    const tombstone = await readTombstone(localFS, '/unlinked');
    expect(tombstone?.type).toBe('directory');
    expect(tombstone?.path).toBe('/unlinked');
    expect(await exists(localFS, tombstonePath('/.meta/tombstones', '/unlinked/sub/a.txt'))).toBe(false);
    expect(await exists(localFS, tombstonePath('/.meta/.deleted', '/unlinked'))).toBe(false);

    // `fs.rmdir` goes through the same tombstone-aware path.
    await mkdirp(group.fs, '/rmdir/nested');
    await group.fs.promises.writeFile('/rmdir/nested/c.txt', 'c');
    await group.fs.promises.rmdir('/rmdir');

    expect(await exists(group.fs, '/rmdir')).toBe(false);
    expect((await readTombstone(localFS, '/rmdir'))?.type).toBe('directory');

    // Metadata stays hidden from the app-facing view.
    expect(await exists(group.fs, '/.meta/group.json')).toBe(false);
    expect(await exists(group.fs, '/.config')).toBe(false);

    await group.dispose();
    await repo.dispose();
  });

  it('config-sync group: a directory tombstone unlinks hidden .keep sidecars even when exists() lies', async () => {
    const appId = 'dir-del-mtime';
    const repo = await createConfigRepo(appId, { nodeId: 'n-mtime' });
    await mkdirp(repo.rootFS, `/${appId}/ghost`);

    await repo.deleteFile(`/${appId}/ghost`);

    // Backends like GiteeFS hide `.mtime` sidecars from their Index, so
    // exists() returns false for a blob that is still on the remote. The
    // directory tombstone must clean them anyway (no exists() gate).
    const deleted: string[] = [];
    const fakeReplica = {
      exists: async () => false,
      stat: async (p: string) => {
        if (p === `/${appId}/ghost`) return { size: 0, mode: 0o040755, isDirectory: () => true };
        throw new Error('ENOENT');
      },
      readdir: async (p: string) => (p === `/${appId}/ghost` ? [] : []),
      unlink: async (p: string) => { deleted.push(p); },
      rmdir: async (p: string) => { deleted.push(p); },
    };
    (repo as any).replicaBackends.set('fake-hidden-sidecars', { instance: fakeReplica });

    await (repo as any).processTombstonesPublic();

    expect(deleted).toContain(`/${appId}/ghost/.keep`);
    expect(deleted).toContain(`/${appId}/ghost/.keep.mtime`);
    expect(deleted).toContain(`/${appId}/ghost`);
    // A sidecar tombstone must not spawn a `.mtime.version` follow-up.
    expect(deleted.some((p) => p.includes('.mtime.version'))).toBe(false);

    await repo.dispose();
  });

  it('config-sync group: deleting a file also drops its local .mtime sidecar', async () => {
    const appId = 'dir-del-file-sidecar';
    const repo = await createConfigRepo(appId, { nodeId: 'n-sidecar' });
    const root = repo.rootFS;

    await mkdirp(root, `/${appId}/notes`);
    await root.promises.writeFile(`/${appId}/notes/a.txt`, 'a');
    // Older builds leaked backend sidecars into the local primary.
    await root.promises.writeFile(`/${appId}/notes/a.txt.mtime`, '{"mtime":1}');
    expect(await exists(root, `/${appId}/notes/a.txt.mtime`)).toBe(true);

    await repo.deleteFile(`/${appId}/notes/a.txt`);

    expect(await exists(root, `/${appId}/notes/a.txt`)).toBe(false);
    expect(await exists(root, `/${appId}/notes/a.txt.mtime`)).toBe(false);

    await repo.dispose();
  });
});
