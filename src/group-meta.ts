/**
 * zen-fs-config — Shared Sync-Group Metadata
 *
 * Implements the layout agreed in SYNC-GROUP-UNIFICATION.zh-CN.md:
 *
 *   /.meta/group.json                 # group descriptor (kind/id/features)
 *   /.meta/tombstones/{encoded}.json  # tombstones (the only deletion record)
 *   /.meta/versions/{encoded}.json    # version records for data groups
 *   /.meta/conflicts/{conflictId}/    # conflict archives (legacy: /.meta/.conflicts)
 *   /.config/**                       # config-sync only (not synced by data groups)
 *
 * Both the config-sync group and the data-sync groups use the `.meta/` helpers
 * below; `.config/` paths stay in config-repo.ts because only that group owns
 * them.
 */

import type {
  AppDataBackendDescriptor,
  ConflictArchive,
  GroupDescriptor,
  SyncGroupFeatures,
  TombstoneMeta,
  TombstoneType,
  VersionMeta,
} from './types';
import { sha256 } from './version';
import { createLogger } from '@richard432/localstorage-logger';
import {
  mergeBackendDescriptor,
  serializeBackendDescriptor,
  serializeGroupDescriptor,
} from './canonical-json';

const log = createLogger('zen-fs-config:tombstones');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const META_DIR = '/.meta';
export const GROUP_DESCRIPTOR_FILE = `${META_DIR}/group.json`;
export const META_BACKENDS_DIR = `${META_DIR}/backends`;
export const TOMBSTONES_DIR = `${META_DIR}/tombstones`;

/**
 * 「删除后重建」判定的容差（毫秒）。文件 mtime 比 `deletedAt` 新出这个余量，
 * 才认定墓碑已被写操作撤销（避免秒级时钟抖动造成误判）。
 */
const RECREATE_AFTER_DELETE_SKEW_MS = 3000;
/**
 * 墓碑 GC 的最短保留期。
 *
 * GC 的「确认」只覆盖本实例配置的 replica 后端，覆盖不到其它设备、其它标签页
 * 以及应用侧仍然留着的副本。墓碑一旦被提前删掉，滞后端会把自己快照里的旧文件
 * 当成「本地新增」持续推回后端，删除就被复活了。
 *
 * 保留期必须长于任一客户端的一个轮询周期（pollIntervalMs 默认 30 分钟），
 * 这里取 24 小时作为稳妥值。
 */
export const TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;
/**
 * 占位类墓碑（`.keep` / `.keep.mtime` / `.mtime` 侧车）的最短保留期。
 * 它们不承载用户数据，被提前回收最多让空目录短暂复活，下一轮 tombstone pass
 * 仍会把它清掉，因此用较短的保留期。
 */
export const TOMBSTONE_PLACEHOLDER_RETENTION_MS = 10 * 60 * 1000;

/** 该墓碑适用的保留期：占位类用短保留，其余用 24h。 */
export function tombstoneRetentionMs(tombstonePath: string): number {
  if (
    tombstonePath.endsWith('.mtime') ||
    tombstonePath === '/.keep' ||
    tombstonePath.endsWith('/.keep')
  ) {
    return TOMBSTONE_PLACEHOLDER_RETENTION_MS;
  }
  return TOMBSTONE_RETENTION_MS;
}

/**
 * 墓碑是否已经老到可以被 GC。
 * `deletedAt` 缺失或非法（旧格式）视为已到期，避免墓碑永远滞留。
 */
export function isTombstoneRetentionElapsed(tombstone: TombstoneMeta, now = Date.now()): boolean {
  const deletedAt = Number(tombstone.deletedAt);
  if (!Number.isFinite(deletedAt)) return true;
  return now - deletedAt >= tombstoneRetentionMs(tombstone.path);
}

/** 目录墓碑：删除目标是一整棵目录树。 */
export function isDirectoryTombstone(tombstone: TombstoneMeta): boolean {
  return tombstone.type === 'directory';
}

/**
 * 墓碑的规范字节。字段顺序固定（`type` 只在目录墓碑上出现），保证：
 * - 旧墓碑（无 `type`）重写后字节不变，不会凭空触发一轮同步；
 * - 同一份墓碑在所有端写出的字节一致。
 */
export function serializeTombstone(tombstone: TombstoneMeta): string {
  const ordered: Record<string, unknown> = {
    path: tombstone.path,
    deletedAt: tombstone.deletedAt,
    deletedBy: tombstone.deletedBy,
    confirmedBy: tombstone.confirmedBy,
  };
  if (tombstone.type) ordered.type = tombstone.type;
  return JSON.stringify(ordered, null, 2);
}

/**
 * 按树清理一个被墓碑标记的路径（本地库 / 各副本通用）。
 *
 * 目录不能直接 unlink（会抛 EISDIR）；隐藏的 `.keep` / `.keep.mtime` 占位在
 * 部分后端的索引里不可见，只能按路径强删。这些占位只要残留一个，空目录就会
 * 在下一轮拉取时复活。
 */
