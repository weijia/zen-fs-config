/**
 * 数据组选择（跨 app 通用）
 *
 * 一个 appId 下可能存在多个数据同步组：历史 `default` 空组、换过后端的旧组、
 * 新建组。旧写法「取 `appDataGroups[0]`」会挂错组，数据写进空组、看起来像
 * 「没同步」。这一层解决「该挂哪个组」：
 *
 *  1. 用户在界面上显式选过的组（本机偏好，localStorage）；
 *  2. 目标目录下确实已有内容的组；
 *  3. 带远端后端的组（唯一一个时直接用）；
 *  4. 只有一个候选时用它。
 *
 * 多个候选且无法判定时返回 `null`，由界面列出来让用户选 —— 绝不静默择一。
 *
 * 这些逻辑与具体应用无关，所以放在库里；应用只提供 `appId` 与自己的数据目录
 * （如 `/golf`、`/bookkeeping`）。
 *
 * 作用对象既可以是 `ConfigRepo`，也可以是配置面板 `onConnected` 交出的
 * `{ repo, dataGroup }` 句柄：函数内部统一归一化，避免各应用各写一份适配。
 */
import type {
  AppDataBackendDescriptor,
  AppDataGroup,
  AppDataGroupDescriptor,
  IConfigRepo,
} from './types';
import { createLogger } from '@richard432/localstorage-logger';
import { dataGroupLocalStoreName } from './errors';

const log = createLogger('zen-fs-config:data-group-selection');

/** 本地后端类型：这类后端不跨设备同步，组里只有它们时不算「已连上可用数据组」。 */
const LOCAL_BACKEND_TYPES = new Set(['IndexedDB', 'InMemory']);

/** 该后端类型是否只是本机存储（不参与跨设备同步）。 */
export function isLocalBackendType(type: string): boolean {
  return LOCAL_BACKEND_TYPES.has(type);
}

// ---------------------------------------------------------------------------
// 本机偏好（用户选定的组 id）
// ---------------------------------------------------------------------------

/** 默认 localStorage 键前缀：`zen-fs-config:data-group:{appId}`。 */
export const DATA_GROUP_PREFERENCE_PREFIX = 'zen-fs-config:data-group:';

/** 最小 storage 形状（浏览器 localStorage / 测试替身）。 */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PreferenceOptions {
  storage?: PreferenceStorage;
  /** 写入用的键前缀，默认 {@link DATA_GROUP_PREFERENCE_PREFIX}。 */
  keyPrefix?: string;
  /**
   * 读取时依次尝试的键前缀（默认只用 `keyPrefix`）。
   * 迁移场景可把旧产品自己的键放进来，例如 `['zen-fs-config:data-group:', 'onenav:data-group:']`。
   */
  readPrefixes?: string[];
}

function defaultStorage(): PreferenceStorage | null {
  try {
    const ls = (globalThis as any)?.localStorage;
    if (ls && typeof ls.getItem === 'function') return ls as PreferenceStorage;
  } catch { /* 无 localStorage（Node / 隐私模式） */ }
  return null;
}

/** 本机为该 appId 记住的数据组 id（没有则 `null`）。 */
export function getPreferredDataGroupId(appId: string, opts: PreferenceOptions = {}): string | null {
  const storage = opts.storage ?? defaultStorage();
  if (!storage) return null;
  const prefixes = opts.readPrefixes ?? [opts.keyPrefix ?? DATA_GROUP_PREFERENCE_PREFIX];
  for (const prefix of prefixes) {
    try {
      const value = storage.getItem(`${prefix}${appId}`);
      if (value && value.trim()) return value.trim();
    } catch { /* 忽略 storage 异常 */ }
  }
  return null;
}

/** 记住（`id === null` 时清除）本机为该 appId 选定的数据组。 */
export function setPreferredDataGroupId(
  appId: string,
  id: string | null,
  opts: PreferenceOptions = {},
): void {
  const storage = opts.storage ?? defaultStorage();
  if (!storage) return;
  const key = `${opts.keyPrefix ?? DATA_GROUP_PREFERENCE_PREFIX}${appId}`;
  try {
    if (id) storage.setItem(key, id);
    else storage.removeItem(key);
  } catch { /* 忽略 storage 异常 */ }
}

