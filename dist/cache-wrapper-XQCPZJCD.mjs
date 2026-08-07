// src/cache-wrapper.ts
import { CachedFileSystem, IdbCacheStore, MemoryCacheStore } from "zen-fs-cache";
function wrapWithCache(backend, backendId, options) {
  const storeType = options.storeType ?? "IdbCacheStore";
  const prefix = options.storePrefix ?? `zen-fs-config:${backendId}:`;
  let store;
  if (storeType === "IdbCacheStore") {
    store = new IdbCacheStore(prefix);
  } else {
    store = new MemoryCacheStore();
  }
  const wrapped = new CachedFileSystem(backend, store, {
    ttlMs: options.ttlMs ?? 0
  });
  if (typeof backend.shouldSync === "function") {
    wrapped.shouldSync = (...args) => backend.shouldSync(...args);
  }
  return wrapped;
}
export {
  wrapWithCache
};
