/**
 * Directory deletion — both group kinds.
 *
 * A directory must be deleted as a tree: one tombstone per contained file,
 * then the empty dirs. Writing a single tombstone for the directory path
 * would be a no-op on backends without directory entries, and simply calling
 * the inner `rmdir`/`unlink` would leave replicas able to resurrect children.
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

function tombstonePath(dir: string, filePath: string): string {
  return `${dir}/${encodeMetaPath(filePath)}.json`;
}

describe('directory deletion', () => {
  it('config-sync group: repo.deleteFile(dir) tombstones every child', async () => {
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

    for (const file of [`/${appId}/dir/sub/a.txt`, `/${appId}/dir/b.txt`]) {
      // New layout + legacy mirror (one release cycle).
      expect(await exists(root, tombstonePath('/.meta/tombstones', file))).toBe(true);
      expect(await exists(root, tombstonePath('/.meta/.deleted', file))).toBe(true);
      const raw = await root.promises.readFile(tombstonePath('/.meta/tombstones', file));
      const tombstone = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
      expect(tombstone.path).toBe(file);
    }

    // Every deleted directory gets a `.keep` tombstone so a hidden placeholder
    // left on a Git backend cannot resurrect the (now empty) directory.
    for (const dir of [`/${appId}/dir`, `/${appId}/dir/sub`]) {
      expect(await exists(root, tombstonePath('/.meta/tombstones', `${dir}/.keep`))).toBe(true);
    }

    await repo.dispose();
  });

  it('config-sync group: deleting a directory that only has a remote .keep records a tombstone', async () => {
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
    expect(await exists(replica, `/${appId}/only-keep/.keep`)).toBe(true);

    await repo.deleteFile(`/${appId}/only-keep`);

    expect(await exists(repo.rootFS, `/${appId}/only-keep`)).toBe(false);
    expect(
      await exists(repo.rootFS, tombstonePath('/.meta/tombstones', `/${appId}/only-keep/.keep`)),
    ).toBe(true);

    // Processing the tombstone removes the remote placeholder, so the
    // directory cannot be pulled back into existence.
    await (repo as any).processTombstonesPublic();
    expect(await exists(replica, `/${appId}/only-keep/.keep`)).toBe(false);

    await repo.dispose();
  });

  it('config-sync group: fs.rmdir(dir) on the chroot view is tombstone-aware', async () => {
    const appId = 'dir-del-config-fs';
    const repo = await createConfigRepo(appId, { nodeId: 'n2' });

    await mkdirp(repo.rootFS, `/${appId}/gone/deep`);
    await repo.rootFS.promises.writeFile(`/${appId}/gone/deep/c.txt`, 'c');

    await repo.fs.promises.rmdir('/gone');

    expect(await exists(repo.fs, '/gone')).toBe(false);
    expect(await exists(repo.rootFS, tombstonePath('/.meta/tombstones', `/${appId}/gone/deep/c.txt`))).toBe(
      true,
    );

    await repo.dispose();
  });

  it('data group: unlink / rmdir on the chroot view tombstone every child', async () => {
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
    for (const file of ['/unlinked/sub/a.txt', '/unlinked/b.txt']) {
      expect(await exists(localFS, tombstonePath('/.meta/tombstones', file))).toBe(true);
      expect(await exists(localFS, tombstonePath('/.meta/.deleted', file))).toBe(true);
    }
    for (const dir of ['/unlinked', '/unlinked/sub']) {
      expect(await exists(localFS, tombstonePath('/.meta/tombstones', `${dir}/.keep`))).toBe(true);
    }

    // `fs.rmdir` goes through the same tombstone-aware path.
    await mkdirp(group.fs, '/rmdir/nested');
    await group.fs.promises.writeFile('/rmdir/nested/c.txt', 'c');
    await group.fs.promises.rmdir('/rmdir');

    expect(await exists(group.fs, '/rmdir')).toBe(false);
    expect(await exists(localFS, tombstonePath('/.meta/tombstones', '/rmdir/nested/c.txt'))).toBe(true);

    // Metadata stays hidden from the app-facing view.
    expect(await exists(group.fs, '/.meta/group.json')).toBe(false);
    expect(await exists(group.fs, '/.config')).toBe(false);

    await group.dispose();
    await repo.dispose();
  });
});
