import { SyncPairStatus, SyncResult, ConflictStrategy, SyncableFS } from 'zen-fs-sync';
export { SyncPairStatus, SyncResult } from 'zen-fs-sync';
import * as node_fs from 'node:fs';

/** A single backend in the topology. */
interface BackendDescriptor {
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
interface BackendsMeta {
    version: 1;
    backends: BackendDescriptor[];
}
/** Content of a sidecar `.version` file. */
interface VersionMeta {
    /** Monotonically increasing version number. */
    version: number;
    /** SHA-256 hash of the corresponding config file content. */
    hash: string;
    /** Author identifier (e.g., "app-a/server-1"). */
    author: string;
    /** Timestamp when the version was created. */
    timestamp: number;
}
/** Content of a tombstone file in `.meta/.deleted/`. */
interface TombstoneMeta {
    /** The deleted file path. */
    path: string;
    /** Timestamp of deletion. */
    deletedAt: number;
    /** Backend ID that initiated the deletion. */
    deletedBy: string;
    /** Backend IDs that have confirmed the deletion (synced). */
    confirmedBy: string[];
}
/** Content of a conflict archive file in `.meta/.conflicts/`. */
interface ConflictArchive {
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
    /** Path to the source-side backup file. */
    sourceBackupPath: string;
    /** Path to the target-side backup file. */
    targetBackupPath: string;
    /** Path to the resolved file (present after resolution). */
    resolvedBackupPath?: string;
}
/** Information passed to conflict event handlers. */
interface ConflictInfo {
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
/** Pluggable serializer for config files. */
interface ConfigSerializer {
    /** Serialize a value to bytes. */
    serialize(data: unknown): Uint8Array;
    /** Deserialize bytes to a value. */
    deserialize(raw: Uint8Array, path: string): unknown;
    /** Check if this serializer can handle the given file path. */
    canHandle(path: string): boolean;
}
/** Cache configuration. */
interface CacheOptions {
    /** Type of cache store. */
    storeType?: 'MemoryCacheStore' | 'IdbCacheStore';
    /** Cache store prefix (for IdbCacheStore). */
    storePrefix?: string;
    /** TTL in milliseconds for cache hits without revalidation. Default: 0 (always revalidate). */
    ttlMs?: number;
}
/** Options for creating a ConfigRepo. */
interface ConfigRepoOptions {
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
    /** Node identifier. Auto-detected if not provided (see DESIGN.md §8.2). */
    nodeId?: string;
    /** Cache configuration. */
    cache?: CacheOptions;
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
}
/** Type of sync group. */
type SyncGroupType = 'config-sync' | 'data-sync';
/** Descriptor for a backend within a data-sync group. */
interface AppDataBackendDescriptor {
    id: string;
    type: string;
    options: Record<string, unknown>;
    /** Optional: reuse account fields from a config-sync backend. */
    accountBackendId?: string;
    description?: string;
}
/** Descriptor for a data-sync group referenced by a config-sync group. */
interface AppDataGroupDescriptor {
    id: string;
    groupType: 'data-sync';
    backends: AppDataBackendDescriptor[];
}
/** Handle to a data-sync group, providing direct fs access. */
interface AppDataGroup {
    readonly groupId: string;
    readonly appId: string;
    /** Direct fs for reading/writing data files (chroot to this group's root). */
    readonly fs: typeof node_fs;
    /** Get sync status for this data group's sync pairs. */
    getSyncStatuses(): Map<string, SyncPairStatus>;
    /** Manually flush pending sync. */
    flush(): Promise<SyncResult[]>;
    /** Stop sync and release resources. */
    dispose(): Promise<void>;
    /**
     * Dynamically add a data backend to this group.
     * Creates the backend instance, sets up bi-directional sync, and triggers initial sync.
     * @param id Unique backend ID within this group
     * @param type Backend type name (must be registered)
     * @param options Backend options (storage location fields; account fields can be resolved via accountBackendId in the descriptor)
     * @param description Optional human-readable description
     */
    addBackend(id: string, type: string, options: Record<string, unknown>, description?: string): Promise<void>;
    /**
     * Dynamically remove a data backend from this group.
     * Tears down the sync pair and disposes the backend instance.
     * @param id Backend ID to remove
     */
    removeBackend(id: string): Promise<void>;
    /** List all backend descriptors in this group. */
    listBackends(): AppDataBackendDescriptor[];
}
/** Options for the unified connect() entry point. */
interface ConnectOptions {
    /** Connection info for a user-provided backend. */
    backendInfo?: {
        type: string;
        options: Record<string, unknown>;
    };
    /** Force a specific group type (skips auto-detection for new backends). */
    groupType?: SyncGroupType;
    /** IndexedDB store name. Default: `zen-fs-config-{appId}` */
    idbStoreName?: string;
    /** Node identifier. */
    nodeId?: string;
    /** Sync polling interval in ms. Default: 1800000 (30 min). */
    syncPollIntervalMs?: number;
}
/** Result of connect(). */
interface ConnectResult {
    /** Detected or forced group type. */
    groupType: SyncGroupType;
    /** Present when groupType === "config-sync". */
    repo?: IConfigRepo;
    /** Present when groupType === "data-sync". */
    dataGroup?: AppDataGroup;
}
/** The main configuration repository interface. */
interface IConfigRepo {
    /** Application ID. */
    readonly appId: string;
    /** Node ID. */
    readonly nodeId: string;
    /** ZenFS-compatible fs object, context-isolated to this app's directories. */
    readonly fs: typeof node_fs;
    /** Un-chrooted fs for low-level browsing (includes /.meta/, all app dirs). */
    readonly rootFS: typeof node_fs;
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
     * Create a data-sync group for this app.
     * Each backend can optionally reference a config-sync backend's account
     * via `accountBackendId` to reuse credentials.
     */
    createAppDataGroup(id: string, backends: AppDataBackendDescriptor[]): Promise<AppDataGroup>;
    /** Get an existing data-sync group handle. */
    getAppDataGroup(id: string): Promise<AppDataGroup>;
    /** List all data-sync group descriptors for this app. */
    listAppDataGroups(): Promise<AppDataGroupDescriptor[]>;
    /** Remove a data-sync group (stops sync, removes descriptor). */
    removeAppDataGroup(id: string): Promise<void>;
    /**
     * List config-sync backends that can be used as account sources
     * for data-sync backends. Returns backends that have `accountFields`
     * declared in their metadata (e.g., Gitee/GitHub with token+owner).
     * Excludes the local IndexedDB primary.
     */
    listAccountBackends(): Promise<BackendDescriptor[]>;
    /** Write the group-type marker file if it doesn't exist. */
    ensureGroupType(type: SyncGroupType): Promise<void>;
    /** Read the group-type marker. Returns null if not set. */
    getGroupType(): Promise<SyncGroupType | null>;
    /** Dispose: stop all sync, release cache FS and resources. */
    dispose(): Promise<void>;
}

/**
 * zen-fs-config — Config Serializers
 *
 * Handles serialization/deserialization between JS values and file bytes.
 * The default serializer handles .json, .txt, and unknown extensions.
 * Users can provide a custom ConfigSerializer via ConfigRepoOptions.
 */

/**
 * Extended serializer that also accepts an optional path hint for routing.
 * The core ConfigSerializer interface only takes `data`, but internally
 * we use the path to pick the right serializer.
 */
interface PathAwareSerializer extends ConfigSerializer {
    serialize(data: unknown, path?: string): Uint8Array;
    deserialize(raw: Uint8Array, path?: string): unknown;
}
/**
 * Create a serializer chain from a user-provided serializer + defaults.
 * The first serializer whose `canHandle()` returns true wins.
 */
declare function createSerializerChain(custom?: ConfigSerializer): PathAwareSerializer;

/**
 * Map a config key to a file path.
 *
 * - `/db/host` → `/db/host.json` (append .json if no extension)
 * - `/readme.md` → `/readme.md` (preserve existing extension)
 */
declare function configKeyToFilePath(configPath: string): string;
/**
 * Extract the file extension (including the dot), or empty string.
 */
declare function getExtension(path: string): string;

/**
 * zen-fs-config — Backend Registry
 *
 * A pluggable registry that maps backend type names to factory functions.
 *
 * Core principle: zen-fs-config does NOT hardcode every ZenFS backend.
 * Instead, it provides:
 *   1. A simple registry API (registerBackend, createBackend, etc.)
 *   2. Two built-in backends (InMemory + IndexedDB) — zero extra config
 *   3. A wrapZenFSFileSystem() helper to adapt any ZenFS FileSystem
 *      implementation into the BackendInstance interface
 *
 * Applications (like zen-fs-config-admin) register whatever backends
 * they need at startup.  Adding a new backend never requires changing
 * zen-fs-config itself.
 */

type BackendFactory = (options: Record<string, unknown>) => Promise<BackendInstance>;
/**
 * The minimal interface a backend instance must satisfy.
 * Matches zen-fs-cache's CacheableFileSystem requirements.
 */
interface BackendInstance {
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
    /** Optional: dispose backend resources (close connections, etc.) */
    dispose?(): Promise<void>;
}
/** A single parameter field definition for a backend type. */
interface BackendParamDef {
    /** Option key (maps to BackendDescriptor.options[key]). */
    key: string;
    /** Human-readable label for the UI form. */
    label: string;
    /** Input type: text, password (masked), or select (dropdown). */
    type: 'text' | 'password' | 'select';
    /** Placeholder text for text/password inputs. */
    placeholder?: string;
    /** Whether the field is required. */
    required?: boolean;
    /** Options for select type. */
    options?: {
        value: string;
        label: string;
    }[];
}
/** Metadata describing a registered backend type (for UI form generation). */
interface BackendMetadata {
    /** Backend type name (matches the registry key). */
    type: string;
    /** Human-readable label. */
    label: string;
    /** Emoji or icon identifier. */
    icon: string;
    /** Parameter field definitions. */
    fields: BackendParamDef[];
    /** Default option values (merged into the form's initial state). */
    defaultOptions: Record<string, string>;
    /**
     * Fields that represent account credentials (e.g., token, owner, baseUrl).
     * Used by data-sync groups to reuse account info from a config-sync backend.
     * Fields not listed here are considered "storage location" fields.
     */
    accountFields?: string[];
}
declare function registerBackend(type: string, factory: BackendFactory, metadata?: BackendMetadata): void;
declare function unregisterBackend(type: string): boolean;
declare function createBackend(descriptor: Pick<BackendDescriptor, 'type' | 'options'>): Promise<BackendInstance>;
declare function hasBackend(type: string): boolean;
declare function listBackends(): string[];
/** Get metadata for a specific backend type. Returns undefined if not registered or no metadata. */
declare function getBackendMetadata(type: string): BackendMetadata | undefined;
/** List all backend types that have registered metadata. Used for dynamic form generation. */
declare function listBackendMetadata(): BackendMetadata[];
/**
 * Get the set of account field names for a backend type.
 * Falls back to an empty array if the backend has no accountFields metadata.
 */
declare function getAccountFields(type: string): string[];
/**
 * Merge account fields from a source backend's options into a target options object.
 * Only fields listed in the backend type's `accountFields` metadata are copied.
 * If a field already exists in target options, it is NOT overwritten.
 */
declare function mergeAccountFields(targetType: string, sourceOptions: Record<string, unknown>, targetOptions: Record<string, unknown>): Record<string, unknown>;
declare function wrapZenFSFileSystem(config: any): Promise<BackendInstance>;

/**
 * zen-fs-config — ConfigRepo Implementation
 *
 * Core implementation of IConfigRepo and the createConfigRepo factory.
 */

/** Fixed ID for the local IndexedDB primary backend. */
declare const LOCAL_IDB_BACKEND_ID = "local-idb";
interface MinimalAsyncFS extends BackendInstance {
}
declare class ConfigRepo implements IConfigRepo {
    readonly appId: string;
    readonly nodeId: string;
    /** Chroot-isolated fs for app-facing API. Typed as `any` to match `typeof import('node:fs')` duck-typically. */
    readonly fs: any;
    /** Un-chrooted fs for low-level browsing. */
    readonly rootFS: any;
    private cachedFS;
    private fullFS;
    private serializer;
    private syncEngine;
    private replicaBackends;
    private appDataGroups;
    private onConflictCallback?;
    private disposed;
    private configCache;
    private readonly primaryBackendId;
    private readonly pollIntervalMs?;
    /** Tombstone cache — avoids redundant reads within a single flush() cycle. */
    private tombstoneCache;
    constructor(appId: string, nodeId: string, primaryBackendId: string, cachedFS: MinimalAsyncFS, serializer: PathAwareSerializer, onConflict?: (conflict: ConflictInfo) => Promise<unknown | null>, pollIntervalMs?: number);
    /** Full path to this node's directory on the primary backend. */
    get nodePath(): string;
    /** Number of replica backends registered (excludes the local primary). */
    get replicaCount(): number;
    load(rawConfig?: string): Promise<void>;
    getConfig<T = unknown>(path: string): T;
    setConfig(path: string, data: unknown): void;
    getNodeConfig<T = unknown>(nodeId: string, path: string): Promise<T>;
    setNodeConfig(nodeId: string, path: string, data: unknown): Promise<void>;
    publishNodeConfig(nodeId: string, options?: {
        paths?: string[];
    }): Promise<SyncResult>;
    peekNodeConfig<T = unknown>(nodeId: string, path: string): Promise<T>;
    flush(): Promise<SyncResult[]>;
    /**
     * Delete a file and write a tombstone so the deletion propagates
     * to all backends instead of being treated as "missing file → re-create".
     */
    deleteFile(path: string): Promise<void>;
    /**
     * Read all tombstones from the primary backend.
     * Results are cached within a flush() cycle to avoid redundant reads.
     */
    private readTombstones;
    /** Invalidate the tombstone cache — call after tombstones are modified. */
    private invalidateTombstoneCache;
    /**
     * Before sync: for each tombstone, delete the actual file on all replicas.
     * This prevents bi-directional sync from copying the file back.
     */
    private processTombstones;
    /** Public wrapper for processTombstones — used by createConfigRepo. */
    processTombstonesPublic(): Promise<void>;
    /**
     * Perform a full sync + dedup cycle without the watch snapshot cache.
     * Used by createConfigRepo to pull remote-only files (like duplicate
     * backend descriptors) that watch()'s initial snapshot would skip.
     */
    initialSyncAndDedup(): Promise<void>;
    /**
     * After sync: mark each tombstone as confirmed by all replica backends.
     */
    private updateTombstoneConfirmations;
    /**
     * GC: remove tombstones where all backends in backends.json have confirmed.
     */
    private gcTombstones;
    /**
     * Sync .meta/ files (backends.json) to all replica backends.
     *
     * This ensures the backend topology is available on every replica, enabling
     * any program that connects to any backend to discover the full topology.
     *
     * Called automatically by createConfigRepo() after setupSync().
     */
    syncMetaToReplicas(): Promise<void>;
    getSyncStatuses(): Map<string, SyncPairStatus>;
    resolveConflict(conflictId: string, mergedContent: unknown): Promise<void>;
    listConflicts(): Promise<ConflictArchive[]>;
    readConflictBackup(conflictId: string, fileType: 'source' | 'target' | 'resolved'): Promise<string>;
    dispose(): Promise<void>;
    setupSync(backends: BackendDescriptor[], primaryBackendId: string, pollIntervalMs?: number): Promise<void>;
    /** Write version sidecar for a config file (no-op for .version files). */
    private writeVersionSidecar;
    /** Delete version sidecar on a backend (no-op for .version files). */
    private unlinkVersionSidecar;
    /** Read version sidecar (returns null for .version files). */
    private readVersionSidecar;
    private persistConfig;
    private reloadConfigCache;
    private handleConflict;
    ensureDir(filePath: string): Promise<void>;
    private walkDir;
    writeMetaFile(path: string, data: unknown): Promise<void>;
    readMetaFile<T>(path: string): Promise<T | null>;
    /** Path for a single backend descriptor: .meta/backends/{id}.json */
    backendFilePath(id: string): string;
    /**
     * Read all backend descriptors from .meta/backends/*.json.
     *
     * If duplicate backends are detected (same type + options but different id),
     * only the first one (sorted by id) is kept and the rest are removed
     * (including their version sidecar files).
     */
    readAllBackendDescriptors(): Promise<BackendDescriptor[]>;
    /** Write a single backend descriptor as .meta/backends/{id}.json */
    writeBackendDescriptor(desc: BackendDescriptor): Promise<void>;
    /** Remove a single backend descriptor file + its version sidecar */
    removeBackendDescriptor(id: string): Promise<void>;
    getBackends(): Promise<BackendsMeta | null>;
    updateBackends(meta: BackendsMeta): Promise<void>;
    addBackend(id: string, type: string, options: Record<string, unknown>, description?: string): Promise<void>;
    removeBackend(id: string): Promise<void>;
    /** Write the group-type marker file if it doesn't exist. */
    ensureGroupType(type: SyncGroupType): Promise<void>;
    /** Read the group-type marker. Returns null if not set. */
    getGroupType(): Promise<SyncGroupType | null>;
    /** Path for a single app data group descriptor: .meta/app-data-groups/{appId}/{id}.json */
    private appDataGroupFilePath;
    /**
     * Resolve a backend descriptor's options by merging account fields
     * from the referenced config-sync backend (if accountBackendId is set).
     */
    private resolveAppDataBackendOptions;
    createAppDataGroup(id: string, backends: AppDataBackendDescriptor[]): Promise<AppDataGroup>;
    getAppDataGroup(id: string): Promise<AppDataGroup>;
    listAppDataGroups(): Promise<AppDataGroupDescriptor[]>;
    removeAppDataGroup(id: string): Promise<void>;
    listAccountBackends(): Promise<BackendDescriptor[]>;
    private tryParse;
    private assertNotDisposed;
}
declare function createConfigRepo(appId: string, options?: ConfigRepoOptions): Promise<IConfigRepo>;

/**
 * zen-fs-config — Standalone Data-Sync Group
 *
 * A data-sync group provides direct file system access for app data,
 * without the config-sync meta layer. It can be used standalone or
 * referenced by a config-sync group via createAppDataGroup().
 */

/**
 * A standalone data-sync group.
 *
 * Creates a local InMemory (or IndexedDB in browser) primary backend,
 * sets up bi-directional sync with each registered data backend, and
 * provides direct fs access for reading/writing data files.
 */
declare class DataSyncGroup implements AppDataGroup {
    readonly groupId: string;
    readonly appId: string;
    fs: any;
    private syncEngine;
    private localFS;
    private dataBackends;
    private disposed;
    constructor(appId: string, groupId: string, localFS: BackendInstance);
    /**
     * Add a data backend and set up bi-directional sync.
     */
    addBackend(id: string, type: string, options: Record<string, unknown>, description?: string): Promise<void>;
    /**
     * Remove a data backend.
     */
    removeBackend(id: string): Promise<void>;
    getSyncStatuses(): Map<string, SyncPairStatus>;
    flush(): Promise<SyncResult[]>;
    listBackends(): BackendDescriptor[];
    dispose(): Promise<void>;
    /**
     * Register a pre-created backend instance with the sync engine.
     * Used internally by createDataSyncGroup() to avoid double-creating backends.
     */
    _registerBackend(id: string, instance: BackendInstance, syncable: SyncableFS, pollIntervalMs?: number): string;
    /** Run syncAll on the internal engine. */
    _syncAll(): Promise<void>;
    /** Get the number of registered data backends. */
    get _backendCount(): number;
    private saveBackendDescriptor;
    private ensureDir;
}
interface DataSyncGroupOptions {
    /** Connection info for the initial data backend. */
    backendInfo?: {
        type: string;
        options: Record<string, unknown>;
    };
    /** ID for the initial data backend. Default: auto-generated. */
    primaryBackendId?: string;
    /** Node identifier (for logging). */
    nodeId?: string;
    /** Sync polling interval in ms. */
    pollIntervalMs?: number;
}
/**
 * Create a standalone data-sync group.
 *
 * 1. Connects to the user-provided backend
 * 2. Reads /.meta/group-type to verify it's a data-sync group (or new)
 * 3. Creates a local primary (InMemory in Node.js)
 * 4. Sets up bi-directional sync with all data backends
 * 5. Returns a DataSyncGroup handle with direct fs access
 */
declare function createDataSyncGroup(appId: string, options?: DataSyncGroupOptions): Promise<DataSyncGroup>;

/**
 * zen-fs-config — Unified Connect Entry Point
 *
 * `connect()` auto-detects the sync group type (config-sync or data-sync)
 * by reading `/.meta/group-type` from the user-provided backend, then
 * dispatches to the appropriate factory function.
 */

/**
 * Unified entry point for connecting to a zen-fs-config sync group.
 *
 * Flow:
 * 1. If `backendInfo` is provided, connect to the backend and read
 *    `/.meta/group-type` to detect the group type.
 * 2. If group-type is "config-sync", dispatch to `createConfigRepo()`.
 * 3. If group-type is "data-sync", dispatch to `createDataSyncGroup()`.
 * 4. If group-type is absent (new backend), use `options.groupType`
 *    or default to "config-sync".
 * 5. If no `backendInfo` is provided, use `options.groupType` or
 *    default to "config-sync" (local-only operation).
 *
 * @param appId Application identifier
 * @param options Connection options
 * @returns ConnectResult containing the group type and the appropriate handle
 */
declare function connect(appId: string, options?: ConnectOptions): Promise<ConnectResult>;

/**
 * zen-fs-config — Sidecar Version File Management
 *
 * Each config file has a companion .version file for version-based change
 * detection and conflict resolution.
 *
 * Config file:  /app-a/db.json
 * Version file: /app-a/.db.json.version
 */

/**
 * Compute the sidecar version file path from a config file path.
 *
 * /app-a/db.json        → /app-a/.db.json.version
 * /shared/flags.json    → /shared/.flags.json.version
 * /nodes/s1/env.json    → /nodes/s1/.env.json.version
 *
 * Returns null for files that are already version sidecars (.version files),
 * to prevent creating version-of-version files (e.g. ..db.json.version.version).
 */
declare function versionPathFor(configFilePath: string): string | null;
/**
 * Compute SHA-256 hash of a Uint8Array.
 * Returns "sha256:" prefix + hex digest.
 */
declare function sha256(data: Uint8Array): Promise<string>;
/**
 * Read and parse a version file. Returns null if it doesn't exist or is invalid.
 */
declare function readVersion(fs: SyncableFS, versionFilePath: string): Promise<VersionMeta | null>;
/**
 * Write a version file.
 */
declare function writeVersion(fs: SyncableFS, versionFilePath: string, meta: VersionMeta): Promise<void>;
/**
 * Increment version for a config file write.
 */
declare function incrementVersion(fs: SyncableFS, configFilePath: string, newContent: Uint8Array, author: string): Promise<VersionMeta>;
/**
 * Verify that the version file's hash matches the actual file content.
 * If mismatch, auto-increment version and return updated meta.
 * If version file doesn't exist, return null.
 */
declare function verifyOrRepairVersion(fs: SyncableFS, configFilePath: string, author: string): Promise<VersionMeta | null>;

export { type AppDataBackendDescriptor, type AppDataGroup, type AppDataGroupDescriptor, type BackendDescriptor, type BackendFactory, type BackendInstance, type BackendMetadata, type BackendParamDef, type BackendsMeta, type CacheOptions, ConfigRepo, type ConfigRepoOptions, type ConfigSerializer, type ConflictArchive, type ConflictInfo, type ConnectOptions, type ConnectResult, DataSyncGroup, type DataSyncGroupOptions, type IConfigRepo, LOCAL_IDB_BACKEND_ID, type SyncGroupType, type TombstoneMeta, type VersionMeta, configKeyToFilePath, connect, createBackend, createConfigRepo, createDataSyncGroup, createSerializerChain, getAccountFields, getBackendMetadata, getExtension, hasBackend, incrementVersion, listBackendMetadata, listBackends, mergeAccountFields, readVersion, registerBackend, sha256, unregisterBackend, verifyOrRepairVersion, versionPathFor, wrapZenFSFileSystem, writeVersion };
