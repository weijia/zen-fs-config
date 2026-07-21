/**
 * zen-fs-config
 *
 * Distributed configuration management library built on ZenFS, zen-fs-cache, and zen-fs-sync.
 *
 * See DESIGN.md for full architecture and design documentation.
 */

// Factory & main class
export { createConfigRepo, ConfigRepo } from './config-repo';

// Backend registry
export { registerBackend, unregisterBackend, createBackend, hasBackend, listBackends, wrapZenFSFileSystem } from './backend-registry';
export type { BackendFactory, BackendInstance } from './backend-registry';

// Serializers
export { createSerializerChain, configKeyToFilePath, getExtension } from './serializer';

// Version management
export { versionPathFor, sha256, readVersion, writeVersion, incrementVersion, verifyOrRepairVersion } from './version';

// All types
export type {
  BackendDescriptor,
  BackendsMeta,
  SyncRule,
  SyncRulesMeta,
  VersionMeta,
  ConflictArchive,
  ConflictInfo,
  ConfigSerializer,
  CacheOptions,
  BootstrapData,
  ConfigRepoOptions,
  IConfigRepo,
} from './types';

// Re-export SyncResult and SyncPairStatus from zen-fs-sync for convenience
export type { SyncResult, SyncPairStatus } from 'zen-fs-sync';