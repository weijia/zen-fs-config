// src/config-repo.ts
import {
  ZenFSSync,
  SyncDirection
} from "zen-fs-sync";

// src/serializer.ts
var JSON_SERIALIZER = {
  serialize(data) {
    return new TextEncoder().encode(JSON.stringify(data, null, 2));
  },
  deserialize(raw) {
    return JSON.parse(new TextDecoder().decode(raw));
  },
  canHandle(path) {
    return path.endsWith(".json");
  }
};
var TEXT_SERIALIZER = {
  serialize(data) {
    return new TextEncoder().encode(String(data));
  },
  deserialize(raw) {
    return new TextDecoder().decode(raw);
  },
  canHandle(path) {
    const ext = getExtension(path);
    return ext === "" || ext === ".txt" || ext === ".md" || ext === ".log";
  }
};
var DEFAULT_SERIALIZERS = [JSON_SERIALIZER, TEXT_SERIALIZER];
function createSerializerChain(custom) {
  const chain = custom ? [custom, ...DEFAULT_SERIALIZERS] : [...DEFAULT_SERIALIZERS];
  return {
    serialize(data, path) {
      if (path) {
        for (const s of chain) {
          if (s.canHandle(path)) return s.serialize(data);
        }
      }
      return JSON_SERIALIZER.serialize(data);
    },
    deserialize(raw, path) {
      if (path) {
        for (const s of chain) {
          if (s.canHandle(path)) return s.deserialize(raw, path);
        }
      }
      return JSON_SERIALIZER.deserialize(raw, path ?? "");
    },
    canHandle(path) {
      return chain.some((s) => s.canHandle(path));
    }
  };
}
function configKeyToFilePath(configPath) {
  const ext = getExtension(configPath);
  if (ext !== "") return configPath;
  return configPath.endsWith("/") ? configPath : `${configPath}.json`;
}
function getExtension(path) {
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  if (lastDot > lastSlash && lastDot < path.length - 1) {
    return path.slice(lastDot);
  }
  return "";
}

// src/context-fs.ts
function resolveChroot(root, userPath) {
  let p = userPath.replace(/\\/g, "/");
  if (p.startsWith("/")) p = p.slice(1);
  const parts = p.split("/").filter(Boolean);
  const resolved = [];
  for (const part of parts) {
    if (part === "..") {
      if (resolved.length > 0) resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }
  const joined = resolved.join("/");
  return root === "/" ? `/${joined}` : `${root}/${joined}`;
}
function createChrootFS(inner, root) {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  function rp(path) {
    return resolveChroot(normalizedRoot, path);
  }
  const promises = {
    async readFile(path, encoding) {
      return inner.readFile(rp(path), encoding);
    },
    async writeFile(path, data, options) {
      await ensureParentDir(rp(path));
      return inner.writeFile(rp(path), data, options);
    },
    async readdir(path) {
      return inner.readdir(rp(path));
    },
    async stat(path) {
      const s = await inner.stat(rp(path));
      return {
        mode: typeof s.mode === "number" ? s.mode : void 0,
        size: s.size ?? 0,
        mtimeMs: s.mtimeMs ?? s.mtime ?? 0
      };
    },
    async access(path) {
      const exists = await inner.exists(rp(path));
      if (!exists) {
        const err = new Error(`ENOENT: no such file or directory, access '${path}'`);
        err.code = "ENOENT";
        throw err;
      }
    },
    async mkdir(path, options) {
      return inner.mkdir(rp(path), options);
    },
    async unlink(path) {
      return inner.unlink(rp(path));
    },
    async rmdir(path) {
      return inner.rmdir?.(rp(path));
    },
    async rename(oldPath, newPath) {
      return inner.rename?.(rp(oldPath), rp(newPath));
    },
    async exists(path) {
      return inner.exists(rp(path));
    }
  };
  const syncFs = {
    readFileSync(path, encoding) {
      throw new Error(
        "zen-fs-config: readFileSync is not supported. Use repo.fs.promises.readFile() or repo.getConfig() instead."
      );
    },
    writeFileSync(path, data, options) {
      promises.writeFile(path, data, options).catch(() => {
      });
    },
    existsSync(path) {
      throw new Error(
        "zen-fs-config: existsSync is not supported. Use repo.fs.promises.exists() instead."
      );
    },
    mkdirSync(path, options) {
      promises.mkdir(path, options).catch(() => {
      });
    },
    readdirSync(path) {
      throw new Error(
        "zen-fs-config: readdirSync is not supported. Use repo.fs.promises.readdir() instead."
      );
    },
    statSync(path) {
      throw new Error(
        "zen-fs-config: statSync is not supported. Use repo.fs.promises.stat() instead."
      );
    },
    unlinkSync(path) {
      promises.unlink(path).catch(() => {
      });
    },
    promises
  };
  return syncFs;
}
async function ensureParentDir(absolutePath) {
}

// src/adapters.ts
function backendToSyncableFS(backend, name) {
  const syncable = {
    async readdir(path) {
      return backend.readdir(path);
    },
    async readFile(path, encoding) {
      const result = await backend.readFile(path, encoding);
      if (encoding) {
        if (typeof result === "string") return result;
        if (result instanceof Uint8Array) return new TextDecoder().decode(result);
        if (Buffer.isBuffer(result)) return result.toString(encoding);
        return String(result);
      }
      if (typeof result === "string") return Buffer.from(result);
      if (result instanceof Uint8Array) return Buffer.from(result);
      if (Buffer.isBuffer(result)) return result;
      return Buffer.from(String(result));
    },
    async writeFile(path, data) {
      return backend.writeFile(path, data);
    },
    async writeFileWithMtime(path, data, mtime) {
      return backend.writeFile(path, data, { mtime });
    },
    async unlink(path) {
      return backend.unlink(path);
    },
    async stat(path) {
      const s = await backend.stat(path);
      return {
        mode: typeof s.mode === "number" ? s.mode : void 0,
        size: s.size ?? 0,
        mtimeMs: typeof s.mtimeMs === "number" ? s.mtimeMs : s.mtime ? new Date(s.mtime).getTime() : 0
      };
    },
    async mkdir(path, options) {
      return backend.mkdir(path, options);
    },
    async exists(path) {
      return backend.exists(path);
    }
  };
  if (typeof backend.onChange === "function") {
    syncable.onChange = (cb) => backend.onChange(cb);
  }
  if (typeof backend.shouldSync === "function") {
    syncable.shouldSync = () => backend.shouldSync();
  }
  if (typeof backend.checkForUpdates === "function") {
    syncable.checkForUpdates = () => backend.checkForUpdates();
  }
  if (name) {
    syncable.backendName = name;
  } else if (backend.backendName) {
    syncable.backendName = backend.backendName;
  } else {
    syncable.backendName = backend.constructor.name || "Backend";
  }
  return syncable;
}

// src/backend-registry.ts
var registry = /* @__PURE__ */ new Map();
var metadataRegistry = /* @__PURE__ */ new Map();
function registerBackend(type, factory, metadata) {
  registry.set(type, factory);
  if (metadata) {
    metadataRegistry.set(type, metadata);
  }
}
function unregisterBackend(type) {
  metadataRegistry.delete(type);
  return registry.delete(type);
}
async function createBackend(descriptor) {
  const factory = registry.get(descriptor.type);
  if (!factory) {
    throw new Error(
      `Unknown backend type: "${descriptor.type}". Available types: ${Array.from(registry.keys()).join(", ")}. Use registerBackend() to register a custom backend.`
    );
  }
  return factory(descriptor.options);
}
function hasBackend(type) {
  return registry.has(type);
}
function listBackends() {
  return Array.from(registry.keys());
}
function getBackendMetadata(type) {
  return metadataRegistry.get(type);
}
function listBackendMetadata() {
  return Array.from(metadataRegistry.values());
}
function getAccountFields(type) {
  return metadataRegistry.get(type)?.accountFields ?? [];
}
function mergeAccountFields(targetType, sourceOptions, targetOptions) {
  const accountFields = getAccountFields(targetType);
  if (accountFields.length === 0) return targetOptions;
  const merged = { ...targetOptions };
  for (const field of accountFields) {
    if (sourceOptions[field] !== void 0 && merged[field] === void 0) {
      merged[field] = sourceOptions[field];
    }
  }
  return merged;
}
async function wrapZenFSFileSystem(config) {
  const zenfs = await import("@zenfs/core");
  const isolatedFS = await zenfs.resolveMountConfig(config);
  let changeCallback = null;
  const notifyChange = () => {
    if (changeCallback) changeCallback();
  };
  const backend = {
    async readFile(path, ...args) {
      const st = await isolatedFS.stat(path);
      const size = st.size;
      const buf = new Uint8Array(size);
      await isolatedFS.read(path, buf, 0, size);
      if (args[0] === "utf-8") return new TextDecoder().decode(buf);
      return buf;
    },
    async writeFile(path, data, _options) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : new TextEncoder().encode(data);
      const parts = path.split("/").filter(Boolean);
      parts.pop();
      let dir = "";
      for (const p of parts) {
        dir += "/" + p;
        if (!await isolatedFS.exists(dir)) {
          await isolatedFS.mkdir(dir, { uid: 0, gid: 0, mode: 493 });
        }
      }
      if (!await isolatedFS.exists(path)) {
        await isolatedFS.createFile(path, { uid: 0, gid: 0, mode: 420 });
      }
      await isolatedFS.write(path, bytes, 0);
      try {
        await isolatedFS.touch(path, { size: bytes.byteLength, mtimeMs: _options?.mtime ?? Date.now() });
      } catch {
      }
      notifyChange();
    },
    async readdir(path) {
      return isolatedFS.readdir(path);
    },
    async stat(path, ..._args) {
      const st = await isolatedFS.stat(path);
      return {
        mode: typeof st.mode === "number" ? st.mode : void 0,
        size: st.size,
        mtimeMs: st.mtimeMs ?? st.mtime ?? 0
      };
    },
    async exists(path) {
      return isolatedFS.exists(path);
    },
    async mkdir(path, options) {
      return isolatedFS.mkdir(path, options ?? { uid: 0, gid: 0, mode: 493 });
    },
    async unlink(path) {
      await isolatedFS.unlink(path);
      notifyChange();
    },
    async rmdir(path) {
      return isolatedFS.rmdir(path);
    },
    async rename(oldPath, newPath) {
      await isolatedFS.rename(oldPath, newPath);
      notifyChange();
    }
  };
  backend.onChange = (callback) => {
    changeCallback = callback;
  };
  return backend;
}
var inMemoryCounter = 0;
registerBackend("InMemory", async (options) => {
  const { InMemory } = await import("@zenfs/core");
  const maxSize = options.maxSize ?? 100 * 1024 * 1024;
  const label = options.label ?? `zen-fs-config-${++inMemoryCounter}`;
  return wrapZenFSFileSystem({ backend: InMemory, maxSize, label });
}, {
  type: "InMemory",
  label: "InMemory",
  icon: "\u{1F9E0}",
  fields: [
    { key: "maxSize", label: "Max Size (bytes)", type: "text", placeholder: "104857600" },
    { key: "label", label: "Label", type: "text", placeholder: "zen-fs-config-1" }
  ],
  defaultOptions: { maxSize: "", label: "" }
});
registerBackend("IndexedDB", async (options) => {
  const { IndexedDB } = await import("@zenfs/dom");
  const storeName = options.storeName ?? "zen-fs-config";
  const label = options.label ?? storeName;
  return wrapZenFSFileSystem({ backend: IndexedDB, storeName, label });
}, {
  type: "IndexedDB",
  label: "IndexedDB",
  icon: "\u{1F4BE}",
  fields: [
    { key: "storeName", label: "Store Name", type: "text", placeholder: "zen-fs-config" }
  ],
  defaultOptions: { storeName: "" }
});

