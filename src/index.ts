/**
 * zen-fs-config
 *
 * Distributed configuration management library built on ZenFS, zen-fs-cache, and zen-fs-sync.
 *
 * See DESIGN.md for full architecture and design documentation.
 */

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