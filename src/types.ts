/**
 * zen-fs-config — Core Type Definitions
 *
 * All public types for the configuration management library.
 */

import type { SyncResult, SyncPairStatus, ConflictStrategy } from 'zen-fs-sync';
import type { MtimePurgeResult } from './mtime-cleanup';
import type { KeepPurgeResult } from './keep-cleanup';

// ---------------------------------------------------------------------------
// Backend Topology
// ---------------------------------------------------------------------------

/** A single backend in the topology. */
export interface BackendDescriptor {
  /** Unique identifier within this config repo (e.g., "local-idb"). */
  id: string;
  /** Backend type name, resolved via the backend registry. */
  type: string;
  /** Options passed to the backend constructor. */
  options: Record<string, unknown>;
  /** Human-readable description. */
  description?: string;
}

/** Content of `.meta/backends.json`. */
export interface BackendsMeta {
  version: 1;
  backends: BackendDescriptor[];
}

// ---------------------------------------------------------------------------
// Version Files (Sidecar)
// ---------------------------------------------------------------------------

/** Content of a sidecar `.version` file. */
export interface VersionMeta {
	/** Version number; increases only when the config content hash changes. */
	version: number;
	/** SHA-256 hash of the corresponding config file content. */
	hash: string;
  /** Author identifier (e.g., "app-a/server-1"). */
  author: string;
  /** Timestamp when the version was created. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Tombstones (Deletion Tracking)
// ---------------------------------------------------------------------------

/**
 * 墓碑目标类型。
 * - `file`（缺省，兼容旧数据）：只删除该路径这一个文件。
 * - `directory`：删除整个目录树。目录墓碑只需一条记录，不必为树里每个文件
 *   各写一条；应用时按树清理（含 `.keep` / `.keep.mtime` 占位）。
 */
export type TombstoneType = 'file' | 'directory';

/** Content of a tombstone file in `.meta/tombstones/`. */
export interface TombstoneMeta {
  /** 被删除的路径（目录墓碑为目录本身，不带结尾 `/`）。 */
  path: string;
  /** Timestamp of deletion. */
  deletedAt: number;
  /** Backend ID that initiated the deletion. */
  deletedBy: string;
  /** Backend IDs that have confirmed the deletion (synced). */
  confirmedBy: string[];
  /** 目标类型；缺省视为 `file`（旧版本墓碑没有该字段）。 */
  type?: TombstoneType;
}

// ---------------------------------------------------------------------------
// Conflict Archives
// ---------------------------------------------------------------------------

/** Content of a conflict archive file in `.meta/.conflicts/`. */
export interface ConflictArchive {
  /** The config file path that conflicted. */
  conflictPath: string;
  /** Timestamp of the conflict. */
  timestamp: number;
  /** Author of the source side. */
  sourceAuthor: string;
  /** Author of the target side. */
  targetAuthor: string;
  /** Source side version. */
  sourceVersion: number;
  /** Target side version. */
  targetVersion: number;
  /** Strategy that was used to auto-resolve (if any). */
  resolvedStrategy?: ConflictStrategy;

  // --- Backup file paths (relative to CONFLICTS_DIR) ---
  /** Path to the source-side backup file. */
  sourceBackupPath: string;
  /** Path to the target-side backup file. */
  targetBackupPath: string;
  /** Path to the resolved file (present after resolution). */
  resolvedBackupPath?: string;
}

/** Information passed to conflict event handlers. */
export interface ConflictInfo {
  /** Unique conflict ID (derived from archive filename). */
  conflictId: string;
  /** The config file path that conflicted. */
  path: string;
  /** Source side author. */
  sourceAuthor: string;
  /** Target side author. */
  targetAuthor: string;
  /** Source content. */
  sourceContent: unknown;
  /** Target content. */
  targetContent: unknown;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Pluggable serializer for config files. */
export interface ConfigSerializer {
  /** Serialize a value to bytes. */
  serialize(data: unknown): Uint8Array;
  /** Deserialize bytes to a value. */
  deserialize(raw: Uint8Array, path: string): unknown;
  /** Check if this serializer can handle the given file path. */
  canHandle(path: string): boolean;
}

// ---------------------------------------------------------------------------
// ConfigRepo Options
// ---------------------------------------------------------------------------

/** Cache configuration. */
export interface CacheOptions {
  /**
   * Type of cache store for replica backends.
   * Default: `'IdbCacheStore'` — persists across page reloads so cached
   * content + revision tokens survive. Use `'MemoryCacheStore'` for
   * session-only caching (lost on reload).
   */
  storeType?: 'MemoryCacheStore' | 'IdbCacheStore';
  /** Cache store prefix (for IdbCacheStore). Default: `'zen-fs-config:'`. */
  storePrefix?: string;
  /**
   * TTL in milliseconds for cache hits without revalidation.
   * Default: 0 (always revalidate via `getRevision` — exact, no stale data).
   * Ignored when the backend implements `getRevision`.
   */
  ttlMs?: number;
}

/** Options for creating a ConfigRepo. */
export interface ConfigRepoOptions {
  /**
   * ID for a user-provided replica backend.
   * If `backendInfo` is provided, this ID identifies the replica in `.meta/backends/`.
   * If omitted, a default ID based on the backend type is generated.
   * The local IndexedDB primary always uses the fixed ID `local-idb`.
   */
  primaryBackendId?: string;

