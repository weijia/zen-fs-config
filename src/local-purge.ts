/**
 * zen-fs-config — 本地同步配置清理（“清除本页同步组配置”）。
 *
 * 只动**本页**应用的本地状态：
 *   · 配置组的 IndexedDB：`zen-fs-config-config-{appId}`
 *   · 各数据组的 IndexedDB：`zen-fs-config-data-{appId}`（default）与
 *     `zen-fs-config-data-{appId}-{groupId}`
 *   · 调用方显式列出的 localStorage 键（后端信息、重建标记等）
 *
 * 远端副本、其它设备与其它标签页的配置都不受影响；删除后本页会以「未连接」
 * 状态重来一次（重新选后端 / 重新认领远端根）。
 */
import { summarizeError, type LocalStoreDeletionResult } from './errors';

const CONFIG_STORE_PREFIX = 'zen-fs-config-config-';
const DATA_STORE_PREFIX = 'zen-fs-config-data-';

export interface PurgeLocalSyncConfigOptions {
  /** 已知的数据组 id；与 `indexedDB.databases()` 的枚举结果合并。 */
  groupIds?: string[];
  /** 需要一并删除的 localStorage 键（后端信息、重建标记等）。 */
  extraStorageKeys?: string[];
  /** 单个库删除的超时；默认 4000ms。 */
  timeoutMs?: number;
}

export interface PurgeLocalSyncConfigResult {
  appId: string;
  databases: LocalStoreDeletionResult[];
  removedStorageKeys: string[];
  /** 当前环境没有 IndexedDB（例如 Node）：只清了 storage key。 */
  unsupported?: boolean;
}

interface IdbLike {
  deleteDatabase(name: string): any;
  databases?(): Promise<Array<{ name?: string }>>;
}

function getIdb(): IdbLike | null {
  const idb = (globalThis as { indexedDB?: IdbLike }).indexedDB;
  if (!idb || typeof idb.deleteDatabase !== 'function') return null;
  return idb;
}

/**
 * 删除一个 IndexedDB 库并等到成功 / 失败 / 超时。
 * 仍被其它连接占用时返回 `blocked: true`（而不是无限挂起）。
 */
export function deleteIndexedDbStore(
  name: string,
  timeoutMs = 4000,
): Promise<LocalStoreDeletionResult> {
  const idb = getIdb();
  if (!idb) {
    return Promise.resolve({
      storeName: name,
      deleted: false,
      blocked: false,
      unsupported: true,
      error: '当前环境没有 IndexedDB：无法删除本地库',
    });
  }

  return new Promise<LocalStoreDeletionResult>((resolve) => {
    let settled = false;
    let blocked = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: LocalStoreDeletionResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let request: any;
    try {
      request = idb.deleteDatabase(name);
    } catch (err) {
      finish({ storeName: name, deleted: false, blocked: false, error: summarizeError(err).message });
      return;
    }

    request.onsuccess = () => finish({ storeName: name, deleted: true, blocked: false });
    request.onerror = () =>
      finish({
        storeName: name,
        deleted: false,
        blocked: false,
        error: summarizeError(request.error).message,
      });
    request.onblocked = () => {
      blocked = true;
    };

    timer = setTimeout(() => {
      finish({
        storeName: name,
        deleted: false,
        blocked,
        error: blocked
          ? '删除被其它页面/实例占用（blocked）：请关闭其它打开该页面的标签页后重试'
          : '删除超时：IndexedDB 未在预期时间内响应',
      });
    }, timeoutMs);
  });
}

/** 本页该应用会创建的全部本地配置库名（用于精确删除，不误伤别的 appId）。 */
export function localSyncStoreNames(appId: string, groupIds: string[] = []): string[] {
  const names = new Set<string>([
    `${CONFIG_STORE_PREFIX}${appId}`,
    `${DATA_STORE_PREFIX}${appId}`,
  ]);
  for (const groupId of groupIds) {
    if (!groupId) continue;
    names.add(`${DATA_STORE_PREFIX}${appId}-${groupId}`);
  }
  return Array.from(names);
}

/**
 * 清除本页该应用的同步组配置（IndexedDB 本地副本 + 指定的 storage 键）。
 *
 * 典型用法：同步时发现远端根属于类型不匹配 / instanceId 不一致的另一个组，
 * 用户确认后清掉本页配置，再重新连接一遍。
 */
export async function purgeLocalSyncConfig(
  appId: string,
  options: PurgeLocalSyncConfigOptions = {},
): Promise<PurgeLocalSyncConfigResult> {
  const idb = getIdb();
  const names = new Set<string>(localSyncStoreNames(appId, options.groupIds));

  const removedStorageKeys: string[] = [];
  const removeStorageKeys = () => {
    try {
      const ls = (globalThis as { localStorage?: Storage }).localStorage;
      if (!ls) return;
      for (const key of options.extraStorageKeys ?? []) {
        try {
          if (ls.getItem(key) !== null) {
            ls.removeItem(key);
            removedStorageKeys.push(key);
          }
        } catch {
          /* 单个 key 失败不影响其它 */
        }
      }
    } catch {
      /* storage 不可用（隐私模式） */
    }
  };

  if (!idb) {
    removeStorageKeys();
    return { appId, databases: [], removedStorageKeys, unsupported: true };
  }

  // 枚举到的库补全（例如已删除组的残留库、旧布局 data-{appId}）。
  try {
    const list = await idb.databases?.();
    for (const entry of list ?? []) {
      const name = entry?.name;
      if (!name) continue;
      if (name === `${CONFIG_STORE_PREFIX}${appId}`) names.add(name);
      if (name === `${DATA_STORE_PREFIX}${appId}` || name.startsWith(`${DATA_STORE_PREFIX}${appId}-`)) {
        names.add(name);
      }
    }
  } catch {
    /* databases() 在部分浏览器不可用：退回已知库名 */
  }

  const databases: LocalStoreDeletionResult[] = [];
  for (const name of names) {
    databases.push(await deleteIndexedDbStore(name, options.timeoutMs));
  }

  removeStorageKeys();

  return { appId, databases, removedStorageKeys };
}
