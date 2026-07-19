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
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, BackendFactory>();

export function registerBackend(type: string, factory: BackendFactory): void {
  registry.set(type, factory);
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

// ---------------------------------------------------------------------------
// Built-in: InMemory Backend
// ---------------------------------------------------------------------------

/**
 * Wrap ZenFS fs.promises into a BackendInstance.
 *
 * ZenFS backends (StoreFS) use their own internal API (write, stat, mkdir, …).
 * CachedFileSystem needs Node.js-style async API (readFile, writeFile, …).
 * ZenFS provides the Node.js compat layer via `fs.promises` from `@zenfs/core`,
 * but only *after* a backend is configured via `configureSingle`.
 *
 * We isolate each backend into a separate ZenFS instance using Port/Worker,
 * but for InMemory (sync) the simplest approach is to configure VFS once
 * and use fs.promises.
 *
 * To support multiple InMemory instances, we use a counter to create
 * unique Port channels.
 */
let inMemoryCounter = 0;

registerBackend('InMemory', async (options) => {
  const zenfs = await import('@zenfs/core');
  const { InMemory } = zenfs;

  const maxSize = (options.maxSize as number) ?? 100 * 1024 * 1024;
  const label = (options.label as string) ?? `zen-fs-config-${++inMemoryCounter}`;

  // configureSingle sets up the global ZenFS VFS with the given backend.
  // It returns void — the configured fs is accessed via the `fs` re-export.
  await zenfs.configureSingle({ backend: InMemory, maxSize, label });

  // fs.promises has Node.js-style async API: readFile, writeFile, etc.
  const pfs = (zenfs.fs as any).promises;

  const backend: BackendInstance = {
    async readFile(path: string, ...args: any[]): Promise<any> {
      // ZenFS fs.promises.readFile supports (path, encoding) and (path, options)
      if (args.length > 0) {
        return pfs.readFile(path, ...args);
      }
      return pfs.readFile(path);
    },
    async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: any): Promise<void> {
      return pfs.writeFile(path, data, options);
    },
    async readdir(path: string): Promise<string[]> {
      const entries = await pfs.readdir(path);
      return entries.map((e: any) => typeof e === 'string' ? e : e.name);
    },
    async stat(path: string, ...args: any[]): Promise<any> {
      return pfs.stat(path, ...args);
    },
    async exists(path: string): Promise<boolean> {
      try { await pfs.stat(path); return true; } catch { return false; }
    },
    async mkdir(path: string, options?: any): Promise<any> {
      return pfs.mkdir(path, options);
    },
    async unlink(path: string): Promise<void> {
      return pfs.unlink(path);
    },
    async rmdir(path: string): Promise<void> {
      return pfs.rmdir(path);
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      return pfs.rename(oldPath, newPath);
    },
  };

  return backend;
});

// ---------------------------------------------------------------------------
// Built-in: IndexedDB (via @zenfs/dom)
// ---------------------------------------------------------------------------

let idbCounter = 0;

registerBackend('IndexedDB', async (options) => {
  const zenfs = await import('@zenfs/core');
  const { IndexedDB } = await import('@zenfs/dom');

  const storeName = (options.storeName as string) ?? `zen-fs-config-${++idbCounter}`;

  await zenfs.configureSingle({ backend: IndexedDB, storeName });

  const pfs = (zenfs.fs as any).promises;

  const backend: BackendInstance = {
    async readFile(path: string, ...args: any[]): Promise<any> {
      return args.length > 0 ? pfs.readFile(path, ...args) : pfs.readFile(path);
    },
    async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: any): Promise<void> {
      return pfs.writeFile(path, data, options);
    },
    async readdir(path: string): Promise<string[]> {
      const entries = await pfs.readdir(path);
      return entries.map((e: any) => typeof e === 'string' ? e : e.name);
    },
    async stat(path: string, ...args: any[]): Promise<any> {
      return pfs.stat(path, ...args);
    },
    async exists(path: string): Promise<boolean> {
      try { await pfs.stat(path); return true; } catch { return false; }
    },
    async mkdir(path: string, options?: any): Promise<any> {
      return pfs.mkdir(path, options);
    },
    async unlink(path: string): Promise<void> {
      return pfs.unlink(path);
    },
    async rmdir(path: string): Promise<void> {
      return pfs.rmdir(path);
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      return pfs.rename(oldPath, newPath);
    },
  };

  return backend;
});

// ---------------------------------------------------------------------------
// Built-in: WebStorage / LocalStorage (via @zenfs/dom)
// ---------------------------------------------------------------------------

