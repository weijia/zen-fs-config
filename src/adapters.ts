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
export function backendToSyncableFS(backend: BackendInstance, name?: string): SyncableFS {
  const syncable: SyncableFS = {
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
      // Directly pass through mode/size/mtimeMs — zen-fs-sync now uses mode to detect type
      return {
        mode: typeof s.mode === 'number' ? s.mode : undefined,
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

  // Set backendName for zen-fs-sync logging
  if (name) {
    syncable.backendName = name;
  } else if ((backend as any).backendName) {
    syncable.backendName = (backend as any).backendName;
  } else {
    syncable.backendName = (backend.constructor as any).name || 'Backend';
  }

  return syncable;
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
        mode: typeof s.mode === 'number' ? s.mode : undefined,
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
export function cachedFSToSyncableFS(cached: any, name?: string): SyncableFS {
  const syncable: SyncableFS = {
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
      // CachedFileSystem may return a deserialized JSON object (no methods).
      // zen-fs-sync now uses mode directly, so we just pass it through.
      return {
        mode: typeof s.mode === 'number' ? s.mode : undefined,
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

  syncable.backendName = name || 'CachedFS';
  return syncable;
}