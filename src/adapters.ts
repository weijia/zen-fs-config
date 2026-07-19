/**
 * zen-fs-config — SyncableFS Adapters
 *
 * Adapters that wrap various FS-like objects into the SyncableFS
 * interface required by zen-fs-sync.
 */

import type { FileStat, SyncableFS } from 'zen-fs-sync';
import type { BackendInstance } from './backend-registry';

// ---------------------------------------------------------------------------
// BackendInstance → SyncableFS
// ---------------------------------------------------------------------------

/**
 * Wrap a BackendInstance (from backend-registry) into a SyncableFS.
 * BackendInstance's readFile may return string | Buffer | Uint8Array;
 * SyncableFS requires readFile(path, 'utf-8') → string and readFile(path) → Buffer.
 */
export function backendToSyncableFS(backend: BackendInstance): SyncableFS {
  return {
    async readdir(path: string): Promise<string[]> {
      return backend.readdir(path);
    },

    async readFile(path: string, encoding?: BufferEncoding): Promise<any> {
      const result = await backend.readFile(path, encoding);
      // If encoding was requested, ensure string return
      if (encoding) {
        if (typeof result === 'string') return result;
        if (result instanceof Uint8Array) return new TextDecoder().decode(result);
        if (Buffer.isBuffer(result)) return result.toString(encoding);
        return String(result);
      }
      // No encoding — should return Buffer-like
      if (typeof result === 'string') return Buffer.from(result);
      if (result instanceof Uint8Array) return Buffer.from(result);
      if (Buffer.isBuffer(result)) return result;
      return Buffer.from(String(result));
    },

    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      return backend.writeFile(path, data);
    },

    async unlink(path: string): Promise<void> {
      return backend.unlink(path);
    },

    async stat(path: string): Promise<FileStat> {
      const s = await backend.stat(path);
      // Normalize various stat shapes into FileStat
      return {
        isFile: typeof s.isFile === 'function' ? () => s.isFile() : () => !!(s.mode && !(s.mode & 0o40000)),
        isDirectory: typeof s.isDirectory === 'function' ? () => s.isDirectory() : () => !!(s.mode && (s.mode & 0o40000)),
        size: s.size ?? 0,
        mtimeMs: typeof s.mtimeMs === 'number' ? s.mtimeMs
          : s.mtime ? new Date(s.mtime).getTime()
          : 0,
      };
    },

    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      return backend.mkdir(path, options);
    },

    async exists(path: string): Promise<boolean> {
      return backend.exists(path);
    },
  };
}

// ---------------------------------------------------------------------------
// ZenFS promises → SyncableFS
// ---------------------------------------------------------------------------

/**
 * Wrap a ZenFS fs.promises object into a SyncableFS.
 */
export function zenfsPromisesToSyncableFS(promises: Record<string, any>): SyncableFS {
  return {
    async readdir(path: string): Promise<string[]> {
      const entries = await promises.readdir(path);
      // ZenFS readdir may return Dirent[] or string[]
      return entries.map((e: any) => typeof e === 'string' ? e : e.name);
    },

    async readFile(path: string, encoding?: BufferEncoding): Promise<any> {
      if (encoding) {
        return promises.readFile(path, encoding);
      }
      return promises.readFile(path);
    },

    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      return promises.writeFile(path, data);
    },

    async unlink(path: string): Promise<void> {
      return promises.unlink(path);
    },

    async stat(path: string): Promise<FileStat> {
      const s = await promises.stat(path);
      return {
        isFile: () => s.isFile(),
        isDirectory: () => s.isDirectory(),
        size: s.size,
        mtimeMs: s.mtimeMs,
      };
    },

    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      return promises.mkdir(path, options);
    },

    async exists(path: string): Promise<boolean> {
      try {
        await promises.stat(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// CachedFileSystem → SyncableFS
// ---------------------------------------------------------------------------

/**
 * Wrap a CachedFileSystem from zen-fs-cache into a SyncableFS.
 * CachedFileSystem's readFile returns Uint8Array.
 */
export function cachedFSToSyncableFS(cached: any): SyncableFS {
  return {
    async readdir(path: string): Promise<string[]> {
      return cached.readdir(path);
    },

    async readFile(path: string, encoding?: BufferEncoding): Promise<any> {
      const data = await cached.readFile(path);
      if (encoding) {
        if (typeof data === 'string') return data;
        return new TextDecoder().decode(
          data instanceof ArrayBuffer ? new Uint8Array(data) : data,
        );
      }
      if (typeof data === 'string') return Buffer.from(data);
      if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
      return Buffer.from(data);
    },

    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      return cached.writeFile(path, data);
    },

    async unlink(path: string): Promise<void> {
      return cached.unlink(path);
    },

    async stat(path: string): Promise<FileStat> {
      const s = await cached.stat(path);
      // CachedFileSystem may return a deserialized JSON object (no methods)
      // or a fresh stat object with isFile/isDirectory as functions or booleans.
      const isDir = typeof s.isDirectory === 'function'
        ? s.isDirectory()
        : typeof s.isDirectory === 'boolean'
          ? s.isDirectory
          : (s.mode !== undefined && ((s.mode as number) & 0o170000) === 0o040000);
      return {
        isFile: () => !isDir,
        isDirectory: () => isDir,
        size: s.size,
        mtimeMs: s.mtimeMs ?? s.mtime,
      };
    },

    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      return cached.mkdir(path, options);
    },

    async exists(path: string): Promise<boolean> {
      return cached.exists(path);
    },
  };
}