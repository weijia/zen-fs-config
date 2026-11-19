/**
 * zen-fs-config — Group Identity (sync boundary)
 *
 * 每个同步组有一个不可变的实例身份（`instanceId`，UUID）。它写在两处：
 *
 *   - 组自己的 `/.meta/group.json`（随同步走，因此每个副本都带着它）；
 *   - 引导副本 `.config/app-data-groups/{appId}/{id}.json`（配置组登记，新设备
 *     在还没连上任何数据后端时就知道该组声明的身份）。
 *
 * 规则：**连接任何远端之前，先读对方的 `/.meta/group.json`**。
 *   - 对方带着同一个实例身份 → 同一组，允许建立同步对；
 *   - 对方还没有实例身份（老仓库）→ 由当前组认领并写入，之后固定归属；
 *   - 对方带着另一个实例身份 → **不建立同步对**，该后端被跳过并告警。
 *
 * 这就是「不同的同步组之间不能同步」的落地点：跨组不是靠路径隔离，而是靠
 * 连接前拒绝建对。
 */

import { readGroupDescriptor, writeGroupDescriptor } from './group-meta';
import { createLogger } from '@richard432/localstorage-logger';
import type { GroupDescriptor, SyncGroupKind } from './types';

const log = createLogger('zen-fs-config:group-identity');

/** 远端根当前归属的判定结果。 */
export type RemoteIdentityState =
  /** 远端根属于本组（实例身份一致）。 */
  | 'match'
  /** 远端根原先没有实例身份，本次由本组认领并写入。 */
  | 'claimed'
  /** 远端根属于另一个同步组 —— 必须跳过，不能建同步对。 */
  | 'conflict';

/** 本组身份：kind + 显示用 id + 不可变实例身份。 */
export interface GroupIdentity {
  kind: SyncGroupKind;
  id: string;
  instanceId: string;
  name?: string;
  /** 组能力位；认领老仓库时一并写入，避免与本地描述符产生字节差异。 */
  features?: GroupDescriptor['features'];
}

const INSTANCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 生成一个新的组实例身份（UUID v4）。 */
export function newGroupInstanceId(): string {
  const cryptoObj = (globalThis as any)?.crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  // 兜底：不依赖 crypto（极老的环境 / 部分测试运行时）。
  const bytes = new Uint8Array(16);
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 只接受 UUID v4 形态，避免把任意字符串当成身份写进会被同步的内容。 */
export function isValidGroupInstanceId(value: unknown): value is string {
  return typeof value === 'string' && INSTANCE_ID_RE.test(value.trim());
}

/**
 * 读远端根的归属，必要时认领。
 *
 * @param remoteFS 远端后端的文件系统（未 chroot 的根）
 * @param identity 本组身份
 */
export async function bindRemoteGroupIdentity(
  remoteFS: any,
  identity: GroupIdentity,
): Promise<RemoteIdentityState> {
  let remote: GroupDescriptor | null = null;
  try {
    remote = await readGroupDescriptor(remoteFS);
  } catch (err) {
    log.warn(`[GroupIdentity] failed to read remote ${identity.kind}/"${identity.id}" group.json:`, err);
    throw err;
  }

  const current = remote?.instanceId;

  if (isValidGroupInstanceId(current)) {
    if (current === identity.instanceId) return 'match';
    log.warn(
      `[GroupIdentity] backend belongs to another sync group ` +
        `(remote instanceId=${current}, this group=${identity.instanceId}, ` +
        `kind ${remote?.kind ?? '?'}/"${remote?.id ?? '?'}") — sync pair NOT created`,
    );
    return 'conflict';
  }

  // 老仓库 / 空仓库：没有实例身份 → 由先到者认领，之后归属固定。
  const next: GroupDescriptor = {
    schemaVersion: 2,
    kind: remote?.kind ?? identity.kind,
    id: remote?.id ?? identity.id,
    instanceId: identity.instanceId,
    ...(remote?.name ?? identity.name ? { name: (remote?.name ?? identity.name) as string } : {}),
    ...((remote?.features ?? identity.features) ? { features: (remote?.features ?? identity.features)! } : {}),
  };
  if (next.kind !== identity.kind) {
    // 远端带着另一种类型的描述符（例如配置组的仓库被数据组连接）：同一实例
    // 身份的缺失不能掩盖类型冲突，仍然拒绝。
    log.warn(
      `[GroupIdentity] remote kind "${next.kind}" ≠ this group kind "${identity.kind}" — sync pair NOT created`,
    );
    return 'conflict';
  }
  try {
    await writeGroupDescriptor(remoteFS, next);
  } catch (err) {
    // 远端只读 / 无写权限时不能假装认领成功，否则下轮仍会被别的组抢走。
    log.warn(`[GroupIdentity] failed to claim remote root for "${identity.id}":`, err);
    return 'conflict';
  }
  log.log(
    `[GroupIdentity] claimed remote root for ${identity.kind}/"${identity.id}" (instanceId=${identity.instanceId})`,
  );
  return 'claimed';
}

/** 从描述符里取已有身份；无效 / 缺失返回 `undefined`。 */
export function pickInstanceId(descriptor: { instanceId?: string } | null | undefined): string | undefined {
  const value = descriptor?.instanceId;
  return isValidGroupInstanceId(value) ? value : undefined;
}
