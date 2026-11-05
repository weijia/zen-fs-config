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

/** Content of a tombstone file in `.meta/.deleted/`. */
export interface TombstoneMeta {
  /** The deleted file path. */
  path: string;
  /** Timestamp of deletion. */
  deletedAt: number;
  /** Backend ID that initiated the deletion. */
  deletedBy: string;
  /** Backend IDs that have confirmed the deletion (synced). */
  confirmedBy: string[];
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
  /** User-editable display name. */
  name?: string;
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
export interface SyncGroupHandle {
  readonly groupId: string;
  readonly appId: string;
  readonly kind: SyncGroupKind;
  /** Derived, never persisted separately from the descriptor. */
  readonly features: SyncGroupFeatures;
  readonly name?: string;

  /** Direct fs view; metadata paths (`.meta`, `.config`) are hidden. */
  readonly fs: typeof import('node:fs');

  // --- sync lifecycle ---
  getSyncStatuses(): Map<string, SyncPairStatus>;
  getBackendSyncStates(): Map<string, BackendSyncState>;
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
   * 数据组读自自己的 `.meta/backends/`；配置组读自 `.config/backends/`。
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
  /** Force a specific group type (skips auto-detection for new backends). */
  groupType?: SyncGroupType;
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

  /** Write the group-type marker file if it doesn't exist. */
  ensureGroupType(type: SyncGroupType): Promise<void>;

  /** Read the group-type marker. Returns null if not set. */
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
