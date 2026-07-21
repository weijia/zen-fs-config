import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerBackend,
  createBackend,
  hasBackend,
  listBackends,
  type BackendInstance,
} from '../backend-registry';

describe('backend-registry', () => {
  describe('registry API', () => {
    it('hasBackend returns true for built-in backends', () => {
      expect(hasBackend('InMemory')).toBe(true);
    });

    it('hasBackend returns false for unknown backends', () => {
      expect(hasBackend('NonexistentBackend')).toBe(false);
    });

    it('listBackends returns all registered backend names', () => {
      const backends = listBackends();
      expect(Array.isArray(backends)).toBe(true);
      expect(backends.length).toBeGreaterThan(0);
      expect(backends).toContain('InMemory');
    });

    it('createBackend throws for unknown backend type', async () => {
      await expect(
        createBackend({ type: 'Nonexistent', options: {} }),
      ).rejects.toThrow(/Unknown backend type/);
    });

    it('registerBackend allows registering a custom backend', async () => {
      const customBackend: BackendInstance = {
        readFile: async () => 'hello',
        writeFile: async () => {},
        readdir: async () => [],
        stat: async () => ({ isFile: () => true, isDirectory: () => false, size: 0, mtime: 0 }),
        exists: async () => true,
        mkdir: async () => {},
        unlink: async () => {},
        rmdir: async () => {},
      };

      registerBackend('CustomTest', async () => customBackend);
      expect(hasBackend('CustomTest')).toBe(true);
      expect(listBackends()).toContain('CustomTest');

      const instance = await createBackend({ type: 'CustomTest', options: {} });
      expect(instance).toBe(customBackend);
    });

    it('registerBackend can override existing backend', async () => {
      const mock: BackendInstance = {
        readFile: async () => 'overridden',
        writeFile: async () => {},
        readdir: async () => [],
        stat: async () => ({ isFile: () => true, isDirectory: () => false, size: 0, mtime: 0 }),
        exists: async () => true,
        mkdir: async () => {},
        unlink: async () => {},
        rmdir: async () => {},
      };

      const original = listBackends().length;
      registerBackend('OverrideTest', async () => mock);
      expect(listBackends().length).toBe(original + 1);

      // Override with same name
      const mock2: BackendInstance = { ...mock, readFile: async () => 'v2' };
      registerBackend('OverrideTest', async () => mock2);
      expect(listBackends().length).toBe(original + 1); // same count

      const instance = await createBackend({ type: 'OverrideTest', options: {} });
      const content = await instance.readFile('/test.txt', 'utf-8');
      expect(content).toBe('v2');
    });
  });

  describe('InMemory backend', () => {
    let backend: BackendInstance;

    beforeEach(async () => {
      backend = await createBackend({
        type: 'InMemory',
        options: { label: `test-${Date.now()}` },
      });
    });

    it('can write and read a file', async () => {
      await backend.writeFile('/hello.txt', 'Hello, World!');
      const content = await backend.readFile('/hello.txt', 'utf-8');
      expect(content).toBe('Hello, World!');
    });

    it('can write and read binary data', async () => {
      const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
      await backend.writeFile('/binary.bin', data);
      const result = await backend.readFile('/binary.bin');
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(5);
      expect(result[0]).toBe(0x48);
    });

    it('can create directories and list contents', async () => {
      await backend.mkdir('/subdir');
      await backend.writeFile('/subdir/file.txt', 'nested');
      const files = await backend.readdir('/subdir');
      expect(files).toContain('file.txt');
    });

    it('writeFile creates parent directories automatically', async () => {
      await backend.writeFile('/a/b/c/deep.txt', 'deep content');
      const content = await backend.readFile('/a/b/c/deep.txt', 'utf-8');
      expect(content).toBe('deep content');
    });

    it('exists returns true for existing files', async () => {
      await backend.writeFile('/exists.txt', 'yes');
      expect(await backend.exists('/exists.txt')).toBe(true);
    });

    it('exists returns false for missing files', async () => {
      expect(await backend.exists('/nope.txt')).toBe(false);
    });

    it('stat returns correct file info', async () => {
      await backend.writeFile('/stat.txt', '12345');
      const st = await backend.stat('/stat.txt');
      expect(st.isFile()).toBe(true);
      expect(st.isDirectory()).toBe(false);
      expect(st.size).toBe(5);
    });

    it('stat returns correct directory info', async () => {
      await backend.mkdir('/mydir');
      const st = await backend.stat('/mydir');
      expect(st.isFile()).toBe(false);
      expect(st.isDirectory()).toBe(true);
    });

    it('can unlink files', async () => {
      await backend.writeFile('/todelete.txt', 'bye');
      expect(await backend.exists('/todelete.txt')).toBe(true);
      await backend.unlink('/todelete.txt');
      expect(await backend.exists('/todelete.txt')).toBe(false);
    });

    it('can rename files', async () => {
      await backend.writeFile('/old.txt', 'rename me');
      await backend.rename!('/old.txt', '/new.txt');
      expect(await backend.exists('/old.txt')).toBe(false);
      expect(await backend.exists('/new.txt')).toBe(true);
      const content = await backend.readFile('/new.txt', 'utf-8');
      expect(content).toBe('rename me');
    });

    it('each InMemory instance is isolated', async () => {
      const b1 = await createBackend({ type: 'InMemory', options: { label: 'a' } });
      const b2 = await createBackend({ type: 'InMemory', options: { label: 'b' } });

      await b1.writeFile('/shared.txt', 'from b1');
      expect(await b2.exists('/shared.txt')).toBe(false);
    });
  });

  describe('custom backend with options', () => {
    it('passes options to the factory function', async () => {
      let receivedOptions: Record<string, unknown> = {};

      registerBackend('OptionsTest', async (options) => {
        receivedOptions = options;
        return {
          readFile: async () => '',
          writeFile: async () => {},
          readdir: async () => [],
          stat: async () => ({ isFile: () => true, isDirectory: () => false, size: 0, mtime: 0 }),
          exists: async () => false,
          mkdir: async () => {},
          unlink: async () => {},
          rmdir: async () => {},
        };
      });

      await createBackend({
        type: 'OptionsTest',
        options: { foo: 'bar', count: 42 },
      });

      expect(receivedOptions.foo).toBe('bar');
      expect(receivedOptions.count).toBe(42);
    });
  });
});