// ---------------------------------------------------------------------------
// 候选枚举
// ---------------------------------------------------------------------------

/** 一个候选数据组（配置仓描述符 + 已实例化的组）。 */
export interface DataGroupCandidate {
  id: string;
  name?: string;
  group: AppDataGroup;
  /** 组里是否有非本地后端（即真能跨设备同步） */
  hasRemote: boolean;
  /** 后端类型列表，便于界面展示 */
  backendTypes: string[];
  /** 目标目录下是否已有内容（用于判断「哪个组才是真正装了数据的」） */
  hasData: boolean;
  /**
   * 该组的隐式本地主存储名（浏览器里是 IndexedDB）。
   *
   * 每个数据组都内置一个 local primary，它是组的本地 source / 离线缓存，
   * 不参与远端同步、也不出现在组描述符里；不能把它当成一个独立可选的数据组。
   */
  localStore: string;
}

/** 数据组来源：`ConfigRepo` 本身，或配置面板 `onConnected` 交出的句柄。 */
export type DataGroupSource =
  | IConfigRepo
  | { repo?: IConfigRepo | null; dataGroup?: AppDataGroup | null };

interface RepoLike {
  listAppDataGroups(): Promise<AppDataGroupDescriptor[]>;
  getAppDataGroup?(id: string): Promise<AppDataGroup>;
  createAppDataGroup?(
    id: string,
    backends?: AppDataBackendDescriptor[],
    options?: { name?: string },
  ): Promise<AppDataGroup>;
}

function asRepo(source: DataGroupSource): RepoLike | null {
  const any = source as any;
  if (typeof any?.listAppDataGroups === 'function') return any as RepoLike;
  const repo = any?.repo ?? any?.dataGroup?.parent;
  return typeof repo?.listAppDataGroups === 'function' ? (repo as RepoLike) : null;
}

function directGroup(source: DataGroupSource): AppDataGroup | null {
  const any = source as any;
  if (any?.dataGroup?.fs?.promises) return any.dataGroup as AppDataGroup;
  if (typeof any?.listAppDataGroups !== 'function' && any?.fs?.promises) {
    return any as AppDataGroup;
  }
  return null;
}

/** 组声明的后端列表（兼容 `listBackends` / `listDeclaredBackends` / 描述符三处来源）。 */
function listGroupBackends(group: AppDataGroup, descriptor?: AppDataGroupDescriptor): AppDataBackendDescriptor[] {
  const anyGroup = group as any;
  const connected: AppDataBackendDescriptor[] =
    typeof anyGroup?.listBackends === 'function' ? anyGroup.listBackends() : [];
  const declared: AppDataBackendDescriptor[] =
    typeof anyGroup?.listDeclaredBackends === 'function' ? anyGroup.listDeclaredBackends() : [];
  const fromDescriptor = descriptor?.backends ?? [];
  return [...connected, ...declared, ...fromDescriptor];
}

function hasRemoteBackend(group: AppDataGroup, descriptor?: AppDataGroupDescriptor): boolean {
  return listGroupBackends(group, descriptor).some((b) => b && !isLocalBackendType(b.type));
}

/** 组在 `path` 下是否至少有一个条目（读失败/未连接都算空）。 */
export async function groupHasPath(group: AppDataGroup, path: string): Promise<boolean> {
  try {
    const p = (group as any)?.fs?.promises;
    if (!p?.readdir) return false;
    const names = await p.readdir(path);
    return Array.isArray(names) ? names.length > 0 : false;
  } catch {
    return false;
  }
}

/**
 * 列出当前 appId 的所有数据组候选（带「是否有数据 / 是否有远端后端」）。
 *
 * @param source `ConfigRepo` 或 `{ repo, dataGroup }`
 * @param appId  应用 id（与 `connect()` 用的是同一个）
 * @param opts.path 判断「组里是否已有数据」的目录（通常是应用自己的数据目录）
 */
