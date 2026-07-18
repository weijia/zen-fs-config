/**
 * zen-fs-config — Chroot-isolated FS Proxy
 *
 * Wraps a CachedFileSystem (or any async FS) with path chroot isolation.
 * Returns an fs-shaped object with both `promises` (async) and sync stubs.
 */

// ---------------------------------------------------------------------------
// ChrootFS — path-restricted proxy over an async FS
// ---------------------------------------------------------------------------

type AsyncFS = {
  readFile(path: string, ...args: any[]): Promise<any>;
  writeFile(path: string, data: any, options?: any): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<any>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: any): Promise<any>;
  unlink(path: string): Promise<void>;
  rmdir?(path: string): Promise<void>;
  rename?(oldPath: string, newPath: string): Promise<void>;
};

/**
 * Resolve a path within the chroot. Prevents escaping.
 */
function resolveChroot(root: string, userPath: string): string {
  // Normalize
  let p = userPath.replace(/\\/g, '/');
  // Remove leading slash (root already has it)
  if (p.startsWith('/')) p = p.slice(1);
  // Remove ..
  const parts = p.split('/').filter(Boolean);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      if (resolved.length > 0) resolved.pop();
      // If empty, stay at root (can't escape)
    } else if (part !== '.') {
      resolved.push(part);
    }
  }
  const joined = resolved.join('/');
  return root === '/' ? `/${joined}` : `${root}/${joined}`;
}

/**
 * Create a chroot-isolated fs-like object.
 *
 * @param inner   The underlying async file system (e.g., CachedFileSystem)
 * @param root    The chroot root path (e.g., '/app-a/')
 */
export function createChrootFS(inner: AsyncFS, root: string) {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '') || '/';

  function rp(path: string): string {
    return resolveChroot(normalizedRoot, path);
  }

  // -----------------------------------------------------------------------
  // promises API (primary)
  // -----------------------------------------------------------------------

  const promises = {
    async readFile(path: string, encoding?: BufferEncoding): Promise<any> {
      return inner.readFile(rp(path), encoding);
    },

    async writeFile(path: string, data: string | Uint8Array, options?: any): Promise<void> {
      await ensureParentDir(rp(path));
      return inner.writeFile(rp(path), data, options);
    },

    async readdir(path: string): Promise<string[]> {
      return inner.readdir(rp(path));
    },

    async stat(path: string): Promise<any> {
      return inner.stat(rp(path));
    },

    async access(path: string): Promise<void> {
      const exists = await inner.exists(rp(path));
      if (!exists) {
        const err = new Error(`ENOENT: no such file or directory, access '${path}'`) as any;
        err.code = 'ENOENT';
        throw err;
      }
    },

    async mkdir(path: string, options?: any): Promise<void> {
      return inner.mkdir(rp(path), options);
    },

    async unlink(path: string): Promise<void> {
      return inner.unlink(rp(path));
    },

    async rmdir(path: string): Promise<void> {
      return inner.rmdir?.(rp(path));
    },

    async rename(oldPath: string, newPath: string): Promise<void> {
      return inner.rename?.(rp(oldPath), rp(newPath));
    },

    async exists(path: string): Promise<boolean> {
      return inner.exists(rp(path));
    },
  };

  // -----------------------------------------------------------------------
  // Sync stubs (for compatibility, delegate to async where trivial)
  // -----------------------------------------------------------------------

  const syncFs = {
    readFileSync(path: string, encoding?: BufferEncoding): any {
      // Sync read is not natively supported — throw a clear error
      throw new Error(
        'zen-fs-config: readFileSync is not supported. ' +
        'Use repo.fs.promises.readFile() or repo.getConfig() instead.',
      );
    },

    writeFileSync(path: string, data: string | Uint8Array, options?: any): void {
      // Sync write fires and forgets — acceptable for cached writes
      promises.writeFile(path, data, options).catch(() => {});
    },

    existsSync(path: string): boolean {
      // Sync exists is best-effort via a synchronous check
      // This will not work in most async backends, but is provided as a convenience
      throw new Error(
        'zen-fs-config: existsSync is not supported. ' +
        'Use repo.fs.promises.exists() instead.',
      );
    },

    mkdirSync(path: string, options?: any): void {
      promises.mkdir(path, options).catch(() => {});
    },

    readdirSync(path: string): string[] {
      throw new Error(
        'zen-fs-config: readdirSync is not supported. ' +
        'Use repo.fs.promises.readdir() instead.',
      );
    },

    statSync(path: string): any {
      throw new Error(
        'zen-fs-config: statSync is not supported. ' +
        'Use repo.fs.promises.stat() instead.',
      );
    },

    unlinkSync(path: string): void {
      promises.unlink(path).catch(() => {});
    },

    promises,
  };

  return syncFs;
}

// ---------------------------------------------------------------------------
// Helper: ensure parent directory exists
// ---------------------------------------------------------------------------

async function ensureParentDir(absolutePath: string): Promise<void> {
  // This is a no-op at this level; the underlying FS (CachedFileSystem → backend)
  // should handle recursive mkdir. We rely on the caller to ensure dirs exist
  // or the backend to support auto-creation.
}

// ---------------------------------------------------------------------------
// Full-path FS (no chroot, for internal use like meta/ and sync)
// ---------------------------------------------------------------------------

/**
 * Create an unrestricted fs wrapper that doesn't chroot.
 * Used internally for .meta/ access and zen-fs-sync.
 */
export function createFullFS(inner: AsyncFS) {
  return createChrootFS(inner, '/');
}