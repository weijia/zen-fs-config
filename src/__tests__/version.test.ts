import { describe, it, expect } from 'vitest';
import { createBackend } from '../backend-registry';
import { incrementVersion, writeVersion, versionPathFor, readVersion } from '../version';

/**
 * These tests lock in the "content-hash-unchanged → do not bump version" rule,
 * which prevents redundant .version sidecar writes (and the resulting remote
 * PUTs) when a config file is re-written with identical content.
 */
describe('incrementVersion', () => {
	it('does not increment version when content hash is unchanged', async () => {
		const fs = await createBackend({ type: 'InMemory', options: { label: `ver-${Date.now()}` } });
		const path = '/app-a/db.json';
		const bytes = new TextEncoder().encode('{"k":1}');

		// First write establishes version 1.
		let v = await incrementVersion(fs, path, bytes, 'author-a');
		await writeVersion(fs, versionPathFor(path)!, v);
		expect(v.version).toBe(1);

		// Second write with identical content must keep version at 1.
		v = await incrementVersion(fs, path, bytes, 'author-a');
		await writeVersion(fs, versionPathFor(path)!, v);
		expect(v.version).toBe(1);

		// The persisted sidecar must still record version 1.
		const stored = await readVersion(fs, versionPathFor(path)!);
		expect(stored?.version).toBe(1);
	});

	it('increments version only when content hash changes', async () => {
		const fs = await createBackend({ type: 'InMemory', options: { label: `ver2-${Date.now()}` } });
		const path = '/app-a/db.json';

		let v = await incrementVersion(fs, path, new TextEncoder().encode('{"k":1}'), 'a');
		await writeVersion(fs, versionPathFor(path)!, v);
		expect(v.version).toBe(1);

		// Same content again → stays 1.
		v = await incrementVersion(fs, path, new TextEncoder().encode('{"k":1}'), 'a');
		expect(v.version).toBe(1);

		// Different content → bumps to 2.
		v = await incrementVersion(fs, path, new TextEncoder().encode('{"k":2}'), 'a');
		expect(v.version).toBe(2);
	});

	it('starts at version 1 for a brand-new file', async () => {
		const fs = await createBackend({ type: 'InMemory', options: { label: `ver3-${Date.now()}` } });
		const v = await incrementVersion(fs, '/new.json', new TextEncoder().encode('x'), 'a');
		expect(v.version).toBe(1);
	});
});
