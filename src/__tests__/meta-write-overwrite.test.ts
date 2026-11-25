import { describe, it, expect } from 'vitest';
import { writeFileOverwrite, type MetaFS } from '../group-meta';

/**
 * 复现 "remove data-group backend FAILED: _Exception: file already exists"：
 * StoreFS 风格的后端在 writeFile 时不会覆盖已有文件，而是走 createFile
 * 并返回 EEXIST。墓碑 / 版本记录会被重复写（例如同一个后端被再次移除），
 * writeFileOverwrite 必须先删再写。
 */
function makeStoreFS(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const writes: string[] = [];
  const fs: MetaFS = {
    async writeFile(path: string, data: any) {
      const text = new TextDecoder().decode(data as Uint8Array);
      if (files.has(path)) {
        const err: any = new Error('file already exists');
        err.code = 'EEXIST';
        throw err;
      }
      files.set(path, text);
      writes.push(path);
    },
    async readFile(path: string) {
      const v = files.get(path);
      if (v === undefined) throw new Error('ENOENT');
      return new TextEncoder().encode(v);
    },
    async readdir() {
      return Array.from(files.keys());
    },
    async mkdir() {
      return undefined;
    },
    async unlink(path: string) {
      files.delete(path);
    },
  };
  return { fs, files, writes };
}

describe('writeFileOverwrite', () => {
  it('文件已存在时先删再写，并写入新内容', async () => {
    const { fs, files, writes } = makeStoreFS({ '/.meta/tombstones/a.json': '{"v":1}' });

    await writeFileOverwrite(fs, '/.meta/tombstones/a.json', new TextEncoder().encode('{"v":2}'));

    expect(files.get('/.meta/tombstones/a.json')).toBe('{"v":2}');
    expect(writes).toEqual(['/.meta/tombstones/a.json']);
  });

  it('文件不存在时直接写', async () => {
    const { fs, files } = makeStoreFS();
    await writeFileOverwrite(fs, '/.meta/tombstones/b.json', new TextEncoder().encode('{}'));
    expect(files.get('/.meta/tombstones/b.json')).toBe('{}');
  });

  it('非 EEXIST 错误照常抛出', async () => {
    const fs = {
      async writeFile() {
        const err: any = new Error('disk full');
        err.code = 'ENOSPC';
        throw err;
      },
      async readFile() { throw new Error('ENOENT'); },
      async readdir() { return []; },
      async mkdir() { return undefined; },
      async unlink() { return undefined; },
    } as unknown as MetaFS;

    await expect(
      writeFileOverwrite(fs, '/.meta/tombstones/c.json', new TextEncoder().encode('{}')),
    ).rejects.toThrow(/disk full/);
  });

  it('幽灵条目（删不掉又建不了）：墓碑语义下按已存在处理', async () => {
    // 目录 listing 里有名字，但索引里没有：exists/stat/unlink 全是 ENOENT，
    // 只有 createFile 报 EEXIST —— 线上 removeBackend 的真实形态。
    const ghost = {
      async writeFile() {
        const err: any = new Error('file already exists');
        err.code = 'EEXIST';
        throw err;
      },
      async readFile() { throw new Error('ENOENT'); },
      async readdir() { return []; },
      async mkdir() { return undefined; },
      async unlink() { throw new Error('ENOENT'); },
    } as unknown as MetaFS;

    await expect(
      writeFileOverwrite(ghost, '/.meta/tombstones/g.json', new TextEncoder().encode('{}'), {
        ignorePersistentEexist: true,
      }),
    ).resolves.toBeUndefined();

    // 需要真实覆盖内容的场景仍然要抛
    await expect(
      writeFileOverwrite(ghost, '/.meta/tombstones/g.json', new TextEncoder().encode('{}')),
    ).rejects.toThrow(/already exists/);
  });
});
