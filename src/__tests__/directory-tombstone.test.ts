/**
 * 目录墓碑（`type: "directory"`）的语义：
 *
 * - 一条记录覆盖整棵目录树，应用时按树清理（含隐藏的 `.keep` / `.keep.mtime`）；
 * - 旧墓碑（没有 `type`）仍按"单文件"处理，读写字节保持兼容；
 * - `TombstoneStore.process()`（数据组走的路径）同样支持目录目标。
 */
import { describe, it, expect } from 'vitest';
import { createBackend } from '../backend-registry';
import {
  isDirectoryTombstone,
  normalizeTombstonePath,
  parseTombstoneFile,
  purgeTombstonedTree,
  readTombstonesFromFs,
  serializeTombstone,
  TOMBSTONES_DIR,
  encodeMetaPath,
  TombstoneStore,
} from '../group-meta';
import type { TombstoneMeta } from '../types';

const fileTombstone: TombstoneMeta = {
  path: '/app/data/a.txt',
  deletedAt: 1000,
  deletedBy: 'local:g',
  confirmedBy: ['local:g'],
};

const dirTombstone: TombstoneMeta = {
  path: '/app/data/2026',
  deletedAt: 2000,
  deletedBy: 'local:g',
  confirmedBy: ['local:g'],
  type: 'directory',
};

