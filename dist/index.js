"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  ConfigRepo: () => ConfigRepo,
  configKeyToFilePath: () => configKeyToFilePath,
  createBackend: () => createBackend,
  createConfigRepo: () => createConfigRepo,
  createSerializerChain: () => createSerializerChain,
  getExtension: () => getExtension,
  hasBackend: () => hasBackend,
  incrementVersion: () => incrementVersion,
  listBackends: () => listBackends,
  readVersion: () => readVersion,
  registerBackend: () => registerBackend,
  sha256: () => sha256,
  verifyOrRepairVersion: () => verifyOrRepairVersion,
  versionPathFor: () => versionPathFor,
  writeVersion: () => writeVersion
});
module.exports = __toCommonJS(index_exports);

// src/config-repo.ts
var import_zen_fs_sync = require("zen-fs-sync");

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
      if (typeof s.isFile === "function" && typeof s.isDirectory === "function") {
        return s;
      }
      const isDir = typeof s.isDirectory === "function" ? s.isDirectory() : typeof s.isDirectory === "boolean" ? s.isDirectory : s.mode !== void 0 && (s.mode & 61440) === 16384;
      return {
        ...s,
        isFile: () => !isDir,
        isDirectory: () => isDir
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
function backendToSyncableFS(backend) {
  return {
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
        isFile: typeof s.isFile === "function" ? () => s.isFile() : () => !!(s.mode && !(s.mode & 16384)),
        isDirectory: typeof s.isDirectory === "function" ? () => s.isDirectory() : () => !!(s.mode && s.mode & 16384),
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
}
function cachedFSToSyncableFS(cached) {
  return {
    async readdir(path) {
      return cached.readdir(path);
    },
    async readFile(path, encoding) {
      const data = await cached.readFile(path);
      if (encoding) {
        if (typeof data === "string") return data;
        return new TextDecoder().decode(
          data instanceof ArrayBuffer ? new Uint8Array(data) : data
        );
      }
      if (typeof data === "string") return Buffer.from(data);
      if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
      return Buffer.from(data);
    },
    async writeFile(path, data) {
      return cached.writeFile(path, data);
    },
    async unlink(path) {
      return cached.unlink(path);
    },
    async stat(path) {
      const s = await cached.stat(path);
      const isDir = typeof s.isDirectory === "function" ? s.isDirectory() : typeof s.isDirectory === "boolean" ? s.isDirectory : s.mode !== void 0 && (s.mode & 61440) === 16384;
      return {
        isFile: () => !isDir,
        isDirectory: () => isDir,
        size: s.size,
        mtimeMs: s.mtimeMs ?? s.mtime
      };
    },
    async mkdir(path, options) {
      return cached.mkdir(path, options);
    },
    async exists(path) {
      return cached.exists(path);
    }
  };
}

// src/backend-registry.ts
var registry = /* @__PURE__ */ new Map();
function registerBackend(type, factory) {
  registry.set(type, factory);
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
      const isDir = typeof st.isDirectory === "function" ? st.isDirectory() : st.mode !== void 0 && (st.mode & 61440) === 16384;
      return {
        isFile: () => !isDir,
        isDirectory: () => isDir,
        size: st.size,
        mtime: st.mtimeMs ?? st.mtime
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
var idbCounter = 0;
registerBackend("IndexedDB", async (options) => {
  const { IndexedDB } = await import("@zenfs/dom");
  const storeName = options.storeName ?? `zen-fs-config-${++idbCounter}`;
  return wrapZenFSFileSystem({ backend: IndexedDB, storeName });
});
registerBackend("WebStorage", async (options) => {
  const { WebStorage } = await import("@zenfs/dom");
  const storageType = options.storageType ?? "localStorage";
  let storage;
  if (storageType === "sessionStorage" && typeof sessionStorage !== "undefined") {
    storage = sessionStorage;
  } else {
    storage = localStorage;
  }
  return wrapZenFSFileSystem({ backend: WebStorage, storage });
});
registerBackend("GitHub", async (options) => {
  const { Github } = await import("zen-fs-github");
  return wrapZenFSFileSystem({
    backend: Github,
    token: options.token,
    owner: options.owner,
    repo: options.repo,
    branch: options.branch,
    baseUrl: options.baseUrl && options.baseUrl.trim() || void 0
  });
});
registerBackend("Gitee", async (options) => {
  const zenGitee = await import("zen-fs-gitee");
  const { GiteeFS } = zenGitee;
  const origInit = GiteeFS.prototype.init;
  const patched = /* @__PURE__ */ new WeakSet();
  GiteeFS.prototype.init = async function() {
    let firstErr;
    try {
      return await origInit.call(this);
    } catch (err) {
      if (!err.message?.includes("404") && !err.message?.includes("Tree not found")) {
        throw err;
      }
      firstErr = err;
    }
    if (patched.has(this)) throw firstErr;
    patched.add(this);
    console.log(`[Gitee] init failed with branch="${this.api.branch}", resolving to SHA...`);
    const baseUrl = this.api.baseUrl || "https://gitee.com/api/v5";
    const auth = `access_token=${this.api.token}`;
    const branchUrl = `${baseUrl}/repos/${this.api.owner}/${this.api.repo}/branches/${this.api.branch}?${auth}`;
    let branchRes = await fetch(branchUrl);
    let branchData;
    if (branchRes.ok) {
      branchData = await branchRes.json();
    } else {
      console.log(`[Gitee] Branch "${this.api.branch}" not found, creating...`);
      const defaultBranch = this.api.branch === "master" ? "main" : "master";
      let defaultSha;
      for (const name of [defaultBranch, "main", "master"]) {
        const dr = await fetch(`${baseUrl}/repos/${this.api.owner}/${this.api.repo}/branches/${name}?${auth}`);
        if (dr.ok) {
          const dd = await dr.json();
          defaultSha = dd.commit?.sha;
          if (defaultSha) break;
        }
      }
      if (!defaultSha) {
        console.log(`[Gitee] No branches found in repo, skipping tree init`);
        this.initialized = true;
        return;
      }
      const createRes = await fetch(`${baseUrl}/repos/${this.api.owner}/${this.api.repo}/branches?${auth}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refs: defaultSha,
          branch_name: this.api.branch
        })
      });
      if (!createRes.ok) {
        const errText = await createRes.text().catch(() => "");
        throw new Error(`Gitee: failed to create branch "${this.api.branch}": ${createRes.status} ${errText}`);
      }
      branchData = await createRes.json();
      console.log(`[Gitee] Branch "${this.api.branch}" created from ${defaultSha.slice(0, 8)}`);
    }
    const commitSha = branchData.commit?.sha;
    if (!commitSha) throw new Error(`Gitee: could not get commit SHA for branch "${this.api.branch}"`);
    const commitUrl = `${baseUrl}/repos/${this.api.owner}/${this.api.repo}/git/commits/${commitSha}?${auth}`;
    const commitRes = await fetch(commitUrl);
    if (!commitRes.ok) throw new Error(`Gitee: commit ${commitSha} not found (${commitRes.status})`);
    const commitData = await commitRes.json();
    const treeSha = commitData.tree?.sha;
    if (!treeSha) throw new Error(`Gitee: could not get tree SHA from commit ${commitSha}`);
    const realBranch = this.api.branch;
    this.api.branch = treeSha;
    console.log(`[Gitee] Resolved branch="${realBranch}" \u2192 commit=${commitSha.slice(0, 8)} \u2192 tree=${treeSha.slice(0, 8)}`);
    try {
      return await origInit.call(this);
    } finally {
      this.api.branch = realBranch;
    }
  };
  return wrapZenFSFileSystem({
    backend: zenGitee.Gitee,
    token: options.token,
    owner: options.owner,
    repo: options.repo,
    branch: options.branch,
    baseUrl: options.baseUrl && options.baseUrl.trim() || void 0
  });
});
registerBackend("WebDAV", async (options) => {
  const url = options.url ?? "";
  const username = options.username ?? "";
  const password = options.password ?? "";
  const rootPath = options.rootPath ?? "/";
  if (!url) throw new Error('WebDAV backend requires "url" option');
  const authHeader = username ? `Basic ${btoa(`${username}:${password}`)}` : "";
  const davUrl = (path) => {
    const cleanRoot = rootPath.replace(/\/$/, "");
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    return `${url.replace(/\/$/, "")}${cleanRoot}${cleanPath}`;
  };
  const davFetch = async (path, method, body) => {
    const headers = {};
    if (authHeader) headers["Authorization"] = authHeader;
    if (body) headers["Content-Type"] = "application/xml";
    const res = await fetch(davUrl(path), { method, headers, body });
    if (!res.ok && res.status !== 404) throw new Error(`WebDAV ${res.status} ${method} ${davUrl(path)}`);
    return res;
  };
  const parseMultiStatus = async (res) => {
    const text = await res.text();
    const results = [];
    const responses = text.match(/<D:response[^>]*>[\s\S]*?<\/D:response>/gi) || [];
    for (const resp of responses) {
      const href = (resp.match(/<D:href>([^<]+)<\/D:href>/i) || [])[1] || "";
      const isDir = /<D:collection\s*\/>/i.test(resp) || /<D:resourcetype>.*<D:collection/.test(resp);
      const sizeMatch = resp.match(/<D:getcontentlength>([^<]+)<\/D:getcontentlength>/i);
      const size = sizeMatch ? parseInt(sizeMatch[1]) : 0;
      const decoded = decodeURIComponent(href);
      results.push({ path: decoded, isDir, size });
    }
    return results;
  };
  const exists = async (path) => {
    const res = await davFetch(path, "PROPFIND");
    return res.ok;
  };
  const backend = {
    async readFile(path, ...args) {
      const res = await davFetch(path, "GET");
      if (!res.ok) throw new Error(`ENOENT: ${path}`);
      if (args[0] === "utf-8") return res.text();
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    },
    async writeFile(path, data, _options) {
      const headers = { "Content-Type": "application/octet-stream" };
      if (authHeader) headers["Authorization"] = authHeader;
      await fetch(davUrl(path), {
        method: "PUT",
        headers,
        body: data instanceof ArrayBuffer ? data : data instanceof Uint8Array ? new Uint8Array(data).buffer : new TextEncoder().encode(data)
      });
    },
    async readdir(path) {
      const headers = { Depth: "1" };
      if (authHeader) headers["Authorization"] = authHeader;
      const res = await fetch(davUrl(path), { method: "PROPFIND", headers });
      if (!res.ok) throw new Error(`WebDAV PROPFIND failed: ${res.status}`);
      const items = await parseMultiStatus(res);
      const prefix = davUrl(path);
      return items.filter((i) => i.path !== prefix && i.path !== `${prefix}/`).map((i) => i.path.split("/").filter(Boolean).pop() || "");
    },
    async stat(path) {
      const headers = { Depth: "0" };
      if (authHeader) headers["Authorization"] = authHeader;
      const res = await fetch(davUrl(path), { method: "PROPFIND", headers });
      if (!res.ok) throw new Error(`ENOENT: ${path}`);
      const items = await parseMultiStatus(res);
      const item = items[0];
      return { isFile: () => !item.isDir, isDirectory: () => item.isDir, size: item.size };
    },
    async exists(path) {
      return exists(path);
    },
    async mkdir(path) {
      const headers = {};
      if (authHeader) headers["Authorization"] = authHeader;
      const res = await fetch(davUrl(path), { method: "MKCOL", headers });
      if (!res.ok && res.status !== 405) throw new Error(`WebDAV MKCOL failed: ${res.status}`);
    },
    async unlink(path) {
      await davFetch(path, "DELETE");
    },
    async rmdir(path) {
      const items = await (async () => {
        const headers = { Depth: "1" };
        if (authHeader) headers["Authorization"] = authHeader;
        const res = await fetch(davUrl(path), { method: "PROPFIND", headers });
        if (!res.ok) return [];
        const parsed = await parseMultiStatus(res);
        const prefix = davUrl(path);
        return parsed.filter((i) => i.path !== prefix && i.path !== `${prefix}/`);
      })();
      for (const item of items) {
        if (item.isDir) await backend.rmdir(item.path);
        else await backend.unlink(item.path);
      }
      await davFetch(path, "DELETE");
    },
    async rename(oldPath, newPath) {
      const headers = { Destination: davUrl(newPath) };
      if (authHeader) headers["Authorization"] = authHeader;
      await fetch(davUrl(oldPath), { method: "MOVE", headers });
    }
  };
  return backend;
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
  const nodeCrypto = await import("crypto");
  const hash = nodeCrypto.createHash("sha256").update(Buffer.from(buffer)).digest("hex");
  return `sha256:${hash}`;
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
var SYNC_RULES_FILE = `${META_DIR}/sync-rules.json`;
var CONFLICTS_DIR = `${META_DIR}/.conflicts`;
var NODES_DIR = "/nodes";
var SHARED_DIR = "/shared";
var NODE_ID_FILE = `${NODES_DIR}/.node-id`;
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
  constructor(appId, nodeId, cachedFS, serializer, onConflict) {
    this.appId = appId;
    this.nodeId = nodeId;
    this.cachedFS = cachedFS;
    this.serializer = serializer;
    this.syncEngine = new import_zen_fs_sync.ZenFSSync();
    this.replicaBackends = /* @__PURE__ */ new Map();
    this.onConflictCallback = onConflict;
    this.fullFS = cachedFSToSyncableFS(cachedFS);
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
        await this.writeMetaFile(BACKENDS_FILE, {
          version: 1,
          backends: data.backends
        });
      }
      if (data.syncRules) {
        await this.writeMetaFile(SYNC_RULES_FILE, {
          version: 1,
          rules: data.syncRules
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
          direction: import_zen_fs_sync.SyncDirection.OneWay,
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
        direction: import_zen_fs_sync.SyncDirection.OneWay,
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
    const resultsMap = await this.syncEngine.syncAll();
    return Array.from(resultsMap.values());
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
    const archivePath = `${CONFLICTS_DIR}/${conflictId}`;
    try {
      const raw = await this.cachedFS.readFile(archivePath);
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
      archive.resolvedContent = mergedContent;
      await this.cachedFS.writeFile(
        archivePath,
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
        if (!entry.endsWith(".json")) continue;
        try {
          const raw = await this.cachedFS.readFile(`${CONFLICTS_DIR}/${entry}`);
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
        const syncable = backendToSyncableFS(instance);
        this.replicaBackends.set(desc.id, { instance, syncable });
        console.log(`[ConfigRepo] Replica ${desc.id} created successfully`);
      } catch (err) {
        console.error(`[ConfigRepo] Failed to create replica ${desc.id} (${desc.type}):`, err);
      }
    }
    console.log(`[ConfigRepo] Available replicas:`, Array.from(this.replicaBackends.keys()));
    for (const [replicaId, replica] of this.replicaBackends.entries()) {
      const pair = this.syncEngine.addPair(
        this.fullFS,
        replica.syncable,
        {
          direction: import_zen_fs_sync.SyncDirection.OneWay,
          conflictStrategy: "source-wins"
          // No filter = sync everything under root
        },
        "/"
      );
      console.log(`[ConfigRepo] Sync pair added: pairId=${pair.pairId}, replica=${replicaId}, root=/`);
      const conflictHandler = (event) => {
        this.handleConflict(event, { prefix: "/", direction: "one-way" });
      };
      this.syncEngine.on(pair.pairId, "conflict", conflictHandler);
      this.syncEngine.watch(pair.pairId);
    }
    console.log(`[ConfigRepo] setupSync complete. Sync statuses:`, this.getSyncStatuses());
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
  async handleConflict(event, _rule) {
    const conflict = event.conflict;
    if (!conflict) return;
    const archive = {
      conflictPath: conflict.path,
      timestamp: event.timestamp,
      sourceAuthor: `${this.appId}/${this.nodeId}`,
      targetAuthor: "unknown",
      sourceContent: this.tryParse(conflict.sourceContent),
      targetContent: this.tryParse(conflict.targetContent),
      sourceVersion: 0,
      targetVersion: 0,
      resolvedStrategy: conflict.resolvedWith
    };
    try {
      const srcVer = await readVersion(this.fullFS, versionPathFor(conflict.path));
      if (srcVer) archive.sourceVersion = srcVer.version;
    } catch {
    }
    const archiveFileName = `${event.timestamp}_${conflict.path.replace(/\//g, "_")}.conflict.json`;
    const archivePath = `${CONFLICTS_DIR}/${archiveFileName}`;
    await this.ensureDir(archivePath);
    await this.cachedFS.writeFile(
      archivePath,
      new TextEncoder().encode(JSON.stringify(archive, null, 2))
    );
    if (this.onConflictCallback) {
      const info = {
        conflictId: archiveFileName,
        path: conflict.path,
        sourceAuthor: archive.sourceAuthor,
        targetAuthor: archive.targetAuthor,
        sourceContent: archive.sourceContent,
        targetContent: archive.targetContent
      };
      try {
        const customMerge = await this.onConflictCallback(info);
        if (customMerge !== null && customMerge !== void 0) {
          await this.resolveConflict(archiveFileName, customMerge);
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
      const exists = await this.fullFS.exists(current);
      console.log(`[ensureDir] ${current} exists=${exists}`);
      if (!exists) {
        try {
          console.log(`[ensureDir] mkdir(${current})`);
          await this.fullFS.mkdir(current);
          console.log(`[ensureDir] mkdir(${current}) OK`);
        } catch (err) {
          console.error(`[ensureDir] mkdir(${current}) FAILED:`, err.message);
        }
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
            if (stat.isDirectory()) {
              stack.push(fullPath);
            } else if (stat.isFile()) {
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
    console.log(`[writeMetaFile] ${path}, ensuring dir...`);
    await this.ensureDir(path);
    console.log(`[writeMetaFile] ${path}, writing ${JSON.stringify(data).length} bytes...`);
    await this.cachedFS.writeFile(
      path,
      new TextEncoder().encode(JSON.stringify(data, null, 2))
    );
    console.log(`[writeMetaFile] ${path} done`);
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
  // IConfigRepo — Meta file access (no chroot)
  // -----------------------------------------------------------------------
  async getBackends() {
    this.assertNotDisposed();
    return this.readMetaFile(BACKENDS_FILE);
  }
  async updateBackends(meta) {
    this.assertNotDisposed();
    await this.writeMetaFile(BACKENDS_FILE, meta);
  }
  async getSyncRules() {
    this.assertNotDisposed();
    return this.readMetaFile(SYNC_RULES_FILE);
  }
  async updateSyncRules(meta) {
    this.assertNotDisposed();
    await this.writeMetaFile(SYNC_RULES_FILE, meta);
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
async function createConfigRepo(appId, options) {
  const primaryInstance = await createBackend({
    type: options.backendInfo.type,
    options: options.backendInfo.options
  });
  const zenCache = await import("zen-fs-cache");
  let cacheStore;
  const storeType = options.cache?.storeType ?? "MemoryCacheStore";
  if (storeType === "IdbCacheStore") {
    cacheStore = new zenCache.IdbCacheStore(options.cache?.storePrefix);
  } else {
    cacheStore = new zenCache.MemoryCacheStore();
  }
  const cachedFS = new zenCache.CachedFileSystem(
    primaryInstance,
    cacheStore,
    {
      ttlMs: options.cache?.ttlMs ?? 0
    }
  );
  try {
    const metaExists = await primaryInstance.exists(META_DIR);
    console.log(`[createConfigRepo] /.meta/ exists: ${metaExists}`);
    if (!metaExists) {
      console.log(`[createConfigRepo] Creating /.meta/ via primaryInstance...`);
      await primaryInstance.mkdir(META_DIR);
      console.log(`[createConfigRepo] /.meta/ created`);
    }
  } catch (err) {
    console.error(`[createConfigRepo] Failed to ensure /.meta/:`, err.message);
  }
  const tempRepo = new ConfigRepo(
    appId,
    "",
    cachedFS,
    createSerializerChain(),
    void 0
  );
  let backendsMeta = await tempRepo.readMetaFile(BACKENDS_FILE);
  if (!backendsMeta) {
    if (options.bootstrap) {
      backendsMeta = {
        version: 1,
        backends: options.bootstrap.backends
      };
      console.log(`[createConfigRepo] First init: using bootstrap backends: ${backendsMeta.backends.map((b) => b.id).join(", ")}`);
    } else {
      backendsMeta = {
        version: 1,
        backends: [
          {
            id: options.primaryBackendId,
            type: options.backendInfo.type,
            options: options.backendInfo.options
          }
        ]
      };
    }
  } else {
    console.log(`[createConfigRepo] Reconnect: using stored backends: ${backendsMeta.backends.map((b) => b.id).join(", ")}`);
  }
  const hasPrimary = backendsMeta.backends.some(
    (b) => b.id === options.primaryBackendId
  );
  if (!hasPrimary) {
    backendsMeta.backends.unshift({
      id: options.primaryBackendId,
      type: options.backendInfo.type,
      options: options.backendInfo.options
    });
  }
  await tempRepo.writeMetaFile(BACKENDS_FILE, backendsMeta);
  let syncRulesMeta = await tempRepo.readMetaFile(SYNC_RULES_FILE);
  if (!syncRulesMeta) {
    if (options.bootstrap) {
      syncRulesMeta = {
        version: 1,
        rules: options.bootstrap.syncRules
      };
      console.log(`[createConfigRepo] First init: using bootstrap syncRules: ${syncRulesMeta.rules.length} rules`);
    } else {
      syncRulesMeta = {
        version: 1,
        rules: [
          {
            prefix: `/${appId}/`,
            direction: "one-way",
            conflictStrategy: "source-wins",
            replicas: backendsMeta.backends.map((b) => b.id)
          },
          {
            prefix: `${SHARED_DIR}/`,
            direction: "bi-directional",
            conflictStrategy: "merge",
            replicas: backendsMeta.backends.map((b) => b.id)
          },
          { prefix: `${NODES_DIR}/`, direction: "none" },
          { prefix: `${META_DIR}/`, direction: "none" }
        ]
      };
    }
  }
  if (syncRulesMeta) {
    console.log(`[createConfigRepo] Reconnect: using stored syncRules: ${syncRulesMeta.rules.length} rules`);
  }
  await tempRepo.writeMetaFile(SYNC_RULES_FILE, syncRulesMeta);
  let nodeId = options.nodeId;
  if (!nodeId) {
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
      await cachedFS.writeFile(
        NODE_ID_FILE,
        new TextEncoder().encode(nodeId)
      );
    } catch {
    }
  }
  const serializer = createSerializerChain(options.serializer);
  const repo = new ConfigRepo(
    appId,
    nodeId,
    cachedFS,
    serializer,
    options.onConflict
  );
  await repo.setupSync(
    backendsMeta.backends,
    options.primaryBackendId
  );
  await repo.load();
  return repo;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
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
  verifyOrRepairVersion,
  versionPathFor,
  writeVersion
});