registerBackend('WebStorage', async (options) => {
  const zenfs = await import('@zenfs/core');
  const { WebStorage } = await import('@zenfs/dom');

  const storageType = (options.storageType as string) ?? 'localStorage';

  let storage: Storage;
  if (storageType === 'sessionStorage' && typeof sessionStorage !== 'undefined') {
    storage = sessionStorage;
  } else {
    storage = localStorage;
  }

  await zenfs.configureSingle({ backend: WebStorage, storage } as any);

  const pfs = (zenfs.fs as any).promises;

  const backend: BackendInstance = {
    async readFile(path: string, ...args: any[]): Promise<any> {
      return args.length > 0 ? pfs.readFile(path, ...args) : pfs.readFile(path);
    },
    async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: any): Promise<void> {
      return pfs.writeFile(path, data, options);
    },
    async readdir(path: string): Promise<string[]> {
      const entries = await pfs.readdir(path);
      return entries.map((e: any) => typeof e === 'string' ? e : e.name);
    },
    async stat(path: string, ...args: any[]): Promise<any> {
      return pfs.stat(path, ...args);
    },
    async exists(path: string): Promise<boolean> {
      try { await pfs.stat(path); return true; } catch { return false; }
    },
    async mkdir(path: string, options?: any): Promise<any> {
      return pfs.mkdir(path, options);
    },
    async unlink(path: string): Promise<void> {
      return pfs.unlink(path);
    },
    async rmdir(path: string): Promise<void> {
      return pfs.rmdir(path);
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      return pfs.rename(oldPath, newPath);
    },
  };

  return backend;
});

// ---------------------------------------------------------------------------
// Built-in: GitHub (raw content API)
// ---------------------------------------------------------------------------

