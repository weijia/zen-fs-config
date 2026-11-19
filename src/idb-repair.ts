/**
 * IndexedDB store self-repair for `@zenfs/core` StoreFS databases.
 *
 * Why this exists
 * ---------------
 * `@zenfs/core`'s StoreFS indexes the store on open (`_populate`). If **any**
 * directory listing cannot be decoded, `_populate` aborts: `_paths` stays
 * partially filled, and the FS then allocates new inode ids from the incomplete
 * index (`allocNew` uses `max(_paths.keys()) + 2`). Those fresh ids collide with
 * ids that already exist on disk, so `commitNew` overwrites another node's data
 * slot. When the victim is a directory, its listing is replaced by file bytes
 * (e.g. a tombstone JSON), and every later `readdir` of that directory throws
 * `Cannot convert <path> to a BigInt`.
 *
 * The same bug chain therefore shows up as data corruption after an
 * interrupted write, not just as a read error: populate aborts → id collision →
 * another listing destroyed → populate aborts again.
 *
 * What this does
 * --------------
 * Before the StoreFS is created, scan the raw store once:
 *   - identify directory inodes (4096-byte inode struct whose `ino` equals its
 *     key, with S_IFDIR in `mode`);
 *   - check that the inode's data slot holds a decodable directory listing;
 *   - if it does not (the slot holds arbitrary file bytes / JSON with
 *     non-numeric values), reset that slot to an empty listing.
 *
 * An empty listing is enough to keep `_populate` from aborting, which in turn
 * keeps id allocation consistent. The destroyed entries themselves are gone —
 * only the corruption is stopped from spreading.
 *
 * The DOM types (`IDBDatabase`, `IDBRequest`, ...) are deliberately avoided:
 * zen-fs-config is compiled without the DOM lib.
 */

const INODE_SIZE = 4096;
const S_IFMT = 0o170000;
const S_IFDIR = 0o40000;
const LEGACY_LISTING_MAGIC = 0x7b; // '{'

export interface RepairResult {
  scanned: number;
  repaired: number;
  details: Array<{ key: number; data: number; reason: string }>;
}

type AnyRequest = {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked?: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
  result?: any;
  error?: any;
  transaction?: any;
};

function idb(): any {
  return (globalThis as any).indexedDB;
}

/**
 * Diagnostics sink. Every repair attempt appends one entry per phase to
 * `globalThis.__zenfsIdbRepair` so the browser console / page scripts can tell
 * whether the repair ran at all (and where it bailed out).
 */
function traceLog(): Array<Record<string, unknown>> | null {
  const g = globalThis as any;
  try {
    if (!Array.isArray(g.__zenfsIdbRepair)) g.__zenfsIdbRepair = [];
    return g.__zenfsIdbRepair as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
}

function openDB(name: string): Promise<any | null> {
  const factory = idb();
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: AnyRequest;
    try {
      req = factory.open(name);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      // Never create a store here: that would mask a missing database.
      try {
        req.transaction?.abort();
      } catch {
        /* ignore */
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

const request = <T>(req: AnyRequest): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });

/** Whether the bytes can be read as a legacy JSON directory listing. */
function isDecodableListing(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  // Non-JSON bytes: the new binary listing format (magic byte) — assume valid.
  if (bytes[0] !== LEGACY_LISTING_MAGIC) return true;
  let text: string;
  try {
    text = new TextDecoder().decode(bytes);
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return Object.values(parsed as Record<string, unknown>).every(
    (v) => typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)),
  );
}

function isDirectoryInode(bytes: Uint8Array, key: number): number | null {
  if (bytes.byteLength !== INODE_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ino = view.getUint32(58, true);
  if (ino !== key) return null;
  const mode = view.getUint16(12, true);
  if ((mode & S_IFMT) !== S_IFDIR) return null;
  const mtime = view.getFloat64(42, true);
  if (!Number.isFinite(mtime) || mtime < 1e11 || mtime > 1e13) return null;
  return view.getUint32(0, true); // data slot key
}

/**
 * Repair a StoreFS IndexedDB database in place. Safe to call on every open:
 * it is a no-op when nothing is corrupted, and it never creates a database.
 */
export async function repairIndexedDBStore(storeName: string): Promise<RepairResult | null> {
  const trace = traceLog();
  const note = (phase: string, extra?: Record<string, unknown>) => {
    if (!trace) return;
    trace.push({ store: storeName, phase, at: Date.now(), ...(extra ?? {}) });
  };
  note('start');
  if (!idb()) {
    note('skip: no indexedDB');
    return null;
  }

  const db = await openDB(storeName);
  if (!db) {
    note('skip: db not opened');
    return null;
  }

  const objectStoreName: string | undefined = Array.from(
    db.objectStoreNames as ArrayLike<string>,
  )[0];
  if (!objectStoreName) {
    note('skip: no object store');
    db.close?.();
    return null;
  }

  const result: RepairResult = { scanned: 0, repaired: 0, details: [] };
  try {
    const tx = db.transaction(objectStoreName, 'readwrite');
    // Attach the completion handlers before awaiting anything: a transaction can
    // finish (and fire these events) while the awaited request promises settle.
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const store = tx.objectStore(objectStoreName);
    const keys = await request<number[]>(store.getAllKeys());
    const values = await request<any[]>(store.getAll());

    const byKey = new Map<number, Uint8Array>();
    for (let i = 0; i < keys.length; i++) {
      const value = values[i];
      if (value instanceof Uint8Array) byKey.set(Number(keys[i]), value);
    }

    for (let i = 0; i < keys.length; i++) {
      const value = values[i];
      if (!(value instanceof Uint8Array)) continue;
      const key = Number(keys[i]);
      if (!Number.isFinite(key)) continue;
      result.scanned++;

      const dataSlot = isDirectoryInode(value, key);
      if (dataSlot === null) continue;

      const listing = byKey.get(dataSlot);
      if (listing && isDecodableListing(listing)) continue;

      const reason = listing ? 'listing slot holds non-listing bytes' : 'listing slot missing';
      result.repaired++;
      result.details.push({ key, data: dataSlot, reason });
      // Empty legacy listing: `_populate` upgrades it to the binary format.
      await request(store.put(new TextEncoder().encode('{}'), dataSlot));
    }

    await done;
    note('done', { scanned: result.scanned, repaired: result.repaired });
  } catch (err) {
    note('error', { message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    try {
      db.close?.();
    } catch {
      /* ignore */
    }
    return null;
  } finally {
    try {
      db.close?.();
    } catch {
      /* ignore */
    }
  }

  return result;
}
