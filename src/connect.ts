/**
 * zen-fs-config — Unified Connect Entry Point
 *
 * `connect()` auto-detects the sync group type (config-sync or data-sync)
 * by reading `/.meta/group-type` from the user-provided backend, then
 * dispatches to the appropriate factory function.
 */

import type {
  ConnectOptions,
  ConnectResult,
  SyncGroupType,
} from './types';
import { createConfigRepo } from './config-repo';
import { createDataSyncGroup } from './data-sync-group';
import { createBackend } from './backend-registry';
import { createLogger } from './logger';

const log = createLogger('connect');

const META_DIR = '/.meta';
const GROUP_TYPE_FILE = `${META_DIR}/group-type`;

/**
 * Detect the group type of a remote backend by reading /.meta/group-type.
 *
 * @returns The detected SyncGroupType, or null if the file doesn't exist.
 */
async function detectGroupType(
  type: string,
  options: Record<string, unknown>,
): Promise<SyncGroupType | null> {
  log(`detectGroupType: connecting to ${type}...`);

  // Create a temporary backend instance to read group-type
  const tempBackend = await createBackend({ type, options });

  try {
    const raw = await tempBackend.readFile(GROUP_TYPE_FILE, 'utf-8');
    const groupType = (raw as string).trim() as SyncGroupType;
    if (groupType === 'config-sync' || groupType === 'data-sync') {
      log(`detectGroupType: detected "${groupType}"`);
      return groupType;
    }
    log(`detectGroupType: unknown group-type value "${groupType}", treating as null`);
    return null;
  } catch {
    log(`detectGroupType: no group-type file found (new backend)`);
    return null;
  } finally {
    // Dispose the temporary backend
    if (tempBackend?.dispose) {
      await tempBackend.dispose();
    }
  }
}

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
export async function connect(
  appId: string,
  options: ConnectOptions = {},
): Promise<ConnectResult> {
  log(`connect: appId=${appId}`);

  // -----------------------------------------------------------------
  // Case 1: No backendInfo — local-only operation
  // -----------------------------------------------------------------
  if (!options.backendInfo) {
    const groupType: SyncGroupType = options.groupType ?? 'config-sync';
    log(`connect: no backendInfo, using groupType="${groupType}"`);

    if (groupType === 'data-sync') {
      const dataGroup = await createDataSyncGroup(appId, {});
      return { groupType: 'data-sync', dataGroup };
    }

    // Default: config-sync
    const repo = await createConfigRepo(appId, {
      idbStoreName: options.idbStoreName,
      nodeId: options.nodeId,
      syncPollIntervalMs: options.syncPollIntervalMs,
    });
    return { groupType: 'config-sync', repo };
  }

  // -----------------------------------------------------------------
  // Case 2: backendInfo provided — detect group type from remote
  // -----------------------------------------------------------------
  const { type, options: backendOptions } = options.backendInfo;
  const detectedType = await detectGroupType(type, backendOptions);

  let groupType: SyncGroupType;
  if (detectedType) {
    // Remote backend already has a group-type
    if (options.groupType && options.groupType !== detectedType) {
      throw new Error(
        `Group type mismatch: remote backend is "${detectedType}" but options.groupType is "${options.groupType}"`,
      );
    }
    groupType = detectedType;
  } else {
    // New backend — use options.groupType or default to config-sync
    groupType = options.groupType ?? 'config-sync';
    log(`connect: new backend, using groupType="${groupType}"`);
  }

  if (groupType === 'data-sync') {
    const dataGroup = await createDataSyncGroup(appId, {
      backendInfo: options.backendInfo,
      primaryBackendId: options.idbStoreName,
      nodeId: options.nodeId,
    });
    return { groupType: 'data-sync', dataGroup };
  }

  // config-sync
  const repo = await createConfigRepo(appId, {
    backendInfo: options.backendInfo,
    idbStoreName: options.idbStoreName,
    nodeId: options.nodeId,
    syncPollIntervalMs: options.syncPollIntervalMs,
  });
  return { groupType: 'config-sync', repo };
}
