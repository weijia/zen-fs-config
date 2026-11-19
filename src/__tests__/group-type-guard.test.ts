import { describe, expect, it, vi } from 'vitest';
import type { SyncableFS } from 'zen-fs-sync';
import { backendToSyncableFS } from '../adapters';
import { createBackend } from '../backend-registry';
import { readGroupIdentity, wrapGroupTypeGuard } from '../group-type-guard';

/** 极简 SyncableFS：只为验证「写一次」守卫，不做任何目录/元数据模拟。 */
function makeFakeFS(seed: Record<string, string> = {}): SyncableFS & { dump: () => Record<string, string> } {
  const store = new Map<string, string>(Object.entries(seed));
  const fs: any = {
    async readdir() {
      return Array.from(store.keys());
    },
    async readFile(path: string, encoding?: string) {
      const value = store.get(path);
      if (value === undefined) throw new Error(`ENOENT ${path}`);
      return encoding ? value : new TextEncoder().encode(value);
    },
    async writeFile(path: string, data: string | Uint8Array) {
      store.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data));
    },
    async writeFileWithMtime(path: string, data: string | Uint8Array) {
      fs.writeFile(path, data);
    },
    async unlink(path: string) {
      store.delete(path);
    },
    async stat() {
      return { size: 0, mtimeMs: 0 };
    },
    async mkdir() {},
    async exists(path: string) {
      return store.has(path);
    },
  };
  return Object.assign(fs, { dump: () => Object.fromEntries(store) });
}

describe('readGroupIdentity', () => {
  it('recognizes both group-type layouts', () => {
    expect(readGroupIdentity('/.config/group-type', 'config-sync')).toBe('config-sync');
    expect(readGroupIdentity('/.meta/group-type', ' data-sync\n')).toBe('data-sync');
  });

  it('recognizes group.json kind and app-data-group descriptor type', () => {
    expect(readGroupIdentity('/.meta/group.json', '{"kind":"config"}')).toBe('kind:config');
    expect(
      readGroupIdentity('/.config/app-data-groups/app/demo.json', '{"id":"demo","groupType":"data-sync"}'),
    ).toBe('groupType:data-sync');
  });

  it('ignores unrelated files and unparsable identity files', () => {
    expect(readGroupIdentity('/db/a.txt', 'config-sync')).toBeNull();
    expect(readGroupIdentity('/.meta/group.json', 'not json')).toBeNull();
    expect(readGroupIdentity('/.config/group-type', '   ')).toBeNull();
  });
});

describe('group-type guard', () => {
  it('allows the first write when the target has no identity yet', async () => {
    const fs = makeFakeFS();
    const guarded = wrapGroupTypeGuard(fs, 'local');
    await guarded.writeFile('/.config/group-type', 'config-sync');
    expect(fs.dump()['/.config/group-type']).toBe('config-sync');
  });

  it('allows an idempotent rewrite with only whitespace differences', async () => {
    const fs = makeFakeFS({ '/.config/group-type': 'config-sync' });
    const guarded = wrapGroupTypeGuard(fs, 'local');
    await guarded.writeFile('/.config/group-type', ' config-sync\n');
    expect(fs.dump()['/.config/group-type'].trim()).toBe('config-sync');
  });

  it('drops a sync write that would flip config-sync into data-sync', async () => {
    const fs = makeFakeFS({ '/.config/group-type': 'config-sync' });
    const onBlock = vi.fn();
    const guarded = wrapGroupTypeGuard(fs, 'InMemory(replica-a)', onBlock);

    await guarded.writeFile('/.config/group-type', 'data-sync');

    expect(fs.dump()['/.config/group-type']).toBe('config-sync');
    expect(onBlock).toHaveBeenCalledTimes(1);
    expect(onBlock.mock.calls[0][0]).toMatchObject({
      side: 'InMemory(replica-a)',
      path: '/.config/group-type',
      existing: 'config-sync',
      incoming: 'data-sync',
    });
    expect((guarded as any).getLastBlockedGroupType()).toMatchObject({ existing: 'config-sync' });
  });

  it('also guards the legacy .meta/group-type and writeFileWithMtime', async () => {
    const fs = makeFakeFS({ '/.meta/group-type': 'data-sync' });
    const guarded = wrapGroupTypeGuard(fs, 'Gitee(replica-b)');

    await guarded.writeFileWithMtime!('/.meta/group-type', 'config-sync', Date.now());

    expect(fs.dump()['/.meta/group-type']).toBe('data-sync');
  });

  it('locks group.json kind but still allows name/features updates', async () => {
    const fs = makeFakeFS({
      '/.meta/group.json': '{"schemaVersion":2,"kind":"config","id":"config","name":"旧名"}',
    });
    const guarded = wrapGroupTypeGuard(fs, 'local');

    await guarded.writeFile(
      '/.meta/group.json',
      '{"schemaVersion":2,"kind":"data","id":"config","name":"旧名"}',
    );
    expect(fs.dump()['/.meta/group.json']).toContain('"kind":"config"');

    await guarded.writeFile(
      '/.meta/group.json',
      '{"schemaVersion":2,"kind":"config","id":"config","name":"新名"}',
    );
    expect(fs.dump()['/.meta/group.json']).toContain('"name":"新名"');
  });

  it('refuses to change an app-data-group descriptor into another group type', async () => {
    const fs = makeFakeFS({
      '/.config/app-data-groups/app/demo.json': '{"id":"demo","groupType":"data-sync"}',
    });
    const guarded = wrapGroupTypeGuard(fs, 'local');

    await guarded.writeFile('/.config/app-data-groups/app/demo.json', '{"id":"demo","groupType":"config-sync"}');

    expect(fs.dump()['/.config/app-data-groups/app/demo.json']).toContain('"groupType":"data-sync"');
  });

  it('leaves ordinary files untouched', async () => {
    const fs = makeFakeFS();
    const guarded = wrapGroupTypeGuard(fs, 'local');
    await guarded.writeFile('/db/config/a.json', '{"a":1}');
    expect(fs.dump()['/db/config/a.json']).toBe('{"a":1}');
  });
});

describe('backendToSyncableFS applies the guard', () => {
  it('protects a real backend from a type flip', async () => {
    const backend: any = await createBackend({ type: 'InMemory', options: { label: 'guard-probe' } });
    await backend.writeFile('/.config/group-type', 'config-sync');

    const syncable = backendToSyncableFS(backend, 'InMemory(guard-probe)');
    await syncable.writeFile('/.config/group-type', 'data-sync');

    const back = await backend.readFile('/.config/group-type', 'utf-8');
    expect(String(back).trim()).toBe('config-sync');
  });
});
