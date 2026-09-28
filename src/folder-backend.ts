/**
 * zen-fs-config — Folder backend (Node.js local persistent store)
 *
 * zenfs core only ships `InMemory` (and `IndexedDB` via `@zenfs/dom` for
 * browsers). There is NO built-in persistent backend for Node.js, so this
 * module implements one:
 *
 *   - `FolderStore`: a `SyncMapStore` that persists each key as a file under a
 *     directory on disk.
 *   - Registered as backend type `"Folder"`, wrapping the store in `StoreFS`.
 *
 * `node:fs` / `node:path` are loaded via **dynamic import** inside the backend
 * factory so that importing this module (e.g. in a browser bundle) never pulls
 * Node built-ins into the static graph — the Folder backend is simply never
 * selected in a browser (see `resolveLocalPrimary`).
 */

import { registerBackend } from './backend-registry';
import { SyncMapStore, SyncMapTransaction, StoreFS } from '@zenfs/core';
import { createLogger } from './logger';

const log = createLogger('folder-backend');

export interface FolderStoreInit {
  path: string;
  label?: string;
  fs: typeof import('node:fs');
  pathMod: typeof import('node:path');
}

/**
 * A `SyncMapStore` backed by the local filesystem: every key (an inode number)
 * is a file under `path`. Fully synchronous, matching zenfs' `SyncMapStore`
 * contract (used by `StoreFS`).
 */
export class FolderStore implements SyncMapStore {
  readonly name = 'folder';
  readonly label?: string;
  readonly flags = [] as const;
  private dir: string;
  private fsApi: typeof import('node:fs');
  private pathMod: typeof import('node:path');

  constructor(init: FolderStoreInit) {
    this.dir = init.path;
    this.label = init.label;
    this.fsApi = init.fs;
    this.pathMod = init.pathMod;
    this.fsApi.mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(id: number): string {
    return this.pathMod.join(this.dir, String(id));
  }

  keys(): Iterable<number> {
    let entries: string[];
    try {
      entries = this.fsApi.readdirSync(this.dir);
    } catch {
      return [];
    }
    const ids: number[] = [];
    for (const name of entries) {
      if (/^\d+$/.test(name)) ids.push(Number(name));
    }
    return ids;
  }

  get(id: number): Uint8Array | undefined {
    try {
      return this.fsApi.readFileSync(this.fileFor(id));
    } catch {
      return undefined;
    }
  }

  async getAsync(id: number): Promise<Uint8Array | undefined> {
    return this.get(id);
  }

  set(id: number, data: Uint8Array): void {
    this.fsApi.writeFileSync(this.fileFor(id), data);
  }

  delete(id: number): void {
    try {
      this.fsApi.rmSync(this.fileFor(id));
    } catch {
      /* already removed */
    }
  }

  transaction(): SyncMapTransaction {
    return new SyncMapTransaction(this);
  }

  async sync(): Promise<void> {
    /* file writes are already durable */
  }
}

async function createFolderStore(options: { path: string; label?: string }): Promise<FolderStore> {
  const fs = await import('node:fs');
  const pathMod = await import('node:path');
  return new FolderStore({ path: options.path, label: options.label, fs, pathMod });
}

/**
 * ZenFS backend descriptor consumed by `wrapZenFSFileSystem` →
 * `resolveMountConfig` (which awaits `create`).
 */
const FolderBackend: any = {
  name: 'Folder',
  options: {
    path: { type: 'string', required: true },
    label: { type: 'string', required: false },
  },
  create: async (opts: { path: string; label?: string }) =>
    new StoreFS(await createFolderStore(opts)),
};

/** Register the Folder backend. Safe to call multiple times. */
export function registerFolderBackend(): void {
  registerBackend(
    'Folder',
    async (options) => {
      const fs = await import('node:fs');
      const pathMod = await import('node:path');
      const dir = options.path as string;
      const store = new FolderStore({ path: dir, label: options.label as string | undefined, fs, pathMod });
      return (await import('./backend-registry')).wrapZenFSFileSystem({ backend: FolderBackend, path: dir, label: options.label });
    },
    {
      type: 'Folder',
      label: 'Folder (Node.js local)',
      icon: '\u{1F4C1}',
      fields: [{ key: 'path', label: 'Directory Path', type: 'text', placeholder: '/path/to/store' }],
      defaultOptions: { path: '' },
    },
  );
  log('Folder backend registered');
}

// Self-register on import (mirrors InMemory / IndexedDB built-ins).
registerFolderBackend();

// ---------------------------------------------------------------------------
// Local primary selection (T2): browser → IndexedDB, Node → Folder
// ---------------------------------------------------------------------------

/** True when running in a browser environment that provides IndexedDB. */
export function isBrowserEnv(): boolean {
  return typeof (globalThis as any).indexedDB !== 'undefined';
}

export interface LocalPrimaryOptions {
  idbStoreName?: string;
  folderPath?: string;
}

/**
 * Resolve the local primary backend descriptor for the current environment.
 *
 * - Browser: `{ type: 'IndexedDB', options: { storeName } }`
 * - Node.js: persistent `{ type: 'Folder', options: { path, label } }` **when
 *   persistence is opted in** via `opts.folderPath` or the `ZEN_FS_CONFIG_HOME`
 *   env var; otherwise falls back to an in-memory local primary (backward
 *   compatible, no on-disk state).
 *
 * Opting into Folder keeps the local store durable across restarts, so the
 * group can be reopened with only `appId` (decision B / T1).
 */
export async function resolveLocalPrimary(
  appId: string,
  kind: 'config' | 'data',
  opts: LocalPrimaryOptions = {},
): Promise<{ type: string; options: Record<string, unknown> }> {
  if (isBrowserEnv()) {
    const storeName = opts.idbStoreName || `zen-fs-config-${kind}-${appId}`;
    return { type: 'IndexedDB', options: { storeName } };
  }
  const label = `zen-fs-config-${kind}-${appId}`;
  if (opts.folderPath || process.env.ZEN_FS_CONFIG_HOME) {
    const dir = opts.folderPath || (await defaultNodeDir(appId, kind));
    return { type: 'Folder', options: { path: dir, label } };
  }
  // Backward-compatible default on Node: in-memory (no persistence)
  return { type: 'InMemory', options: { label: `${label}-${Date.now()}` } };
}

/** The backend type used for the implicit local primary in the current env (default). */
export function localPrimaryType(): string {
  if (isBrowserEnv()) return 'IndexedDB';
  return process.env.ZEN_FS_CONFIG_HOME ? 'Folder' : 'InMemory';
}

async function defaultNodeDir(appId: string, kind: 'config' | 'data'): Promise<string> {
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const base =
    process.env.ZEN_FS_CONFIG_HOME ||
    (process.env.VITEST || process.env.NODE_ENV === 'test'
      ? pathMod.join(os.tmpdir(), 'zen-fs-config-tests')
      : pathMod.join(os.homedir(), '.zen-fs-config'));
  return pathMod.join(base, kind, appId);
}
