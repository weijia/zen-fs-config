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
  ConfigSyncGroupHandle,
  SyncGroupHandle,
  GroupDescriptor,
} from './types';
import { createConfigRepo } from './config-repo';
import { createBackend } from './backend-registry';
import { createLogger } from './logger';
import { readGroupDescriptor, readGroupDescriptorStrict, isNotFoundError } from './group-meta';
import {
  isValidGroupInstanceId,
  summarizeIdentity,
  type RemoteIdentitySnapshot,
} from './group-identity';

const isInstanceIdLike = (value: unknown): value is string =>
  typeof value === 'string' && isValidGroupInstanceId(value);

const log = createLogger('connect');

const GROUP_TYPE_FILE = '/.config/group-type';
const LEGACY_GROUP_TYPE_FILE = '/.meta/group-type';

/**
 * Detect the group type of a remote backend by reading `.config/group-type`
 * (new layout), falling back to the legacy `.meta/group-type`.
 *
 * @returns The detected SyncGroupType, or null if the file doesn't exist.
 */
async function detectGroupType(
  type: string,
  options: Record<string, unknown>,
): Promise<SyncGroupType | null> {
  const detail = await detectGroupTypeDetailed(type, options);
  return detail.groupType;
}

/**
 * 类型探测的详细版：同时读远端 `.meta/group.json`，把「这个根到底被谁占了」
 * （kind / id / instanceId）带回来，供错误信息与界面直接展示。
 */
async function detectGroupTypeDetailed(
  type: string,
  options: Record<string, unknown>,
): Promise<{ groupType: SyncGroupType | null; remote: RemoteIdentitySnapshot | null }> {
  log(`detectGroupType: connecting to ${type}...`);

  // Create a temporary backend instance to read group-type
  const tempBackend = await createBackend({ type, options });

  let remote: RemoteIdentitySnapshot | null = null;
  try {
    try {
      const descriptor = await readGroupDescriptor(tempBackend);
      if (descriptor) {
        remote = {
          kind: descriptor.kind,
          id: descriptor.id,
          instanceId: isInstanceIdLike(descriptor.instanceId) ? descriptor.instanceId : undefined,
          ...(descriptor.name ? { name: descriptor.name } : {}),
        };
      }
    } catch {
      /* 读不到描述符不影响类型探测，但信息就是缺的，UI 会看到无描述符 */
    }
  } finally {
    /* dispose 在下面的 finally 统一做 */
  }

  try {
    // `.meta/group.json` 的 kind 是这个根的身份声明；标记文件只是缓存，
    // 可能是别的组同步过来的残留（远端根被误接进配置组时就会出现）。
    // 所以先认描述符，再退到标记。
    if (remote?.kind === 'data') {
      log('detectGroupType: .meta/group.json declares kind=data → data-sync');
      return { groupType: 'data-sync', remote };
    }
    if (remote?.kind === 'config') {
      log('detectGroupType: .meta/group.json declares kind=config → config-sync');
      return { groupType: 'config-sync', remote };
    }
    for (const path of [GROUP_TYPE_FILE, LEGACY_GROUP_TYPE_FILE]) {
      try {
        const raw = await tempBackend.readFile(path, 'utf-8');
        const groupType = (raw as string).trim() as SyncGroupType;
        if (groupType === 'config-sync' || groupType === 'data-sync') {
          log(`detectGroupType: detected "${groupType}" at ${path} (no descriptor)`);
          return { groupType, remote };
        }
        log(`detectGroupType: unknown group-type value "${groupType}" at ${path}, treating as null`);
        return { groupType: null, remote };
      } catch {
        // Try the next layout.
      }
    }
    log(`detectGroupType: no group-type file and no descriptor kind (new backend)`);
    return { groupType: null, remote };
  } finally {
    // Dispose the temporary backend
    if (tempBackend?.dispose) {
      await tempBackend.dispose();
    }
  }
}

// ---------------------------------------------------------------------------
// Three-state probe + init guard (see SYNC-GROUP-DESIGN §3.1.1)
// ---------------------------------------------------------------------------

/** 探测结果：不可达 / 空库 / 只有 group-type 标记 / 已有组描述符。 */
export type GroupProbeState = 'unreachable' | 'empty' | 'marked' | 'occupied';

export interface GroupProbeResult {
  state: GroupProbeState;
  /** 已知的组类型；`empty`/`unreachable` 下为 null。 */
  groupType: SyncGroupType | null;
  /** 远端已有的身份摘要（仅 occupied 时可能非空）。 */
  remote: RemoteIdentitySnapshot | null;
  /** 出错原因（unreachable 时是失败原因；occupied 但 kind 非法时是说明）。 */
  error?: string;
  /**
   * 探测时读到的完整描述符（`null` = 已确认远端没有描述符）。
   * 供 `createConfigRepo` 复用，避免 setupSync 再读一次同一个 `group.json`。
   */
  descriptor?: GroupDescriptor | null;
}

