/**
 * zen-fs-config — Backend Registry
 *
 * A pluggable registry that maps backend type names to factory functions.
 *
 * Core principle: zen-fs-config does NOT hardcode every ZenFS backend.
 * Instead, it provides:
 *   1. A simple registry API (registerBackend, createBackend, etc.)
 *   2. Two built-in backends (InMemory + IndexedDB) — zero extra config
 *   3. A wrapZenFSFileSystem() helper to adapt any ZenFS FileSystem
 *      implementation into the BackendInstance interface
 *
 * Applications (like zen-fs-config-admin) register whatever backends
 * they need at startup.  Adding a new backend never requires changing
 * zen-fs-config itself.
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
  /** Optional: dispose backend resources (close connections, etc.) */
  dispose?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Backend Metadata (for dynamic UI form generation)
// ---------------------------------------------------------------------------

/** A single parameter field definition for a backend type. */
export interface BackendParamDef {
  /** Option key (maps to BackendDescriptor.options[key]). */
  key: string;
  /** Human-readable label for the UI form. */
  label: string;
  /** Input type: text, password (masked), or select (dropdown). */
  type: 'text' | 'password' | 'select';
  /** Placeholder text for text/password inputs. */
  placeholder?: string;
  /** Whether the field is required. */
  required?: boolean;
  /** Options for select type. */
  options?: { value: string; label: string }[];
}