  /**
   * Connection info for a user-provided replica backend.
   * When provided, this backend is added as a replica and auto-synced with
   * the local IndexedDB primary. When omitted, only the local IndexedDB
   * primary is used (offline-first mode).
   */
  backendInfo?: {
    type: string;
    options: Record<string, unknown>;
  };

  /**
   * 连接前已探测到的远端描述符（内部优化）：同一个 type+options 的副本在
   * `setupSync()` 里直接复用，省掉一次重复的 `group.json` 远端读。
   * `descriptor: null` 表示已确认远端没有描述符（空库 / 老仓库）。
   */
  prefetchedRemote?: {
    type: string;
    options?: Record<string, unknown>;
    descriptor: GroupDescriptor | null;
  };

  /**
   * 把副本建对推迟到后台（默认 true）。`createConfigRepo` 先用本地缓存可用，
   * 副本校验与建对由 `whenReplicasReady()` 通知；校验完成前不会建任何 pair，
   * 也不会启动首同步。传 `false` 恢复旧行为（逐个校验远端后再返回，任一后端
   * 不响应会一直等下去）。
   */
  deferReplicaSetup?: boolean;

  /** IndexedDB store name for the local primary backend. Default: `zen-fs-config-{appId}` */
  idbStoreName?: string;

  /**
   * Directory for the local primary backend on Node.js (used when IndexedDB is
   * unavailable). Only applies on Node.js; ignored in browsers. Defaults to
   * `$ZEN_FS_CONFIG_HOME` (or `~/.zen-fs-config`) when omitted.
   */
  folderPath?: string;

  /** Node identifier. Auto-detected if not provided (see DESIGN.md §8.2). */
  nodeId?: string;

  /**
   * 配置组的 profile 名。缺省 `config`。
   *
   * 身份按 profile 确定性派生（`config:<profile>`），所以多个应用共享同一个
   * 配置组时，只要 profile 与远端根相同，各端算出的 instanceId 都相同。
   * 一个远端根只能承载一个 profile。
   */
  profile?: string;

  /**
   * Cache configuration for replica backends.
   *
   * - **Default** (omitted): Caching is enabled with `IdbCacheStore`
   *   (persists across page reloads). Replica backends (Gitee,
   *   RemoteStorage, etc.) are wrapped with `CachedFileSystem` to avoid
   *   redundant network reads via `getRevision` revalidation.
   * - Pass a `CacheOptions` object to customize the store type, prefix,
   *   or TTL.
   * - Pass `false` to disable caching entirely (all reads go directly
   *   to the backend).
   */
  cache?: CacheOptions | false;

  /** Custom serializer. */
  serializer?: ConfigSerializer;

  /** Custom conflict handler. Called before auto-resolution. */
  onConflict?: (conflict: ConflictInfo) => Promise<unknown | null>;

  /**
   * Sync polling interval in milliseconds.
   * Controls how often the sync engine checks for remote changes.
   * Default: 1800000 (30 minutes).
   */
  syncPollIntervalMs?: number;

  /**
   * Delete leaked `.mtime` sidecars from the local primary on startup.
   *
   * Backends that keep a precise mtime out-of-band (RemoteStorage, Gitee…)
   * write a `.mtime` file next to each data file. Older builds copied those
   * backend-internal files into the local primary, where sync ignores them —
   * so they linger forever and warn on every walk.
   *
   * Default: `true`. Pass `false` to skip the (local-only) startup sweep.
   */
  purgeMtimeSidecars?: boolean;

  /**
   * Delete leaked `.keep` placeholders from the local primary on startup.
   *
   * Backends that cannot store empty directories (Gitee, RemoteStorage…) keep a
   * directory alive with an internal `.keep` placeholder. Older builds copied
   * those backend-internal files into the local primary, where sync ignores
   * them — so they linger forever. The intentional `/.meta/backends/.keep` is
   * always protected.
   *
   * Default: `true`. Pass `false` to skip the (local-only) startup sweep.
   */
  purgeKeepFiles?: boolean;

