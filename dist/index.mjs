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
  const token = options.token ?? "";
  const owner = options.owner ?? "";
  const repo = options.repo ?? "";
  const branch = options.branch ?? "main";
  const baseUrl = options.baseUrl ?? "https://api.github.com";
  if (!owner || !repo) throw new Error('GitHub backend requires "owner" and "repo" options');
  const headers = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "zen-fs-config"
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const apiUrl = (path) => {
    const p = path.startsWith("/") ? path.slice(1) : path;
    return `${baseUrl}/repos/${owner}/${repo}/contents/${p}?ref=${branch}`;
  };
  const treeUrl = () => `${baseUrl}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  const ghStat = (item) => ({
    isFile: () => item.type === "file",
    isDirectory: () => item.type === "dir",
    size: item.size ?? 0
  });
  const fetchJson = async (url) => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);
    return res.json();
  };
  const backend = {
    async readFile(path, ...args) {
      const data = await fetchJson(apiUrl(path));
      if (data.encoding === "base64") {
        const raw = Uint8Array.from(atob(data.content), (c) => c.charCodeAt(0));
        if (args[0] === "utf-8") return new TextDecoder().decode(raw);
        return raw;
      }
      return data;
    },
    async writeFile(path, data, options2) {
      const message = options2?.message || `Update ${path}`;
      const content = typeof data === "string" ? btoa(unescape(encodeURIComponent(data))) : btoa(String.fromCharCode(...new Uint8Array(data)));
      const sha = await (async () => {
        try {
          const d = await fetchJson(apiUrl(path));
          return d.sha;
        } catch {
          return void 0;
        }
      })();
      await fetch(apiUrl(path), {
        method: "PUT",
        headers,
        body: JSON.stringify({ message, content, sha, branch })
      });
    },
    async readdir(path) {
      const data = await fetchJson(apiUrl(path));
      return data.map((item) => item.name);
    },
    async stat(path, ...args) {
      try {
        const data = await fetchJson(apiUrl(path));
        if (Array.isArray(data)) {
          return { isFile: () => false, isDirectory: () => true, size: 0 };
        }
        return ghStat(data);
      } catch {
        throw new Error(`ENOENT: ${path}`);
      }
    },
    async exists(path) {
      try {
        await fetchJson(apiUrl(path));
        return true;
      } catch {
        return false;
      }
    },
    async mkdir(path, options2) {
      const dirPath = path.replace(/\/$/, "");
      const keepPath = `${dirPath}/.gitkeep`;
      const message = options2?.message || `Create directory ${dirPath}`;
      const content = btoa("");
      await fetch(apiUrl(keepPath), {
        method: "PUT",
        headers,
        body: JSON.stringify({ message, content, branch })
      });
    },
    async unlink(path) {
      const data = await fetchJson(apiUrl(path));
      await fetch(apiUrl(path), {
        method: "DELETE",
        headers,
        body: JSON.stringify({ message: `Delete ${path}`, sha: data.sha, branch })
      });
    },
    async rmdir(path) {
      const items = await fetchJson(apiUrl(path));
      if (Array.isArray(items)) {
        for (const item of items) {
          const itemPath = `${path}/${item.name}`;
          if (item.type === "dir") {
            await backend.rmdir(itemPath);
          } else {
            await backend.unlink(itemPath);
          }
        }
      }
    },
    async rename(oldPath, newPath) {
      const content = await backend.readFile(oldPath);
      await backend.writeFile(newPath, content);
      await backend.unlink(oldPath);
    }
  };
  return backend;
});
registerBackend("Gitee", async (options) => {
  const token = options.token ?? "";
  const owner = options.owner ?? "";
  const repo = options.repo ?? "";
  const branch = options.branch ?? "master";
  const baseUrl = options.baseUrl ?? "https://gitee.com/api/v5";
  if (!owner || !repo) throw new Error('Gitee backend requires "owner" and "repo" options');
  const fetchJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gitee API ${res.status}: ${url}`);
    return res.json();
  };
  const apiUrl = (path) => {
    const p = path.startsWith("/") ? path.slice(1) : path;
    const params = new URLSearchParams({ access_token: token, ref: branch, path: p });
    return `${baseUrl}/repos/${owner}/${repo}/contents?${params}`;
  };
  const ghStat = (item) => ({
    isFile: () => item.type === "file",
    isDirectory: () => item.type === "dir",
    size: item.size ?? 0
  });
  const backend = {
    async readFile(path, ...args) {
      const data = await fetchJson(apiUrl(path));
      if (data.content) {
        const raw = Uint8Array.from(atob(data.content), (c) => c.charCodeAt(0));
        if (args[0] === "utf-8") return new TextDecoder().decode(raw);
        return raw;
      }
      return data;
    },
    async writeFile(path, data, options2) {
      const message = options2?.message || `Update ${path}`;
      const content = typeof data === "string" ? btoa(unescape(encodeURIComponent(data))) : btoa(String.fromCharCode(...new Uint8Array(data)));
      const sha = await (async () => {
        try {
          const d = await fetchJson(apiUrl(path));
          return d.sha;
        } catch {
          return void 0;
        }
      })();
      await fetch(apiUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: token, message, content, sha, branch })
      });
    },
    async readdir(path) {
      const data = await fetchJson(apiUrl(path));
      return Array.isArray(data) ? data.map((i) => i.name) : [];
    },
    async stat(path) {
      try {
        const data = await fetchJson(apiUrl(path));
        if (Array.isArray(data)) return ghStat({ type: "dir", size: 0 });
        return ghStat(data);
      } catch {
        throw new Error(`ENOENT: ${path}`);
      }
    },
    async exists(path) {
      try {
        await fetchJson(apiUrl(path));
        return true;
      } catch {
        return false;
      }
    },
    async mkdir(path, options2) {
      const dirPath = path.replace(/\/$/, "");
      const keepPath = `${dirPath}/.gitkeep`;
      const message = options2?.message || `Create directory ${dirPath}`;
      await fetch(apiUrl(keepPath), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: token, message, content: btoa(""), branch })
      });
    },
    async unlink(path) {
      const data = await fetchJson(apiUrl(path));
      await fetch(apiUrl(path), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: token, message: `Delete ${path}`, sha: data.sha, branch })
      });
    },
    async rmdir(path) {
      const items = await fetchJson(apiUrl(path));
      if (Array.isArray(items)) {
        for (const item of items) {
          const itemPath = `${path}/${item.name}`;
          if (item.type === "dir") await backend.rmdir(itemPath);
          else await backend.unlink(itemPath);
        }
      }
    },
    async rename(oldPath, newPath) {
      const content = await backend.readFile(oldPath);
      await backend.writeFile(newPath, content);
      await backend.unlink(oldPath);
    }
  };
  return backend;
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
    this.syncEngine = new ZenFSSync();
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
          direction: SyncDirection.OneWay,
          conflictStrategy: "source-wins"
          // No filter = sync everything under nodePath
        },
        this.nodePath
      );
      console.log(`[ConfigRepo] Sync pair added: pairId=${pair.pairId}, replica=${replicaId}, root=${this.nodePath}`);
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
  verifyOrRepairVersion,
  versionPathFor,
  writeVersion
};
