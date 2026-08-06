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

  return new CachedFileSystem(backend, store, {
    ttlMs: options.ttlMs ?? 0,
  });
}