// src/version.ts
function versionPathFor(configFilePath) {
  const lastSlash = configFilePath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? configFilePath.slice(0, lastSlash) : "";
  const fileName = lastSlash >= 0 ? configFilePath.slice(lastSlash + 1) : configFilePath;
  const versionFileName = `.${fileName}.version`;
  return dir ? `${dir}/${versionFileName}` : versionFileName;
}
async function sha256(data) {
  const buffer = data.byteLength === data.buffer.byteLength ? data.buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (typeof crypto !== "undefined" && typeof crypto.subtle?.digest === "function") {
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    return `sha256:${hex}`;
  }
  if (typeof globalThis.window === "undefined") {
    const nodeCrypto = await new Function("return import('node:crypto')")();
    const hash = nodeCrypto.createHash("sha256").update(Buffer.from(buffer)).digest("hex");
    return `sha256:${hash}`;
  }
  throw new Error("SHA-256 not available: neither Web Crypto nor Node.js crypto module found");
}
async function readVersion(fs, versionFilePath) {
  try {
    const content = await fs.readFile(versionFilePath, "utf-8");
    const parsed = JSON.parse(content);
    if (typeof parsed.version === "number" && typeof parsed.hash === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
async function writeVersion(fs, versionFilePath, meta) {
  const content = JSON.stringify(meta, null, 2);
  await fs.writeFile(versionFilePath, new TextEncoder().encode(content));
}
async function incrementVersion(fs, configFilePath, newContent, author) {
  const vPath = versionPathFor(configFilePath);
  const prev = await readVersion(fs, vPath);
  const hash = await sha256(newContent);
  return {
    version: (prev?.version ?? 0) + 1,
    hash,
    author,
    timestamp: Date.now()
  };
}
async function verifyOrRepairVersion(fs, configFilePath, author) {
  const vPath = versionPathFor(configFilePath);
  const existing = await readVersion(fs, vPath);
  if (!existing) return null;
  try {
    const content = await fs.readFile(configFilePath);
    let data;
    if (typeof content === "string") {
      data = new TextEncoder().encode(content);
    } else if (content instanceof Uint8Array) {
      data = content;
    } else if (Buffer.isBuffer(content)) {
      data = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    } else {
      data = new Uint8Array(content);
    }
    const actualHash = await sha256(data);
    if (actualHash === existing.hash) {
      return existing;
    }
    const repaired = {
      version: existing.version + 1,
      hash: actualHash,
      author,
      timestamp: Date.now()
    };
    await writeVersion(fs, vPath, repaired);
    return repaired;
  } catch {
    return null;
  }
}

// src/config-repo.ts
var META_DIR = "/.meta";
var GROUP_TYPE_FILE = `${META_DIR}/group-type`;
var BACKENDS_FILE = `${META_DIR}/backends.json`;
var BACKENDS_DIR = `${META_DIR}/backends`;
var APP_DATA_GROUPS_DIR = `${META_DIR}/app-data-groups`;
var CONFLICTS_DIR = `${META_DIR}/.conflicts`;
var DELETIONS_DIR = `${META_DIR}/.deleted`;
var NODES_DIR = "/nodes";
var LOCAL_IDB_BACKEND_ID = "local-idb";
function tombstoneFileName(filePath) {
  return filePath.replace(/^\//, "").replace(/\//g, "__").replace(/\./g, "++") + ".json";
}
function stableOptionsKey(options) {
  if (!options || typeof options !== "object") return "{}";
  return JSON.stringify(sortKeysDeep(options));
}
function sortKeysDeep(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeysDeep(obj[key]);
  }
  return sorted;
}
function backendDedupKey(desc) {
  return `${desc.type}:${stableOptionsKey(desc.options)}`;
}
var ConfigRepo = class {
  appId;
  nodeId;
  /** Chroot-isolated fs for app-facing API. Typed as `any` to match `typeof import('node:fs')` duck-typically. */
  fs;
  /** Un-chrooted fs for low-level browsing. */
  rootFS;
  cachedFS;
  fullFS;
  serializer;
  syncEngine;
  replicaBackends;
  appDataGroups = /* @__PURE__ */ new Map();
  onConflictCallback;
  disposed = false;
  configCache = /* @__PURE__ */ new Map();
  primaryBackendId;
  pollIntervalMs;
  constructor(appId, nodeId, primaryBackendId, cachedFS, serializer, onConflict, pollIntervalMs) {
    this.appId = appId;
    this.nodeId = nodeId;
    this.primaryBackendId = primaryBackendId;
    this.cachedFS = cachedFS;
    this.serializer = serializer;
    this.syncEngine = new ZenFSSync();
    this.replicaBackends = /* @__PURE__ */ new Map();
    this.onConflictCallback = onConflict;
    this.pollIntervalMs = pollIntervalMs;
    this.fullFS = backendToSyncableFS(cachedFS, primaryBackendId);
    this.fs = createChrootFS(cachedFS, `/${appId}`);
    this.rootFS = createChrootFS(cachedFS, "/");
  }
  /** Full path to this node's directory on the primary backend. */
  get nodePath() {
    return `/nodes/${this.nodeId}`;
  }
  /** Number of replica backends registered (excludes the local primary). */
  get replicaCount() {
    return this.replicaBackends.size;
  }
  // -----------------------------------------------------------------------
  // IConfigRepo — Load
  // -----------------------------------------------------------------------
  async load(rawConfig) {
    this.assertNotDisposed();
    if (rawConfig) {
      const data = JSON.parse(rawConfig);
      if (data.backends) {
        await this.updateBackends({
          version: 1,
          backends: data.backends
        });
      }
    }
    await this.reloadConfigCache();
  }
  // -----------------------------------------------------------------------
  // IConfigRepo — Config Read/Write
  // -----------------------------------------------------------------------
  getConfig(path) {
    this.assertNotDisposed();
    const filePath = configKeyToFilePath(path);
    const key = `/${this.appId}${filePath}`;
    if (!this.configCache.has(key)) {
      throw new Error(
        `Config not loaded: ${path}. Call load() first, or use fs.promises.readFile().`
      );
    }
    return this.configCache.get(key);
  }
  setConfig(path, data) {
    this.assertNotDisposed();
    const filePath = configKeyToFilePath(path);
    const fullPath = `/${this.appId}${filePath}`;
    const bytes = this.serializer.serialize(data, fullPath);
    this.configCache.set(fullPath, data);
    this.persistConfig(fullPath, bytes).catch((err) => {
      console.error(`[zen-fs-config] Failed to persist ${fullPath}:`, err);
    });
  }
  // -----------------------------------------------------------------------
  // IConfigRepo — Node-Local Config
  // -----------------------------------------------------------------------
  async getNodeConfig(nodeId, path) {
    this.assertNotDisposed();
    const filePath = configKeyToFilePath(path);
    const fullPath = `${NODES_DIR}/${nodeId}${filePath}`;
    try {
      const raw = await this.cachedFS.readFile(fullPath);
      return this.serializer.deserialize(toUint8Array(raw), fullPath);
    } catch {
      throw new Error(`Node config not found: ${nodeId}${path}`);
    }
  }
  async setNodeConfig(nodeId, path, data) {
    this.assertNotDisposed();
    const filePath = configKeyToFilePath(path);
    const fullPath = `${NODES_DIR}/${nodeId}${filePath}`;
    const bytes = this.serializer.serialize(data, fullPath);
    await this.ensureDir(fullPath);
    await this.cachedFS.writeFile(fullPath, bytes);
  }
  // -----------------------------------------------------------------------
  // IConfigRepo — Publish Node Config
  // -----------------------------------------------------------------------
  async publishNodeConfig(nodeId, options) {
    this.assertNotDisposed();
    const nodeDir = `${NODES_DIR}/${nodeId}`;
    const files = options?.paths?.map((p) => configKeyToFilePath(p)).map((p) => `${nodeDir}${p}`) ?? [];
    if (files.length === 0) {
      const allFiles = await this.walkDir(nodeDir);
      files.push(...allFiles);
    }
    const results = [];
    for (const [_id, replica] of this.replicaBackends) {
      const pair = this.syncEngine.addPair(
        this.fullFS,
        replica.syncable,
        {
          direction: SyncDirection.OneWay,
          filter: {
            includePrefixes: files
          }
        },
        "/"
      );
      try {
        const result = await this.syncEngine.sync(pair.pairId);
        results.push(result);
      } finally {
        this.syncEngine.removePair(pair.pairId);
      }
    }
    return results.reduce(
      (acc, r) => ({
        ...acc,
        filesCreated: acc.filesCreated + r.filesCreated,
        filesUpdated: acc.filesUpdated + r.filesUpdated,
        filesDeleted: acc.filesDeleted + r.filesDeleted,
        conflicts: [...acc.conflicts, ...r.conflicts],
        changes: [...acc.changes, ...r.changes],
        durationMs: acc.durationMs + r.durationMs
      }),
      {
        pairId: `publish-${nodeId}`,
        direction: SyncDirection.OneWay,
        timestamp: Date.now(),
        filesCreated: 0,
        filesUpdated: 0,
        filesDeleted: 0,
        filesSkipped: 0,
        conflicts: [],
        changes: [],
        durationMs: 0
      }
    );
  }
  // -----------------------------------------------------------------------
  // IConfigRepo — Peek Node Config
  // -----------------------------------------------------------------------
  async peekNodeConfig(nodeId, path) {
    this.assertNotDisposed();
    const filePath = configKeyToFilePath(path);
    const fullPath = `${NODES_DIR}/${nodeId}${filePath}`;
    try {
      const raw = await this.cachedFS.readFile(fullPath);
      return this.serializer.deserialize(toUint8Array(raw), fullPath);
    } catch {
      throw new Error(`Node config not found: ${nodeId}${path}`);
    }
  }
  // -----------------------------------------------------------------------
  // IConfigRepo — Sync Management
  // -----------------------------------------------------------------------
  async flush() {
    this.assertNotDisposed();
    await this.processTombstones();
    const resultsMap = await this.syncEngine.syncAll();
    await this.readAllBackendDescriptors();
    await this.processTombstones();
    await this.updateTombstoneConfirmations();
    await this.gcTombstones();
    return Array.from(resultsMap.values());
  }
  // -----------------------------------------------------------------------
  // Tombstone (Deletion Tracking)
  // -----------------------------------------------------------------------
  /**
   * Delete a file and write a tombstone so the deletion propagates
   * to all backends instead of being treated as "missing file → re-create".
   */
  async deleteFile(path) {
    this.assertNotDisposed();
    const normalizedPath = path.startsWith("/") ? path : "/" + path;
    const tombstonePath = `${DELETIONS_DIR}/${tombstoneFileName(normalizedPath)}`;
    const tombstone = {
      path: normalizedPath,
      deletedAt: Date.now(),
      deletedBy: this.primaryBackendId,
      confirmedBy: [this.primaryBackendId]
    };
    await this.ensureDir(tombstonePath);
    await this.cachedFS.writeFile(
      tombstonePath,
      new TextEncoder().encode(JSON.stringify(tombstone, null, 2))
    );
    try {
      await this.cachedFS.unlink(normalizedPath);
    } catch {
    }
    const versionPath = versionPathFor(normalizedPath);
    try {
      await this.cachedFS.unlink(versionPath);
    } catch {
    }
    console.log(`[ConfigRepo] deleteFile: ${normalizedPath} (tombstone at ${tombstonePath})`);
  }
  /**
   * Read all tombstones from the primary backend.
   */
  async readTombstones() {
    try {
      const entries = await this.cachedFS.readdir(DELETIONS_DIR);
      const tombstones = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        try {
          const raw = await this.cachedFS.readFile(`${DELETIONS_DIR}/${entry}`);
          const data = JSON.parse(new TextDecoder().decode(toUint8Array(raw)));
          tombstones.push(data);
        } catch {
        }
      }
      return tombstones;
    } catch {
      return [];
    }
  }
  /**
   * Before sync: for each tombstone, delete the actual file on all replicas.
   * This prevents bi-directional sync from copying the file back.
   */
  async processTombstones() {
    const tombstones = await this.readTombstones();
    if (tombstones.length === 0) return;
    console.log(`[ConfigRepo] processTombstones: ${tombstones.length} tombstone(s)`);
    for (const tombstone of tombstones) {
      try {
        await this.cachedFS.unlink(tombstone.path);
      } catch {
      }
      try {
        await this.cachedFS.unlink(versionPathFor(tombstone.path));
      } catch {
      }
      for (const [replicaId, replica] of this.replicaBackends) {
        try {
          await replica.instance.unlink(tombstone.path);
        } catch {
        }
        try {
          await replica.instance.unlink(versionPathFor(tombstone.path));
        } catch {
        }
        console.log(`[ConfigRepo] tombstone ${tombstone.path}: deleted on ${replicaId}`);
      }
    }
  }
  /** Public wrapper for processTombstones — used by createConfigRepo. */
  async processTombstonesPublic() {
    await this.processTombstones();
  }
  /**
   * Perform a full sync + dedup cycle without the watch snapshot cache.
   * Used by createConfigRepo to pull remote-only files (like duplicate
   * backend descriptors) that watch()'s initial snapshot would skip.
   */
  async initialSyncAndDedup() {
    this.syncEngine.unwatchAll();
    await this.syncEngine.syncAll();
    await this.readAllBackendDescriptors();
    await this.processTombstones();
    this.syncEngine.watchAll();
  }
  /**
   * After sync: mark each tombstone as confirmed by all replica backends.
   */
  async updateTombstoneConfirmations() {
    const tombstones = await this.readTombstones();
    if (tombstones.length === 0) return;
    const backendsMeta = await this.getBackends();
    const allBackendIds = backendsMeta?.backends.map((b) => b.id) ?? [this.primaryBackendId];
    for (const tombstone of tombstones) {
      const tombstonePath = `${DELETIONS_DIR}/${tombstoneFileName(tombstone.path)}`;
      for (const replicaId of this.replicaBackends.keys()) {
        if (!tombstone.confirmedBy.includes(replicaId)) {
          tombstone.confirmedBy.push(replicaId);
        }
      }
      try {
        await this.cachedFS.writeFile(
          tombstonePath,
          new TextEncoder().encode(JSON.stringify(tombstone, null, 2))
        );
      } catch {
      }
    }
    console.log(`[ConfigRepo] updateTombstoneConfirmations: ${tombstones.length} tombstone(s) updated`);
  }
  /**
   * GC: remove tombstones where all backends in backends.json have confirmed.
   */
  async gcTombstones() {
    const tombstones = await this.readTombstones();
    if (tombstones.length === 0) return;
    const backendsMeta = await this.getBackends();
    const allBackendIds = backendsMeta?.backends.map((b) => b.id) ?? [this.primaryBackendId];
    for (const tombstone of tombstones) {
      const allConfirmed = allBackendIds.every((id) => tombstone.confirmedBy.includes(id));
      if (allConfirmed) {
        const tombstonePath = `${DELETIONS_DIR}/${tombstoneFileName(tombstone.path)}`;
        try {
          await this.cachedFS.unlink(tombstonePath);
          console.log(`[ConfigRepo] gcTombstones: removed ${tombstonePath} (all ${allBackendIds.length} backends confirmed)`);
        } catch {
        }
      }
    }
  }
  /**
   * Sync .meta/ files (backends.json) to all replica backends.
   *
   * This ensures the backend topology is available on every replica, enabling
   * any program that connects to any backend to discover the full topology.
   *
   * Called automatically by createConfigRepo() after setupSync().
   */
  async syncMetaToReplicas() {
    this.assertNotDisposed();
    const results = await this.flush();
    for (const result of results) {
      console.log(
        `[ConfigRepo] syncMetaToReplicas: ${result.pairId} +${result.filesCreated}/~${result.filesUpdated}/-${result.filesDeleted} skip:${result.filesSkipped} ${result.durationMs}ms`
      );
    }
  }
  getSyncStatuses() {
    this.assertNotDisposed();
    return this.syncEngine.getStatusAll();
  }
  // -----------------------------------------------------------------------
  // IConfigRepo — Conflict Management
  // -----------------------------------------------------------------------
  async resolveConflict(conflictId, mergedContent) {
    this.assertNotDisposed();
    const metaPath = `${CONFLICTS_DIR}/${conflictId}`;
    try {
      const raw = await this.cachedFS.readFile(metaPath);
      const archive = JSON.parse(
        new TextDecoder().decode(toUint8Array(raw))
      );
      const configPath = archive.conflictPath;
      const bytes = this.serializer.serialize(mergedContent, configPath);
      await this.cachedFS.writeFile(configPath, bytes);
      const author = `${this.appId}/${this.nodeId}`;
      const version = await incrementVersion(
        this.fullFS,
        configPath,
        bytes,
        author
      );
      await writeVersion(this.fullFS, versionPathFor(configPath), version);
      const conflictDir = metaPath.substring(0, metaPath.lastIndexOf("/"));
      const resolvedBackupPath = `${conflictDir}/resolved`;
      const resolvedBytes = typeof mergedContent === "string" ? new TextEncoder().encode(mergedContent) : new TextEncoder().encode(JSON.stringify(mergedContent, null, 2));
      await this.cachedFS.writeFile(resolvedBackupPath, resolvedBytes);
      archive.resolvedBackupPath = `./resolved`;
      await this.cachedFS.writeFile(
        metaPath,
        new TextEncoder().encode(JSON.stringify(archive, null, 2))
      );
    } catch (err) {
      throw new Error(`Failed to resolve conflict ${conflictId}: ${err}`);
    }
  }
  async listConflicts() {
    this.assertNotDisposed();
    const archives = [];
    try {
      const entries = await this.cachedFS.readdir(CONFLICTS_DIR);
      for (const entry of entries) {
        const metaPath = `${CONFLICTS_DIR}/${entry}/meta.json`;
        try {
          const raw = await this.cachedFS.readFile(metaPath);
          const archive = JSON.parse(
            new TextDecoder().decode(toUint8Array(raw))
          );
          archives.push(archive);
        } catch {
        }
      }
    } catch {
    }
    return archives.sort((a, b) => a.timestamp - b.timestamp);
  }
  async readConflictBackup(conflictId, fileType) {
    this.assertNotDisposed();
    const conflictDir = `${CONFLICTS_DIR}/${conflictId}`.replace(/\/meta\.json$/, "");
    const filePath = `${conflictDir}/${fileType}`;
    const raw = await this.cachedFS.readFile(filePath);
    return new TextDecoder().decode(toUint8Array(raw));
  }
  // -----------------------------------------------------------------------
  // IConfigRepo — Lifecycle
  // -----------------------------------------------------------------------
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.syncEngine.dispose();
    for (const [_id, replica] of this.replicaBackends) {
      if (replica.instance?.dispose) {
        await replica.instance.dispose();
      }
    }
    this.replicaBackends.clear();
    for (const [_id, group] of this.appDataGroups) {
      await group.dispose();
    }
    this.appDataGroups.clear();
    this.configCache.clear();
  }
  // -----------------------------------------------------------------------
  // Internal — Setup
  // -----------------------------------------------------------------------
  async setupSync(backends, primaryBackendId, pollIntervalMs) {
    console.log(`[ConfigRepo] setupSync: ${backends.length} backends, primary=${primaryBackendId} pollInterval=${pollIntervalMs ?? "default"}ms`);
    for (const desc of backends) {
      if (desc.id === primaryBackendId) continue;
      if (desc.enabled === false) {
        console.log(`[ConfigRepo] Skipping disabled replica: ${desc.id}`);
        continue;
      }
      console.log(`[ConfigRepo] Creating replica backend: id=${desc.id}, type=${desc.type}`);
      try {
        const instance = await createBackend(desc);
        const syncable = backendToSyncableFS(instance, `${desc.type}(${desc.id})`);
        const pair = this.syncEngine.addPair(
          this.fullFS,
          syncable,
          {
            direction: SyncDirection.BiDirectional,
            conflictStrategy: "source-wins",
            pollIntervalMs
          },
          "/"
        );
        this.replicaBackends.set(desc.id, { instance, syncable, pairId: pair.pairId });
        const conflictHandler = (event) => {
          this.handleConflict(event);
        };
        this.syncEngine.on(pair.pairId, "conflict", conflictHandler);
        console.log(`[ConfigRepo] Replica ${desc.id} created, sync pair=${pair.pairId}`);
      } catch (err) {
        console.error(`[ConfigRepo] Failed to create replica ${desc.id} (${desc.type}):`, err);
      }
    }
    console.log(`[ConfigRepo] setupSync complete. Replicas:`, Array.from(this.replicaBackends.keys()));
    console.log(`[ConfigRepo] Sync statuses:`, this.getSyncStatuses());
  }
  // -----------------------------------------------------------------------
  // Internal — Persistence
  // -----------------------------------------------------------------------
  async persistConfig(fullPath, bytes) {
    await this.ensureDir(fullPath);
    await this.cachedFS.writeFile(fullPath, bytes);
    const author = `${this.appId}/${this.nodeId}`;
    const version = await incrementVersion(this.fullFS, fullPath, bytes, author);
    await this.ensureDir(versionPathFor(fullPath));
    await writeVersion(this.fullFS, versionPathFor(fullPath), version);
  }
  async reloadConfigCache() {
    const appDir = `/${this.appId}`;
    try {
      const files = await this.walkDir(appDir);
      for (const filePath of files) {
        try {
          const raw = await this.cachedFS.readFile(filePath);
          const data = this.serializer.deserialize(toUint8Array(raw), filePath);
          this.configCache.set(filePath, data);
        } catch {
        }
      }
    } catch {
    }
  }
  // -----------------------------------------------------------------------
  // Internal — Conflict Handling
  // -----------------------------------------------------------------------
  async handleConflict(event) {
    const conflict = event.conflict;
    if (!conflict) return;
    const conflictId = `${event.timestamp}_${conflict.path.replace(/\//g, "_")}`;
    const conflictDir = `${CONFLICTS_DIR}/${conflictId}`;
    const sourceBackupPath = `${conflictDir}/source`;
    const targetBackupPath = `${conflictDir}/target`;
    await this.ensureDir(conflictDir);
    await this.cachedFS.writeFile(
      sourceBackupPath,
      new TextEncoder().encode(conflict.sourceContent)
    );
    await this.cachedFS.writeFile(
      targetBackupPath,
      new TextEncoder().encode(conflict.targetContent)
    );
    let sourceVersion = 0;
    try {
      const srcVer = await readVersion(this.fullFS, versionPathFor(conflict.path));
      if (srcVer) sourceVersion = srcVer.version;
    } catch {
    }
    const archive = {
      conflictPath: conflict.path,
      timestamp: event.timestamp,
      sourceAuthor: `${this.appId}/${this.nodeId}`,
      targetAuthor: "unknown",
      sourceVersion,
      targetVersion: 0,
      resolvedStrategy: conflict.resolvedWith,
      sourceBackupPath: `./source`,
      targetBackupPath: `./target`
    };
    const metaPath = `${conflictDir}/meta.json`;
    await this.cachedFS.writeFile(
      metaPath,
      new TextEncoder().encode(JSON.stringify(archive, null, 2))
    );
    if (this.onConflictCallback) {
      const info = {
        conflictId: `${conflictId}/meta.json`,
        path: conflict.path,
        sourceAuthor: archive.sourceAuthor,
        targetAuthor: archive.targetAuthor,
        sourceContent: this.tryParse(conflict.sourceContent),
        targetContent: this.tryParse(conflict.targetContent)
      };
      try {
        const customMerge = await this.onConflictCallback(info);
        if (customMerge !== null && customMerge !== void 0) {
          await this.resolveConflict(`${conflictId}/meta.json`, customMerge);
        }
      } catch (err) {
        console.error("[zen-fs-config] Conflict handler error:", err);
      }
    }
  }
  // -----------------------------------------------------------------------
  // Internal — File System Helpers
  // -----------------------------------------------------------------------
  async ensureDir(filePath) {
    const parts = filePath.split("/").filter(Boolean);
    parts.pop();
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      try {
        await this.fullFS.mkdir(current);
      } catch {
      }
    }
  }
  async walkDir(dir) {
    const results = [];
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      try {
        const entries = await this.cachedFS.readdir(current);
        for (const entry of entries) {
          if (entry.startsWith(".")) continue;
          const fullPath = current === "/" ? `/${entry}` : `${current}/${entry}`;
          try {
            const stat = await this.cachedFS.stat(fullPath);
            if (stat.mode !== void 0 && (stat.mode & 16384) === 16384) {
              stack.push(fullPath);
            } else {
              results.push(fullPath);
            }
          } catch {
          }
        }
      } catch {
      }
    }
    return results;
  }
  async writeMetaFile(path, data) {
    await this.ensureDir(path);
    const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2));
    await this.cachedFS.writeFile(path, bytes);
    const author = `${this.appId}/${this.nodeId}`;
    const version = await incrementVersion(this.fullFS, path, bytes, author);
    await this.ensureDir(versionPathFor(path));
    await writeVersion(this.fullFS, versionPathFor(path), version);
  }
  async readMetaFile(path) {
    try {
      const raw = await this.cachedFS.readFile(path);
      return JSON.parse(new TextDecoder().decode(toUint8Array(raw)));
    } catch {
      return null;
    }
  }
  // -----------------------------------------------------------------------
  // Internal — Individual Backend Descriptor Files
  // -----------------------------------------------------------------------
  /** Path for a single backend descriptor: .meta/backends/{id}.json */
  backendFilePath(id) {
    return `${BACKENDS_DIR}/${id}.json`;
  }
  /**
   * Read all backend descriptors from .meta/backends/*.json.
   *
   * If duplicate backends are detected (same type + options but different id),
   * only the first one (sorted by id) is kept and the rest are removed
   * (including their version sidecar files).
   */
  async readAllBackendDescriptors() {
    try {
      const entries = await this.cachedFS.readdir(BACKENDS_DIR);
      const items = [];
      const corruptFiles = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const filePath = `${BACKENDS_DIR}/${entry}`;
        try {
          const raw = await this.cachedFS.readFile(filePath);
          const desc = JSON.parse(new TextDecoder().decode(toUint8Array(raw)));
          if (desc.id && desc.type) {
            let mtime = 0;
            try {
              const stat = await this.cachedFS.stat(filePath);
              mtime = stat.mtimeMs ?? 0;
            } catch {
            }
            items.push({ desc, mtime });
          } else {
            console.warn(`[ConfigRepo] Backend descriptor ${entry} is missing id/type fields, marking for cleanup`);
            corruptFiles.push(filePath);
          }
        } catch (parseErr) {
          console.warn(`[ConfigRepo] Backend descriptor ${entry} has corrupted JSON: ${parseErr}. Marking for cleanup.`);
          corruptFiles.push(filePath);
        }
      }
      for (const corruptPath of corruptFiles) {
        for (const [, replica] of this.replicaBackends) {
          try {
            await replica.instance.unlink(corruptPath);
          } catch {
          }
          try {
            await replica.instance.unlink(versionPathFor(corruptPath));
          } catch {
          }
        }
        try {
          await this.deleteFile(corruptPath);
        } catch {
          try {
            await this.cachedFS.unlink(corruptPath);
          } catch {
          }
          try {
            await this.cachedFS.unlink(versionPathFor(corruptPath));
          } catch {
          }
        }
      }
      const seen = /* @__PURE__ */ new Map();
      const duplicates = [];
      for (const item of items) {
        const key = backendDedupKey(item.desc);
        const existing = seen.get(key);
        if (existing) {
          if (item.mtime < existing.mtime) {
            duplicates.push(existing.desc.id);
            seen.set(key, item);
          } else {
            duplicates.push(item.desc.id);
          }
        } else {
          seen.set(key, item);
        }
      }
      if (duplicates.length > 0) {
        console.log(
          `[ConfigRepo] readAllBackendDescriptors: removing ${duplicates.length} duplicate(s): ${duplicates.join(", ")}`
        );
        for (const dupId of duplicates) {
          const descPath = this.backendFilePath(dupId);
          for (const [replicaId, replica] of this.replicaBackends) {
            try {
              await replica.instance.unlink(descPath);
            } catch {
            }
            try {
              await replica.instance.unlink(versionPathFor(descPath));
            } catch {
            }
          }
          try {
            await this.deleteFile(descPath);
          } catch {
            await this.removeBackendDescriptor(dupId);
          }
        }
      }
      return Array.from(seen.values()).map((i) => i.desc);
    } catch {
      return [];
    }
  }
  /** Write a single backend descriptor as .meta/backends/{id}.json */
  async writeBackendDescriptor(desc) {
    const path = this.backendFilePath(desc.id);
    await this.ensureDir(path);
    const bytes = new TextEncoder().encode(JSON.stringify(desc, null, 2));
    await this.cachedFS.writeFile(path, bytes);
    const author = `${this.appId}/${this.nodeId}`;
    const version = await incrementVersion(this.fullFS, path, bytes, author);
    await this.ensureDir(versionPathFor(path));
    await writeVersion(this.fullFS, versionPathFor(path), version);
  }
  /** Remove a single backend descriptor file + its version sidecar */
  async removeBackendDescriptor(id) {
    const path = this.backendFilePath(id);
    try {
      await this.cachedFS.unlink(path);
    } catch {
    }
    try {
      await this.cachedFS.unlink(versionPathFor(path));
    } catch {
    }
  }
  // -----------------------------------------------------------------------
  // IConfigRepo — Meta file access (no chroot)
  // -----------------------------------------------------------------------
  async getBackends() {
    this.assertNotDisposed();
    const descriptors = await this.readAllBackendDescriptors();
    const fullList = [
      {
        id: LOCAL_IDB_BACKEND_ID,
        type: "IndexedDB",
        options: { storeName: "" },
        // actual storeName is internal
        description: "Local IndexedDB primary (implicit)"
      },
      ...descriptors
    ];
    return { version: 1, backends: fullList };
  }
  async updateBackends(meta) {
    this.assertNotDisposed();
    const replicas = meta.backends.filter((b) => b.id !== LOCAL_IDB_BACKEND_ID);
    if (replicas.length === 0 && meta.backends.length === 0) {
      return;
    }
    await this.ensureDir(`${BACKENDS_DIR}/.keep`);
    for (const desc of replicas) {
      await this.writeBackendDescriptor(desc);
    }
    const keepIds = new Set(replicas.map((b) => b.id));
    const current = await this.readAllBackendDescriptors();
    for (const desc of current) {
      if (!keepIds.has(desc.id)) {
        const descPath = this.backendFilePath(desc.id);
        try {
          await this.deleteFile(descPath);
        } catch {
          await this.removeBackendDescriptor(desc.id);
        }
      }
    }
  }
  // -----------------------------------------------------------------------
  // IConfigRepo — Dynamic Backend Management
  // -----------------------------------------------------------------------
  async addBackend(id, type, options, description) {
    this.assertNotDisposed();
    if (id === LOCAL_IDB_BACKEND_ID) {
      throw new Error(`Cannot add backend with reserved ID "${LOCAL_IDB_BACKEND_ID}"`);
    }
    const existing = await this.readAllBackendDescriptors();
    if (existing.some((b) => b.id === id)) {
      throw new Error(`Backend "${id}" already exists. Use removeBackend() first.`);
    }
    const newKey = backendDedupKey({ id, type, options });
    const dup = existing.find((b) => backendDedupKey(b) === newKey);
    if (dup) {
      throw new Error(
        `Backend "${id}" has the same configuration as existing backend "${dup.id}" (type=${type}). Use removeBackend("${dup.id}") first, or connect with the existing backend's ID.`
      );
    }
    console.log(`[ConfigRepo] addBackend: creating ${id} (${type})...`);
    const instance = await createBackend({ type, options });
    const syncable = backendToSyncableFS(instance, `${type}(${id})`);
    const desc = { id, type, options, description };
    await this.writeBackendDescriptor(desc);
    const pair = this.syncEngine.addPair(
      this.fullFS,
      syncable,
      {
        direction: SyncDirection.BiDirectional,
        conflictStrategy: "source-wins"
      },
      "/"
    );
    this.replicaBackends.set(id, { instance, syncable, pairId: pair.pairId });
    const conflictHandler = (event) => {
      this.handleConflict(event);
    };
    this.syncEngine.on(pair.pairId, "conflict", conflictHandler);
    console.log(`[ConfigRepo] addBackend: ${id} (${type}) added, sync pair=${pair.pairId}`);
    await this.syncMetaToReplicas();
    this.syncEngine.watch(pair.pairId);
  }
  async removeBackend(id) {
    this.assertNotDisposed();
    if (id === LOCAL_IDB_BACKEND_ID) {
      throw new Error("Cannot remove the local IndexedDB primary backend");
    }
    const replica = this.replicaBackends.get(id);
    if (!replica) {
      throw new Error(`Backend "${id}" is not a registered replica`);
    }
    const descPath = this.backendFilePath(id);
    try {
      await replica.instance.unlink(descPath);
    } catch {
    }
    try {
      await replica.instance.unlink(versionPathFor(descPath));
    } catch {
    }
    try {
      await this.deleteFile(descPath);
    } catch {
      await this.removeBackendDescriptor(id);
    }
    this.syncEngine.removePair(replica.pairId);
    console.log(`[ConfigRepo] removeBackend: sync pair ${replica.pairId} removed`);
    this.replicaBackends.delete(id);
    if (replica.instance?.dispose) {
      await replica.instance.dispose();
    }
    console.log(`[ConfigRepo] removeBackend: ${id} removed (tombstone written, remote cleaned)`);
  }
  // -----------------------------------------------------------------------
  // IConfigRepo — Group Type
  // -----------------------------------------------------------------------
  /** Write the group-type marker file if it doesn't exist. */
  async ensureGroupType(type) {
    this.assertNotDisposed();
    try {
      const existing = await this.cachedFS.readFile(GROUP_TYPE_FILE, "utf-8");
      const current = existing.trim();
      if (current && current !== type) {
        console.warn(`[ConfigRepo] group-type already set to "${current}", ignoring request to set "${type}"`);
        return;
      }
    } catch {
    }
    await this.ensureDir(GROUP_TYPE_FILE);
    await this.cachedFS.writeFile(GROUP_TYPE_FILE, new TextEncoder().encode(type));
    console.log(`[ConfigRepo] group-type set to "${type}"`);
  }
  /** Read the group-type marker. Returns null if not set. */
  async getGroupType() {
    this.assertNotDisposed();
    try {
      const raw = await this.cachedFS.readFile(GROUP_TYPE_FILE, "utf-8");
      const type = raw.trim();
      if (type === "config-sync" || type === "data-sync") return type;
      return null;
    } catch {
      return null;
    }
  }
  // -----------------------------------------------------------------------
  // IConfigRepo — App Data Groups (data-sync groups)
  // -----------------------------------------------------------------------
  /** Path for a single app data group descriptor: .meta/app-data-groups/{appId}/{id}.json */
  appDataGroupFilePath(id) {
    return `${APP_DATA_GROUPS_DIR}/${this.appId}/${id}.json`;
  }
  /**
   * Resolve a backend descriptor's options by merging account fields
   * from the referenced config-sync backend (if accountBackendId is set).
   */
  async resolveAppDataBackendOptions(desc) {
    if (!desc.accountBackendId) {
      return desc.options;
    }
    const allBackends = await this.readAllBackendDescriptors();
    const accountBackend = allBackends.find((b) => b.id === desc.accountBackendId);
    if (!accountBackend) {
      throw new Error(`Account backend "${desc.accountBackendId}" not found for data backend "${desc.id}"`);
    }
    return mergeAccountFields(desc.type, accountBackend.options, desc.options);
  }
  async createAppDataGroup(id, backends) {
    this.assertNotDisposed();
    if (this.appDataGroups.has(id)) {
      throw new Error(`App data group "${id}" already exists. Use removeAppDataGroup() first.`);
    }
    console.log(`[ConfigRepo] createAppDataGroup: creating "${id}" with ${backends.length} backend(s)`);
    const resolvedBackends = [];
    for (const desc of backends) {
      const mergedOptions = await this.resolveAppDataBackendOptions(desc);
      resolvedBackends.push({ ...desc, options: mergedOptions });
    }
    const group = new AppDataGroupImpl(
      id,
      this.appId,
      resolvedBackends,
      this.pollIntervalMs
    );
    await group.init();
    const descriptor = {
      id,
      groupType: "data-sync",
      backends: resolvedBackends
    };
    const descPath = this.appDataGroupFilePath(id);
    await this.ensureDir(descPath);
    const bytes = new TextEncoder().encode(JSON.stringify(descriptor, null, 2));
    await this.cachedFS.writeFile(descPath, bytes);
    const author = `${this.appId}/${this.nodeId}`;
    const version = await incrementVersion(this.fullFS, descPath, bytes, author);
    await this.ensureDir(versionPathFor(descPath));
    await writeVersion(this.fullFS, versionPathFor(descPath), version);
    this.appDataGroups.set(id, group);
    console.log(`[ConfigRepo] createAppDataGroup: "${id}" created`);
    return group;
  }
  async getAppDataGroup(id) {
    this.assertNotDisposed();
    const cached = this.appDataGroups.get(id);
    if (cached) return cached;
    const descPath = this.appDataGroupFilePath(id);
    try {
      const raw = await this.cachedFS.readFile(descPath);
      const descriptor = JSON.parse(new TextDecoder().decode(toUint8Array(raw)));
      const group = new AppDataGroupImpl(
        id,
        this.appId,
        descriptor.backends,
        this.pollIntervalMs
      );
      await group.init();
      this.appDataGroups.set(id, group);
      return group;
    } catch {
      throw new Error(`App data group "${id}" not found`);
    }
  }
  async listAppDataGroups() {
    this.assertNotDisposed();
    const dir = `${APP_DATA_GROUPS_DIR}/${this.appId}`;
    try {
      const entries = await this.cachedFS.readdir(dir);
      const descriptors = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        try {
          const raw = await this.cachedFS.readFile(`${dir}/${entry}`);
          const desc = JSON.parse(new TextDecoder().decode(toUint8Array(raw)));
          if (desc.id && desc.groupType === "data-sync") {
            descriptors.push(desc);
          }
        } catch {
        }
      }
      return descriptors;
    } catch {
      return [];
    }
  }
  async removeAppDataGroup(id) {
    this.assertNotDisposed();
    const group = this.appDataGroups.get(id);
    if (group) {
      await group.dispose();
      this.appDataGroups.delete(id);
    }
    const descPath = this.appDataGroupFilePath(id);
    try {
      await this.cachedFS.unlink(descPath);
    } catch {
    }
    try {
      await this.cachedFS.unlink(versionPathFor(descPath));
    } catch {
    }
    console.log(`[ConfigRepo] removeAppDataGroup: "${id}" removed`);
  }
  async listAccountBackends() {
    this.assertNotDisposed();
    const allBackends = await this.readAllBackendDescriptors();
    return allBackends.filter((b) => getAccountFields(b.type).length > 0);
  }
  tryParse(content) {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }
  assertNotDisposed() {
    if (this.disposed) {
      throw new Error("ConfigRepo has been disposed");
    }
  }
};
var AppDataGroupImpl = class {
  groupId;
  appId;
  fs;
  syncEngine;
  localFS;
  dataBackends = /* @__PURE__ */ new Map();
  disposed = false;
  constructor(groupId, appId, backends, pollIntervalMs) {
    this.groupId = groupId;
    this.appId = appId;
    this.syncEngine = new ZenFSSync();
    this.localFS = null;
    this.fs = null;
    this._backends = backends;
    this._pollIntervalMs = pollIntervalMs;
  }
  _backends;
  _pollIntervalMs;
  async init() {
    try {
      this.localFS = await createBackend({
        type: "InMemory",
        options: { label: `data-group-${this.groupId}-${Date.now()}` }
      });
    } catch {
      throw new Error(`Failed to create local primary for data group "${this.groupId}"`);
    }
    const localSyncable = backendToSyncableFS(this.localFS, `local(${this.groupId})`);
    this.fs = createChrootFS(this.localFS, "/");
    for (const desc of this._backends) {
      try {
        const instance = await createBackend({ type: desc.type, options: desc.options });
        const syncable = backendToSyncableFS(instance, `${desc.type}(${desc.id})`);
        const pair = this.syncEngine.addPair(
          localSyncable,
          syncable,
          {
            direction: SyncDirection.BiDirectional,
            conflictStrategy: "source-wins",
            pollIntervalMs: this._pollIntervalMs
          },
          "/"
        );
        this.dataBackends.set(desc.id, { instance, syncable, pairId: pair.pairId, desc });
        console.log(`[AppDataGroup:${this.groupId}] backend ${desc.id} (${desc.type}) connected, pair=${pair.pairId}`);
      } catch (err) {
        console.error(`[AppDataGroup:${this.groupId}] Failed to create backend ${desc.id} (${desc.type}):`, err);
      }
    }
    try {
      await this.syncEngine.syncAll();
    } catch (err) {
      console.warn(`[AppDataGroup:${this.groupId}] Initial sync failed:`, err);
    }
    this.syncEngine.watchAll();
  }
  getSyncStatuses() {
    return this.syncEngine.getStatusAll();
  }
  async flush() {
    const results = await this.syncEngine.syncAll();
    return Array.from(results.values());
  }
  async addBackend(id, type, options, description) {
    if (this.disposed) throw new Error("DataSyncGroup has been disposed");
    if (this.dataBackends.has(id)) {
      throw new Error(`Backend "${id}" already exists in data group "${this.groupId}"`);
    }
    console.log(`[AppDataGroup:${this.groupId}] addBackend: creating ${id} (${type})...`);
    const instance = await createBackend({ type, options });
    const syncable = backendToSyncableFS(instance, `${type}(${id})`);
    const localSyncable = backendToSyncableFS(this.localFS, `local(${this.groupId})`);
    const pair = this.syncEngine.addPair(
      localSyncable,
      syncable,
      {
        direction: SyncDirection.BiDirectional,
        conflictStrategy: "source-wins",
        pollIntervalMs: this._pollIntervalMs
      },
      "/"
    );
    const desc = { id, type, options, description };
    this.dataBackends.set(id, { instance, syncable, pairId: pair.pairId, desc });
    console.log(`[AppDataGroup:${this.groupId}] addBackend: ${id} (${type}) connected, pair=${pair.pairId}`);
    try {
      await this.syncEngine.sync(pair.pairId);
    } catch (err) {
      console.warn(`[AppDataGroup:${this.groupId}] addBackend: initial sync failed for ${id}:`, err);
    }
    this.syncEngine.watch(pair.pairId);
  }
  async removeBackend(id) {
    if (this.disposed) throw new Error("DataSyncGroup has been disposed");
    const backend = this.dataBackends.get(id);
    if (!backend) {
      throw new Error(`Backend "${id}" not found in data group "${this.groupId}"`);
    }
    this.syncEngine.removePair(backend.pairId);
    this.dataBackends.delete(id);
    if (backend.instance?.dispose) {
      await backend.instance.dispose();
    }
    console.log(`[AppDataGroup:${this.groupId}] removeBackend: ${id} removed`);
  }
  listBackends() {
    return Array.from(this.dataBackends.values()).map((b) => b.desc);
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.syncEngine.dispose();
    for (const [_id, backend] of this.dataBackends) {
      if (backend.instance?.dispose) {
        await backend.instance.dispose();
      }
    }
    this.dataBackends.clear();
  }
};
function toUint8Array(raw) {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (raw instanceof Uint8Array) return raw;
  if (typeof raw === "string") return new TextEncoder().encode(raw);
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return new Uint8Array(raw);
}
async function createConfigRepo(appId, options = {}) {
  const idbStoreName = options.idbStoreName || `zen-fs-config-${appId}`;
  console.log(`[createConfigRepo] Creating IndexedDB primary (store: ${idbStoreName})...`);
  const primaryInstance = await createBackend({
    type: "IndexedDB",
    options: { storeName: idbStoreName }
  });
  const cachedFS = primaryInstance;
  try {
    await primaryInstance.mkdir(META_DIR);
    console.log(`[createConfigRepo] /.meta/ ready`);
  } catch (err) {
    console.error(`[createConfigRepo] Failed to ensure /.meta/:`, err.message);
  }
  try {
    const groupTypeBytes = new TextEncoder().encode("config-sync");
    try {
      await primaryInstance.readFile(`${META_DIR}/group-type`);
    } catch {
      await primaryInstance.writeFile(`${META_DIR}/group-type`, groupTypeBytes);
      console.log(`[createConfigRepo] group-type set to "config-sync"`);
    }
  } catch (err) {
    console.warn(`[createConfigRepo] Failed to write group-type:`, err.message);
  }
  const tempRepo = new ConfigRepo(
    appId,
    "",
    LOCAL_IDB_BACKEND_ID,
    cachedFS,
    createSerializerChain(),
    void 0,
    options.syncPollIntervalMs
  );
  const oldBackendsMeta = await tempRepo.readMetaFile(BACKENDS_FILE);
  if (oldBackendsMeta && oldBackendsMeta.backends?.length > 0) {
    console.log(`[createConfigRepo] Migrating ${oldBackendsMeta.backends.length} backend(s) from backends.json to individual files...`);
    await tempRepo.ensureDir(`${BACKENDS_DIR}/.keep`);
    for (const desc of oldBackendsMeta.backends) {
      if (desc.id === LOCAL_IDB_BACKEND_ID || desc.type === "IndexedDB") {
        console.log(`[createConfigRepo] Skipping local backend ${desc.id} during migration`);
        continue;
      }
      await tempRepo.writeBackendDescriptor(desc);
    }
    try {
      await cachedFS.unlink(BACKENDS_FILE);
    } catch {
    }
    try {
      await cachedFS.unlink(versionPathFor(BACKENDS_FILE));
    } catch {
    }
    console.log(`[createConfigRepo] Migration complete`);
  }
  if (options.backendInfo) {
    const replicaId = options.primaryBackendId || `${options.backendInfo.type}-replica`;
    const allBackends2 = await tempRepo.readAllBackendDescriptors();
    const hasReplica = allBackends2.some((b) => b.id === replicaId);
    const newKey = backendDedupKey({
      id: replicaId,
      type: options.backendInfo.type,
      options: options.backendInfo.options
    });
    const dupConfig = allBackends2.find((b) => backendDedupKey(b) === newKey);
    if (!hasReplica && !dupConfig) {
      await tempRepo.writeBackendDescriptor({
        id: replicaId,
        type: options.backendInfo.type,
        options: options.backendInfo.options
      });
      console.log(`[createConfigRepo] Added replica backend: ${replicaId} (${options.backendInfo.type})`);
    } else if (dupConfig) {
      console.log(`[createConfigRepo] Replica with same config already registered as "${dupConfig.id}", skipping`);
    } else {
      console.log(`[createConfigRepo] Replica ${replicaId} already registered`);
    }
  }
  const allBackends = await tempRepo.readAllBackendDescriptors();
  console.log(`[createConfigRepo] Replica backends: ${allBackends.map((b) => b.id).join(", ") || "(none)"}`);
  let nodeId = options.nodeId;
  if (!nodeId) {
    nodeId = `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[createConfigRepo] Generated nodeId: ${nodeId}`);
  }
  const serializer = createSerializerChain(options.serializer);
  const repo = new ConfigRepo(
    appId,
    nodeId,
    LOCAL_IDB_BACKEND_ID,
    cachedFS,
    serializer,
    options.onConflict,
    options.syncPollIntervalMs
  );
  await repo.setupSync(allBackends, LOCAL_IDB_BACKEND_ID, options.syncPollIntervalMs);
  await repo.load();
  if (repo.replicaCount > 0) {
    console.log("[createConfigRepo] Initial sync + dedup cycle...");
    await repo.initialSyncAndDedup();
  }
  repo.syncMetaToReplicas().catch((err) => {
    console.error("[createConfigRepo] background syncMetaToReplicas failed:", err);
  });
  return repo;
}

