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
  /** Type of cache store. */
  storeType?: 'MemoryCacheStore' | 'IdbCacheStore';
  /** Cache store prefix (for IdbCacheStore). */
  storePrefix?: string;
  /** TTL in milliseconds for cache hits without revalidation. Default: 0 (always revalidate). */
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

  /** Node identifier. Auto-detected if not provided (see DESIGN.md §8.2). */
  nodeId?: string;

  /** Cache configuration. */
  cache?: CacheOptions;

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

  /** Dispose: stop all sync, release cache FS and resources. */
  dispose(): Promise<void>;
}
