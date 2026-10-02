/**
 * zen-fs-config
 *
 * Distributed configuration management library built on ZenFS, zen-fs-cache, and zen-fs-sync.
 *
 * See DESIGN.md for full architecture and design documentation.
 */

// Factory & main class
export { createConfigRepo, ConfigRepo, LOCAL_IDB_BACKEND_ID } from './config-repo';

// Node.js local persistent backend (Folder) — self-registers on import
export { resolveLocalPrimary, localPrimaryType, isBrowserEnv, FolderStore, registerFolderBackend } from './folder-backend';

// Unified connect entry point — the single recommended external entry.
// Data-sync groups are always managed by a config-sync repo (decision A / T5);
// the standalone `createDataSyncGroup` factory is deprecated and NOT exported.
export { connect } from './connect';

// Backend registry
export { registerBackend, unregisterBackend, createBackend, hasBackend, listBackends, getBackendMetadata, listBackendMetadata, getAccountFields, mergeAccountFields, wrapZenFSFileSystem } from './backend-registry';
export type { BackendFactory, BackendInstance, BackendMetadata, BackendParamDef } from './backend-registry';

// Serializers
export { createSerializerChain, configKeyToFilePath, getExtension } from './serializer';

// Version management
export { versionPathFor, sha256, readVersion, writeVersion, incrementVersion, verifyOrRepairVersion } from './version';

// mtime sidecar cleanup (local primary only)
export { purgeMtimeSidecars, isMtimeSidecar } from './mtime-cleanup';
export type { PurgeableFS, PurgeMtimeOptions, MtimePurgeResult } from './mtime-cleanup';

// All types
export type {
  BackendDescriptor,
  BackendsMeta,
  VersionMeta,
  TombstoneMeta,
  ConflictArchive,
  ConflictInfo,
  ConfigSerializer,
  CacheOptions,
  ConfigRepoOptions,
  IConfigRepo,
  SyncGroupType,
  AppDataBackendDescriptor,
  AppDataGroupDescriptor,
  AppDataGroup,
  ConnectOptions,
  ConnectResult,
} from './types';

// Re-export SyncResult and SyncPairStatus from zen-fs-sync for convenience
export type { SyncResult, SyncPairStatus } from 'zen-fs-sync';