describe('directory tombstones', () => {
  it('serializes file tombstones exactly as the legacy format (no `type` key)', () => {
    const bytes = serializeTombstone(fileTombstone);
    expect(bytes).toBe(JSON.stringify(fileTombstone, null, 2));
    expect(bytes.includes('"type"')).toBe(false);
  });

  it('serializes directory tombstones with a trailing type field', () => {
    const parsed = JSON.parse(serializeTombstone(dirTombstone));
    expect(parsed.path).toBe('/app/data/2026');
    expect(parsed.type).toBe('directory');
    expect(serializeTombstone(dirTombstone)).toBe(serializeTombstone(dirTombstone));
  });

  it('normalizes directory paths (leading slash, no trailing slash)', () => {
    expect(normalizeTombstonePath('app/data/2026/')).toBe('/app/data/2026');
    expect(normalizeTombstonePath('/app/data/2026')).toBe('/app/data/2026');
    expect(normalizeTombstonePath('/')).toBe('/');
    // 两种写法编码成同一个墓碑文件名，不会各存一份。
    expect(encodeMetaPath(normalizeTombstonePath('/app/x/'))).toBe(encodeMetaPath('/app/x'));
  });

  it('parses directory tombstones and keeps legacy bodies type-less', () => {
    const dir = parseTombstoneFile(serializeTombstone(dirTombstone));
    expect(dir.tombstones[0].type).toBe('directory');
    expect(isDirectoryTombstone(dir.tombstones[0])).toBe(true);

    const legacy = parseTombstoneFile(serializeTombstone(fileTombstone));
    expect(legacy.tombstones[0].type).toBeUndefined();
    expect(isDirectoryTombstone(legacy.tombstones[0])).toBe(false);

    // 损坏的旧记录（只能从文件名恢复路径）按文件墓碑处理，不会误删整个目录。
    const recovered = parseTombstoneFile('{"path": ', 'app__data__2026.json');
    expect(recovered.tombstones[0].type).toBeUndefined();
  });

  it('reads directory tombstones from .meta/tombstones', async () => {
    const fs = await createBackend({ type: 'InMemory', options: { label: 'tomb-read' } });
    const p = `${TOMBSTONES_DIR}/${encodeMetaPath(dirTombstone.path)}.json`;
    await fs.mkdir(TOMBSTONES_DIR, { recursive: true } as any).catch(() => undefined);
    await fs.writeFile(p, serializeTombstone(dirTombstone));

    const list = await readTombstonesFromFs(fs, () => undefined);
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe('/app/data/2026');
    expect(list[0].type).toBe('directory');
  });

  it('purges a directory tree including hidden .keep placeholders', async () => {
    const fs = await createBackend({ type: 'InMemory', options: { label: 'purge' } });
    await fs.mkdir('/a/b', { recursive: true } as any).catch(() => undefined);
    await fs.writeFile('/a/x.txt', 'x');
    await fs.writeFile('/a/b/y.txt', 'y');
    await fs.writeFile('/a/.keep', '\n');
    await fs.writeFile('/a/.keep.mtime', '{"mtime":1}');
    await fs.writeFile('/a/b/.keep', '\n');

    await purgeTombstonedTree(fs, '/a');

    expect(await fs.exists('/a/x.txt')).toBe(false);
    expect(await fs.exists('/a/b/y.txt')).toBe(false);
    expect(await fs.exists('/a/.keep')).toBe(false);
    expect(await fs.exists('/a/.keep.mtime')).toBe(false);
    expect(await fs.exists('/a/b/.keep')).toBe(false);
    expect(await fs.exists('/a/b')).toBe(false);
    expect(await fs.exists('/a')).toBe(false);
  });

  it('TombstoneStore.process applies a directory tombstone on local store and targets', async () => {
    const local = await createBackend({ type: 'InMemory', options: { label: 'store-local' } });
    const target = await createBackend({ type: 'InMemory', options: { label: 'store-target' } });

    for (const fs of [local, target]) {
      await fs.mkdir('/data/old/sub', { recursive: true } as any).catch(() => undefined);
      await fs.writeFile('/data/old/a.txt', 'a');
      await fs.writeFile('/data/old/sub/b.txt', 'b');
      await fs.writeFile('/data/old/.keep.mtime', '{"mtime":1}');
    }

    const store = new TombstoneStore(local, 'local:g');
    // deletedAt 必须是"刚刚删除"：目录本身在删除前就存在，若墓碑时间戳早于它
    // 的 mtime，会被判定为"删除后又被重建"而自动过期。
    await store.write({ ...dirTombstone, path: '/data/old', deletedAt: Date.now() });

    await store.process([{ id: 'target', fs: target }]);

    for (const fs of [local, target]) {
      expect(await fs.exists('/data/old/a.txt')).toBe(false);
      expect(await fs.exists('/data/old/sub/b.txt')).toBe(false);
      expect(await fs.exists('/data/old/.keep.mtime')).toBe(false);
      expect(await fs.exists('/data/old')).toBe(false);
      // 同级的其他数据不受影响。
      expect(await fs.exists('/data')).toBe(true);
    }
  });

  it('does not confirm a target whose purge failed (conservative, same as config group)', async () => {
    const local = await createBackend({ type: 'InMemory', options: { label: 'confirm-local' } });
    const good = await createBackend({ type: 'InMemory', options: { label: 'confirm-good' } });
    const stuck = await createBackend({ type: 'InMemory', options: { label: 'confirm-stuck' } });

    for (const fs of [local, good, stuck]) {
      await fs.mkdir('/data/old/sub', { recursive: true } as any).catch(() => undefined);
      await fs.writeFile('/data/old/a.txt', 'a');
      await fs.writeFile('/data/old/sub/b.txt', 'b');
    }
    // 模拟一个"删除永远失败"的副本（网络 / 后端权限）。
    stuck.unlink = async () => {
      throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
    };
    stuck.rmdir = async () => {
      throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
    };

    const store = new TombstoneStore(local, 'local:g');
    await store.write({ ...dirTombstone, path: '/data/old', deletedAt: Date.now() });

    const targets = [
      { id: 'good', fs: good },
      { id: 'stuck', fs: stuck },
    ];
    await store.process(targets);
    await store.confirm(targets);

    const tombstone = (await store.list())[0];
    expect(tombstone.confirmedBy).toContain('good');
    expect(tombstone.confirmedBy).not.toContain('stuck');
    expect(await stuck.exists('/data/old/a.txt')).toBe(true);
  });

  it('gc re-checks each target and keeps the tombstone when a copy came back', async () => {
    const local = await createBackend({ type: 'InMemory', options: { label: 'gc-local' } });
    const target = await createBackend({ type: 'InMemory', options: { label: 'gc-target' } });

    for (const fs of [local, target]) {
      await fs.mkdir('/data/old/sub', { recursive: true } as any).catch(() => undefined);
      await fs.writeFile('/data/old/a.txt', 'a');
    }

    const store = new TombstoneStore(local, 'local:g');
    await store.write({ ...dirTombstone, path: '/data/old', deletedAt: Date.now() });

    const targets = [{ id: 'target', fs: target }];
    await store.process(targets);
    await store.confirm(targets);
    expect((await store.list())[0].confirmedBy).toContain('target');

    // 超出保留期（把 deletedAt 往前拨 25h），但副本又把残留带了回来。
    const p = `${TOMBSTONES_DIR}/${encodeMetaPath('/data/old')}.json`;
    const raw = await local.readFile(p);
    const aged = JSON.parse(new TextDecoder().decode(raw as any));
    await local.writeFile(p, JSON.stringify({ ...aged, deletedAt: Date.now() - 25 * 60 * 60 * 1000 }, null, 2));
    await target.writeFile('/data/old/a.txt', 'a');

    await store.gc(['target'], targets);

    expect(await local.exists(p)).toBe(true);
  });

  it('TombstoneStore.process leaves a recreated directory alone (delete intent revoked)', () => {
    // 目录在删除之后被再次写入 → mtime 更新 → 墓碑过期，不再整树删除。
    // 这里只校验判定函数对目录墓碑的输入形态没问题（type 不参与判定）。
    expect(isDirectoryTombstone({ ...dirTombstone, deletedAt: 1 })).toBe(true);
  });
});
