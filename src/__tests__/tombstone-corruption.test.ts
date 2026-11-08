/**
 * Tombstone corruption handling.
 *
 * Policy under test: a tombstone that cannot be parsed still counts as "this
 * path was deleted" — the target path is recovered from the encoded filename.
 * Dropping it silently (the previous behavior) would let a stale replica
 * resurrect a file the user deleted on purpose.
 */
import { describe, it, expect } from 'vitest';
import { createBackend } from '../backend-registry';
import { encodeMetaPath, parseTombstoneFile, readTombstonesFromFs } from '../group-meta';

const NEW_DIR = '/.meta/tombstones';
const LEGACY_DIR = '/.meta/.deleted';

async function newFs(label: string): Promise<any> {
  return createBackend({ type: 'InMemory', options: { label: `tombstone-${label}` } });
}

async function mkdirp(fs: any, p: string): Promise<void> {
  let current = '';
  for (const part of p.split('/').filter(Boolean)) {
    current += `/${part}`;
    try {
      await fs.mkdir(current);
    } catch (err: any) {
      if (err?.code !== 'EEXIST' && !/exist/i.test(String(err?.message ?? ''))) throw err;
    }
  }
}

async function writeTombstone(fs: any, dir: string, filePath: string, body: string): Promise<void> {
  await mkdirp(fs, dir);
  await fs.writeFile(`${dir}/${encodeMetaPath(filePath)}.json`, new TextEncoder().encode(body));
}

function record(path: string, confirmedBy: string[] = []): string {
  return JSON.stringify({ path, deletedAt: 1000, deletedBy: 'local-idb', confirmedBy }, null, 2);
}

describe('tombstone corruption', () => {
  it('bad JSON is still honored (path recovered from the filename)', async () => {
    const fs = await newFs('bad-json');
    const warnings: string[] = [];
    await writeTombstone(fs, NEW_DIR, '/data/bad.txt', 'this is not json at all');

    const tombstones = await readTombstonesFromFs(fs, (m) => warnings.push(m));

    expect(tombstones.map((t) => t.path)).toEqual(['/data/bad.txt']);
    expect(tombstones[0].confirmedBy).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('data__bad++txt');
    expect(warnings[0]).toContain('treated as deleted');
  });

  it('truncated JSON is still honored (mid-write body)', async () => {
    const fs = await newFs('truncated');
    const warnings: string[] = [];
    const truncated =
      '{"path":"/data/truncated.txt","deletedAt":1000,"deletedBy":"local-idb",' +
      '"confirmedBy":["local-idb","gitee","remotestorage-1';
    await writeTombstone(fs, NEW_DIR, '/data/truncated.txt', truncated);

    const tombstones = await readTombstonesFromFs(fs, (m) => warnings.push(m));

    expect(tombstones.map((t) => t.path)).toEqual(['/data/truncated.txt']);
    expect(warnings[0]).toContain('JSON parse error');
    expect(warnings[0]).toContain('treated as deleted');
  });

  it('duplicate writes for the same path are merged (new + legacy, and concatenated docs)', async () => {
    const fs = await newFs('duplicates');
    const bodyA = record('/data/dup.txt', ['local-idb']);
    const bodyB = record('/data/dup.txt', ['local-idb', 'gitee']);
    await writeTombstone(fs, NEW_DIR, '/data/dup.txt', bodyA);
    await writeTombstone(fs, LEGACY_DIR, '/data/dup.txt', bodyB);

    // A second file for a different path whose body holds two concatenated docs.
    await writeTombstone(fs, NEW_DIR, '/data/concat.txt', record('/data/concat.txt', ['local-idb']) + '\n' + record('/data/concat.txt', ['local-idb', 'remote']));

    const warnings: string[] = [];
    const tombstones = await readTombstonesFromFs(fs, (m) => warnings.push(m));

    const dup = tombstones.find((t) => t.path === '/data/dup.txt');
    expect(dup).toBeDefined();
    expect([...dup!.confirmedBy].sort()).toEqual(['gitee', 'local-idb']);

    const concat = tombstones.find((t) => t.path === '/data/concat.txt');
    expect(concat).toBeDefined();
    expect([...concat!.confirmedBy].sort()).toEqual(['local-idb', 'remote']);

    // Only the concatenated body is reported; the two valid mirrors are not.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('2 concatenated documents recovered');
  });

  it('mixed valid + corrupt files across paths are all returned', async () => {
    const fs = await newFs('mixed');
    const warnings: string[] = [];
    await writeTombstone(fs, NEW_DIR, '/data/a.txt', record('/data/a.txt', ['local-idb']));
    await writeTombstone(fs, NEW_DIR, '/data/b.txt', record('/data/b.txt', ['local-idb']));
    await writeTombstone(fs, NEW_DIR, '/data/c.txt', '{"path":"/data/c.txt","deletedAt":1000,');
    // Non-tombstone files in the directory must be ignored.
    await mkdirp(fs, NEW_DIR);
    await fs.writeFile(`${NEW_DIR}/README.md`, new TextEncoder().encode('ignore me'));

    const tombstones = await readTombstonesFromFs(fs, (m) => warnings.push(m));
    const paths = tombstones.map((t) => t.path).sort();

    expect(paths).toEqual(['/data/a.txt', '/data/b.txt', '/data/c.txt']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/.meta/tombstones/');
    expect(warnings[0]).toContain('data__c++txt');
  });

  it('parseTombstoneFile keeps working when a valid object is followed by garbage', () => {
    const parsed = parseTombstoneFile(record('/data/x.txt', ['local-idb']) + '{"path":"/data/x.txt"');
    expect(parsed.tombstones.map((t) => t.path)).toEqual(['/data/x.txt']);
    expect(parsed.problems.join('; ')).toContain('JSON parse error');
  });
});
