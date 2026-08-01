import { describe, it, expect } from 'vitest';
import { mergeAccountFields, getAccountFields, registerBackend } from '../backend-registry';

describe('account reuse', () => {
  // Register a test backend that declares which option keys are "account"
  // fields. These are the credentials (token, owner) that can be reused from
  // a config-sync backend, while `repo` is a storage-location field.
  registerBackend(
    'TestAccountBackend',
    async () => ({
      readFile: async () => '',
      writeFile: async () => {},
      readdir: async () => [],
      stat: async () => ({ isFile: () => true, isDirectory: () => false, size: 0, mtime: 0 }),
      exists: async () => false,
      mkdir: async () => {},
      unlink: async () => {},
      rmdir: async () => {},
    }),
    {
      type: 'TestAccountBackend',
      label: 'Test',
      icon: '🧪',
      fields: [
        { key: 'token', label: 'Token', type: 'password' },
        { key: 'owner', label: 'Owner', type: 'text' },
        { key: 'repo', label: 'Repo', type: 'text' },
      ],
      defaultOptions: {},
      accountFields: ['token', 'owner'],
    },
  );

  describe('getAccountFields', () => {
    it('returns empty array for backend without accountFields', () => {
      // InMemory is a built-in backend with no accountFields metadata.
      expect(getAccountFields('InMemory')).toEqual([]);
    });

    it('returns empty array for an unknown backend type', () => {
      expect(getAccountFields('CompletelyUnknownBackend')).toEqual([]);
    });

    it('returns the configured fields for backend with accountFields', () => {
      expect(getAccountFields('TestAccountBackend')).toEqual(['token', 'owner']);
    });
  });

  describe('mergeAccountFields', () => {
    it('copies account fields from source to target', () => {
      const source = { token: 'abc', owner: 'user1', repo: 'myrepo' };
      const target = { repo: 'different-repo' };
      const result = mergeAccountFields('TestAccountBackend', source, target);
      expect(result).toEqual({ token: 'abc', owner: 'user1', repo: 'different-repo' });
    });

    it('does NOT overwrite existing fields in target', () => {
      const source = { token: 'abc', owner: 'user1', repo: 'myrepo' };
      const target = { repo: 'different-repo', token: 'existing-token' };
      const result = mergeAccountFields('TestAccountBackend', source, target);
      // `token` is already set in target -> must NOT be overwritten.
      expect(result.token).toBe('existing-token');
      // `owner` is missing from target -> copied from source.
      expect(result.owner).toBe('user1');
      // `repo` is a storage-location field, untouched.
      expect(result.repo).toBe('different-repo');
    });

    it('only copies fields listed in accountFields (not other fields)', () => {
      const source = { token: 'abc', owner: 'user1', repo: 'myrepo' };
      const target: Record<string, unknown> = {};
      const result = mergeAccountFields('TestAccountBackend', source, target);
      // `repo` is a storage-location field, not an account field -> not copied.
      expect(result).toEqual({ token: 'abc', owner: 'user1' });
      expect(result).not.toHaveProperty('repo');
    });

    it('returns target unchanged when targetType has no accountFields', () => {
      const source = { token: 'abc', owner: 'user1' };
      const target = { repo: 'different-repo' };
      const result = mergeAccountFields('InMemory', source, target);
      // No accountFields declared -> nothing merged, target returned as-is.
      expect(result).toEqual({ repo: 'different-repo' });
      expect(result).toBe(target);
    });

    it('handles undefined source field values (skips them)', () => {
      const source: Record<string, unknown> = {
        token: undefined,
        owner: 'user1',
        repo: 'myrepo',
      };
      const target = { repo: 'different-repo' };
      const result = mergeAccountFields('TestAccountBackend', source, target);
      // `token` is undefined in source -> skipped, not added to target.
      expect(result).toEqual({ owner: 'user1', repo: 'different-repo' });
      expect(result).not.toHaveProperty('token');
    });
  });
});