registerBackend('GitHub', async (options) => {
  const token = (options.token as string) ?? '';
  const owner = (options.owner as string) ?? '';
  const repo = (options.repo as string) ?? '';
  const branch = (options.branch as string) ?? 'main';
  const baseUrl = (options.baseUrl as string) ?? 'https://api.github.com';

  if (!owner || !repo) throw new Error('GitHub backend requires "owner" and "repo" options');

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'zen-fs-config',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const apiUrl = (path: string) => {
    const p = path.startsWith('/') ? path.slice(1) : path;
    return `${baseUrl}/repos/${owner}/${repo}/contents/${p}?ref=${branch}`;
  };

  const treeUrl = () => `${baseUrl}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;

  const ghStat = (item: any): { isFile: () => boolean; isDirectory: () => boolean; size: number } => ({
    isFile: () => item.type === 'file',
    isDirectory: () => item.type === 'dir',
    size: item.size ?? 0,
  });

  const fetchJson = async (url: string): Promise<any> => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);
    return res.json();
  };

  const backend: BackendInstance = {
    async readFile(path: string, ...args: any[]): Promise<any> {
      const data = await fetchJson(apiUrl(path));
      if (data.encoding === 'base64') {
        const raw = Uint8Array.from(atob(data.content), c => c.charCodeAt(0));
        if (args[0] === 'utf-8') return new TextDecoder().decode(raw);
        return raw;
      }
      return data;
    },
    async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: any): Promise<void> {
      const message = (options as any)?.message || `Update ${path}`;
      const content = typeof data === 'string' ? btoa(unescape(encodeURIComponent(data))) : btoa(String.fromCharCode(...new Uint8Array(data)));
      const sha = await (async () => {
        try { const d = await fetchJson(apiUrl(path)); return d.sha; } catch { return undefined; }
      })();
      await fetch(apiUrl(path), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ message, content, sha, branch }),
      });
    },
    async readdir(path: string): Promise<string[]> {
      const data = await fetchJson(apiUrl(path));
      return data.map((item: any) => item.name);
    },
    async stat(path: string, ...args: any[]): Promise<any> {
      try {
        const data = await fetchJson(apiUrl(path));
        if (Array.isArray(data)) {
          return { isFile: () => false, isDirectory: () => true, size: 0 };
        }
        return ghStat(data);
      } catch { throw new Error(`ENOENT: ${path}`); }
    },
    async exists(path: string): Promise<boolean> {
      try { await fetchJson(apiUrl(path)); return true; } catch { return false; }
    },
    async mkdir(path: string, options?: any): Promise<any> {
      // GitHub API: create a .gitkeep file
      const dirPath = path.replace(/\/$/, '');
      const keepPath = `${dirPath}/.gitkeep`;
      const message = (options as any)?.message || `Create directory ${dirPath}`;
      const content = btoa('');
      await fetch(apiUrl(keepPath), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ message, content, branch }),
      });
    },
    async unlink(path: string): Promise<void> {
      const data = await fetchJson(apiUrl(path));
      await fetch(apiUrl(path), {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ message: `Delete ${path}`, sha: data.sha, branch }),
      });
    },
    async rmdir(path: string): Promise<void> {
      // Recursively delete all contents
      const items = await fetchJson(apiUrl(path));
      if (Array.isArray(items)) {
        for (const item of items) {
          const itemPath = `${path}/${item.name}`;
          if (item.type === 'dir') {
            await backend.rmdir!(itemPath);
          } else {
            await backend.unlink(itemPath);
          }
        }
      }
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      // GitHub has no rename API — copy + delete
      const content = await backend.readFile(oldPath);
      await backend.writeFile(newPath, content as any);
      await backend.unlink(oldPath);
    },
  };

  return backend;
});

// ---------------------------------------------------------------------------
// Built-in: Gitee (raw content API, similar to GitHub)
// ---------------------------------------------------------------------------

registerBackend('Gitee', async (options) => {
  const token = (options.token as string) ?? '';
  const owner = (options.owner as string) ?? '';
  const repo = (options.repo as string) ?? '';
  const branch = (options.branch as string) ?? 'master';
  const baseUrl = (options.baseUrl as string) ?? 'https://gitee.com/api/v5';

  if (!owner || !repo) throw new Error('Gitee backend requires "owner" and "repo" options');

  const fetchJson = async (url: string): Promise<any> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gitee API ${res.status}: ${url}`);
    return res.json();
  };

  const apiUrl = (path: string) => {
    const p = path.startsWith('/') ? path.slice(1) : path;
    const params = new URLSearchParams({ access_token: token, ref: branch, path: p });
    return `${baseUrl}/repos/${owner}/${repo}/contents?${params}`;
  };

  const ghStat = (item: any) => ({
    isFile: () => item.type === 'file',
    isDirectory: () => item.type === 'dir',
    size: item.size ?? 0,
  });

  const backend: BackendInstance = {
    async readFile(path: string, ...args: any[]): Promise<any> {
      const data = await fetchJson(apiUrl(path));
      if (data.content) {
        const raw = Uint8Array.from(atob(data.content), c => c.charCodeAt(0));
        if (args[0] === 'utf-8') return new TextDecoder().decode(raw);
        return raw;
      }
      return data;
    },
    async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: any): Promise<void> {
      const message = (options as any)?.message || `Update ${path}`;
      const content = typeof data === 'string' ? btoa(unescape(encodeURIComponent(data))) : btoa(String.fromCharCode(...new Uint8Array(data)));
      const sha = await (async () => {
        try { const d = await fetchJson(apiUrl(path)); return d.sha; } catch { return undefined; }
      })();
      await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token, message, content, sha, branch }),
      });
    },
    async readdir(path: string): Promise<string[]> {
      const data = await fetchJson(apiUrl(path));
      return Array.isArray(data) ? data.map((i: any) => i.name) : [];
    },
    async stat(path: string): Promise<any> {
      try {
        const data = await fetchJson(apiUrl(path));
        if (Array.isArray(data)) return ghStat({ type: 'dir', size: 0 });
        return ghStat(data);
      } catch { throw new Error(`ENOENT: ${path}`); }
    },
    async exists(path: string): Promise<boolean> {
      try { await fetchJson(apiUrl(path)); return true; } catch { return false; }
    },
    async mkdir(path: string, options?: any): Promise<any> {
      const dirPath = path.replace(/\/$/, '');
      const keepPath = `${dirPath}/.gitkeep`;
      const message = (options as any)?.message || `Create directory ${dirPath}`;
      await fetch(apiUrl(keepPath), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token, message, content: btoa(''), branch }),
      });
    },
    async unlink(path: string): Promise<void> {
      const data = await fetchJson(apiUrl(path));
      await fetch(apiUrl(path), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token, message: `Delete ${path}`, sha: data.sha, branch }),
      });
    },
    async rmdir(path: string): Promise<void> {
      const items = await fetchJson(apiUrl(path));
      if (Array.isArray(items)) {
        for (const item of items) {
          const itemPath = `${path}/${item.name}`;
          if (item.type === 'dir') await backend.rmdir!(itemPath);
          else await backend.unlink(itemPath);
        }
      }
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      const content = await backend.readFile(oldPath);
      await backend.writeFile(newPath, content as any);
      await backend.unlink(oldPath);
    },
  };

  return backend;
});

// ---------------------------------------------------------------------------
// Built-in: WebDAV
// ---------------------------------------------------------------------------

