/**
 * Cache wrapper — wraps a replica backend with `CachedFileSystem` from
 * `zen-fs-cache`, using an IndexedDB-backed (or memory-backed) `CacheStore`.
 *
 * The cache is applied to **replica backends only** (Gitee, RemoteStorage,
 * etc.), not the local IndexedDB primary (which is already local storage and
 * would not benefit from a second IndexedDB layer).
 *
 * When the backend implements `getRevision` (e.g. GiteeFS returns Git blob
 * SHA from memory, RemoteStorageFileSystem returns HTTP ETag via HEAD),
 * the cache achieves zero-download revalidation: on each read, it compares
 * the stored revision token with the backend's current one — if they match,
 * the cached content is returned without any network transfer.
 */

import { CachedFileSystem, IdbCacheStore, MemoryCacheStore } from 'zen-fs-cache';
import type { CacheOptions } from './types';

/**
 * Wrap a backend instance with `CachedFileSystem`.
 *
 * @param backend  The raw backend instance (e.g. GiteeFS, RemoteStorageFileSystem)
 * @param backendId  Backend identifier — used in the cache key prefix for isolation
 * @param options  Cache configuration (storeType, storePrefix, ttlMs)
 * @returns The wrapped `CachedFileSystem` instance
 */
export function wrapWithCache(
  backend: any,
  backendId: string,
  options: CacheOptions,
): CachedFileSystem {
  const storeType = options.storeType ?? 'IdbCacheStore';
  const prefix = options.storePrefix ?? `zen-fs-config:${backendId}:`;

  let store;
  if (storeType === 'IdbCacheStore') {
    store = new IdbCacheStore(prefix);
  } else {
    store = new MemoryCacheStore();
  }

  // Best-effort: remove any cached `.keep` placeholder entries left over from a
  // prior build that cached backend-internal `.keep` files. The cache store is
  // created fresh on each sync setup (startup), so this runs once per replica
  // and is a harmless no-op when there are none. Fire-and-forget: `wrapWithCache`
  // is synchronous, and the deletes are best-effort anyway.
  try {
    const purge = (store as { purgeKeepFiles?: () => Promise<unknown> }).purgeKeepFiles?.();
    if (purge && typeof (purge as Promise<unknown>).catch === 'function') {
      (purge as Promise<unknown>).catch(() => {});
    }
  } catch {
    // best-effort
  }

  const wrapped = new CachedFileSystem(backend, store, {
    ttlMs: options.ttlMs ?? 0,
  });

  // Pass through shouldSync from the underlying backend.
  // CachedFileSystem does not implement this itself, but the sync engine
  // relies on it to skip unnecessary full syncs (see zen-fs-sync onPoll).
  if (typeof backend.shouldSync === 'function') {
    (wrapped as any).shouldSync = (...args: any[]) => backend.shouldSync(...args);
  }

  // Pass through writeFileWithMtime from the underlying backend.
  // CachedFileSystem does not implement this itself; without it the sync
  // engine silently falls back to plain writeFile (losing the atomic
  // data+sidecar write and the mtimeCache refresh that e.g. GiteeFS
  // .writeFileWithMtime provides). Forward it so mtime preservation uses
  // the intended path instead of the eager-cache write() fallback.
  if (typeof backend.writeFileWithMtime === 'function') {
    (wrapped as any).writeFileWithMtime = (
      path: string,
      data: string | Uint8Array,
      mtimeMs: number,
    ) => backend.writeFileWithMtime(path, data, mtimeMs);
  }

  return wrapped;
}