export async function purgeTombstonedTree(fs: any, targetPath: string): Promise<void> {
  let isDir = false;
  try {
    const stat = await fs.stat?.(targetPath);
    if (stat) {
      if (typeof stat.isDirectory === 'function') isDir = stat.isDirectory();
      else {
        const mode = Number(stat.mode ?? 0);
        isDir = mode > 0 && (mode & 0o170000) === 0o040000;
      }
    }
  } catch {
    isDir = false; // 不存在（或后端不支持 stat）
  }
  // 部分后端（或包装层）只给出权限位、不带 S_IFDIR；readdir 成功即可确认是目录。
  if (!isDir) {
    try { await fs.readdir(targetPath); isDir = true; } catch { isDir = false; }
  }

  if (!isDir) {
    try { await fs.unlink(targetPath); } catch { /* already gone */ }
    return;
  }

  for (const placeholder of [`${targetPath}/.keep`, `${targetPath}/.keep.mtime`]) {
    try { await fs.unlink(placeholder); } catch { /* 不存在或后端不支持 */ }
  }
  let children: string[] = [];
  try { children = await fs.readdir(targetPath); } catch { /* 目录可能已消失 */ }
  for (const child of children) await purgeTombstonedTree(fs, `${targetPath}/${child}`);
  try {
    if (typeof fs.rmdir === 'function') await fs.rmdir(targetPath);
    else await fs.unlink(targetPath);
  } catch {
    try { await fs.unlink(targetPath); } catch { /* 仍存在 */ }
  }
}
/**
 * 历史归档目录。仅作为常量保留（旧数据仍在远端，按普通内容对待）：
 * 既不读取也不写入，删除状态只以 {@link TOMBSTONES_DIR} 为准。
 */
export const LEGACY_TOMBSTONES_DIR = `${META_DIR}/.deleted`;
export const VERSIONS_DIR = `${META_DIR}/versions`;
export const CONFLICTS_DIR = `${META_DIR}/conflicts`;
export const LEGACY_CONFLICTS_DIR = `${META_DIR}/.conflicts`;
/** 旧版数据组镜像目录；自 0.7.x 起只写 `/.config/app-data-groups/`。 */
export const LEGACY_APP_DATA_GROUPS_DIR = `${META_DIR}/app-data-groups`;
export const CONFIG_DIR = '/.config';

/**
 * 是否属于「可以当普通残留清掉」的旧版元数据路径。
 *
 * 删除账本迁到 `/.meta/tombstones/`、冲突记录迁到 `/.meta/conflicts/`、数据组
 * 描述符迁到 `/.config/app-data-groups/` 之后，`/.meta/.deleted`、
 * `/.meta/.conflicts`、`/.meta/app-data-groups` 这三处不再被写入，留在里面的
 * 只是历史残留 —— 允许用户清理，否则永远删不掉一批已经死掉的文件。
 *
 * 现行账本（tombstones / versions / conflicts）、后端清单（`/.meta/backends/`）
 * 和组身份（`/.meta/group.json`）**不在此列**，仍然一律禁删。
 */
export function isDeletableLegacyMetaPath(path: string): boolean {
  for (const dir of [LEGACY_TOMBSTONES_DIR, LEGACY_CONFLICTS_DIR, LEGACY_APP_DATA_GROUPS_DIR]) {
    if (path === dir || path.startsWith(`${dir}/`)) return true;
  }
  return false;
}

/** Default features for a data-sync group: tombstones on, versions/conflicts opt-in. */
export const DATA_GROUP_DEFAULT_FEATURES: SyncGroupFeatures = {
  tombstones: true,
  versions: false,
  conflicts: false,
  configHost: false,
  appData: true,
};

// ---------------------------------------------------------------------------
// Small fs helpers (work with backend instances and SyncableFS alike)
// ---------------------------------------------------------------------------

type MetaFS = {
  readFile(path: string, encoding?: string): Promise<any>;
  writeFile(path: string, data: any): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string): Promise<any>;
  unlink(path: string): Promise<void>;
  exists?(path: string): Promise<boolean>;
};

function toBytes(raw: any): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (typeof raw === 'string') return new TextEncoder().encode(raw);
  return new Uint8Array(raw);
}

/**
 * 覆盖写一个 `.meta` 文件。
 *
 * 某些后端（StoreFS / RemoteStorage / WebDAV）的 `writeFile` 在文件已存在时
 * 仍会走「新建」路径，后端侧返回 `EEXIST`（"file already exists"）。
 * 墓碑 / 版本 / 冲突这类文件天然会被重复写（例如同一个后端被再次移除），
 * 所以这里显式做「失败 → unlink → 再写」的兜底。
 */
export async function writeFileOverwrite(fs: MetaFS, path: string, data: any): Promise<void> {
  const bytes = toBytes(data);
  try {
    await fs.writeFile(path, bytes);
    return;
  } catch (err) {
    if (!isAlreadyExistsError(err)) throw err;
  }
  try {
    await fs.unlink(path);
  } catch {
    /* 文件可能已被别人删掉 */
  }
  await fs.writeFile(path, bytes);
}