function errorText(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

/** 只提取路径类字段用于提示，绝不包含凭证/token。 */
function rootHintOf(options: Record<string, unknown>): string | undefined {
  for (const key of ['folderPath', 'basePath', 'root', 'remoteRoot', 'prefix', 'path']) {
    const value = options[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function bytesToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  return String(value ?? '');
}

/** 远端连不上（网络/鉴权/超时）：不能当成空库处理，直接拒绝，避免误建本地组。 */
export class RemoteUnreachableError extends Error {
  readonly code = 'REMOTE_UNREACHABLE';
  constructor(readonly backendType: string, readonly reason?: string) {
    super(
      `远端不可达（${backendType}）${reason ? `：${reason}` : ''}；` +
        '未创建任何本地同步组。请检查网络/凭证后重试。',
    );
    this.name = 'RemoteUnreachableError';
  }
}

/** 远端是空库：必须由用户显式选择组类型（initGroupType）才允许初始化。 */
export class NeedsInitError extends Error {
  readonly code = 'NEEDS_INIT';
  readonly requiresInit = true;
  constructor(readonly backendType: string, readonly rootHint?: string) {
    super(
      `远端${rootHint ? `（${backendType} ${rootHint}）` : `（${backendType}）`}尚未初始化：` +
        '请确认是否将其初始化为 config-sync 或 data-sync，再带 initGroupType 重试。',
    );
    this.name = 'NeedsInitError';
  }
}

/**
 * 三态探测：严格区分「远端不可达」与「真·空库」。
 *
 * - 严格读 `/.meta/group.json`：只有明确的“文件不存在”才继续；
 *   其它错误一律视为不可达，不再 `catch {}` 吞掉。
 * - 无描述符时读 `/.config/group-type`、`/.meta/group-type`：
 *   读到合法值 = `marked`；都不存在 = `empty`。
 */
export async function probeGroupTypeDetailed(
  type: string,
  options: Record<string, unknown>,
): Promise<GroupProbeResult> {
  let tempBackend: Awaited<ReturnType<typeof createBackend>> | undefined;
  try {
    tempBackend = await createBackend({ type, options });
  } catch (err) {
    return { state: 'unreachable', groupType: null, remote: null, error: errorText(err) };
  }

  try {
    let descriptor: Awaited<ReturnType<typeof readGroupDescriptorStrict>>;
    try {
      descriptor = await readGroupDescriptorStrict(tempBackend);
    } catch (err) {
      return { state: 'unreachable', groupType: null, remote: null, error: errorText(err) };
    }

    let remote: RemoteIdentitySnapshot | null = null;
    if (descriptor) {
      remote = {
        kind: descriptor.kind,
        id: descriptor.id,
        instanceId: isInstanceIdLike(descriptor.instanceId) ? descriptor.instanceId : undefined,
        ...(descriptor.name ? { name: descriptor.name } : {}),
      };
      if (descriptor.kind === 'config') {
        log(`probe: .meta/group.json kind=config → occupied(config-sync)`);
        return { state: 'occupied', groupType: 'config-sync', remote, descriptor };
      }
      if (descriptor.kind === 'data') {
        log(`probe: .meta/group.json kind=data → occupied(data-sync)`);
        return { state: 'occupied', groupType: 'data-sync', remote, descriptor };
      }
      return {
        state: 'occupied',
        groupType: null,
        remote,
        descriptor,
        error: `无法识别的组描述符 kind="${String(descriptor.kind)}"`,
      };
    }

    for (const path of [GROUP_TYPE_FILE, LEGACY_GROUP_TYPE_FILE]) {
      let raw: unknown;
      try {
        raw = await tempBackend.readFile(path, 'utf-8');
      } catch (err) {
        if (isNotFoundError(err)) continue;
        return { state: 'unreachable', groupType: null, remote: null, error: errorText(err) };
      }
      const value = bytesToText(raw).trim();
      if (value === 'config-sync' || value === 'data-sync') {
        log(`probe: found "${value}" at ${path} (no descriptor) → marked`);
        return { state: 'marked', groupType: value, remote: null, descriptor: null };
      }
      return {
        state: 'occupied',
        groupType: null,
        remote: null,
        descriptor: null,
        error: `group-type 标记值非法："${value}"（${path}）`,
      };
    }

    log('probe: no descriptor and no group-type marker → empty');
    return { state: 'empty', groupType: null, remote: null, descriptor: null };
  } finally {
    if (tempBackend?.dispose) {
      try {
        await tempBackend.dispose();
      } catch {
        // ignore dispose failure
      }
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
    // Recover any locally-cached data groups (persisted in the local primary
    // store). Never create a group here: connect() is not a create action, and
    // a descriptor that exists but fails to load must surface as an error
    // instead of being overwritten by an empty "default" group.
    const appDataGroups: AppDataGroup[] = [];
    const descriptors = await repo.listAppDataGroups();
    for (const d of descriptors) {
      try {
        appDataGroups.push(await repo.getAppDataGroup(d.id));
      } catch (err) {
        log(`connect: failed to load app data group "${d.id}":`, err);
      }
    }
    const dataGroup = appDataGroups[0];
    if (!dataGroup && descriptors.length > 0) {
      log(
        `connect: ${descriptors.length} data group descriptor(s) found but none could be loaded; ` +
        'leaving them untouched (no empty group is created)',
      );
    }
    return {
      groupType: options.groupType ?? 'config-sync',
      repo,
      configGroup: repo as ConfigSyncGroupHandle,
      groups: [repo as unknown as SyncGroupHandle, ...appDataGroups],
      dataGroup,
      appDataGroups,
    };
  }

  // -----------------------------------------------------------------
  // Case 2: backendInfo provided — detect group type from remote
  // -----------------------------------------------------------------
  const { type, options: backendOptions } = options.backendInfo;
  const probe = await probeGroupTypeDetailed(type, backendOptions);

  let groupType: SyncGroupType;
  if (probe.state === 'unreachable') {
    throw new RemoteUnreachableError(type, probe.error);
  }
  if (probe.state === 'empty') {
    // 空库：默认不初始化。只有显式 initGroupType（新契约）或显式 groupType
    //（旧调用方已经做过选择）才继续，否则让 UI 去问用户。
    const chosen = options.initGroupType ?? options.groupType;
    if (!chosen) throw new NeedsInitError(type, rootHintOf(backendOptions));
    groupType = chosen;
    log(`connect: empty remote, initialized as "${groupType}" (explicit consent)`);
  } else if (probe.groupType) {
    // 远端已被某个组占用（或只留下 group-type 标记）
    if (options.groupType && options.groupType !== probe.groupType) {
      const remoteText = summarizeIdentity(probe.remote);
      const advice = probe.groupType === 'config-sync'
        ? '该远端根已被一个配置组占用：请给数据组换一个专属的远端根，或在配置组侧解除对该根的绑定'
        : '该远端根已被一个数据组占用：请给配置组换一个远端根，或删除那个数据组后端';
      throw new Error(
        `Group type mismatch: 远端标记为 "${probe.groupType}"（${remoteText}），本端要求 "${options.groupType}"。${advice}`,
      );
    }
    groupType = probe.groupType;
  } else {
    // occupied 但 kind 无法识别：不允许猜测，直接失败。
    throw new Error(
      `远端根已有无法识别的组描述符${probe.error ? `：${probe.error}` : ''}；拒绝自动建组。`,
    );
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
          prefetchedRemote: {
            type,
            options: backendOptions,
            descriptor: probe.descriptor ?? null,
          },
          deferReplicaSetup: options.deferReplicaSetup,
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
  //
  // Guard: only create the group when there is truly no descriptor yet. If
  // descriptors exist but failed to load, creating "default" would overwrite
  // an existing group (and, once connected, its remote bootstrap copy) with an
  // empty one — surface the failure instead.
  let dataGroup: AppDataGroup | undefined = appDataGroups[0];
  if (groupType === 'data-sync') {
    if (!dataGroup) {
      if (descriptors.length > 0) {
        log(
          `connect: ${descriptors.length} data group descriptor(s) exist but could not be loaded; ` +
          'refusing to create/overwrite "default"',
        );
      } else {
        dataGroup = await repo.createAppDataGroup('default', []);
        appDataGroups.push(dataGroup);
      }
    }
    const backendId = `${type}-primary`;
    if (dataGroup && !dataGroup.listBackends().some(b => b.id === backendId)) {
      await dataGroup.addBackend(backendId, type, backendOptions);
    }
  }

  const replicasPending =
    !!options.deferReplicaSetup && groupType === 'config-sync' && !!options.backendInfo;
  const whenReplicasReady =
    typeof repo.whenReplicasReady === 'function' ? repo.whenReplicasReady() : undefined;

  return {
    groupType,
    repo,
    configGroup: repo as ConfigSyncGroupHandle,
    groups: [repo as unknown as SyncGroupHandle, ...appDataGroups],
    dataGroup,
    appDataGroups,
    replicasPending,
    whenReplicasReady,
  };
}
