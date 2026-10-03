import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createConfigRepo } from '../config-repo';
import { purgeKeepFiles, isKeepFile } from '../keep-cleanup';

describe('keep placeholder cleanup', () => {
  it('isKeepFile detects only the exact .keep name', () => {
    expect(isKeepFile('.keep')).toBe(true);
    expect(isKeepFile('foo.keep')).toBe(false);
    expect(isKeepFile('keep')).toBe(false);
  });

  it('purges leaked .keep from the local primary and keeps data files', async () => {
    const repo = await createConfigRepo('test-app-keep1', {
      nodeId: 'node-keep1',
      purgeKeepFiles: false,
    });
    const p = (repo as any).rootFS.promises;

    await p.writeFile('/retire/user.json', '{}');
    await p.writeFile('/retire/.keep', '\n');
    await p.writeFile('/docs/.keep', '\n');

    // dryRun reports without deleting
    const dry = await repo.purgeKeepFiles({ dryRun: true });
    expect(dry.removed.sort()).toEqual(['/docs/.keep', '/retire/.keep']);
    expect(await p.exists('/retire/.keep')).toBe(true);

    const res = await repo.purgeKeepFiles();
    expect(res.removed.sort()).toEqual(['/docs/.keep', '/retire/.keep']);
    expect(res.failed).toEqual([]);
    expect(await p.exists('/retire/.keep')).toBe(false);
    expect(await p.exists('/docs/.keep')).toBe(false);
    expect(await p.exists('/retire/user.json')).toBe(true);

    await repo.dispose();
  });

  it('protects the intentional /.meta/backends/.keep', async () => {
    const repo = await createConfigRepo('test-app-keep2', {
      nodeId: 'node-keep2',
      purgeKeepFiles: false,
    });
    const p = (repo as any).rootFS.promises;

    // intentional meta placeholder
    await p.writeFile('/.meta/backends/.keep', '\n');
    // leaked placeholder elsewhere
    await p.writeFile('/retire/.keep', '\n');

    const res = await repo.purgeKeepFiles();
    expect(res.removed).toEqual(['/retire/.keep']);
    expect(await p.exists('/.meta/backends/.keep')).toBe(true);

    await repo.dispose();
  });

  it('scans only the requested subtree', async () => {
    const repo = await createConfigRepo('test-app-keep3', {
      nodeId: 'node-keep3',
      purgeKeepFiles: false,
    });
    const p = (repo as any).rootFS.promises;

    await p.writeFile('/retire/.keep', '\n');
    await p.writeFile('/keep/.keep', '\n');

    await repo.purgeKeepFiles({ root: '/retire' });
    expect(await p.exists('/retire/.keep')).toBe(false);
    expect(await p.exists('/keep/.keep')).toBe(true);

    await repo.dispose();
  });

  it('createConfigRepo purges leaked .keep on startup', async () => {
    const appId = 'test-app-keep4';
    const dir = path.join(os.tmpdir(), `zen-fs-config-keep-${Date.now()}`);
    try {
      const first = await createConfigRepo(appId, {
        nodeId: 'node-keep4',
        folderPath: dir,
        purgeKeepFiles: false,
      });
      const p1 = (first as any).rootFS.promises;
      await p1.writeFile('/retire/.keep', '\n');
      expect(await p1.exists('/retire/.keep')).toBe(true);
      await first.dispose();

      const second = await createConfigRepo(appId, { nodeId: 'node-keep4', folderPath: dir });
      const p2 = (second as any).rootFS.promises;
      expect(await p2.exists('/retire/.keep')).toBe(false);
      await second.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('purgeKeepFiles works on a bare backend instance', async () => {
    const { createBackend } = await import('../backend-registry');
    const backend = await createBackend({ type: 'InMemory', options: { label: 'keep-raw' } });
    await backend.mkdir('/retire');
    await backend.writeFile('/retire/data.json', '{}');
    await backend.writeFile('/retire/.keep', '\n');

    const res = await purgeKeepFiles(backend);
    expect(res.removed).toEqual(['/retire/.keep']);
    expect(await backend.exists('/retire/data.json')).toBe(true);
  });
});