/** 后端把「文件已存在」报成 EEXIST / EEXIST 文案两种形态。 */
function isAlreadyExistsError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code === 'EEXIST') return true;
  return /file already exists|already exists|文件已存在/i.test(String(e.message ?? ''));
}

/** Create every parent directory of `filePath`. mkdir is idempotent. */
export async function ensureParentDir(fs: MetaFS, filePath: string): Promise<void> {
  const parts = filePath.split('/').filter(Boolean);
  parts.pop();
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    try {
      await fs.mkdir(current);
    } catch {
      /* already exists */
    }
  }
}

async function readJson<T>(fs: MetaFS, path: string): Promise<T | null> {
  const raw = await readText(fs, path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Read a text file, returning `null` when it does not exist / cannot be read. */
async function readText(fs: MetaFS, path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(toBytes(await fs.readFile(path)));
  } catch {
    return null;
  }
}

async function writeJson(fs: MetaFS, path: string, value: unknown): Promise<void> {
  await ensureParentDir(fs, path);
  await writeFileOverwrite(fs, path, new TextEncoder().encode(JSON.stringify(value, null, 2)));
}

async function existsSafe(fs: MetaFS, path: string): Promise<boolean> {
  try {
    if (typeof fs.exists === 'function') return await fs.exists(path);
    await fs.readFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Backend-internal mtime sidecar (`<name>.mtime`).
 *
 * GiteeFS keeps these out of its Index and only in its SHA cache, so `exists()`
 * reports `false` for them even when the blob is still on the remote. They must
 * be unlinked unconditionally, otherwise `<dir>/.keep.mtime` survives a
 * directory delete and keeps the (now empty) directory alive in Git.
 */
function isMtimeSidecarPath(path: string): boolean {
  return path.endsWith('.mtime');
}

/** `.keep` / `.keep.mtime` / `*.mtime` 这类后端占位，对 `exists()` 不可见。 */
function isHiddenPlaceholderPath(path: string): boolean {
  return isMtimeSidecarPath(path) || path === '/.keep' || path.endsWith('/.keep');
}

/**
 * Encode a file path into a flat metadata entry name.
 * `/a/b.json` → `a__b++json`
 */
export function encodeMetaPath(filePath: string): string {
  const normalized = filePath.startsWith('/') ? filePath : `/${filePath}`;
  return normalized.replace(/^\//, '').replace(/\//g, '__').replace(/\./g, '++');
}

/**
 * Decode a tombstone entry name back into the deleted file path.
 * `a__b++json.json` → `/a/b.json`. Returns `null` for names that cannot have
 * been produced by {@link encodeMetaPath}.
 *
 * This is the last-resort source of the target path: the name encodes the path,
 * so it survives a truncated or concatenated tombstone body.
 */
export function decodeMetaPath(entry: string): string | null {
  if (!entry.endsWith('.json')) return null;
  const encoded = entry.slice(0, -'.json'.length);
  if (!encoded) return null;
  return `/${encoded.replace(/__/g, '/').replace(/\+\+/g, '.')}`;
}

function fallbackTombstone(path: string): TombstoneMeta {
  // The body is unusable: keep the record minimal but still valid so the
  // downstream confirmation/GC passes can rewrite it into a well-formed file.
  return { path, deletedAt: 0, deletedBy: 'unknown', confirmedBy: [] };
}

function normalizeTombstoneRecord(value: unknown, fallbackPath?: string): TombstoneMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawPath = typeof record.path === 'string' ? record.path : fallbackPath;
  if (!rawPath) return null;
  const path = normalizeTombstonePath(rawPath);
  const confirmedBy = Array.isArray(record.confirmedBy)
    ? (record.confirmedBy as unknown[]).filter((id): id is string => typeof id === 'string')
    : [];
  const type: TombstoneType | undefined =
    record.type === 'directory' ? 'directory' : record.type === 'file' ? 'file' : undefined;
  return {
    path,
    deletedAt: typeof record.deletedAt === 'number' ? record.deletedAt : 0,
    deletedBy: typeof record.deletedBy === 'string' ? record.deletedBy : 'unknown',
    confirmedBy,
    ...(type ? { type } : {}),
  };
}

/**
 * 规范化墓碑路径：补上前导 `/`，去掉结尾 `/`。
 *
 * 目录墓碑记录的是目录本身（`/app/data/2026`），不能带结尾斜杠 —— 否则
 * `encodeMetaPath()` 会编出 `app__data__2026__` 这种带空段的文件名，两个
 * 写法不同的目录墓碑就会各存一份、互相不认。
 */
export function normalizeTombstonePath(rawPath: string): string {
  const withLeading = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return withLeading.length > 1 ? withLeading.replace(/\/+$/, '') || '/' : withLeading;
}

/**
 * Extract every balanced `{...}` object from `raw`.
 *
 * Tombstones are written with a plain PUT/POST to the remote. When two writers
 * race on the same path (or a write is cut off mid-body), the result is a
 * truncated object followed by the beginning of another one — invalid JSON that
 * still contains recoverable complete objects. Braces inside strings are
 * ignored so a path such as `/{a}.json` cannot confuse the scanner.
 */
function extractJsonObjects(raw: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * Parse one tombstone file body, tolerating corruption.
 *
 * Policy — a corrupt tombstone means "this path was deleted" (conservative):
 *   - The alternative ("ignore it") is what the old `catch {}` did, and it lets
 *     a stale replica resurrect a file the user deliberately deleted. That is
 *     unrecoverable data loss from the user's point of view.
 *   - Honoring it costs at most one extra unlink of an already-absent path,
 *     which is idempotent and cheap.
 *   - The target path is recovered from the filename (`decodeMetaPath`) when the
 *     body is unusable, so a truncated write still protects the right file.
 *
 * A body can contain several JSON documents (a cut-off write followed by a
 * concurrent rewrite). Every balanced object is returned; the caller merges
 * duplicates by path.
 */
export function parseTombstoneFile(
  raw: string,
  fallbackPath?: string,
): { tombstones: TombstoneMeta[]; problems: string[] } {
  const problems: string[] = [];
  const text = raw.trim();
  if (text === '') {
    problems.push('empty body');
    if (fallbackPath) {
      problems.push('path derived from filename');
      return { tombstones: [fallbackTombstone(fallbackPath)], problems };
    }
    problems.push('no path derivable from filename — skipped');
    return { tombstones: [], problems };
  }

  try {
    const parsed = normalizeTombstoneRecord(JSON.parse(text), fallbackPath);
    if (parsed) return { tombstones: [parsed], problems: [] };
    problems.push('JSON parsed but has no usable "path"');
  } catch (err) {
    problems.push(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const recovered = extractJsonObjects(text)
    .map((chunk) => {
      try {
        return normalizeTombstoneRecord(JSON.parse(chunk));
      } catch {
        return null;
      }
    })
    .filter((t): t is TombstoneMeta => t !== null);

  if (recovered.length > 0) {
    if (recovered.length > 1) problems.push(`${recovered.length} concatenated documents recovered`);
    return { tombstones: recovered, problems };
  }

  if (fallbackPath) {
    problems.push('no recoverable document; path derived from filename');
    return { tombstones: [fallbackTombstone(fallbackPath)], problems };
  }

  problems.push('no recoverable document and no path derivable from filename — skipped');
  return { tombstones: [], problems };
}

function mergeTombstone(byPath: Map<string, TombstoneMeta>, tombstone: TombstoneMeta): void {
  const prev = byPath.get(tombstone.path);
  if (!prev) {
    byPath.set(tombstone.path, tombstone);
    return;
  }
  // Duplicate writes (same file, or new + legacy mirror) must not block GC:
  // union the confirmations, keep the first record's metadata.
  for (const id of tombstone.confirmedBy) {
    if (!prev.confirmedBy.includes(id)) prev.confirmedBy.push(id);
  }
  // 同一路径既有文件墓碑又有目录墓碑时，目录墓碑覆盖力更强（整棵树都删掉），
  // 保留它，避免旧的文件墓碑把语义降级成"只删这个路径"。
  if (isDirectoryTombstone(tombstone) && !isDirectoryTombstone(prev)) prev.type = 'directory';
}

/**
 * Read every tombstone from `.meta/tombstones/`, never dropping a corrupt
 * record silently.
 *
 * `warn` receives a human-readable diagnostic (file path + parse problem) for
 * each file that needed repair or recovery.
 */
export async function readTombstonesFromFs(
  fs: MetaFS,
  warn: (message: string) => void,
): Promise<TombstoneMeta[]> {
  const byPath = new Map<string, TombstoneMeta>();
  {
    const dir = TOMBSTONES_DIR;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return []; // directory doesn't exist in this layout
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const filePath = `${dir}/${entry}`;
      let raw: string;
      try {
        raw = new TextDecoder().decode(toBytes(await fs.readFile(filePath)));
      } catch (err) {
        warn(
          `[Tombstones] unreadable tombstone ${filePath}: ` +
          `${err instanceof Error ? err.message : String(err)} — skipped`,
        );
        continue;
      }
      const { tombstones, problems } = parseTombstoneFile(raw, decodeMetaPath(entry) ?? undefined);
      if (problems.length > 0) {
        const action = tombstones.length > 0
          ? tombstones.map((t) => `"${t.path}" treated as deleted`).join(', ')
          : 'skipped';
        warn(`[Tombstones] corrupt tombstone ${filePath}: ${problems.join('; ')} → ${action}`);
      }
      for (const tombstone of tombstones) mergeTombstone(byPath, tombstone);
    }
  }
  return Array.from(byPath.values());
}

// ---------------------------------------------------------------------------
// Group descriptor
// ---------------------------------------------------------------------------

/** Read `.meta/group.json`. `updatedAt` is deprecated and ignored on read. */
export async function readGroupDescriptor(fs: MetaFS): Promise<GroupDescriptor | null> {
  const parsed = await readJson<GroupDescriptor & { updatedAt?: number }>(fs, GROUP_DESCRIPTOR_FILE);
  if (!parsed) return null;
  const { updatedAt: _ignored, ...rest } = parsed;
  return rest as GroupDescriptor;
}

/** 该错误是否表示“文件不存在”（而不是网络/权限失败）。 */
export function isNotFoundError(err: unknown): boolean {
  const e = err as { code?: string; name?: string; errno?: number; message?: string } | null;
  if (!e) return false;
  if (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.name === 'NotFoundError' || e.errno === -2) return true;
  return /no such file|not found|不存在/i.test(String(e.message ?? ''));
}

/**
 * 严格版读取：**只**把「文件不存在」当作 null，其它错误（网络 / 权限 / 解码）
 * 一律抛出。
 *
 * 归属校验必须用它——否则「远端读不到」会被当成「空仓库」进而尝试认领，
 * 把小故障误当成新仓库。
 */
export async function readGroupDescriptorStrict(fs: MetaFS): Promise<GroupDescriptor | null> {
  let raw: string;
  try {
    raw = new TextDecoder().decode(toBytes(await fs.readFile(GROUP_DESCRIPTOR_FILE)));
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as GroupDescriptor & { updatedAt?: number };
    const { updatedAt: _ignored, ...rest } = parsed;
    return rest as GroupDescriptor;
  } catch {
    return null;
  }
}

/**
 * Write `.meta/group.json`.
 *
 * 幂等：内容与磁盘现有内容字节相同则不写。`updatedAt` 是 deprecated 字段，
 * 不再写入（写进随同步走的内容会形成「写 → 内容变 → 触发同步 → 对端再写」
 * 的无限回环）。
 */
export async function writeGroupDescriptor(fs: MetaFS, descriptor: GroupDescriptor): Promise<void> {
  const bytes = serializeGroupDescriptor(descriptor);
  if ((await readText(fs, GROUP_DESCRIPTOR_FILE)) === bytes) return;
  await ensureParentDir(fs, GROUP_DESCRIPTOR_FILE);
  await fs.writeFile(GROUP_DESCRIPTOR_FILE, new TextEncoder().encode(bytes));
}

// ---------------------------------------------------------------------------
// Data-group backend descriptors (`.meta/backends/{id}.json`)
// ---------------------------------------------------------------------------

/**
 * Backend ids become file names, so they must not escape `.meta/backends/`.
 * `/`, `\` and `..` are rejected (path traversal).
 */
export function assertValidBackendId(id: string): void {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('Backend id must be a non-empty string');
  }
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`Invalid backend id "${id}": must not contain "/", "\\" or ".."`);
  }
}

/** Path of a data-group backend descriptor: `.meta/backends/{id}.json`. */
export function backendMetaFilePath(id: string): string {
  assertValidBackendId(id);
  return `${META_BACKENDS_DIR}/${id}.json`;
}

/**
 * Read every backend descriptor from `.meta/backends/`.
 *
 * Returns `null` when the directory does not exist (→ caller may lazily
 * backfill from the config group's bootstrap descriptor) and `[]` when the
 * directory exists but holds no usable descriptors (→ authoritative empty list,
 * e.g. after every backend was removed).
 */
export async function readBackendMetaDescriptors(
  fs: MetaFS,
): Promise<AppDataBackendDescriptor[] | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(META_BACKENDS_DIR);
  } catch {
    return null;
  }
  const out: AppDataBackendDescriptor[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const desc = await readJson<AppDataBackendDescriptor>(fs, `${META_BACKENDS_DIR}/${entry}`);
    if (!desc || typeof desc.id !== 'string' || typeof desc.type !== 'string') continue;
    out.push(desc);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Write one backend descriptor with canonical bytes.
 *
 * `createdAt` is merged with the value already on disk by `min`, so two devices
 * never rewrite each other's file just because they recorded different
 * timestamps. Returns `true` when the file was actually written.
 */
export async function writeBackendMetaDescriptor(
  fs: MetaFS,
  descriptor: AppDataBackendDescriptor,
): Promise<boolean> {
  assertValidBackendId(descriptor.id);
  const path = backendMetaFilePath(descriptor.id);
  const raw = await readText(fs, path);
  let existing: AppDataBackendDescriptor | null = null;
  if (raw !== null) {
    try {
      existing = JSON.parse(raw) as AppDataBackendDescriptor;
    } catch {
      existing = null; // corrupt → overwrite with the good copy
    }
  }
  const bytes = serializeBackendDescriptor(mergeBackendDescriptor(existing, descriptor));
  if (raw === bytes) return false;
  await ensureParentDir(fs, path);
  await fs.writeFile(path, new TextEncoder().encode(bytes));
  return true;
}

/** Delete one backend descriptor file. The caller is responsible for the tombstone. */
export async function removeBackendMetaDescriptor(fs: MetaFS, id: string): Promise<void> {
  const path = backendMetaFilePath(id);
  try {
    await fs.unlink(path);
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// TombstoneStore
// ---------------------------------------------------------------------------

export interface TombstoneTarget {
  id: string;
  fs: any;
}

/**
 * Tombstone store for a group's local store.
 *
 * 删除状态只写在 `/.meta/tombstones/`；历史归档目录不再读写。
 */
export class TombstoneStore {
  /**
   * 本轮 `process()` 真正核对过"确实不存在"的（路径 → 目标 id）。
   *
   * 只有出现在这里的副本才会被写进 `confirmedBy`（见 {@link confirm}），与
   * 配置组 `ConfigRepo.updateTombstoneConfirmations` 的保守语义一致：副本删除
   * 失败（网络、后端限制、只剩占位目录）时绝不算已确认。
   */
  private readonly verifiedAbsent = new Map<string, Set<string>>();

  constructor(
    private fs: MetaFS,
    private author: string,
  ) {}

  private pathFor(filePath: string): string {
    return `${TOMBSTONES_DIR}/${encodeMetaPath(filePath)}.json`;
  }

  /** All tombstones. */
  async list(): Promise<TombstoneMeta[]> {
    return readTombstonesFromFs(this.fs, (message) => log.warn(message));
  }

  /** Write a tombstone. */
  async write(tombstone: TombstoneMeta): Promise<void> {
    const bytes = new TextEncoder().encode(serializeTombstone(tombstone));
    const p = this.pathFor(tombstone.path);
    await ensureParentDir(this.fs, p);
    // 同一路径的墓碑可能已存在（再次删除同一后端 / 目录），这里必须覆盖。
    await writeFileOverwrite(this.fs, p, bytes);
  }

  /** Persist an updated tombstone (confirmations) when it still exists. */
  async save(tombstone: TombstoneMeta): Promise<void> {
    const bytes = new TextEncoder().encode(serializeTombstone(tombstone));
    const p = this.pathFor(tombstone.path);
    if (!(await existsSafe(this.fs, p))) return;
    await writeFileOverwrite(this.fs, p, bytes);
  }

  /** Delete a tombstone. */
  async remove(tombstone: TombstoneMeta): Promise<void> {
    const p = this.pathFor(tombstone.path);
    if (!(await existsSafe(this.fs, p))) return;
    try {
      await this.fs.unlink(p);
    } catch {
      /* race */
    }
  }

  /**
   * Delete every tombstoned file (and its version record) on the local store
   * and on each target backend, so bi-directional sync cannot resurrect it.
   *
   * 墓碑只对「删除之后没有再写入」的路径有效。同步类工具会不断重建某些文件
   * （最典型的是 `.sync.lock`：每轮删除 → 重建），若墓碑永久生效，路径会被每一
   * 轮 preSync 删掉，表现为「刚写完 1 秒就消失、锁永远拿不到」。因此这里先判定
   * 目标路径是否在 `deletedAt` 之后被重新写入：是则墓碑已被用户写操作撤销，保留
   * 文件并删除墓碑；否则按删除传播处理。
   */
  async process(targets: TombstoneTarget[] = []): Promise<void> {
    const tombstones = await this.list();
    const expired: TombstoneMeta[] = [];
    // 每轮重新核对：上一轮确认过的副本可能又被同步写回来了。
    this.verifiedAbsent.clear();
    for (const tombstone of tombstones) {
      if (await this.wasRecreatedAfterDeletion(tombstone)) {
        expired.push(tombstone);
        continue;
      }
      await this.deleteEverywhere(this.fs, tombstone);
      for (const target of targets) {
        await this.deleteEverywhere(target.fs, tombstone);
      }
      // 删除之后再逐个目标核对"现在确实不存在"，只记下真实清干净的目标。
      for (const target of targets) {
        if (await this.absentOnTarget(target.fs, tombstone)) {
          this.markVerified(tombstone.path, target.id);
        }
      }
    }
    for (const tombstone of expired) {
      await this.remove(tombstone);
      log.log(
        `[TombstoneStore] expired tombstone for ${tombstone.path} — recreated after deletion`,
      );
    }
  }

  private markVerified(path: string, targetId: string): void {
    let ids = this.verifiedAbsent.get(path);
    if (!ids) {
      ids = new Set<string>();
      this.verifiedAbsent.set(path, ids);
    }
    ids.add(targetId);
  }

  /**
   * 目标上该路径当前是否确实不存在。
   *
   * `.mtime` 侧车与 `.keep` 占位对部分后端不可见（`exists()` 恒为 false），这类
   * 路径只能相信本轮 unlink 没有报错，因此按"不可见即可信"处理（与配置组的
   * `allReplicasConfirmAbsent` 一致）。
   */
  private async absentOnTarget(fs: any, tombstone: TombstoneMeta): Promise<boolean> {
    if (!isDirectoryTombstone(tombstone) && isHiddenPlaceholderPath(tombstone.path)) {
      return true;
    }
    try {
      const stat = await fs.stat?.(tombstone.path);
      if (stat) return false; // 还在
    } catch {
      /* stat 不可用或不存在，下面再用 exists 兜底 */
    }
    try {
      if (typeof fs.exists === 'function') return !(await fs.exists(tombstone.path));
    } catch {
      /* ignore */
    }
    return true;
  }

  /**
   * 本地存储上该路径的 mtime 是否晚于墓碑的删除时刻。
   *
   * 只看本地主存储：副本上的同路径文件可能只是「删除之前的旧副本」，它的 mtime
   * 本来就旧，用副本判定既不可靠又会掩盖真正的删除传播。
   */
  private async wasRecreatedAfterDeletion(tombstone: TombstoneMeta): Promise<boolean> {
    const mtimeMs = await this.mtimeOf(this.fs, tombstone.path);
    if (mtimeMs === null) return false;
    return mtimeMs > tombstone.deletedAt + RECREATE_AFTER_DELETE_SKEW_MS;
  }

  private async mtimeOf(fs: any, filePath: string): Promise<number | null> {
    try {
      const stat = await fs.stat?.(filePath);
      const mtimeMs = Number(stat?.mtimeMs);
      return Number.isFinite(mtimeMs) ? mtimeMs : null;
    } catch {
      return null; // 不存在（或后端不支持 stat）→ 不判定为重建
    }
  }

  private async deleteEverywhere(fs: any, tombstone: TombstoneMeta): Promise<void> {
    // 目录墓碑：按树清理，含隐藏的 `.keep` / `.keep.mtime` 占位。
    // `unlink(dir)` 会抛 EISDIR，而且这些占位在部分后端不可见（exists() 为
    // false），所以不能走"先 exists 再 unlink"的路径。
    if (isDirectoryTombstone(tombstone)) {
      await purgeTombstonedTree(fs, tombstone.path);
      return;
    }
    // `.mtime` sidecars are hidden from the backend index (GiteeFS keeps them in
    // its SHA cache only), so exists() lies and the unlink below would never run.
    // Attempt the delete unconditionally — a missing blob just throws and is ignored.
    if (!isMtimeSidecarPath(tombstone.path) && !(await existsSafe(fs, tombstone.path))) return;
    try {
      await fs.unlink(tombstone.path);
    } catch {
      /* race — already gone */
    }
  }

  /**
   * 把本轮真正核对过"确实不存在"的目标写进墓碑的 `confirmedBy`。
   *
   * 旧实现把传入的后端 id 无条件写入，等于"跑过一轮就算所有副本都清干净了"；
   * 副本删除失败时墓碑仍会被 GC，下一轮同步再把残留拉回本地。现在只确认
   * {@link process} 中现场核对通过的目标（与配置组语义一致），并支持只传 id
   * 的旧调用方式（此时沿用同一份核对结果）。
   */
  async confirm(targets: TombstoneTarget[] | string[]): Promise<number> {
    const isTargetList = (value: TombstoneTarget[] | string[]): value is TombstoneTarget[] =>
      value.length > 0 && typeof (value[0] as any) === 'object';
    const ids = isTargetList(targets) ? targets.map((t) => t.id) : targets;
    const tombstones = await this.list();
    let modified = 0;
    for (const tombstone of tombstones) {
      const verified = this.verifiedAbsent.get(tombstone.path);
      let changed = false;
      for (const id of ids) {
        if (tombstone.confirmedBy.includes(id)) continue;
        if (!verified?.has(id)) continue; // 没核对通过 → 保守：不确认
        tombstone.confirmedBy.push(id);
        changed = true;
      }
      if (!changed) continue;
      try {
        await this.save(tombstone);
        modified++;
      } catch {
        /* ignore */
      }
    }
    return modified;
  }

  /** Remove tombstones confirmed by every connected backend. */
  async gc(allBackendIds: string[], targets: TombstoneTarget[] = []): Promise<void> {
    const tombstones = await this.list();
    for (const tombstone of tombstones) {
      // 保留期内不回收：确认只覆盖本实例的后端，滞后客户端还没看到墓碑。
      if (!isTombstoneRetentionElapsed(tombstone)) continue;
      const allConfirmed = allBackendIds.every((id) => tombstone.confirmedBy.includes(id));
      if (!allConfirmed) continue;
      // 与配置组一致：不能只看历史 confirmedBy —— 某个副本可能在上次确认之后
      // 又把残留带了回来，GC 前必须现场复核"当前确实不存在"。
      let stillAbsent = true;
      for (const target of targets) {
        if (!(await this.absentOnTarget(target.fs, tombstone))) {
          stillAbsent = false;
          break;
        }
      }
      if (!stillAbsent) continue;
      const p = this.pathFor(tombstone.path);
      if (await existsSafe(this.fs, p)) {
        try {
          await this.fs.unlink(p);
        } catch {
          /* race */
        }
      }
      for (const target of targets) {
        if (await existsSafe(target.fs, p)) {
          try {
            await target.fs.unlink(p);
          } catch {
            /* race */
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// VersionStore (data groups)
// ---------------------------------------------------------------------------

/**
 * Version records for data files, stored centrally under `/.meta/versions/`.
 * Config-sync keeps its historical `<file>.version` sidecars; only data groups
 * use this store (see SYNC-GROUP-UNIFICATION §4.4 for the migration note).
 */
export class VersionStore {
  constructor(
    private fs: MetaFS,
    private author: string,
  ) {}

  /** `null` for metadata paths and version files themselves. */
  pathFor(filePath: string): string | null {
    const normalized = filePath.startsWith('/') ? filePath : `/${filePath}`;
    if (normalized.startsWith(`${META_DIR}/`)) return null;
    if (normalized.endsWith('.version')) return null;
    return `${VERSIONS_DIR}/${encodeMetaPath(normalized)}.json`;
  }

  async read(filePath: string): Promise<VersionMeta | null> {
    const p = this.pathFor(filePath);
    if (!p) return null;
    return readJson<VersionMeta>(this.fs, p);
  }

  async record(filePath: string, content: Uint8Array): Promise<VersionMeta | null> {
    const p = this.pathFor(filePath);
    if (!p) return null;
    const prev = await this.read(filePath);
    const hash = await sha256(content);
    if (prev && prev.hash === hash) return prev;
    const meta: VersionMeta = {
      version: (prev?.version ?? 0) + 1,
      hash,
      author: this.author,
      timestamp: Date.now(),
    };
    await writeJson(this.fs, p, meta);
    return meta;
  }

  async remove(filePath: string): Promise<void> {
    const p = this.pathFor(filePath);
    if (!p || !(await existsSafe(this.fs, p))) return;
    try {
      await this.fs.unlink(p);
    } catch {
      /* race */
    }
  }
}

// ---------------------------------------------------------------------------
// ConflictStore (data groups)
// ---------------------------------------------------------------------------

export interface RawConflict {
  path: string;
  sourceContent: string;
  targetContent: string;
  resolvedWith?: string;
}

/**
 * Conflict archives for data files, stored under `/.meta/conflicts/`.
 * Legacy `/.meta/.conflicts/` archives stay readable (list/read fallback).
 */
export class ConflictStore {
  constructor(
    private fs: MetaFS,
    private appId: string,
    private nodeId: string,
    private versions: VersionStore,
  ) {}

  /** Persist source/target backups + meta.json. Returns the archive record. */
  async archive(conflict: RawConflict, timestamp = Date.now()): Promise<ConflictArchive> {
    const conflictId = `${timestamp}_${conflict.path.replace(/\//g, '_')}`;
    const dir = `${CONFLICTS_DIR}/${conflictId}`;
    await ensureParentDir(this.fs, `${dir}/meta.json`);
    await this.fs.writeFile(`${dir}/source`, new TextEncoder().encode(conflict.sourceContent));
    await this.fs.writeFile(`${dir}/target`, new TextEncoder().encode(conflict.targetContent));

    const sourceVersion = (await this.versions.read(conflict.path))?.version ?? 0;
    const archive: ConflictArchive = {
      conflictPath: conflict.path,
      timestamp,
      sourceAuthor: `${this.appId}/${this.nodeId}`,
      targetAuthor: 'unknown',
      sourceVersion,
      targetVersion: 0,
      ...(conflict.resolvedWith ? { resolvedStrategy: conflict.resolvedWith as any } : {}),
      sourceBackupPath: './source',
      targetBackupPath: './target',
    };
    await writeJson(this.fs, `${dir}/meta.json`, archive);
    return archive;
  }

  /** All archives, new layout first, legacy entries only when not shadowed. */
  async list(): Promise<ConflictArchive[]> {
    const seen = new Set<string>();
    const archives: ConflictArchive[] = [];
    for (const dir of [CONFLICTS_DIR, LEGACY_CONFLICTS_DIR]) {
      let entries: string[];
      try {
        entries = await this.fs.readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (seen.has(entry)) continue;
        const archive = await readJson<ConflictArchive>(this.fs, `${dir}/${entry}/meta.json`);
        if (!archive) continue;
        seen.add(entry);
        archives.push(archive);
      }
    }
    return archives.sort((a, b) => a.timestamp - b.timestamp);
  }

  private candidatesFor(conflictId: string): string[] {
    const id = conflictId.replace(/\/meta\.json$/, '');
    return [`${CONFLICTS_DIR}/${id}`, `${LEGACY_CONFLICTS_DIR}/${id}`];
  }

  async readBackup(conflictId: string, fileType: 'source' | 'target' | 'resolved'): Promise<string> {
    for (const dir of this.candidatesFor(conflictId)) {
      const p = `${dir}/${fileType}`;
      try {
        return new TextDecoder().decode(toBytes(await this.fs.readFile(p)));
      } catch {
        /* try next */
      }
    }
    throw new Error(`Conflict backup not found: ${conflictId}/${fileType}`);
  }

  /** Resolve a conflict with raw (already serialized) content. */
  async resolve(conflictId: string, mergedContent: string | Uint8Array): Promise<void> {
    for (const dir of this.candidatesFor(conflictId)) {
      const metaPath = `${dir}/meta.json`;
      const archive = await readJson<ConflictArchive>(this.fs, metaPath);
      if (!archive) continue;

      const bytes = typeof mergedContent === 'string'
        ? new TextEncoder().encode(mergedContent)
        : mergedContent;
      await ensureParentDir(this.fs, archive.conflictPath);
      await this.fs.writeFile(archive.conflictPath, bytes);
      await this.versions.record(archive.conflictPath, bytes);

      await this.fs.writeFile(`${dir}/resolved`, bytes);
      archive.resolvedBackupPath = './resolved';
      await writeJson(this.fs, metaPath, archive);
      return;
    }
    throw new Error(`Failed to resolve conflict ${conflictId}: archive not found`);
  }
}