  /**
   * Migrate legacy `.x.version` sidecars to the new `<name>.version` naming on
   * startup (rename locally, delete the remote residual).
   *
   * Older builds stored version sidecars as hidden dotfiles (`.db.json.version`).
   * They are now `<name>.version`. This one-time sweep renames existing legacy
   * sidecars (preserving version history) and removes the old copy from every
   * replica so sync does not pull it back.
   *
   * Default: `true`. Pass `false` to skip the startup sweep.
   */
  migrateVersionSidecars?: boolean;
}

// ---------------------------------------------------------------------------
// Sync Group Types
// ---------------------------------------------------------------------------

/** Type of sync group. */
export type SyncGroupType = 'config-sync' | 'data-sync';

/** Descriptor for a backend within a data-sync group. */
export interface AppDataBackendDescriptor {
  id: string;
  type: string;
  options: Record<string, unknown>;
  /** Optional: reuse account fields from a config-sync backend. */
  accountBackendId?: string;
  description?: string;
  /**
   * Optional creation timestamp (ms). Used when deduplicating backends that
   * point to the same endpoint — the OLDEST one is kept. Backends without
   * this field are treated as legacy/oldest (e.g. a fixed `*-primary` id).
   */
  createdAt?: number;
}

/** Descriptor for a data-sync group referenced by a config-sync group. */
export interface AppDataGroupDescriptor {
  id: string;
  groupType: 'data-sync';
  /** User-editable display name. `id` is the stable identifier. */
  name?: string;
  /**
   * 组的实例身份（见 `GroupDescriptor.instanceId`）。引导副本随它一起下发，
   * 让新设备在连远端之前就知道该组声明的身份，避免认领到别人的仓库。
   */
  instanceId?: string;
  /** Capability overrides (versions/conflicts are opt-in for data groups). */
  features?: Partial<SyncGroupFeatures>;
  backends: AppDataBackendDescriptor[];
}

/** Descriptor for the config-sync group itself (display metadata only). */
export interface ConfigSyncGroupDescriptor {
  groupType: 'config-sync';
  /** User-editable display name. The group has no separate id. */
  name?: string;
}

/** Per-backend sync state of a group. */
export interface BackendSyncState {
  backendId: string;
  /** Pair id when the backend instance was created and paired successfully. */
  pairId?: string;
  /**
   * Present when this descriptor could not be connected (e.g. a required
   * option is missing), so no sync pair exists for it.
   */
  error?: { message: string; timestamp: number };
}

/**
 * 同步对事件（`onSyncEvent`）。
 *
 * `sync:end` 每轮同步结束都会发（**包含零变更轮**），调用方可用 `result`
 * 里的计数过滤自己关心的变更；`sync:error` 只在整轮抛错时发。
 */
export interface SyncGroupSyncEvent {
  /**
   * `sync:progress` 由未来的 zen-fs-sync 逐文件进度回调提供；当前上游没有，
   * 库不会伪造这个事件。
   */
  type: 'sync:start' | 'sync:progress' | 'sync:end' | 'sync:error' | 'conflict';
  /** 事件所属组的类型。 */
  groupKind: SyncGroupKind;
  /** 配置组固定为 `config`；数据组为其 groupId。 */
  groupId: string;
  /** 该同步对对应的后端 id（不含隐式本地主库）。 */
  backendId: string;
  pairId: string;
  timestamp: number;
  /** `sync:end` 时附带本轮结果。 */
  result?: SyncResult;
  /** `sync:error` 时的错误消息。 */
  error?: string;
  /**
   * 逐文件进度。上游 `zen-fs-sync` 尚未提供，保留字段供后续透传。
   * 调用方不能假设它一定存在，也不能据此伪造百分比。
   */
  progress?: {
    processed: number;
    total?: number;
    currentPath?: string;
    phase?: string;
  };
  /** `conflict` 时的上游冲突详情。 */
  conflict?: unknown;
}


// ---------------------------------------------------------------------------
// Sync Group (unified config-sync / data-sync model)
// ---------------------------------------------------------------------------

/** Structural discriminator for a sync group. */
export type SyncGroupKind = 'config' | 'data';

/** Capability switches, derived from `kind` + the group descriptor. */
export interface SyncGroupFeatures {
  tombstones: boolean;
  versions: boolean;
  conflicts: boolean;
  /** Config payload: app config, node config, group descriptors. */
  configHost: boolean;
  /** Whether the product layer may read/write the group root directly. */
  appData: boolean;
}

/** Content of `.meta/group.json` — the unified group descriptor. */
export interface GroupDescriptor {
  /**
   * 2 = 规范化序列化 + 不再写 `updatedAt`。读取时 1 与 2 一视同仁；
   * 1 的老文件会在下一次内容变化时被就地升级。
   */
  schemaVersion: 1 | 2;
  kind: SyncGroupKind;
  /** Group id (`config` for the config-sync group, the descriptor id otherwise). */
  id?: string;
  /**
   * 组的实例身份（UUID）。创建时生成一次，之后不可变。
   *
   * 同步边界就是它：连接任何远端之前先读对方的 `.meta/group.json`，实例身份
   * 不一致就**不建立同步对**，因此两个不同的同步组永远不会互相同步。
   * 缺失表示「尚未认领」的老仓库，由第一个连接的组认领并写入。
   */
  instanceId?: string;
  /** User-editable display name. */
  name?: string;
  /**
   * 配置组的 profile 名（仅 `kind=config`）。缺省 `config`。
   *
   * 一个远端根只承载一个 profile；身份按 profile 派生，因此多个应用共享同一个
   * 配置组（同一 profile、同一远端根）时算出的 instanceId 天然一致。
   */
  profile?: string;
  features?: Partial<SyncGroupFeatures>;
  /**
   * @deprecated 不再写入、读取侧忽略。时间戳写进随同步走的内容会形成
   * 「写 → 内容变 → 触发同步 → 对端再写」的无限回环，只允许放在本地存储。
   */
  updatedAt?: number;
}

/**
 * One sync group = a local primary store + zero-or-more remote replicas +
 * the shared `.meta/` metadata area + that group's own backend definitions.
 *
 * 配置组与数据组是**同一基座上的两个能力位**，不是「配置组 ⊃ 数据组」：
 *   - 配置组 `configHost = true`：可承载 `.config`（数据组登记、引导副本、
 *     `group-type`），整棵 `/` 参与同步；
 *   - 数据组 `appData = true`：可被登记为数据组，同步时排除 `/.config`、
 *     `/nodes`、`/shared`。
 * 两个能力位互不蕴含。
 */
/** 归属冲突的细分原因。 */
export type BackendConflictReason =
  | 'kind-mismatch'
  | 'id-mismatch'
  | 'instance-mismatch'
  | 'unreadable'
  | 'claim-failed'
  /** 本组实例身份尚未确定（没有读到任何候选），本轮不判定、也不认领。 */
  | 'local-unset';

/**
 * 一个后端与远端根归属冲突的完整信息。
 *
 * `kind` / `id` / `instanceId` 三者用途不同，必须同时展示：
 *   - `kind`：组类型（config / data）；
 *   - `id`：组 id（同时决定本地库名与引导副本路径）；
 *   - `instanceId`：组实例身份（UUID，判定“这个远端根归谁”）。
 */
export interface BackendConflictInfo {
  backendId: string;
  /** 一句话原因（已含两侧身份摘要，可直接展示）。 */
  reason: string;
  conflict?: BackendConflictReason;
  /** 远端根的现状；空仓库或读不到时为 null。 */
  remote: { kind?: SyncGroupKind; id?: string; instanceId?: string; name?: string } | null;
  /** 本组身份。 */
  local: { kind: SyncGroupKind; id: string; instanceId?: string };
  /** 允许“只把本地 instanceId 对齐到远端”（要求 kind 与 id 都相同）。 */
  canAdoptRemoteInstance: boolean;
  /** 允许“把远端 group.json 改写成本组身份”（要求 kind 相同；会影响共享该根的副本）。 */
  canRewriteRemoteIdentity: boolean;
  unreadable?: boolean;
  error?: string;
}

/** 用户确认后的冲突解决动作。 */
export type BackendConflictResolution =
  | 'adopt-remote-instance'
  | 'rewrite-remote-identity';

export interface BackendConflictResolutionResult {
  mode: BackendConflictResolution;
  ok: boolean;
  reason?: string;
  /** adopt-remote-instance 成功后应落盘的本地 instanceId。 */
  instanceId?: string;
}

/** `instanceId` 的候选来源：本地描述符 / 共享引导副本 / 某个远端根。 */
export type IdentityCandidateSource = 'local' | 'bootstrap' | 'remote';

/**
 * 一条身份候选。同一值可能被多个根持有，用 `rootCount` 表示。
 * 界面必须把它们全部列出，由用户决定本组最终使用哪个值。
 */
export interface IdentityCandidate {
  source: IdentityCandidateSource;
  /** 远端候选对应的后端 id（local / bootstrap 无此字段）。 */
  backendId?: string;
  instanceId: string;
  /** 持有该值的根数量（local / bootstrap 为 1）。 */
  rootCount: number;
  /** 该值所属的 kind / id；与本组不一致的候选已在收集阶段被排除。 */
  kind?: SyncGroupKind;
  id?: string;
}

/** 用户决定本组实例身份时的选项。 */
export interface SetGroupInstanceIdOptions {
  /**
   * 同时把本组所有 `kind` / `id` 相同的远端根统一成该值（默认 false）。
   * 这是唯一会改写远端 `group.json` 的路径，必须由用户确认后调用。
   */
  rewriteRoots?: boolean;
}

/** 逐个远端根的写回结果。 */
export interface GroupInstanceIdRootResult {
  backendId: string;
  ok: boolean;
  /** 该根原本的 instanceId（用于如实汇报“从什么改成什么”）。 */
  before?: string;
  reason?: string;
}

export interface SetGroupInstanceIdResult {
  ok: boolean;
  instanceId?: string;
  reason?: string;
  /** 各根的处理结果（`rewriteRoots: true` 时逐条返回）。 */
  roots: GroupInstanceIdRootResult[];
}

export interface SyncGroupHandle {
  readonly groupId: string;
  readonly appId: string;
  readonly kind: SyncGroupKind;
  /** Derived, never persisted separately from the descriptor. */
  readonly features: SyncGroupFeatures;
  readonly name?: string;
  /**
   * 本组的实例身份（UUID）。它是同步边界：连接远端前比对对方
   * `.meta/group.json` 的 `instanceId`，不一致就不建同步对。
   */
  getGroupInstanceId(): string | undefined;
  /** 因归属其他同步组而被跳过的后端（不建同步对）。 */
  listSkippedBackends(): { backendId: string; reason: string }[];
  /**
   * 归属冲突的完整信息（含两侧 kind / id / instanceId 与可执行的对齐动作）。
   * UI 应展示这些字段让用户判断，而不是只给一句“不一致”。
   */
  listBackendConflicts(): BackendConflictInfo[];
  /**
   * 用户确认后解决某个后端的归属冲突。
   * 调用方负责二次确认，并在成功后重新连接/刷新（本组实例需要重新 init）。
   */
  resolveBackendConflict(
    backendId: string,
    mode: BackendConflictResolution,
  ): Promise<BackendConflictResolutionResult>;
  /**
   * 本组 `instanceId` 的全部候选（本地 / 引导副本 / 每个远端根）。
   * 不一致时界面必须让用户挑一个，不允许代码静默择一。
   */
  getIdentityCandidates(): IdentityCandidate[];
  /**
   * 同上，但会现场回读各根再返回（同步 getter 只给缓存）。
   * 界面优先用它，才能在「本地已有身份、远端与本地不一致」时看到两个值。
   * 可选：老版本实现可能没有这个方法。
   */
  getIdentityCandidatesAsync?(): Promise<IdentityCandidate[]>;
  /**
   * 候选之间是否互相矛盾（需要用户在界面上拍板）。
   * 可选：老版本实现可能没有这个方法，调用方按候选去重自行判断。
   */
  isIdentityUnsettled?(): boolean;
  /**
   * 用户确认后的唯一写入口：把本组身份设成指定值。
   * `rewriteRoots: true` 时一并把本组所有 kind/id 相同的根统一成该值。
   */
  setGroupInstanceId(
    instanceId: string,
    options?: SetGroupInstanceIdOptions,
  ): Promise<SetGroupInstanceIdResult>;

