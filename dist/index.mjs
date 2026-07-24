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
function registerBackend(type, factory) {
  registry.set(type, factory);
}
function unregisterBackend(type) {
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
async function wrapZenFSFileSystem(config) {
  const zenfs = await import("@zenfs/core");
  const isolatedFS = await zenfs.resolveMountConfig(config);
  return {
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
      await isolatedFS.touch(path, { size: bytes.byteLength, mtimeMs: Date.now() });
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
      return isolatedFS.unlink(path);
    },
    async rmdir(path) {
      return isolatedFS.rmdir(path);
    },
    async rename(oldPath, newPath) {
      return isolatedFS.rename(oldPath, newPath);
    }
  };
}
var inMemoryCounter = 0;
registerBackend("InMemory", async (options) => {
  const { InMemory } = await import("@zenfs/core");
  const maxSize = options.maxSize ?? 100 * 1024 * 1024;
  const label = options.label ?? `zen-fs-config-${++inMemoryCounter}`;
  return wrapZenFSFileSystem({ backend: InMemory, maxSize, label });
});
registerBackend("IndexedDB", async (options) => {
  const { IndexedDB } = await import("@zenfs/dom");
  const storeName = options.storeName ?? "zen-fs-config";
  const label = options.label ?? storeName;
  return wrapZenFSFileSystem({ backend: IndexedDB, storeName, label });
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
var BACKENDS_FILE = `${META_DIR}/backends.json`;
var BACKENDS_DIR = `${META_DIR}/backends`;
var CONFLICTS_DIR = `${META_DIR}/.conflicts`;
var DELETIONS_DIR = `${META_DIR}/.deleted`;
var NODES_DIR = "/nodes";
var NODE_ID_FILE = `${NODES_DIR}/.node-id`;
var LOCAL_IDB_BACKEND_ID = "local-idb";
function tombstoneFileName(filePath) {
  return filePath.replace(/^\//, "").replace(/\//g, "__").replace(/\./g, "++") + ".json";
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
  onConflictCallback;
  disposed = false;
  configCache = /* @__PURE__ */ new Map();
  primaryBackendId;
  constructor(appId, nodeId, primaryBackendId, cachedFS, serializer, onConflict) {
    this.appId = appId;
    this.nodeId = nodeId;
    this.primaryBackendId = primaryBackendId;
    this.cachedFS = cachedFS;
    this.serializer = serializer;
    this.syncEngine = new ZenFSSync();
    this.replicaBackends = /* @__PURE__ */ new Map();
    this.onConflictCallback = onConflict;
    this.fullFS = backendToSyncableFS(cachedFS, primaryBackendId);
    this.fs = createChrootFS(cachedFS, `/${appId}`);
    this.rootFS = createChrootFS(cachedFS, "/");
  }
  /** Full path to this node's directory on the primary backend. */
  get nodePath() {
    return `/nodes/${this.nodeId}`;
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
    this.configCache.clear();
  }
  // -----------------------------------------------------------------------
  // Internal — Setup
  // -----------------------------------------------------------------------
  async setupSync(backends, primaryBackendId) {
    console.log(`[ConfigRepo] setupSync: ${backends.length} backends, primary=${primaryBackendId}`);
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
            conflictStrategy: "source-wins"
          },
          "/"
        );
        this.replicaBackends.set(desc.id, { instance, syncable, pairId: pair.pairId });
        const conflictHandler = (event) => {
          this.handleConflict(event);
        };
        this.syncEngine.on(pair.pairId, "conflict", conflictHandler);
        this.syncEngine.watch(pair.pairId);
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
  /** Read all backend descriptors from .meta/backends/*.json */
  async readAllBackendDescriptors() {
    try {
      const entries = await this.cachedFS.readdir(BACKENDS_DIR);
      const descriptors = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        try {
          const raw = await this.cachedFS.readFile(`${BACKENDS_DIR}/${entry}`);
          descriptors.push(JSON.parse(new TextDecoder().decode(toUint8Array(raw))));
        } catch {
        }
      }
      return descriptors;
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
    if (descriptors.length === 0) return null;
    return { version: 1, backends: descriptors };
  }
  async updateBackends(meta) {
    this.assertNotDisposed();
    await this.ensureDir(`${BACKENDS_DIR}/.keep`);
    for (const desc of meta.backends) {
      await this.writeBackendDescriptor(desc);
    }
    const keepIds = new Set(meta.backends.map((b) => b.id));
    const current = await this.readAllBackendDescriptors();
    for (const desc of current) {
      if (!keepIds.has(desc.id)) {
        await this.removeBackendDescriptor(desc.id);
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
    this.syncEngine.watch(pair.pairId);
    console.log(`[ConfigRepo] addBackend: ${id} (${type}) added, sync pair=${pair.pairId}`);
    await this.syncMetaToReplicas();
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
    this.syncEngine.removePair(replica.pairId);
    console.log(`[ConfigRepo] removeBackend: sync pair ${replica.pairId} removed`);
    this.replicaBackends.delete(id);
    if (replica.instance?.dispose) {
      await replica.instance.dispose();
    }
    await this.removeBackendDescriptor(id);
    console.log(`[ConfigRepo] removeBackend: ${id} removed`);
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
  const tempRepo = new ConfigRepo(
    appId,
    "",
    LOCAL_IDB_BACKEND_ID,
    cachedFS,
    createSerializerChain(),
    void 0
  );
  const oldBackendsMeta = await tempRepo.readMetaFile(BACKENDS_FILE);
  if (oldBackendsMeta && oldBackendsMeta.backends?.length > 0) {
    console.log(`[createConfigRepo] Migrating ${oldBackendsMeta.backends.length} backend(s) from backends.json to individual files...`);
    await tempRepo.ensureDir(`${BACKENDS_DIR}/.keep`);
    for (const desc of oldBackendsMeta.backends) {
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
  await tempRepo.ensureDir(`${BACKENDS_DIR}/.keep`);
  const existingBackends = await tempRepo.readAllBackendDescriptors();
  const hasLocalIdb = existingBackends.some((b) => b.id === LOCAL_IDB_BACKEND_ID);
  if (!hasLocalIdb) {
    await tempRepo.writeBackendDescriptor({
      id: LOCAL_IDB_BACKEND_ID,
      type: "IndexedDB",
      options: { storeName: idbStoreName },
      description: "Local IndexedDB primary backend"
    });
    console.log(`[createConfigRepo] Created local-idb descriptor`);
  }
  if (options.backendInfo) {
    const replicaId = options.primaryBackendId || `${options.backendInfo.type}-replica`;
    const allBackends2 = await tempRepo.readAllBackendDescriptors();
    const hasReplica = allBackends2.some((b) => b.id === replicaId);
    if (!hasReplica) {
      await tempRepo.writeBackendDescriptor({
        id: replicaId,
        type: options.backendInfo.type,
        options: options.backendInfo.options
      });
      console.log(`[createConfigRepo] Added replica backend: ${replicaId} (${options.backendInfo.type})`);
    } else {
      console.log(`[createConfigRepo] Replica ${replicaId} already registered`);
    }
  }
  const allBackends = await tempRepo.readAllBackendDescriptors();
  console.log(`[createConfigRepo] Backends: ${allBackends.map((b) => b.id).join(", ")}`);
  let nodeId = options.nodeId;
  if (!nodeId && typeof process !== "undefined" && process.env?.NODE_ID) {
    nodeId = process.env.NODE_ID;
  }
  if (!nodeId) {
    try {
      const raw = await cachedFS.readFile(NODE_ID_FILE);
      nodeId = new TextDecoder().decode(toUint8Array(raw)).trim();
    } catch {
    }
  }
  if (!nodeId) {
    nodeId = `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await cachedFS.writeFile(NODE_ID_FILE, new TextEncoder().encode(nodeId));
    } catch {
    }
  }
  const serializer = createSerializerChain(options.serializer);
  const repo = new ConfigRepo(
    appId,
    nodeId,
    LOCAL_IDB_BACKEND_ID,
    cachedFS,
    serializer,
    options.onConflict
  );
  await repo.setupSync(allBackends, LOCAL_IDB_BACKEND_ID);
  await repo.syncMetaToReplicas();
  await repo.load();
  return repo;
}
export {
  ConfigRepo,
  configKeyToFilePath,
  createBackend,
  createConfigRepo,
  createSerializerChain,
  getExtension,
  hasBackend,
  incrementVersion,
  listBackends,
  readVersion,
  registerBackend,
  sha256,
  unregisterBackend,
  verifyOrRepairVersion,
  versionPathFor,
  wrapZenFSFileSystem,
  writeVersion
};
