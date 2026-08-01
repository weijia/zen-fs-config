/**
 * zen-fs-config
 *
 * Distributed configuration management library built on ZenFS, zen-fs-cache, and zen-fs-sync.
 *
 * See DESIGN.md for full architecture and design documentation.
 */

// Factory & main class
export { createConfigRepo, ConfigRepo, LOCAL_IDB_BACKEND_ID } from './config-repo';

// Data-sync group (standalone)
export { DataSyncGroup, createDataSyncGroup } from './data-sync-group';
export type { DataSyncGroupOptions } from './data-sync-group';

// Unified connect entry point
export { connect } from './connect';

// Backend registry
export { registerBackend, unregisterBackend, createBackend, hasBackend, listBackends, getBackendMetadata, listBackendMetadata, getAccountFields, mergeAccountFields, wrapZenFSFileSystem } from './backend-registry';
export type { BackendFactory, BackendInstance, BackendMetadata, BackendParamDef } from './backend-registry';

// Serializers
export { createSerializerChain, configKeyToFilePath, getExtension } from './serializer';

// Version management
export { versionPathFor, sha256, readVersion, writeVersion, incrementVersion, verifyOrRepairVersion } from './version';

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
