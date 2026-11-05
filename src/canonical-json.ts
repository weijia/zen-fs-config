/**
 * zen-fs-config — Canonical JSON Serialization
 *
 * 所有会随同步走、且需要「内容相同则字节相同」的判断都使用这里的序列化器：
 *
 *   - `.meta/group.json`            （组描述符）
 *   - `.meta/backends/{id}.json`    （数据组权威后端描述符）
 *   - `.config/backends/{id}.json`  （配置组后端描述符）
 *   - `.config/app-data-groups/**`  （数据组引导描述符）
 *
 * 规范化规则（跨设备必须完全确定，否则两台设备会写出「语义相同、字节不同」
 * 的文件，从而互相触发写入）：
 *
 *   1. 固定字段顺序（每种描述符一份白名单顺序），未知字段按 key 升序排在后面；
 *   2. `backends` 数组按 `id` 升序；
 *   3. `options` 与其它自由对象递归按 key 升序（使用逐 code unit 比较，
 *      不使用 localeCompare / 本地化，也不做 Unicode 归一化）；
 *   4. 2 空格缩进、`\n` 换行、UTF-8 无 BOM、结尾不加换行
 *      （与历史上 `JSON.stringify(value, null, 2)` 的字节布局一致）；
 *   5. `undefined` 字段被丢弃，可选字段不会以 `null` 形式泄漏。
 *
 * 判定「是否需要写」时比较的是**投影字节**（即序列化结果），不持久化任何哈希
 * 或 revision 字段 —— 那会把「内容哈希」写进内容本身，形成自指回环。
 */

import type {
  AppDataBackendDescriptor,
  AppDataGroupDescriptor,
  BackendDescriptor,
  GroupDescriptor,
} from './types';

// ---------------------------------------------------------------------------
// Field orders (whitelist, fixed across devices)
// ---------------------------------------------------------------------------

const FEATURE_ORDER = ['tombstones', 'versions', 'conflicts', 'configHost', 'appData'] as const;
const GROUP_DESCRIPTOR_ORDER = ['schemaVersion', 'kind', 'id', 'name', 'features'] as const;
const APP_DATA_GROUP_ORDER = ['id', 'groupType', 'name', 'features', 'backends'] as const;
const BACKEND_ORDER = ['id', 'type', 'options', 'accountBackendId', 'description', 'createdAt'] as const;

// ------------------------------------------------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------------------------------------------------

/** 逐 code unit 的稳定比较（不使用 localeCompare）。 */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 规范化一个对象：先按白名单顺序输出已知字段，再按 key 升序输出其它字段。
 * 值为 `undefined` 的字段直接丢弃。
 */
function canonicalObject(
  value: Record<string, unknown>,
  order: readonly string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (value[key] !== undefined) out[key] = canonicalField(key, value[key]);
  }
  for (const key of Object.keys(value).sort(compareKeys)) {
    if (order.includes(key) || value[key] === undefined) continue;
    out[key] = canonicalField(key, value[key]);
  }
  return out;
}

/** 规范化任意字段值；`key` 用于识别 `features` / `backends` / `options`。 */
function canonicalField(key: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    if (key === 'backends') {
      return value
        .map((item) => (isPlainObject(item) ? canonicalObject(item, BACKEND_ORDER) : item))
        .sort((a, b) =>
          compareKeys(String((a as any)?.id ?? ''), String((b as any)?.id ?? '')),
        );
    }
    return value.map((item) => canonicalField('', item));
  }
  if (isPlainObject(value)) {
    if (key === 'features') return canonicalObject(value, FEATURE_ORDER);
    // `options` 以及其它自由对象：递归按 key 升序。
    return canonicalObject(value);
  }
  return value;
}

