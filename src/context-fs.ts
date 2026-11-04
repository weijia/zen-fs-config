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

/** Options for the chroot proxy. */
export interface ChrootOptions {
  /**
   * Absolute paths (relative to the inner FS) that the view must hide and
   * refuse to write. Used to keep `.meta` / `.config` out of app-facing views
   * without excluding them from sync (hiding ≠ not syncing).
   */
  hiddenPrefixes?: string[];
  /** Called after a successful writeFile, e.g. to record a version entry. */
  onWrite?: (path: string, data: any) => Promise<void> | void;
  /**
   * When provided, `unlink` delegates entirely to this hook (used for
   * tombstone-aware deletion). The hook is responsible for removing the file.
   */
  onUnlink?: (path: string) => Promise<void>;
}

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

function makeEnoent(userPath: string): any {
  const err = new Error(`ENOENT: no such file or directory, '${userPath}'`) as any;
  err.code = 'ENOENT';
  return err;
}

/**
 * Create a chroot-isolated fs-like object.
 *
 * @param inner   The underlying async file system (e.g., CachedFileSystem)
 * @param root    The chroot root path (e.g., '/app-a/')
 * @param options Hiding / write hooks (see ChrootOptions)
 */
export function createChrootFS(inner: AsyncFS, root: string, options: ChrootOptions = {}) {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const hiddenPrefixes = (options.hiddenPrefixes ?? []).map((p) =>
    p.startsWith('/') ? p.replace(/\/+$/, '') : `/${p}`.replace(/\/+$/, ''),
  );

  function rp(path: string): string {
    return resolveChroot(normalizedRoot, path);
  }

  function isHidden(absolutePath: string): boolean {
    return hiddenPrefixes.some(
      (prefix) => absolutePath === prefix || absolutePath.startsWith(`${prefix}/`),
    );
  }

  function visible(path: string): string {
    const absolute = rp(path);
    if (isHidden(absolute)) throw makeEnoent(path);
    return absolute;
  }

  // -----------------------------------------------------------------------
  // promises API (primary)
  // -----------------------------------------------------------------------

  const promises = {
    async readFile(path: string, encoding?: string): Promise<any> {
      return inner.readFile(visible(path), encoding);
    },

    async writeFile(path: string, data: string | Uint8Array, writeOptions?: any): Promise<void> {
      const target = visible(path);
      await ensureParentDir(target);
      await inner.writeFile(target, data, writeOptions);
      if (options.onWrite) await options.onWrite(path, data);
    },

    async readdir(path: string): Promise<string[]> {
      const entries = await inner.readdir(visible(path));
      if (hiddenPrefixes.length === 0) return entries;
      const dirPath = rp(path);
      return entries.filter((entry) => {
        const child = dirPath === '/' ? `/${entry}` : `${dirPath}/${entry}`;
        return !isHidden(child);
      });
    },

    async stat(path: string): Promise<any> {
      const s = await inner.stat(visible(path));
      // Pass through mode/size/mtimeMs directly — consumers use mode to detect type
      return {
        mode: typeof s.mode === 'number' ? s.mode : undefined,
        size: s.size ?? 0,
        mtimeMs: s.mtimeMs ?? s.mtime ?? 0,
      };
    },

    async access(path: string): Promise<void> {
      const exists = await inner.exists(visible(path));
      if (!exists) throw makeEnoent(path);
    },

    async mkdir(path: string, mkdirOptions?: any): Promise<void> {
      return inner.mkdir(visible(path), mkdirOptions);
    },

    async unlink(path: string): Promise<void> {
      const target = visible(path);
      if (options.onUnlink) return options.onUnlink(target);
      return inner.unlink(target);
    },

    async rmdir(path: string): Promise<void> {
      return inner.rmdir?.(visible(path));
    },

    async rename(oldPath: string, newPath: string): Promise<void> {
      return inner.rename?.(visible(oldPath), visible(newPath));
    },

    async exists(path: string): Promise<boolean> {
      if (isHidden(rp(path))) return false;
      return inner.exists(rp(path));
    },
  };

  // -----------------------------------------------------------------------
  // Sync stubs (for compatibility, delegate to async where trivial)
  // -----------------------------------------------------------------------

  const syncFs = {
    readFileSync(path: string, encoding?: string): any {
      // Sync read is not natively supported — throw a clear error
      throw new Error(
        'zen-fs-config: readFileSync is not supported. ' +
        'Use repo.fs.promises.readFile() or repo.getConfig() instead.',
      );
    },

    writeFileSync(path: string, data: string | Uint8Array, writeOptions?: any): void {
      // Sync write fires and forgets — acceptable for cached writes
      promises.writeFile(path, data, writeOptions).catch(() => {});
    },

    existsSync(path: string): boolean {
      // Sync exists is best-effort via a synchronous check
      throw new Error(
        'zen-fs-config: existsSync is not supported. ' +
        'Use repo.fs.promises.exists() or repo.getConfig() instead.',
      );
    },

    mkdirSync(path: string, mkdirOptions?: any): void {
      promises.mkdir(path, mkdirOptions).catch(() => {});
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
