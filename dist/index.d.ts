import { ConflictStrategy, SyncResult, SyncPairStatus, SyncableFS } from 'zen-fs-sync';
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
/** Sync direction for a path prefix. */
type SyncDirection = 'one-way' | 'bi-directional' | 'none';
/** A single sync rule. */
interface SyncRule {
    /** Path prefix this rule applies to (e.g., "/app-a/"). */
    prefix: string;
    /** Sync direction. */
    direction: SyncDirection;
    /** Conflict resolution strategy (only relevant for bi-directional). */
    conflictStrategy?: ConflictStrategy;
    /** IDs of replica backends to sync with (from .meta/backends.json). */
    replicas?: string[];
}
/** Content of `.meta/sync-rules.json`. */
interface SyncRulesMeta {
    version: 1;
    rules: SyncRule[];
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
/** Bootstrap data, written to .meta/ only on first initialization. */
interface BootstrapData {
    backends: Omit<BackendDescriptor, 'description'>[];
    syncRules: SyncRule[];
}
/** Options for creating a ConfigRepo. */
interface ConfigRepoOptions {
    /** The backend ID (from .meta/backends.json) to use as this instance's primary. */
    primaryBackendId: string;
    /** Connection info for the primary backend. */
    backendInfo: {
        type: string;
        options: Record<string, unknown>;
    };
    /** Node identifier. Auto-detected if not provided (see DESIGN.md §8.2). */
    nodeId?: string;
    /** Cache configuration. */
    cache?: CacheOptions;
    /** Bootstrap data (only used when .meta/backends.json doesn't exist). */
    bootstrap?: BootstrapData;
    /** Custom serializer. */
    serializer?: ConfigSerializer;
    /** Custom conflict handler. Called before auto-resolution. */
    onConflict?: (conflict: ConflictInfo) => Promise<unknown | null>;
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
    /** Read .meta/backends.json. */
    getBackends(): Promise<BackendsMeta | null>;
    /** Write .meta/backends.json. */
    updateBackends(meta: BackendsMeta): Promise<void>;
    /** Read .meta/sync-rules.json. */
    getSyncRules(): Promise<SyncRulesMeta | null>;
    /** Write .meta/sync-rules.json. */
    updateSyncRules(meta: SyncRulesMeta): Promise<void>;
    /**
     * Sync .meta/ files (backends.json, sync-rules.json) to all replica backends.
     * Called automatically by createConfigRepo() after setupSync().
     */
    syncMetaToReplicas(): Promise<void>;
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
 * zen-fs-config — ConfigRepo Implementation
 *
 * Core implementation of IConfigRepo and the createConfigRepo factory.
 */

interface MinimalAsyncFS {
    readFile(path: string, ...args: any[]): Promise<any>;
    writeFile(path: string, data: any, options?: any): Promise<void>;
    readdir(path: string): Promise<string[]>;
    stat(path: string): Promise<any>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string, options?: any): Promise<any>;
    unlink(path: string): Promise<void>;
    rmdir?(path: string): Promise<void>;
    rename?(oldPath: string, newPath: string): Promise<void>;
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
    private onConflictCallback?;
    private disposed;
    private configCache;
    constructor(appId: string, nodeId: string, cachedFS: MinimalAsyncFS, serializer: PathAwareSerializer, onConflict?: (conflict: ConflictInfo) => Promise<unknown | null>);
    /** Full path to this node's directory on the primary backend. */
    get nodePath(): string;
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
     * Sync .meta/ files (backends.json, sync-rules.json) to all replica backends.
     *
     * This ensures the backend topology is available on every replica, enabling
     * any program that connects to any backend to discover the full topology.
     *
     * Called automatically by createConfigRepo() after setupSync().
     * Can also be called manually after updateBackends() / updateSyncRules().
     */
    syncMetaToReplicas(): Promise<void>;
    getSyncStatuses(): Map<string, SyncPairStatus>;
    resolveConflict(conflictId: string, mergedContent: unknown): Promise<void>;
    listConflicts(): Promise<ConflictArchive[]>;
    readConflictBackup(conflictId: string, fileType: 'source' | 'target' | 'resolved'): Promise<string>;
    dispose(): Promise<void>;
    setupSync(backends: BackendDescriptor[], primaryBackendId: string): Promise<void>;
    private persistConfig;
    private reloadConfigCache;
    private handleConflict;
    private ensureDir;
    private walkDir;
    writeMetaFile(path: string, data: BackendsMeta | SyncRulesMeta): Promise<void>;
    readMetaFile<T>(path: string): Promise<T | null>;
    getBackends(): Promise<BackendsMeta | null>;
    updateBackends(meta: BackendsMeta): Promise<void>;
    getSyncRules(): Promise<SyncRulesMeta | null>;
    updateSyncRules(meta: SyncRulesMeta): Promise<void>;
    private tryParse;
    private assertNotDisposed;
}
declare function createConfigRepo(appId: string, options: ConfigRepoOptions): Promise<IConfigRepo>;

/**
 * zen-fs-config — Backend Registry
 *
 * A pluggable registry that maps backend type names to factory functions.
 *
 * Core principle: zen-fs-config does NOT hardcode every ZenFS backend.
 * Instead, it provides:
 *   1. A simple registry API (registerBackend, createBackend, etc.)
 *   2. One built-in backend (InMemory) — zero extra dependencies
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
}
declare function registerBackend(type: string, factory: BackendFactory): void;
declare function unregisterBackend(type: string): boolean;
declare function createBackend(descriptor: Pick<BackendDescriptor, 'type' | 'options'>): Promise<BackendInstance>;
declare function hasBackend(type: string): boolean;
declare function listBackends(): string[];
declare function wrapZenFSFileSystem(config: any): Promise<BackendInstance>;

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
 */
declare function versionPathFor(configFilePath: string): string;
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

export { type BackendDescriptor, type BackendFactory, type BackendInstance, type BackendsMeta, type BootstrapData, type CacheOptions, ConfigRepo, type ConfigRepoOptions, type ConfigSerializer, type ConflictArchive, type ConflictInfo, type IConfigRepo, type SyncRule, type SyncRulesMeta, type VersionMeta, configKeyToFilePath, createBackend, createConfigRepo, createSerializerChain, getExtension, hasBackend, incrementVersion, listBackends, readVersion, registerBackend, sha256, unregisterBackend, verifyOrRepairVersion, versionPathFor, wrapZenFSFileSystem, writeVersion };