// src/data-sync-group.ts
import {
  ZenFSSync as ZenFSSync2,
  SyncDirection as SyncDirection2
} from "zen-fs-sync";

// src/logger.ts
var isDebug = (() => {
  if (typeof process !== "undefined" && process.env?.ZEN_FS_CONFIG_DEBUG) {
    return true;
  }
  if (typeof localStorage !== "undefined") {
    try {
      return localStorage.getItem("ZEN_FS_CONFIG_DEBUG") === "1";
    } catch {
      return false;
    }
  }
  return false;
})();
function createLogger(prefix) {
  if (!isDebug) {
    return () => {
    };
  }
  return (...args) => {
    console.log(`[${prefix}]`, ...args);
  };
}

// src/data-sync-group.ts
var log = createLogger("data-sync-group");
var META_DIR2 = "/.meta";
var GROUP_TYPE_FILE2 = `${META_DIR2}/group-type`;
var BACKENDS_DIR2 = `${META_DIR2}/backends`;
var DataSyncGroup = class {
  groupId;
  appId;
  fs;
  syncEngine;
  localFS;
  dataBackends = /* @__PURE__ */ new Map();
  disposed = false;
  constructor(appId, groupId, localFS) {
    this.appId = appId;
    this.groupId = groupId;
    this.syncEngine = new ZenFSSync2();
    this.localFS = localFS;
    this.fs = createChrootFS(localFS, "/");
  }
  /**
   * Add a data backend and set up bi-directional sync.
   */
  async addBackend(id, type, options, description) {
    if (this.disposed) throw new Error("DataSyncGroup has been disposed");
    if (this.dataBackends.has(id)) {
      throw new Error(`Backend "${id}" already exists in data group "${this.groupId}"`);
    }
    log(`addBackend: creating ${id} (${type})...`);
    const instance = await createBackend({ type, options });
    const syncable = backendToSyncableFS(instance, `${type}(${id})`);
    const localSyncable = backendToSyncableFS(this.localFS, `local(${this.groupId})`);
    const pair = this.syncEngine.addPair(
      localSyncable,
      syncable,
      {
        direction: SyncDirection2.BiDirectional,
        conflictStrategy: "source-wins"
      },
      "/"
    );
    this.dataBackends.set(id, { instance, syncable, pairId: pair.pairId, desc: { id, type, options, description } });
    this.syncEngine.watch(pair.pairId);
    log(`addBackend: ${id} (${type}) connected, pair=${pair.pairId}`);
    await this.saveBackendDescriptor(id, type, options, description);
    try {
      await this.syncEngine.sync(pair.pairId);
    } catch (err) {
      log(`addBackend: initial sync failed for ${id}:`, err);
    }
  }
  /**
   * Remove a data backend.
   */
  async removeBackend(id) {
    if (this.disposed) throw new Error("DataSyncGroup has been disposed");
    const backend = this.dataBackends.get(id);
    if (!backend) {
      throw new Error(`Backend "${id}" not found in data group "${this.groupId}"`);
    }
    this.syncEngine.removePair(backend.pairId);
    this.dataBackends.delete(id);
    if (backend.instance?.dispose) {
      await backend.instance.dispose();
    }
    try {
      await this.localFS.unlink(`${BACKENDS_DIR2}/${id}.json`);
    } catch {
    }
    log(`removeBackend: ${id} removed`);
  }
  getSyncStatuses() {
    return this.syncEngine.getStatusAll();
  }
  async flush() {
    const results = await this.syncEngine.syncAll();
    return Array.from(results.values());
  }
  listBackends() {
    return Array.from(this.dataBackends.values()).map((b) => b.desc);
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.syncEngine.dispose();
    for (const [_id, backend] of this.dataBackends) {
      if (backend.instance?.dispose) {
        await backend.instance.dispose();
      }
    }
    this.dataBackends.clear();
    log(`disposed`);
  }
  // -----------------------------------------------------------------------
  // Internal — used by the factory function
  // -----------------------------------------------------------------------
  /**
   * Register a pre-created backend instance with the sync engine.
   * Used internally by createDataSyncGroup() to avoid double-creating backends.
   */
  _registerBackend(id, instance, syncable, pollIntervalMs) {
    const localSyncable = backendToSyncableFS(this.localFS, `local(${this.groupId})`);
    const pair = this.syncEngine.addPair(
      localSyncable,
      syncable,
      {
        direction: SyncDirection2.BiDirectional,
        conflictStrategy: "source-wins",
        pollIntervalMs
      },
      "/"
    );
    this.dataBackends.set(id, { instance, syncable, pairId: pair.pairId, desc: { id, type: instance.constructor?.name || "unknown", options: {} } });
    this.syncEngine.watch(pair.pairId);
    return pair.pairId;
  }
  /** Run syncAll on the internal engine. */
  async _syncAll() {
    await this.syncEngine.syncAll();
  }
  /** Get the number of registered data backends. */
  get _backendCount() {
    return this.dataBackends.size;
  }
  // -----------------------------------------------------------------------
  // Internal — descriptor persistence
  // -----------------------------------------------------------------------
  async saveBackendDescriptor(id, type, options, description) {
    const desc = { id, type, options, description };
    const path = `${BACKENDS_DIR2}/${id}.json`;
    await this.ensureDir(path);
    const bytes = new TextEncoder().encode(JSON.stringify(desc, null, 2));
    await this.localFS.writeFile(path, bytes);
  }
  async ensureDir(filePath) {
    const parts = filePath.split("/").filter(Boolean);
    parts.pop();
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      try {
        await this.localFS.mkdir(current);
      } catch {
      }
    }
  }
};
async function createDataSyncGroup(appId, options = {}) {
  const groupId = `data-${appId}-${Date.now().toString(36)}`;
  log(`createDataSyncGroup: appId=${appId} groupId=${groupId}`);
  const localFS = await createBackend({
    type: "InMemory",
    options: { label: `data-sync-${appId}-${Date.now()}` }
  });
  try {
    await localFS.mkdir(META_DIR2);
  } catch {
  }
  if (options.backendInfo) {
    const remoteBackend = await createBackend({
      type: options.backendInfo.type,
      options: options.backendInfo.options
    });
    try {
      const raw = await remoteBackend.readFile(GROUP_TYPE_FILE2, "utf-8");
      const remoteType = raw.trim();
      if (remoteType === "config-sync") {
        throw new Error(
          `Backend is a config-sync group, not data-sync. Use createConfigRepo() instead.`
        );
      }
    } catch (err) {
      if (err.message?.includes("config-sync")) throw err;
      try {
        await remoteBackend.writeFile(
          GROUP_TYPE_FILE2,
          new TextEncoder().encode("data-sync")
        );
      } catch (writeErr) {
        log(`Could not write group-type on remote: ${writeErr.message}`);
      }
    }
    let remoteBackendDescs = [];
    try {
      const entries = await remoteBackend.readdir(BACKENDS_DIR2);
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        try {
          const raw = await remoteBackend.readFile(`${BACKENDS_DIR2}/${entry}`);
          const desc2 = JSON.parse(new TextDecoder().decode(raw instanceof Uint8Array ? raw : new Uint8Array(raw)));
          if (desc2.id && desc2.type) remoteBackendDescs.push(desc2);
        } catch {
        }
      }
    } catch {
    }
    const group2 = new DataSyncGroup(appId, groupId, localFS);
    try {
      await localFS.writeFile(GROUP_TYPE_FILE2, new TextEncoder().encode("data-sync"));
    } catch {
    }
    const backendId = options.primaryBackendId || `${options.backendInfo.type}-primary`;
    const desc = {
      id: backendId,
      type: options.backendInfo.type,
      options: options.backendInfo.options
    };
    try {
      await localFS.mkdir(BACKENDS_DIR2);
    } catch {
    }
    await localFS.writeFile(
      `${BACKENDS_DIR2}/${backendId}.json`,
      new TextEncoder().encode(JSON.stringify(desc, null, 2))
    );
    const remoteSyncable = backendToSyncableFS(remoteBackend, `${options.backendInfo.type}(${backendId})`);
    group2._registerBackend(backendId, remoteBackend, remoteSyncable, options.pollIntervalMs);
    for (const rdesc of remoteBackendDescs) {
      if (rdesc.id === backendId) continue;
      try {
        const instance = await createBackend({ type: rdesc.type, options: rdesc.options });
        const syncable = backendToSyncableFS(instance, `${rdesc.type}(${rdesc.id})`);
        group2._registerBackend(rdesc.id, instance, syncable, options.pollIntervalMs);
      } catch (err) {
        log(`Failed to add remote backend ${rdesc.id}:`, err);
      }
    }
    try {
      await group2._syncAll();
    } catch (err) {
      log(`Initial sync failed:`, err);
    }
    log(`createDataSyncGroup: ready with ${group2._backendCount} backend(s)`);
    return group2;
  }
  const group = new DataSyncGroup(appId, groupId, localFS);
  try {
    await localFS.writeFile(GROUP_TYPE_FILE2, new TextEncoder().encode("data-sync"));
  } catch {
  }
  log(`createDataSyncGroup: local-only group created`);
  return group;
}