  /**
   * Direct fs view of the group root. `.config/` is hidden (config-sync
   * territory); sync bookkeeping under `.meta/` (tombstones / versions /
   * conflicts / group.json) is visible but read-only — writes there fail with
   * `EPERM`. Everything else, including `.meta/backends/`, is normal data.
   */
  readonly fs: typeof import('node:fs');

  // --- sync lifecycle ---
  getSyncStatuses(): Map<string, SyncPairStatus>;
  getBackendSyncStates(): Map<string, BackendSyncState>;
  /**
   * 订阅同步对事件（`sync:end` / `sync:error`）。返回取消订阅函数。
   * 可选：老版本实现可能没有该方法，调用方按可选处理。
   */
  onSyncEvent?(handler: (event: SyncGroupSyncEvent) => void): () => void;
  flush(): Promise<SyncResult[]>;
  dispose(): Promise<void>;

  // --- backend management ---
  addBackend(
    id: string,
    type: string,
    options: Record<string, unknown>,
    description?: string,
  ): Promise<void>;
  removeBackend(id: string): Promise<void>;
  listBackends(): AppDataBackendDescriptor[];
  /**
   * 该组**声明**的后端列表（权威定义，允许尚未连接成功的条目）。
   *
   * 数据组与配置组都读自 `.meta/backends/`（唯一权威位置）。
   * 与 `listBackends()`（已连接视图）不同，这个列表不会因为后端暂时不可达
   * 而少显示条目。
   */
  listDeclaredBackends(): AppDataBackendDescriptor[];
  /** Update the display name only (descriptor-only). */
  rename(name: string): Promise<void>;

