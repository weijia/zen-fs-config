/**
 * zen-fs-config — Core Type Definitions
 *
 * All public types for the configuration management library.
 */

import type { SyncResult, SyncPairStatus, ConflictStrategy } from 'zen-fs-sync';

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
// Sync Rules
// ---------------------------------------------------------------------------

/** Sync direction for a path prefix. */
export type SyncDirection = 'one-way' | 'bi-directional' | 'none';

/** A single sync rule. */
export interface SyncRule {
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
export interface SyncRulesMeta {
  version: 1;
  rules: SyncRule[];
}

// ---------------------------------------------------------------------------
// Version Files (Sidecar)
// ---------------------------------------------------------------------------

/** Content of a sidecar `.version` file. */
export interface VersionMeta {
  /** Monotonically increasing version number. */
  version: number;
  /** SHA-256 hash of the corresponding config file content. */
  hash: string;
  /** Author identifier (e.g., "app-a/server-1"). */
  author: string;
  /** Timestamp when the version was created. */
  timestamp: number;
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
  /** Source side content. */
  sourceContent: unknown;
  /** Target side content. */
  targetContent: unknown;
  /** Source side version. */
  sourceVersion: number;
  /** Target side version. */
  targetVersion: number;
  /** Strategy that was used to auto-resolve (if any). */
  resolvedStrategy?: ConflictStrategy;
  /** The content that was written as the resolved result (if auto-resolved). */
  resolvedContent?: unknown;
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
  /** Type of cache store. */
  storeType?: 'MemoryCacheStore' | 'IdbCacheStore';
  /** Cache store prefix (for IdbCacheStore). */
  storePrefix?: string;
  /** TTL in milliseconds for cache hits without revalidation. Default: 0 (always revalidate). */
  ttlMs?: number;
}

/** Bootstrap data, written to .meta/ only on first initialization. */
export interface BootstrapData {
  backends: Omit<BackendDescriptor, 'description'>[];
  syncRules: SyncRule[];
}

/** Options for creating a ConfigRepo. */
export interface ConfigRepoOptions {
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

// ---------------------------------------------------------------------------
// ConfigRepo Interface
// ---------------------------------------------------------------------------

/** The main configuration repository interface. */
export interface IConfigRepo {
  /** Application ID. */
  readonly appId: string;
  /** Node ID. */
  readonly nodeId: string;
  /** ZenFS-compatible fs object, context-isolated to this app's directories. */
  readonly fs: typeof import('node:fs');

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

  /** Read .meta/backends.json. */
  getBackends(): Promise<BackendsMeta | null>;

  /** Write .meta/backends.json. */
  updateBackends(meta: BackendsMeta): Promise<void>;

  /** Read .meta/sync-rules.json. */
  getSyncRules(): Promise<SyncRulesMeta | null>;

  /** Write .meta/sync-rules.json. */
  updateSyncRules(meta: SyncRulesMeta): Promise<void>;

  /** Dispose: stop all sync, release cache FS and resources. */
  dispose(): Promise<void>;
}