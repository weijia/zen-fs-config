/**
 * zen-fs-config — Backend Registry
 *
 * A pluggable registry that maps backend type names to factory functions.
 * Built-in support for ZenFS backends (InMemory, IndexedDB, etc.)
 * loaded from @zenfs/core.
 *
 * Users can register custom backends via `registerBackend()`.
 */

import type { BackendDescriptor } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackendFactory = (
  options: Record<string, unknown>,
) => Promise<BackendInstance>;

/**
 * The minimal interface a backend instance must satisfy.
 * Matches zen-fs-cache's CacheableFileSystem requirements.
 */
export interface BackendInstance {
  readFile(path: string, ...args: any[]): Promise<any>;
  writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: any): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string, ...args: any[]): Promise<any>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: any): Promise<any>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  rename?(oldPath: string, newPath: string): Promise<void>;
  readFileMeta?(path: string, opts?: any): Promise<any>;
  getRevision?(path: string): Promise<string | number | undefined>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, BackendFactory>();

export function registerBackend(type: string, factory: BackendFactory): void {
  registry.set(type, factory);
}

export async function createBackend(
  descriptor: Pick<BackendDescriptor, 'type' | 'options'>,
): Promise<BackendInstance> {
  const factory = registry.get(descriptor.type);
  if (!factory) {
    throw new Error(
      `Unknown backend type: "${descriptor.type}". ` +
      `Available types: ${Array.from(registry.keys()).join(', ')}. ` +
      `Use registerBackend() to register a custom backend.`,
    );
  }
  return factory(descriptor.options);
}

export function hasBackend(type: string): boolean {
  return registry.has(type);
}

export function listBackends(): string[] {
  return Array.from(registry.keys());
}

// ---------------------------------------------------------------------------
// Built-in: InMemory Backend
// ---------------------------------------------------------------------------

/**
 * Wrap a synchronous ZenFS FileSystem into an async BackendInstance.
 * ZenFS backends (InMemory, etc.) use sync methods (writeFile, readdir, …).
 * CachedFileSystem requires async methods. This adapter bridges the gap.
 */
function syncToAsync(backend: any): BackendInstance {
  return {
    readFile(path: string, ...args: any[]): Promise<any> {
      const result = backend.readFile(path, ...args);
      return Promise.resolve(result);
    },
    writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: any): Promise<void> {
      backend.writeFile(path, data, options);
      return Promise.resolve();
    },
    readdir(path: string): Promise<string[]> {
      const entries: any[] = backend.readdir(path);
      // ZenFS may return string[] or Dirent[]
      return Promise.resolve(entries.map((e: any) => typeof e === 'string' ? e : e.name));
    },
    stat(path: string, ...args: any[]): Promise<any> {
      return Promise.resolve(backend.stat(path, ...args));
    },
    exists(path: string): Promise<boolean> {
      try {
        backend.stat(path);
        return Promise.resolve(true);
      } catch {
        return Promise.resolve(false);
      }
    },
    mkdir(path: string, options?: any): Promise<any> {
      backend.mkdir(path, options);
      return Promise.resolve();
    },
    unlink(path: string): Promise<void> {
      backend.unlink(path);
      return Promise.resolve();
    },
    rmdir(path: string): Promise<void> {
      if (typeof backend.rmdir === 'function') {
        backend.rmdir(path);
      }
      return Promise.resolve();
    },
    rename(oldPath: string, newPath: string): Promise<void> {
      if (typeof backend.rename === 'function') {
        backend.rename(oldPath, newPath);
      }
      return Promise.resolve();
    },
  };
}

registerBackend('InMemory', async (options) => {
  const { InMemory } = await import('@zenfs/core');
  const maxSize = (options.maxSize as number) ?? 100 * 1024 * 1024;
  const label = (options.label as string) ?? 'zen-fs-config';

  // InMemory.create() returns a synchronous StoreFS<InMemoryStore>
  const fs = InMemory.create({ maxSize, label });

  // Wrap sync → async so CachedFileSystem can use it
  return syncToAsync(fs);
});