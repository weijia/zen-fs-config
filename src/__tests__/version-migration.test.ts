import { describe, it, expect, vi } from 'vitest';
import { createBackend } from '../backend-registry';
import { versionPathFor, legacyVersionPathFor, readVersion } from '../version';
import { migrateVersionSidecars } from '../version-migration';

function makeReplicaSpy() {
  const deleted: string[] = [];
  const unlink = vi.fn(async (p: string) => {
    deleted.push(p);
  });
  return { unlink, deleted };
}

describe('legacyVersionPathFor', () => {
  it('returns the old dotfile path for non-dot configs', () => {
    expect(legacyVersionPathFor('/app-a/db.json')).toBe('/app-a/.db.json.version');
    expect(legacyVersionPathFor('flags.json')).toBe('.flags.json.version');
  });

  it('returns null for dotfile configs (naming unchanged)', () => {
    expect(legacyVersionPathFor('/.meta/backends/.rs.json')).toBeNull();
  });

  it('returns null for version files themselves', () => {
    expect(legacyVersionPathFor('/app-a/db.json.version')).toBeNull();
  });
});

describe('migrateVersionSidecars', () => {
  it('renames a legacy `.x.version` (+ its .mtime) to `<name>.version` and cleans replicas', async () => {
    const fs = await createBackend({ type: 'InMemory', options: { label: `mig-${Date.now()}` } });
    // Config exists (non-dot), under an app directory (as in production).
    await fs.writeFile('/app-a/db.json', new TextEncoder().encode('{"k":1}'));
    // Legacy version sidecar + its mtime sibling.
    await fs.writeFile('/app-a/.db.json.version', new TextEncoder().encode('{"version":3,"hash":"h"}'));
    await fs.writeFile('/app-a/.db.json.version.mtime', new TextEncoder().encode('1700000000000'));

    const replica = makeReplicaSpy();
    const result = await migrateVersionSidecars(fs, { replicas: [replica] });

    expect(result.renamed).toContain('/app-a/.db.json.version');
    expect(await fs.exists('/app-a/db.json.version')).toBe(true);
    expect(await fs.exists('/app-a/.db.json.version')).toBe(false);
    expect(await fs.exists('/app-a/db.json.version.mtime')).toBe(true);
    expect(await fs.exists('/app-a/.db.json.version.mtime')).toBe(false);

    // History preserved.
    const v = await readVersion(fs, versionPathFor('/app-a/db.json')!);
    expect(v?.version).toBe(3);

    // Remote residual legacy paths deleted (both version + mtime).
    expect(replica.deleted).toContain('/app-a/.db.json.version');
    expect(replica.deleted).toContain('/app-a/.db.json.version.mtime');
  });

  it('skips legacy paths that belong to a dotfile config', async () => {
    const fs = await createBackend({ type: 'InMemory', options: { label: `mig2-${Date.now()}` } });
    // Dotfile config exists → legacy `.rs.json.version` is its (unchanged) version.
    await fs.writeFile('/.meta/backends/.rs.json', new TextEncoder().encode('{"a":1}'));
    await fs.writeFile('/.meta/backends/.rs.json.version', new TextEncoder().encode('{"version":2}'));

    const replica = makeReplicaSpy();
    const result = await migrateVersionSidecars(fs, { replicas: [replica] });

    expect(result.renamed).not.toContain('/.meta/backends/.rs.json.version');
    expect(await fs.exists('/.meta/backends/.rs.json.version')).toBe(true);
    // No remote deletion attempted for the skipped (still-valid) sidecar.
    expect(replica.deleted).not.toContain('/.meta/backends/.rs.json.version');
  });

  it('deletes orphaned legacy sidecars with no owning config', async () => {
    const fs = await createBackend({ type: 'InMemory', options: { label: `mig3-${Date.now()}` } });
    await fs.writeFile('/.gone.json.version', new TextEncoder().encode('{"version":1}'));

    const result = await migrateVersionSidecars(fs, {});

    expect(result.deleted).toContain('/.gone.json.version');
    expect(await fs.exists('/.gone.json.version')).toBe(false);
  });
});