registerBackend('WebDAV', async (options) => {
  const url = (options.url as string) ?? '';
  const username = (options.username as string) ?? '';
  const password = (options.password as string) ?? '';
  const rootPath = (options.rootPath as string) ?? '/';

  if (!url) throw new Error('WebDAV backend requires "url" option');

  const authHeader = username ? `Basic ${btoa(`${username}:${password}`)}` : '';

  const davUrl = (path: string) => {
    const cleanRoot = rootPath.replace(/\/$/, '');
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${url.replace(/\/$/, '')}${cleanRoot}${cleanPath}`;
  };

  const davFetch = async (path: string, method: string, body?: any) => {
    const headers: Record<string, string> = {};
    if (authHeader) headers['Authorization'] = authHeader;
    if (body) headers['Content-Type'] = 'application/xml';
    const res = await fetch(davUrl(path), { method, headers, body });
    if (!res.ok && res.status !== 404) throw new Error(`WebDAV ${res.status} ${method} ${davUrl(path)}`);
    return res;
  };

  const parseMultiStatus = async (res: Response): Promise<{ path: string; isDir: boolean; size: number }[]> => {
    const text = await res.text();
    const results: { path: string; isDir: boolean; size: number }[] = [];
    // Simple XML parsing for DAV:response elements
    const responses = text.match(/<D:response[^>]*>[\s\S]*?<\/D:response>/gi) || [];
    for (const resp of responses) {
      const href = (resp.match(/<D:href>([^<]+)<\/D:href>/i) || [])[1] || '';
      const isDir = /<D:collection\s*\/>/i.test(resp) || /<D:resourcetype>.*<D:collection/.test(resp);
      const sizeMatch = resp.match(/<D:getcontentlength>([^<]+)<\/D:getcontentlength>/i);
      const size = sizeMatch ? parseInt(sizeMatch[1]) : 0;
      const decoded = decodeURIComponent(href);
      results.push({ path: decoded, isDir, size });
    }
    return results;
  };

  const exists = async (path: string): Promise<boolean> => {
    const res = await davFetch(path, 'PROPFIND');
    return res.ok;
  };

  const backend: BackendInstance = {
    async readFile(path: string, ...args: any[]): Promise<any> {
      const res = await davFetch(path, 'GET');
      if (!res.ok) throw new Error(`ENOENT: ${path}`);
      if (args[0] === 'utf-8') return res.text();
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    },
    async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, _options?: any): Promise<void> {
      const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
      if (authHeader) headers['Authorization'] = authHeader;
      await fetch(davUrl(path), {
        method: 'PUT',
        headers,
        body: data instanceof ArrayBuffer ? data : data instanceof Uint8Array ? new Uint8Array(data).buffer as ArrayBuffer : new TextEncoder().encode(data),
      });
    },
    async readdir(path: string): Promise<string[]> {
      const headers: Record<string, string> = { Depth: '1' };
      if (authHeader) headers['Authorization'] = authHeader;
      const res = await fetch(davUrl(path), { method: 'PROPFIND', headers });
      if (!res.ok) throw new Error(`WebDAV PROPFIND failed: ${res.status}`);
      const items = await parseMultiStatus(res);
      const prefix = davUrl(path);
      return items
        .filter(i => i.path !== prefix && i.path !== `${prefix}/`)
        .map(i => i.path.split('/').filter(Boolean).pop() || '');
    },
    async stat(path: string): Promise<any> {
      const headers: Record<string, string> = { Depth: '0' };
      if (authHeader) headers['Authorization'] = authHeader;
      const res = await fetch(davUrl(path), { method: 'PROPFIND', headers });
      if (!res.ok) throw new Error(`ENOENT: ${path}`);
      const items = await parseMultiStatus(res);
      const item = items[0];
      return { isFile: () => !item.isDir, isDirectory: () => item.isDir, size: item.size };
    },
    async exists(path: string): Promise<boolean> {
      return exists(path);
    },
    async mkdir(path: string): Promise<any> {
      const headers: Record<string, string> = {};
      if (authHeader) headers['Authorization'] = authHeader;
      const res = await fetch(davUrl(path), { method: 'MKCOL', headers });
      if (!res.ok && res.status !== 405) throw new Error(`WebDAV MKCOL failed: ${res.status}`);
    },
    async unlink(path: string): Promise<void> {
      await davFetch(path, 'DELETE');
    },
    async rmdir(path: string): Promise<void> {
      const items = await (async () => {
        const headers: Record<string, string> = { Depth: '1' };
        if (authHeader) headers['Authorization'] = authHeader;
        const res = await fetch(davUrl(path), { method: 'PROPFIND', headers });
        if (!res.ok) return [];
        const parsed = await parseMultiStatus(res);
        const prefix = davUrl(path);
        return parsed.filter(i => i.path !== prefix && i.path !== `${prefix}/`);
      })();
      for (const item of items) {
        if (item.isDir) await backend.rmdir!(item.path);
        else await backend.unlink(item.path);
      }
      await davFetch(path, 'DELETE');
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
      const headers: Record<string, string> = { Destination: davUrl(newPath) };
      if (authHeader) headers['Authorization'] = authHeader;
      await fetch(davUrl(oldPath), { method: 'MOVE', headers });
    },
  };

  return backend;
});