  // --- deletion & metadata (common to both kinds) ---
  /** Write a tombstone, delete the file + version record, trigger sync. */
  deleteFile(path: string): Promise<void>;
  listConflicts(): Promise<ConflictArchive[]>;
  resolveConflict(conflictId: string, mergedContent: unknown): Promise<void>;
  readConflictBackup(conflictId: string, fileType: 'source' | 'target' | 'resolved'): Promise<string>;
  purgeMtimeSidecars(options?: { root?: string; dryRun?: boolean }): Promise<MtimePurgeResult>;
  purgeKeepFiles(options?: { root?: string; dryRun?: boolean }): Promise<KeepPurgeResult>;
}

/** Handle to a data-sync group, providing direct fs access. */
export interface AppDataGroup extends SyncGroupHandle {
  readonly kind: 'data';
  /**
   * 远端阶段（建实例 → 定身份 → 建同步对 → 首同步 → watch）的完成信号。
   *
   * 组实例在本地就绪后即返回，远端后端在后台逐个（并发 + 超时）探测；调用方可以
   * 先渲染组的本地状态，再等这个 Promise 结束后刷新为真实的同步对计数 / 错误。
   * 未启动时立即 resolve，永不 reject。旧版本没有该方法，调用方按可选处理。
   */
  whenBackendsReady?: () => Promise<void>;
}


// ---------------------------------------------------------------------------
// Connect (unified entry point)
// ---------------------------------------------------------------------------

/** Options for the unified connect() entry point. */
export interface ConnectOptions {
  /** Connection info for a user-provided backend. */
  backendInfo?: {
    type: string;
    options: Record<string, unknown>;
  };
  /**
   * Force a specific group type. For an already-marked remote it must match the
   * remote's type; for an empty remote it is treated as the user's explicit
   * choice (legacy callers). New callers should use `initGroupType` instead.
   */
  groupType?: SyncGroupType;
  /**
   * 空库初始化授权：仅当远端完全为空（无 group.json、无 group-type 标记）时使用。
   * 未提供时 connect() 抛 `NeedsInitError`，由 UI 询问用户后带上本字段重试。
   */
  initGroupType?: SyncGroupType;
  /** IndexedDB store name. Default: `zen-fs-config-{appId}` */
  idbStoreName?: string;
  /**
   * ID for a user-provided replica backend. If `backendInfo` is provided,
   * this ID identifies the replica in `.meta/backends/`. If omitted, a default
   * ID based on the backend type is generated.
   */
  primaryBackendId?: string;
  /**
   * Directory for the local primary backend on Node.js (used when IndexedDB is
   * unavailable). Only applies on Node.js; ignored in browsers. Defaults to
   * `$ZEN_FS_CONFIG_HOME` (or `~/.zen-fs-config`) when omitted.
   */
  folderPath?: string;
  /** Node identifier. Auto-detected if not provided. */
  nodeId?: string;
  /**
   * 配置组的 profile 名。缺省 `config`（见 `GroupDescriptor.profile`）。
   * 只影响配置组的确定性身份，不改变任何目录结构。
   */
  profile?: string;
  /**
   * Cache configuration for replica backends. Omit for the default
   * (`IdbCacheStore`, persists across reloads); pass `false` to disable; pass a
   * `CacheOptions` object to customize.
   */
  cache?: CacheOptions | false;
  /** Custom serializer. */
  serializer?: ConfigSerializer;
  /** Custom conflict handler. Called before auto-resolution. */
  onConflict?: (conflict: ConflictInfo) => Promise<unknown | null>;
  /** Sync polling interval in ms. Default: 1800000 (30 min). */
  syncPollIntervalMs?: number;