/** Metadata describing a registered backend type (for UI form generation). */
export interface BackendMetadata {
  /** Backend type name (matches the registry key). */
  type: string;
  /** Human-readable label. */
  label: string;
  /** Emoji or icon identifier. */
  icon: string;
  /** Parameter field definitions. */
  fields: BackendParamDef[];
  /** Default option values (merged into the form's initial state). */
  defaultOptions: Record<string, string>;
  /**
   * Fields that represent account credentials (e.g., token, owner, baseUrl).
   * Used by data-sync groups to reuse account info from a config-sync backend.
   * Fields not listed here are considered "storage location" fields.
   */
  accountFields?: string[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, BackendFactory>();
const metadataRegistry = new Map<string, BackendMetadata>();

export function registerBackend(type: string, factory: BackendFactory, metadata?: BackendMetadata): void {
  registry.set(type, factory);
  if (metadata) {
    metadataRegistry.set(type, metadata);
  }
}

export function unregisterBackend(type: string): boolean {
  metadataRegistry.delete(type);
  return registry.delete(type);
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

/** Get metadata for a specific backend type. Returns undefined if not registered or no metadata. */
export function getBackendMetadata(type: string): BackendMetadata | undefined {
  return metadataRegistry.get(type);
}

/** List all backend types that have registered metadata. Used for dynamic form generation. */
export function listBackendMetadata(): BackendMetadata[] {
  return Array.from(metadataRegistry.values());
}

/**
 * Get the set of account field names for a backend type.
 * Falls back to an empty array if the backend has no accountFields metadata.
 */
export function getAccountFields(type: string): string[] {
  return metadataRegistry.get(type)?.accountFields ?? [];
}

/**
 * Merge account fields from a source backend's options into a target options object.
 * Only fields listed in the backend type's `accountFields` metadata are copied.
 * If a field already exists in target options, it is NOT overwritten.
 */
export function mergeAccountFields(
  targetType: string,
  sourceOptions: Record<string, unknown>,
  targetOptions: Record<string, unknown>,
): Record<string, unknown> {
  const accountFields = getAccountFields(targetType);
  if (accountFields.length === 0) return targetOptions;
  const merged: Record<string, unknown> = { ...targetOptions };
  for (const field of accountFields) {
    if (sourceOptions[field] !== undefined && merged[field] === undefined) {
      merged[field] = sourceOptions[field];
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Helper: wrap a ZenFS FileSystem into a BackendInstance
//
// Uses resolveMountConfig to create an ISOLATED fs — does NOT touch the
// global ZenFS VFS (configureSingle). This is critical because multiple
// backends must coexist without overwriting each other.
//
// Exported so that external backend packages can reuse this adapter
// instead of reimplementing the Node.js-style API bridge.
// ---------------------------------------------------------------------------

export async function wrapZenFSFileSystem(config: any): Promise<BackendInstance> {
  const zenfs = await import('@zenfs/core');
  const isolatedFS = await zenfs.resolveMountConfig(config);

  // --- onChange 推送：本地写入时通知 sync 引擎 ---
  let changeCallback: (() => void) | null = null;

  const notifyChange = (): void => {
    if (changeCallback) changeCallback();
  };

  const backend: BackendInstance = {
    async readFile(path: string, ...args: any[]): Promise<any> {
      const st = await isolatedFS.stat(path);
      const size = st.size;
      const buf = new Uint8Array(size);
      await isolatedFS.read(path, buf, 0, size);
      if (args[0] === 'utf-8') return new TextDecoder().decode(buf);
      return buf;
    },
    async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, _options?: any): Promise<void> {
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : data instanceof Uint8Array
          ? data
          : new TextEncoder().encode(data);
      // Ensure parent dir exists
      const parts = path.split('/').filter(Boolean);
      parts.pop();
      let dir = '';
      for (const p of parts) {
        dir += '/' + p;
        if (!(await isolatedFS.exists(dir))) {
          await isolatedFS.mkdir(dir, { uid: 0, gid: 0, mode: 0o755 });
        }
      }
      if (!(await isolatedFS.exists(path))) {
        await isolatedFS.createFile(path, { uid: 0, gid: 0, mode: 0o644 });
      }
      await isolatedFS.write(path, bytes, 0);
      // touch updates local Inode metadata (size/mtime). Some backends (e.g.
      // RemoteStorage) don't support touch and throw — that's fine since their
      // metadata is server-managed, so we silently ignore the error.
      try {
        await isolatedFS.touch(path, { size: bytes.byteLength, mtimeMs: Date.now() });
      } catch { /* backend doesn't support touch — metadata is server-managed */ }
      // 通知 sync 引擎：本地有变更
      notifyChange();
    },
    async readdir(path: string): Promise<string[]> {
      return isolatedFS.readdir(path);
    },
    async stat(path: string, ..._args: any[]): Promise<any> {
      const st = await isolatedFS.stat(path);
      return {
        mode: typeof st.mode === 'number' ? st.mode : undefined,
        size: st.size,
        mtimeMs: (st as any).mtimeMs ?? (st as any).mtime ?? 0,
      };
    },
    async exists(path: string): Promise<boolean> {
      return isolatedFS.exists(path);
    },
    async mkdir(path: string, options?: any): Promise<any> {
      return isolatedFS.mkdir(path, options ?? { uid: 0, gid: 0, mode: 0o755 });
    },
    async unlink(path: string): Promise<void> {
      await isolatedFS.unlink(path);
      // 通知 sync 引擎：本地有变更
      notifyChange();
    },
    async rmdir(path: string): Promise<void> {
      return isolatedFS.rmdir(path);
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      await isolatedFS.rename(oldPath, newPath);
      // 通知 sync 引擎：本地有变更
      notifyChange();
    },
  };

  // 挂载 onChange 方法，供 sync 引擎注册回调
  (backend as any).onChange = (callback: () => void): void => {
    changeCallback = callback;
  };

  // 透传 createSnapshot（如底层 ZenFS FS 实现了此方法）
  if (typeof (isolatedFS as any).createSnapshot === 'function') {
    (backend as any).createSnapshot = (root: string, filter?: any) =>
      (isolatedFS as any).createSnapshot(root, filter);
  }

  // 透传 writeFileWithMtime（如底层 ZenFS FS 实现了此方法）
  if (typeof (isolatedFS as any).writeFileWithMtime === 'function') {
    (backend as any).writeFileWithMtime = (path: string, data: string | Uint8Array, mtimeMs: number) =>
      (isolatedFS as any).writeFileWithMtime(path, data, mtimeMs);
  }

  return backend;
}

// ---------------------------------------------------------------------------
// Built-in: InMemory
//
// No extra dependencies beyond @zenfs/core (which is a peer dep anyway).
// ---------------------------------------------------------------------------

let inMemoryCounter = 0;

registerBackend('InMemory', async (options) => {
  const { InMemory } = await import('@zenfs/core');

  const maxSize = (options.maxSize as number) ?? 100 * 1024 * 1024;
  const label = (options.label as string) ?? `zen-fs-config-${++inMemoryCounter}`;

  return wrapZenFSFileSystem({ backend: InMemory, maxSize, label });
}, {
  type: 'InMemory',
  label: 'InMemory',
  icon: '\u{1F9E0}',
  fields: [
    { key: 'maxSize', label: 'Max Size (bytes)', type: 'text', placeholder: '104857600' },
    { key: 'label', label: 'Label', type: 'text', placeholder: 'zen-fs-config-1' },
  ],
  defaultOptions: { maxSize: '', label: '' },
});

// ---------------------------------------------------------------------------
// Built-in: IndexedDB (browser)
//
// Used as the default local primary backend for offline-first operation.
// Requires @zenfs/dom (optional peer dependency). In Node.js environments
// where @zenfs/dom is not available, this backend will fail at creation
// time with a clear error message.
// ---------------------------------------------------------------------------

registerBackend('IndexedDB', async (options) => {
  const { IndexedDB } = await import('@zenfs/dom');

  const storeName = (options.storeName as string) ?? 'zen-fs-config';
  const label = (options.label as string) ?? storeName;

  return wrapZenFSFileSystem({ backend: IndexedDB, storeName, label });
}, {
  type: 'IndexedDB',
  label: 'IndexedDB',
  icon: '\u{1F4BE}',
  fields: [
    { key: 'storeName', label: 'Store Name', type: 'text', placeholder: 'zen-fs-config' },
  ],
  defaultOptions: { storeName: '' },
});