// src/connect.ts
var log2 = createLogger("connect");
var META_DIR3 = "/.meta";
var GROUP_TYPE_FILE3 = `${META_DIR3}/group-type`;
async function detectGroupType(type, options) {
  log2(`detectGroupType: connecting to ${type}...`);
  const tempBackend = await createBackend({ type, options });
  try {
    const raw = await tempBackend.readFile(GROUP_TYPE_FILE3, "utf-8");
    const groupType = raw.trim();
    if (groupType === "config-sync" || groupType === "data-sync") {
      log2(`detectGroupType: detected "${groupType}"`);
      return groupType;
    }
    log2(`detectGroupType: unknown group-type value "${groupType}", treating as null`);
    return null;
  } catch {
    log2(`detectGroupType: no group-type file found (new backend)`);
    return null;
  } finally {
    if (tempBackend?.dispose) {
      await tempBackend.dispose();
    }
  }
}
async function connect(appId, options = {}) {
  log2(`connect: appId=${appId}`);
  if (!options.backendInfo) {
    const groupType2 = options.groupType ?? "config-sync";
    log2(`connect: no backendInfo, using groupType="${groupType2}"`);
    if (groupType2 === "data-sync") {
      const dataGroup = await createDataSyncGroup(appId, {});
      return { groupType: "data-sync", dataGroup };
    }
    const repo2 = await createConfigRepo(appId, {
      idbStoreName: options.idbStoreName,
      nodeId: options.nodeId,
      syncPollIntervalMs: options.syncPollIntervalMs
    });
    return { groupType: "config-sync", repo: repo2 };
  }
  const { type, options: backendOptions } = options.backendInfo;
  const detectedType = await detectGroupType(type, backendOptions);
  let groupType;
  if (detectedType) {
    if (options.groupType && options.groupType !== detectedType) {
      throw new Error(
        `Group type mismatch: remote backend is "${detectedType}" but options.groupType is "${options.groupType}"`
      );
    }
    groupType = detectedType;
  } else {
    groupType = options.groupType ?? "config-sync";
    log2(`connect: new backend, using groupType="${groupType}"`);
  }
  if (groupType === "data-sync") {
    const dataGroup = await createDataSyncGroup(appId, {
      backendInfo: options.backendInfo,
      primaryBackendId: options.idbStoreName,
      nodeId: options.nodeId
    });
    return { groupType: "data-sync", dataGroup };
  }
  const repo = await createConfigRepo(appId, {
    backendInfo: options.backendInfo,
    idbStoreName: options.idbStoreName,
    nodeId: options.nodeId,
    syncPollIntervalMs: options.syncPollIntervalMs
  });
  return { groupType: "config-sync", repo };
}
export {
  ConfigRepo,
  DataSyncGroup,
  LOCAL_IDB_BACKEND_ID,
  configKeyToFilePath,
  connect,
  createBackend,
  createConfigRepo,
  createDataSyncGroup,
  createSerializerChain,
  getAccountFields,
  getBackendMetadata,
  getExtension,
  hasBackend,
  incrementVersion,
  listBackendMetadata,
  listBackends,
  mergeAccountFields,
  readVersion,
  registerBackend,
  sha256,
  unregisterBackend,
  verifyOrRepairVersion,
  versionPathFor,
  wrapZenFSFileSystem,
  writeVersion
};