  /**
   * 把「建副本同步对」整体推迟到后台：`connect()` 只做探测 + 本地仓初始化，
   * 返回后由 `whenReplicasReady` 通知结果。默认 true（本地缓存优先启动）；
   * 传 false 恢复旧行为（等待所有副本校验完成才返回）。
   * 校验完成前不建任何 pair，因此不存在「建了又拆」的冲突窗口。
   */
  deferReplicaSetup?: boolean;
}

/** `whenReplicasReady()` 的结果：哪些副本已可用、哪些被跳过、哪些失败。 */
export interface ReplicaSetupSummary {
  /** 校验通过并已建同步对的副本 id。 */
  ready: string[];
  /** 因归属冲突/不可读被跳过的副本。 */
  skipped: { backendId: string; reason: string }[];
  /** 建实例或建对失败的副本。 */
  failed: { backendId: string; error: string }[];
}

/** Result of connect(). */
export interface ConnectResult {
  /** Detected or forced group type. */
  groupType: SyncGroupType;
  /**
   * The config-sync repo. Under the "data groups always managed by config-sync"
   * model this is always present — it hosts the data groups' topology.
   */
  repo?: IConfigRepo;
  /** The config-sync group as a unified handle (same object as `repo`). */
  configGroup?: ConfigSyncGroupHandle;
  /** All groups for this app: config group first, then data groups. */
  groups?: SyncGroupHandle[];
  /**
   * Handle to the default (`default`) app data group. Always owned by `repo`;
   * present on first launch and when a data-sync backend was connected.
   */
  dataGroup?: AppDataGroup;
  /** All app data group handles loaded for this app (may be empty). */
  appDataGroups?: AppDataGroup[];
  /**
   * 副本是否还在后台准备中。`true` 时 `repo` 已可用（本地数据可读），
   * 但远端同步对尚未建好，调用方应等待 `whenReplicasReady` 再做远端相关操作。
   */
  replicasPending?: boolean;
  /**
   * 副本准备结果。未开启 `deferReplicaSetup` 时是一个已 resolve 的 Promise。
   * 永不 reject：失败信息放在 `failed` / `skipped` 里。
   */
  whenReplicasReady?: Promise<ReplicaSetupSummary>;
}

// ---------------------------------------------------------------------------
// ConfigRepo Interface
// ---------------------------------------------------------------------------

/** The main configuration repository interface. */
export interface IConfigRepo {
  /** Application ID. */
  readonly appId: string;
  /** Node ID. */
  readonly nodeId: string;
  /**
   * 副本后台准备的结果（`deferReplicaSetup` 时才有意义）。
   * 未推迟时立即 resolve；永不 reject。
   */
  whenReplicasReady?(): Promise<ReplicaSetupSummary>;
  /** Fixed group id of the config-sync group (`config`). */
  readonly groupId: string;
  /** Structural discriminator — always `'config'`. */
  readonly kind: 'config';
  /** Capability switches (config group is the superset: all true). */
  readonly features: SyncGroupFeatures;
  /** User-editable display name (from `.config/config-sync-group.json`). */
  readonly name?: string;
  /** ZenFS-compatible fs object, context-isolated to this app's directories. */
  readonly fs: typeof import('node:fs');