export async function listDataGroupCandidates(
  source: DataGroupSource,
  appId: string,
  opts: { path?: string } = {},
): Promise<DataGroupCandidate[]> {
  const repo = asRepo(source);
  const direct = directGroup(source);

  // 没有 repo、只有界面给的一个组（data-sync 模式）：就用它，不去 connect()。
  if (!repo && direct) {
    const id = String((direct as any).groupId ?? (direct as any).id ?? '');
    return [{
      id,
      name: (direct as any).name,
      group: direct,
      hasRemote: hasRemoteBackend(direct),
      backendTypes: Array.from(new Set(listGroupBackends(direct).map((b) => String(b?.type ?? '?')))),
      hasData: opts.path ? await groupHasPath(direct, opts.path) : false,
      localStore: dataGroupLocalStoreName(appId, id || 'default'),
    }];
  }

  const descriptors: AppDataGroupDescriptor[] = [];
  if (repo) {
    try {
      descriptors.push(...(await repo.listAppDataGroups()));
    } catch (err) {
      log.warn(`[${appId}] 列出数据组失败:`, err);
    }
  }

  const groups: { group: AppDataGroup; descriptor?: AppDataGroupDescriptor }[] = [];
  if (repo?.getAppDataGroup) {
    for (const d of descriptors) {
      try {
        const group = await repo.getAppDataGroup(d.id);
        if ((group as any)?.fs?.promises) groups.push({ group, descriptor: d });
      } catch (err) {
        log.warn(`[${appId}] 加载数据组 ${d.id} 失败:`, err);
      }
    }
  } else if (direct) {
    groups.push({ group: direct });
  }

  const out: DataGroupCandidate[] = [];
  for (const { group, descriptor } of groups) {
    const id = String((group as any).groupId ?? (group as any).id ?? descriptor?.id ?? '');
    out.push({
      id,
      name: (group as any).name ?? descriptor?.name,
      group,
      hasRemote: hasRemoteBackend(group, descriptor),
      backendTypes: Array.from(new Set(listGroupBackends(group, descriptor).map((b) => String(b?.type ?? '?')))),
      hasData: opts.path ? await groupHasPath(group, opts.path) : false,
      localStore: dataGroupLocalStoreName(appId, id || 'default'),
    });
  }
  // 有数据的排前面，其次有远端后端的，方便「默认选中正确组」
  out.sort((a, b) => Number(b.hasData) - Number(a.hasData) || Number(b.hasRemote) - Number(a.hasRemote));
  return out;
}

/** 兼容旧命名（应用侧曾叫 collectDataGroupCandidates）。 */
export const collectDataGroupCandidates = listDataGroupCandidates;

export interface ResolveDataGroupOptions {
  /** 显式指定的组 id；缺省读本机偏好。 */
  preferGroupId?: string | null;
  /** 应用自己的数据目录，用于「哪个组里真有数据」的判定。 */
  path?: string;
  preference?: PreferenceOptions;
}

/**
 * 按「偏好 → 有数据 → 唯一远端 → 单候选」的顺序解析出要挂载的组。
 * 多个候选且无法判定时返回 `null`，交给界面让用户选。
 */
export async function resolveDataGroup(
  source: DataGroupSource,
  appId: string,
  opts: ResolveDataGroupOptions = {},
): Promise<AppDataGroup | null> {
  const direct = directGroup(source);
  const candidates = await listDataGroupCandidates(source, appId, { path: opts.path });
  if (candidates.length === 0) return direct ?? null;

  const want = opts.preferGroupId ?? getPreferredDataGroupId(appId, opts.preference);
  if (want) {
    const named = candidates.find((c) => c.id === want);
    if (named) return named.group;
    log.warn(`[${appId}] 偏好的数据组 ${want} 不在本机配置仓中，改用其它候选`);
  }
  if (opts.path) {
    const withData = candidates.find((c) => c.hasData);
    if (withData) return withData.group;
  }
  const remote = candidates.filter((c) => c.hasRemote);
  if (remote.length === 1) return remote[0].group;
  if (candidates.length === 1) return candidates[0].group;
  if (remote.length > 1) {
    // 宁可提示，也不要在多个远端组之间静默择一
    log.warn(
      `[${appId}] 存在多个可用数据组，需用户选择：${candidates.map((c) => c.id).join(', ')}`,
    );
    return null;
  }
  return null;
}

