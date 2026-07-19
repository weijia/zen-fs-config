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
 * Wrap ZenFS fs.promises into a BackendInstance.
 *
 * ZenFS backends (StoreFS) use their own internal API (write, stat, mkdir, …).
 * CachedFileSystem needs Node.js-style async API (readFile, writeFile, …).
 * ZenFS provides the Node.js compat layer via `fs.promises` from `@zenfs/core`,
 * but only *after* a backend is configured via `configureSingle`.
 *
 * We isolate each backend into a separate ZenFS instance using Port/Worker,
 * but for InMemory (sync) the simplest approach is to configure VFS once
 * and use fs.promises.
 *
 * To support multiple InMemory instances, we use a counter to create
 * unique Port channels.
 */
let inMemoryCounter = 0;

registerBackend('InMemory', async (options) => {
  const zenfs = await import('@zenfs/core');
  const { InMemory } = zenfs;

  const maxSize = (options.maxSize as number) ?? 100 * 1024 * 1024;
  const label = (options.label as string) ?? `zen-fs-config-${++inMemoryCounter}`;

  // configureSingle sets up the global ZenFS VFS with the given backend.
  // It returns void — the configured fs is accessed via the `fs` re-export.
  await zenfs.configureSingle({ backend: InMemory, maxSize, label });

  // fs.promises has Node.js-style async API: readFile, writeFile, etc.
  const pfs = (zenfs.fs as any).promises;

  const backend: BackendInstance = {
    async readFile(path: string, ...args: any[]): Promise<any> {
      // ZenFS fs.promises.readFile supports (path, encoding) and (path, options)
      if (args.length > 0) {
        return pfs.readFile(path, ...args);
      }
      return pfs.readFile(path);
    },
    async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: any): Promise<void> {
      return pfs.writeFile(path, data, options);
    },
    async readdir(path: string): Promise<string[]> {
      const entries = await pfs.readdir(path);
      return entries.map((e: any) => typeof e === 'string' ? e : e.name);
    },
    async stat(path: string, ...args: any[]): Promise<any> {
      return pfs.stat(path, ...args);
    },
    async exists(path: string): Promise<boolean> {
      try { await pfs.stat(path); return true; } catch { return false; }
    },
    async mkdir(path: string, options?: any): Promise<any> {
      return pfs.mkdir(path, options);
    },
    async unlink(path: string): Promise<void> {
      return pfs.unlink(path);
    },
    async rmdir(path: string): Promise<void> {
      return pfs.rmdir(path);
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      return pfs.rename(oldPath, newPath);
    },
  };

  return backend;
});