  /** Un-chrooted fs for low-level browsing (includes /.meta/, all app dirs). */
  readonly rootFS: typeof import('node:fs');

  /** Load or reload configuration from a raw string. */
  load(rawConfig: string): Promise<void>;

  /** Read a config value. */
  getConfig<T = unknown>(path: string): T;

  /** Write a config value (auto-synced). */
  setConfig(path: string, data: unknown): void;

  /** Read node-local config. */
  getNodeConfig<T = unknown>(nodeId: string, path: string): Promise<T>;

  /** Write node-local config (no auto-sync). */
  setNodeConfig(nodeId: string, path: string, data: unknown): Promise<void>;

  /** Publish node-local config to sync backends (one-time, for debugging). */
  publishNodeConfig(nodeId: string, options?: {
    paths?: string[];
  }): Promise<SyncResult>;

  /** Peek at another node's published config (read-only). */
  peekNodeConfig<T = unknown>(nodeId: string, path: string): Promise<T>;

  /** Manually flush all pending sync operations. */
  flush(): Promise<SyncResult[]>;

  /** Get sync status for all registered sync pairs. */
  getSyncStatuses(): Map<string, SyncPairStatus>;

  /**
   * Subscribe to pair-level sync events (`sync:end` / `sync:error`).
   * Returns an unsubscribe function. Optional for older implementations.
   */
  onSyncEvent?(handler: (event: SyncGroupSyncEvent) => void): () => void;

  /**
   * Per-backend sync state, including replica descriptors that failed to
   * connect and therefore have no pair (they do not appear in
   * getSyncStatuses()).
   */
  getBackendSyncStates(): Map<string, BackendSyncState>;

  /** Update the config-sync group's display name only. */
  rename(name: string): Promise<void>;

  /** Resolve a conflict with custom merged content. */
  resolveConflict(conflictId: string, mergedContent: unknown): Promise<void>;

  /** List all conflict archives. */
  listConflicts(): Promise<ConflictArchive[]>;

  /** Read the raw content of a conflict backup file (source/target/resolved).
   *  @param conflictId The meta.json path (e.g., "12345_path.conflict/meta.json")
   *  @param fileType One of "source", "target", or "resolved"
   */
  readConflictBackup(conflictId: string, fileType: 'source' | 'target' | 'resolved'): Promise<string>;

  /** Read backend topology (aggregated from .meta/backends/*.json). */
  getBackends(): Promise<BackendsMeta | null>;

  /** Write backend topology (writes each backend as .meta/backends/{id}.json). */
  updateBackends(meta: BackendsMeta): Promise<void>;

  /**
   * Dynamically add a replica backend.
   * Creates the backend instance, saves its descriptor as `.meta/backends/{id}.json`,
   * sets up bi-directional sync with the local IndexedDB primary, and triggers
   * an initial sync.
   * @param id Unique backend ID (e.g., "gitee-prod")
   * @param type Backend type name (must be registered via `registerBackend()`)
   * @param options Options passed to the backend constructor
   * @param description Optional human-readable description
   */
  addBackend(id: string, type: string, options: Record<string, unknown>, description?: string): Promise<void>;

  /**
   * Dynamically remove a replica backend.
   * Tears down the sync pair, removes the backend descriptor file, and disposes
   * the backend instance. The local IndexedDB primary cannot be removed.
   * @param id Backend ID to remove
   */
  removeBackend(id: string): Promise<void>;

  /**
   * Delete a file and record a tombstone for cross-backend sync.
   * The tombstone ensures the deletion propagates to all backends
   * instead of being treated as a "missing file" that gets re-created.
   */
  deleteFile(path: string): Promise<void>;

  /**
   * Write a repo-root file (`/.config/...`, `/.meta/...`, `/shared/...`) at its
   * real path and record its `.version` sidecar.
   *
   * Distinct from `setConfig(path)`, which prefixes `/${appId}` and is meant for
   * app payload keys; using it for root paths writes to a shadow location
   * (`/admin/.config/...`) that nothing reads.
   */
  writeRepoFile(path: string, data: string | Uint8Array): Promise<void>;

