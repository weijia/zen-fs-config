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

/**
 * A factory function that creates a file system instance from options.
 * The returned value must satisfy SyncableFS (and ideally CacheableFileSystem).
 */
export type BackendFactory = (
  options: Record<string, unknown>,
) => Promise<BackendInstance>;

/**
 * The minimal interface a backend instance must satisfy.
 * Combines SyncableFS (from zen-fs-sync) with the write signature
 * needed by CachedFileSystem.
 */
export interface BackendInstance {
  readFile(path: string, ...args: any[]): Promise<any>;
  writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: any): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string, ...args: any[]): Promise<any>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: any): Promise<any>;
  unlink(path: string): Promise<void>;
  rmdir?(path: string): Promise<void>;
  rename?(oldPath: string, newPath: string): Promise<void>;
  readFileMeta?(path: string, opts?: any): Promise<any>;
  getRevision?(path: string): Promise<string | number | undefined>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, BackendFactory>();

/**
 * Register a backend factory by type name.
 */
export function registerBackend(type: string, factory: BackendFactory): void {
  registry.set(type, factory);
}

/**
 * Create a backend instance from a descriptor.
 */
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
  const instance = await factory(descriptor.options);
  // Ensure rmdir exists (required by CacheableFileSystem)
  if (!instance.rmdir) {
    instance.rmdir = async (_path: string) => {
      // No-op by default; backends that need it should implement it
    };
  }
  return instance;
}

/**
 * Check if a backend type is registered.
 */
export function hasBackend(type: string): boolean {
  return registry.has(type);
}

/**
 * List all registered backend type names.
 */
export function listBackends(): string[] {
  return Array.from(registry.keys());
}

// ---------------------------------------------------------------------------
// Built-in: InMemory Backend
// ---------------------------------------------------------------------------

registerBackend('InMemory', async (options) => {
  // Dynamic import to keep @zenfs/core as a peer dependency
  const { InMemory } = await import('@zenfs/core');
  const maxSize = (options.maxSize as number) ?? 100 * 1024 * 1024; // 100MB default
  const label = (options.label as string) ?? 'zen-fs-config';
  return InMemory.create({ maxSize, label }) as unknown as BackendInstance;
});