export interface EnsureDataGroupOptions extends ResolveDataGroupOptions {
  /** 是否允许在「一个描述符都没有」时补建本机默认组（默认允许）。 */
  allowCreateLocal?: boolean;
}

export interface EnsureDataGroupResult {
  group: AppDataGroup | null;
  candidates: DataGroupCandidate[];
  /** 本次是否新建了本机默认组（界面据此提示「仅本地」） */
  created: boolean;
  /** 有描述符但一个都加载不出来（此时不建 default，避免与远端组冲突） */
  descriptorsUnavailable: boolean;
}

/**
 * 确保某个 appId **至少有一个可用的数据组实例**，没有就建一个本机默认组。
 *
 * 数据组不是「只有配了远端后端才有」：每个组都自带隐式本地主存储。应用要在
 * 数据组里读写就必须有一个组实例，否则页面只能停在「还没有数据组」。
 *
 * - 已有描述符：按 {@link resolveDataGroup} 的规则选；
 * - **一个描述符都没有**：`createAppDataGroup('default', [])`，得到一个只有
 *   隐式本地存储的组（不参与远端同步，之后可再加远端后端）；
 * - **有描述符但都加载失败**：绝不建 default，返回 `descriptorsUnavailable`。
 */
export async function ensureDataGroup(
  source: DataGroupSource,
  appId: string,
  opts: EnsureDataGroupOptions = {},
): Promise<EnsureDataGroupResult> {
  const allowCreate = opts.allowCreateLocal !== false;
  const candidates = await listDataGroupCandidates(source, appId, { path: opts.path });
  if (candidates.length > 0) {
    const picked = await resolveDataGroup(source, appId, opts);
    return { group: picked, candidates, created: false, descriptorsUnavailable: false };
  }

  const repo = asRepo(source);
  const canCreate =
    allowCreate &&
    typeof repo?.createAppDataGroup === 'function' &&
    typeof repo?.getAppDataGroup === 'function' &&
    typeof repo?.listAppDataGroups === 'function';

  if (!repo || !canCreate) {
    return { group: null, candidates, created: false, descriptorsUnavailable: false };
  }

  let descriptors: AppDataGroupDescriptor[] | null = null;
  try {
    descriptors = await repo.listAppDataGroups();
  } catch (err) {
    log.warn(`[${appId}] 无法确认数据组描述符，跳过本机默认组创建:`, err);
    descriptors = null;
  }
  if (descriptors === null) {
    return { group: null, candidates, created: false, descriptorsUnavailable: true };
  }
  if (descriptors.length > 0) {
    // 有描述符却一个都没实例化出来（后端加载失败等）：不建 default
    return { group: null, candidates, created: false, descriptorsUnavailable: true };
  }

  let created = false;
  try {
    await repo.createAppDataGroup!('default', []);
    created = true;
  } catch (err) {
    // 可能是另一个标签页/设备刚建好，或已存在：继续尝试读取现有 default
    log.warn(`[${appId}] 创建本机默认数据组失败（将尝试读取现有 default）:`, err);
  }

  let group: AppDataGroup | null = null;
  try {
    group = (await repo.getAppDataGroup!('default')) ?? null;
  } catch (err) {
    log.warn(`[${appId}] 读取本机默认数据组失败:`, err);
    group = null;
  }

  const next = await listDataGroupCandidates(source, appId, { path: opts.path });
  return { group, candidates: next, created: created && !!group, descriptorsUnavailable: false };
}