/** JSON.stringify 的固定布局：2 空格缩进、`\n`、无结尾换行。 */
function stringify(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

// ------------------------------------------------------------------------------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------------------------------------------------------------------------------

/** `.meta/group.json` 的规范化字节。 */
export function serializeGroupDescriptor(descriptor: GroupDescriptor): string {
  const { updatedAt: _ignored, ...rest } = descriptor as GroupDescriptor & { updatedAt?: number };
  return stringify(canonicalObject(rest as Record<string, unknown>, GROUP_DESCRIPTOR_ORDER));
}

/** 单个后端描述符（配置组 `.config/backends` 或数据组 `.meta/backends`）的规范化字节。 */
export function serializeBackendDescriptor(
  descriptor: BackendDescriptor | AppDataBackendDescriptor,
): string {
  return stringify(canonicalObject(descriptor as unknown as Record<string, unknown>, BACKEND_ORDER));
}

/** 数据组引导描述符（`.config/app-data-groups/**.json`）的规范化字节。 */
export function serializeAppDataGroupDescriptor(descriptor: AppDataGroupDescriptor): string {
  return stringify(canonicalObject(descriptor as unknown as Record<string, unknown>, APP_DATA_GROUP_ORDER));
}

/**
 * 后端列表的投影字节：`createdAt` 之外的内容规范化后排序拼接。
 *
 * `createdAt` 只用于「同一远端去重时保留最老者」，不参与「是否需要写」的判断；
 * 写入时用 `min(existing, incoming)` 合并，保证两端的值收敛到同一个最小值，
 * 因而不会因为时间戳不同而互相覆盖。
 */
export function serializeBackendList(backends: AppDataBackendDescriptor[]): string {
  return stringify(
    canonicalField('backends', backends.map((b) => stripBackendCreatedAt(b))) as unknown as Record<string, unknown>,
  );
}

/** 去掉 `createdAt`，用于投影比较。 */
export function stripBackendCreatedAt(descriptor: AppDataBackendDescriptor): AppDataBackendDescriptor {
  const { createdAt: _ignored, ...rest } = descriptor;
  return rest as AppDataBackendDescriptor;
}

/**
 * 合并两个后端描述符：`createdAt` 取最小值（缺失视为「更老」，即保留对方），
 * 其余字段以 `incoming` 为准。用于「写入前与磁盘现有内容合并」，
 * 保证 `createdAt` 不会在两端来回抖动。
 */
export function mergeBackendDescriptor(
  existing: AppDataBackendDescriptor | null | undefined,
  incoming: AppDataBackendDescriptor,
): AppDataBackendDescriptor {
  const existingCreatedAt = typeof existing?.createdAt === 'number' ? existing.createdAt : undefined;
  const incomingCreatedAt = typeof incoming.createdAt === 'number' ? incoming.createdAt : undefined;
  const createdAt =
    existingCreatedAt === undefined
      ? incomingCreatedAt
      : incomingCreatedAt === undefined
        ? existingCreatedAt
        : Math.min(existingCreatedAt, incomingCreatedAt);
  return createdAt === undefined ? stripBackendCreatedAt(incoming) : { ...incoming, createdAt };
}

/** 按 id 把现有描述符的 `createdAt` 合并进新列表（新列表条目的其余字段保持不变）。 */
export function mergeBackendCreatedAt(
  incoming: AppDataBackendDescriptor[],
  existing: AppDataBackendDescriptor[] | null | undefined,
): AppDataBackendDescriptor[] {
  if (!existing || existing.length === 0) return incoming;
  const byId = new Map(existing.map((d) => [d.id, d]));
  return incoming.map((desc) => mergeBackendDescriptor(byId.get(desc.id), desc));
}

/** 把描述符的 `backends` 与磁盘现有的 `createdAt` 合并，其余字段以描述符为准。 */
export function mergeDescriptorCreatedAt(
  descriptor: AppDataGroupDescriptor,
  existing: AppDataGroupDescriptor | null | undefined,
): AppDataGroupDescriptor {
  return {
    ...descriptor,
    backends: mergeBackendCreatedAt(descriptor.backends, existing?.backends),
  };
}
