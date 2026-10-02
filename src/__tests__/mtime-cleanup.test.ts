import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createConfigRepo } from '../config-repo';
import { purgeMtimeSidecars, isMtimeSidecar } from '../mtime-cleanup';

describe('mtime sidecar cleanup', () => {
  it('isMtimeSidecar detects plain and nested sidecars', () => {
    expect(isMtimeSidecar('.user.json.mtime')).toBe(true);
    expect(isMtimeSidecar('..user.json.version.mtime.mtime')).toBe(true);
    expect(isMtimeSidecar('user.json')).toBe(false);
    expect(isMtimeSidecar('.user.json.version')).toBe(false);
  });

  it('purges sidecars from the local primary and keeps data files', async () => {
    const repo = await createConfigRepo('test-app-mt1', {
      nodeId: 'node-mt1',
      purgeMtimeSidecars: false,
    });
    const p = (repo as any).rootFS.promises;

    await p.writeFile('/retire/user.json', '{}');
    await p.writeFile('/retire/.user.json.version', '{"version":1}');
    await p.writeFile('/retire/.user.json.version.mtime', '1700000000000');
    await p.writeFile('/retire/..user.json.version.mtime.mtime', '1700000000000');

    // dryRun reports without deleting
    const dry = await repo.purgeMtimeSidecars({ dryRun: true });
    expect(dry.removed.sort()).toEqual([
      '/retire/..user.json.version.mtime.mtime',
      '/retire/.user.json.version.mtime',
    ]);
    expect(await p.exists('/retire/.user.json.version.mtime')).toBe(true);

    const res = await repo.purgeMtimeSidecars();
    expect(res.removed.sort()).toEqual([
      '/retire/..user.json.version.mtime.mtime',
      '/retire/.user.json.version.mtime',
    ]);
    expect(res.failed).toEqual([]);
    expect(await p.exists('/retire/.user.json.version.mtime')).toBe(false);
    expect(await p.exists('/retire/..user.json.version.mtime.mtime')).toBe(false);
    expect(await p.exists('/retire/user.json')).toBe(true);
    expect(await p.exists('/retire/.user.json.version')).toBe(true);

    await repo.dispose();
  });

  it('scans only the requested subtree', async () => {
    const repo = await createConfigRepo('test-app-mt3', {
      nodeId: 'node-mt3',
      purgeMtimeSidecars: false,
    });
    const p = (repo as any).rootFS.promises;

    await p.writeFile('/retire/.a.json.mtime', '1700000000000');
    await p.writeFile('/keep/.b.json.mtime', '1700000000000');

    await repo.purgeMtimeSidecars({ root: '/retire' });
    expect(await p.exists('/retire/.a.json.mtime')).toBe(false);
    expect(await p.exists('/keep/.b.json.mtime')).toBe(true);

    await repo.dispose();
  });

  it('createConfigRepo purges leaked sidecars on startup', async () => {
    const appId = 'test-app-mt2';
    const dir = path.join(os.tmpdir(), `zen-fs-config-mtime-${Date.now()}`);
    try {
      const first = await createConfigRepo(appId, {
        nodeId: 'node-mt2',
        folderPath: dir,
        purgeMtimeSidecars: false,
      });
      const p1 = (first as any).rootFS.promises;
      await p1.writeFile('/retire/.data.json.mtime', '1700000000000');
      expect(await p1.exists('/retire/.data.json.mtime')).toBe(true);
      await first.dispose();

      const second = await createConfigRepo(appId, { nodeId: 'node-mt2', folderPath: dir });
      const p2 = (second as any).rootFS.promises;
      expect(await p2.exists('/retire/.data.json.mtime')).toBe(false);
      await second.dispose();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('purgeMtimeSidecars works on a bare backend instance', async () => {
    const { createBackend } = await import('../backend-registry');
    const backend = await createBackend({ type: 'InMemory', options: { label: 'mt-raw' } });
    await backend.mkdir('/retire');
    await backend.writeFile('/retire/data.json', '{}');
    await backend.writeFile('/retire/.data.json.mtime', '1700000000000');

    const res = await purgeMtimeSidecars(backend);
    expect(res.removed).toEqual(['/retire/.data.json.mtime']);
    expect(await backend.exists('/retire/data.json')).toBe(true);
  });
});