  /**
   * Sync .meta/ files (backends.json) to all replica backends.
   * Called automatically by createConfigRepo() after setupSync().
   */
  syncMetaToReplicas(): Promise<void>;

  /**
   * Delete leaked `.mtime` sidecars from the local primary backend.
   *
   * Runs automatically on `createConfigRepo()` unless
   * `options.purgeMtimeSidecars === false`. Call it manually to clean a
   * long-lived store, or with `{ dryRun: true }` to only list them.
   */
  purgeMtimeSidecars(options?: { root?: string; dryRun?: boolean }): Promise<MtimePurgeResult>;

  /**
   * Delete leaked `.keep` placeholders from the local primary backend.
   *
   * Runs automatically on `createConfigRepo()` unless
   * `options.purgeKeepFiles === false`. Call it manually to clean a
   * long-lived store, or with `{ dryRun: true }` to only list them.
   */
  purgeKeepFiles(options?: { root?: string; dryRun?: boolean }): Promise<KeepPurgeResult>;

  // --- App Data Storage (data-sync groups) ---

  /**
   * Create a data-sync group for this app.
   * Each backend can optionally reference a config-sync backend's account
   * via `accountBackendId` to reuse credentials.
   */
  createAppDataGroup(
    id: string,
    backends: AppDataBackendDescriptor[],
    options?: { name?: string; features?: Partial<SyncGroupFeatures> },
  ): Promise<AppDataGroup>;

  /** Get an existing data-sync group handle. */
  getAppDataGroup(id: string): Promise<AppDataGroup>;

  /** List all data-sync group descriptors for this app. */
  listAppDataGroups(): Promise<AppDataGroupDescriptor[]>;

  /**
   * Update a data-sync group's display name (descriptor-only; id, backends,
   * local and remote data are untouched). Empty/oversized names are rejected.
   */
  updateAppDataGroupName(id: string, name: string): Promise<void>;

  /** Read the config-sync group's display descriptor (may be absent). */
  getConfigSyncGroupDescriptor(): Promise<ConfigSyncGroupDescriptor | null>;

  /**
   * Update the config-sync group's display name (descriptor-only; backends,
   * local store and remote data are untouched).
   */
  updateConfigSyncGroupDescriptor(patch: { name: string }): Promise<ConfigSyncGroupDescriptor>;

  /**
   * Replace a backend's parameters while keeping its id.
   *
   * Changing parameters means switching to a different remote target:
   * the old sync pair is torn down, the new backend is instantiated, paired
   * and initially synced. Old remote data is NOT migrated. If the new
   * parameters cannot be instantiated, the old backend/pair is left intact
   * and the error is rethrown.
   */
  replaceBackend(
    id: string,
    type: string,
    options: Record<string, unknown>,
    description?: string,
  ): Promise<void>;

  /**
   * Replace a data-sync backend's parameters (same semantics as
   * replaceBackend: old pair is rebuilt against the new target).
   */
  replaceAppDataGroupBackend(
    groupId: string,
    backendId: string,
    type: string,
    options: Record<string, unknown>,
    description?: string,
  ): Promise<AppDataGroup>;

  /** Remove a data-sync group (stops sync, removes descriptor). */
  removeAppDataGroup(id: string): Promise<void>;

  /**
   * List config-sync backends that can be used as account sources
   * for data-sync backends. Returns backends that have `accountFields`
   * declared in their metadata (e.g., Gitee/GitHub with token+owner).
   * Excludes the local IndexedDB primary.
   */
  listAccountBackends(): Promise<BackendDescriptor[]>;

  /**
   * List registered replica backend descriptors (excludes the implicit local
   * primary). Unified handle method shared with data groups.
   */
  listBackends(): AppDataBackendDescriptor[];

  // --- Group Type ---

  /**
   * Ensure the unified group descriptor (`.meta/group.json`) exists.
   *
   * No longer writes any `group-type` marker (since 0.9.0); `type` is kept for
   * API compatibility only. Stale markers are deleted when encountered.
   */
  ensureGroupType(type: SyncGroupType): Promise<void>;

  /**
   * Read the legacy `group-type` marker (`/.config/group-type`, then
   * `/.meta/group-type`). Returns null when neither exists — which is now the
   * normal case, since type is carried by `.meta/group.json`'s `kind`.
   */
  getGroupType(): Promise<SyncGroupType | null>;

  /** Dispose: stop all sync, release cache FS and resources. */
  dispose(): Promise<void>;
}

/**
 * The config-sync group as a unified handle. It is the capability superset:
 * `SyncGroupHandle` + config payload / node config / topology management.
 */
export interface ConfigSyncGroupHandle extends IConfigRepo, SyncGroupHandle {
  readonly kind: 'config';
}
