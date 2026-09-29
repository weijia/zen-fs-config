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
  AppDataGroup,
} from './types';
import { createConfigRepo } from './config-repo';
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
 * 3. If group-type is "data-sync", create a config-sync repo (the host for
 *    data groups) and register a default app data group under it via
 *    `ConfigRepo.createAppDataGroup()` (the standalone `createDataSyncGroup()`
 *    is deprecated — decision A / T5).
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
  // Case 1: No backendInfo — first launch (local-only)
  // -----------------------------------------------------------------
  if (!options.backendInfo) {
    // Data groups are always managed by config-sync: create the config repo
    // first, then register a default app data group under it.
    const repo = await createConfigRepo(appId, {
      idbStoreName: options.idbStoreName,
      nodeId: options.nodeId,
      primaryBackendId: options.primaryBackendId,
      folderPath: options.folderPath,
      cache: options.cache,
      serializer: options.serializer,
      onConflict: options.onConflict,
      syncPollIntervalMs: options.syncPollIntervalMs,
    });
    const dataGroup = await repo.createAppDataGroup('default', []);
    return {
      groupType: options.groupType ?? 'config-sync',
      repo,
      dataGroup,
      appDataGroups: [dataGroup],
    };
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

  // The config-sync repo always hosts the data groups' topology. For a
  // config-sync remote we connect the repo to that backend; for a data-sync
  // remote we keep the config repo local-only and attach the data backend to
  // the data group instead (see below). See USE-CASES UC2 / UC3.
  const repo = await createConfigRepo(
    appId,
    groupType === 'config-sync'
      ? {
          backendInfo: options.backendInfo,
          idbStoreName: options.idbStoreName,
          nodeId: options.nodeId,
          primaryBackendId: options.primaryBackendId,
          folderPath: options.folderPath,
          cache: options.cache,
          serializer: options.serializer,
          onConflict: options.onConflict,
          syncPollIntervalMs: options.syncPollIntervalMs,
        }
      : {
          idbStoreName: options.idbStoreName,
          nodeId: options.nodeId,
          folderPath: options.folderPath,
          serializer: options.serializer,
          onConflict: options.onConflict,
          syncPollIntervalMs: options.syncPollIntervalMs,
        },
  );

  // Spin up sync for every app data group already registered in config-sync.
  const descriptors = await repo.listAppDataGroups();
  const appDataGroups: AppDataGroup[] = [];
  for (const d of descriptors) {
    try {
      appDataGroups.push(await repo.getAppDataGroup(d.id));
    } catch (err) {
      log(`connect: failed to load app data group "${d.id}":`, err);
    }
  }

  // If the remote is itself a data-sync backend (UC3): ensure the default data
  // group exists and attach this backend to it. AppDataGroupImpl.addBackend
  // writes the backend info back into config-sync's app-data-groups.
  let dataGroup: AppDataGroup | undefined = appDataGroups[0];
  if (groupType === 'data-sync') {
    if (!dataGroup) {
      dataGroup = await repo.createAppDataGroup('default', []);
      appDataGroups.push(dataGroup);
    }
    const backendId = `${type}-primary`;
    if (!dataGroup.listBackends().some(b => b.id === backendId)) {
      await dataGroup.addBackend(backendId, type, backendOptions);
    }
  }

  return { groupType, repo, dataGroup, appDataGroups };
}
