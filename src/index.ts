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

// 本地数据组存储不可用：可识别的错误类型 + 重建（删库）原语
export {
  LOCAL_STORAGE_UNAVAILABLE,
  LocalStorageUnavailableError,
  isLocalStorageUnavailableError,
  dataGroupLocalStoreName,
  deleteDataGroupLocalStore,
} from './errors';
export type {
  LocalStorageUnavailableDetails,
  LocalStoreDeletionResult,
} from './errors';

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
export { versionPathFor, legacyVersionPathFor, sha256, readVersion, writeVersion, incrementVersion, verifyOrRepairVersion } from './version';

// mtime sidecar cleanup (local primary only)
export { purgeMtimeSidecars, isMtimeSidecar } from './mtime-cleanup';
export type { PurgeableFS, PurgeMtimeOptions, MtimePurgeResult } from './mtime-cleanup';

// .keep placeholder cleanup (local primary only)
export { purgeKeepFiles, isKeepFile } from './keep-cleanup';
export type { PurgeKeepOptions, KeepPurgeResult } from './keep-cleanup';

// Version sidecar migration (legacy `.x.version` → `<name>.version`)
export { migrateVersionSidecars } from './version-migration';
export type { MigrateLocalFS, MigrateReplicaFS, VersionMigrationOptions, VersionMigrationResult } from './version-migration';

// Unified sync-group metadata layout (`.meta/`, `.config/`)
export {
  META_DIR,
  GROUP_DESCRIPTOR_FILE,
  TOMBSTONES_DIR,
  LEGACY_TOMBSTONES_DIR,
  VERSIONS_DIR,
  CONFLICTS_DIR,
  LEGACY_CONFLICTS_DIR,
  CONFIG_DIR,
  DATA_GROUP_DEFAULT_FEATURES,
  readGroupDescriptor,
  writeGroupDescriptor,
  encodeMetaPath,
  TombstoneStore,
  VersionStore,
  ConflictStore,
} from './group-meta';

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
  SyncGroupKind,
  SyncGroupFeatures,
  SyncGroupHandle,
  ConfigSyncGroupHandle,
  GroupDescriptor,
  AppDataBackendDescriptor,
  AppDataGroupDescriptor,
  AppDataGroup,
  ConfigSyncGroupDescriptor,
  BackendSyncState,
  ConnectOptions,
  ConnectResult,
} from './types';

// Re-export SyncResult and SyncPairStatus from zen-fs-sync for convenience
export type { SyncResult, SyncPairStatus } from 'zen-fs-sync';
