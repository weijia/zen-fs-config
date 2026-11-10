/**
 * 本地主存储（IndexedDB）不可用 / 已损坏。
 *
 * 背景：浏览器 IndexedDB 记录丢失时，@zenfs/dom 抛出 `NotReadableError`，
 * @zenfs/core 再把它映射成 `EIO`。此前 `AppDataGroupImpl.init()` 把任何异常
 * 都包成一句 `Failed to create local primary ...`，原始错因（name/code/message）
 * 全部丢失，调用方无法区分「本地库坏了」和「组就是不存在」，于是被降级成
 * 「没有可用的数据同步组」。
 *
 * 这个错误类型把「本地存储不可用」变成可识别、可修复的状态：
 * - 保留原始 `cause`（含 code/name/message）；
 * - 带上 appId / groupId / IndexedDB 库名，供 UI 精确展示与一键重建；
 * - `isLocalStorageUnavailableError()` 能穿透 cause 链识别底层原始异常。
 */
export const LOCAL_STORAGE_UNAVAILABLE = 'LOCAL_STORAGE_UNAVAILABLE';

export interface LocalStorageUnavailableDetails {
  appId: string;
  groupId: string;
  /** 该数据组独占的 IndexedDB 库名（`zen-fs-config-data-{appId}[-{groupId}]`）。 */
  storeName: string;
  /** 原始异常（NotReadableError / EIO / DOMException …）。 */
  cause?: unknown;
}

/** 数据组本地主存储所在的 IndexedDB 库名（与 resolveLocalPrimary 保持一致）。 */
export function dataGroupLocalStoreName(appId: string, groupId: string): string {
  // default（legacy）组沿用旧库名；其它组按 groupId 隔离。
  return groupId === 'default'
    ? `zen-fs-config-data-${appId}`
    : `zen-fs-config-data-${appId}-${groupId}`;
}

export class LocalStorageUnavailableError extends Error {
  readonly code = LOCAL_STORAGE_UNAVAILABLE;
  readonly appId: string;
  readonly groupId: string;
  readonly storeName: string;
  readonly cause?: unknown;

  constructor(details: LocalStorageUnavailableDetails) {
    super(
      `Local storage for data group "${details.groupId}" is unavailable ` +
        `(IndexedDB "${details.storeName}"): ${describeError(details.cause)}`,
    );
    this.name = 'LocalStorageUnavailableError';
    this.appId = details.appId;
    this.groupId = details.groupId;
    this.storeName = details.storeName;
    this.cause = details.cause;
  }

  /** 原始异常的可序列化摘要（code / name / message），便于日志与诊断面板展示。 */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      appId: this.appId,
      groupId: this.groupId,
      storeName: this.storeName,
      message: this.message,
      cause: summarizeError(this.cause),
    };
  }
}

/** 原始异常摘要：保留 code / name / message，不吞成一句概括。 */
export function summarizeError(err: unknown): {
  name?: string;
  code?: string;
  message: string;
  stack?: string;
} {
  if (err instanceof Error || (err && typeof err === 'object')) {
    const anyErr = err as { name?: string; code?: string; message?: string; stack?: string };
    return {
      name: anyErr.name,
      code: anyErr.code,
      message: anyErr.message ?? String(err),
      stack: anyErr.stack,
    };
  }
  return { message: String(err) };
}

function describeError(err: unknown): string {
  const s = summarizeError(err);
  return [s.name, s.code, s.message].filter(Boolean).join(': ');
}

/** 这些 message 片段说明 IndexedDB 的记录已丢失/不可恢复。 */
const STORAGE_MESSAGE_HINTS = [
  /Data lost due to missing file/i,
  /should be considered irrecoverable/i,
  /IndexedDB.*(corrupt|unreadable)/i,
];

/**
 * 判断一个异常（含 cause 链）是否代表「本地存储不可用」。
 *
 * 识别依据：
 * - 本库包装的 {@link LocalStorageUnavailableError}；
 * - `NotReadableError`（IndexedDB 记录丢失）；
 * - `EIO`（@zenfs/core 对 NotReadableError 的映射）；
 * - “Data lost due to missing file” 等原始 message。
 */
export function isLocalStorageUnavailableError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 6; depth++) {
    if (cur instanceof LocalStorageUnavailableError) return true;
    const anyErr = cur as { name?: string; code?: string; message?: string; cause?: unknown };
    if (anyErr.name === 'NotReadableError') return true;
    if (anyErr.code === 'EIO') return true;
    const message = typeof anyErr.message === 'string' ? anyErr.message : '';
    if (message && STORAGE_MESSAGE_HINTS.some((re) => re.test(message))) return true;
    cur = anyErr.cause;
  }
  return false;
}

export interface LocalStoreDeletionResult {
  storeName: string;
  /** 库已被删除（或本来就不存在）。 */
  deleted: boolean;
  /** 删除被其它连接（其它标签页）阻塞，尚未完成。 */
  blocked: boolean;
  /** 当前环境没有 IndexedDB（例如 Node），无法执行。 */
  unsupported?: boolean;
  error?: string;
}

/**
 * 删除**该数据组独占**的本地 IndexedDB 库（只删
 * `zen-fs-config-data-{appId}[-{groupId}]`，绝不触碰配置仓的
 * `zen-fs-config-config-{appId}`）。
 *
 * 注意：如果还有别的标签页/实例连着这个库，浏览器会触发 `blocked`，此时删除
 * 会一直挂起。函数在 `timeoutMs` 后返回 `blocked: true`，调用方应提示用户关闭
 * 其它页面（或刷新后在没有旧连接的情况下重试）。
 */
export function deleteDataGroupLocalStore(
  appId: string,
  groupId: string,
  options: { timeoutMs?: number } = {},
): Promise<LocalStoreDeletionResult> {
  const storeName = dataGroupLocalStoreName(appId, groupId);
  // 不引入 DOM 类型（本包 lib 只有 ES2022），用最小结构描述用到的 API。
  const idb = (globalThis as {
    indexedDB?: { deleteDatabase(name: string): any };
  }).indexedDB;
  if (!idb || typeof idb.deleteDatabase !== 'function') {
    return Promise.resolve({
      storeName,
      deleted: false,
      blocked: false,
      unsupported: true,
      error: '当前环境没有 IndexedDB：无法删除本地数据组存储',
    });
  }

  const timeoutMs = options.timeoutMs ?? 4000;
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
      request = idb.deleteDatabase(storeName);
    } catch (err) {
      finish({ storeName, deleted: false, blocked: false, error: summarizeError(err).message });
      return;
    }

    request.onsuccess = () => finish({ storeName, deleted: true, blocked: false });
    request.onerror = () =>
      finish({
        storeName,
        deleted: false,
        blocked: false,
        error: summarizeError(request.error).message,
      });
    // `blocked` 之后仍可能 success（其它连接关闭时）；超时前先等。
    request.onblocked = () => {
      blocked = true;
    };

    timer = setTimeout(() => {
      finish({
        storeName,
        deleted: false,
        blocked,
        error: blocked
          ? '删除被其它页面/实例占用（blocked）：请关闭其它打开该页面的标签页后重试'
          : '删除超时：IndexedDB 未在预期时间内响应',
      });
    }, timeoutMs);
  });
}
