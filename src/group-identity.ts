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

import { readGroupDescriptorStrict, writeGroupDescriptor, readGroupAlias, readGroupAliases, writeGroupAlias } from './group-meta';
import { createLogger } from '@richard432/localstorage-logger';
import type { GroupAliasDescriptor, GroupDescriptor, SyncGroupKind } from './types';

const log = createLogger('zen-fs-config:group-identity');

/** 远端根当前归属的判定结果。 */
export type RemoteIdentityState =
  /** 远端根属于本组（实例身份一致）。 */
  | 'match'
  /** 远端根原先没有实例身份，本次由本组认领并写入。 */
  | 'claimed'
  /** 远端根属于另一个同步组 —— 必须跳过，不能建同步对。 */
  | 'conflict';

/** 冲突的细分原因：三类身份的哪一项不一致。 */
export type IdentityConflictReason =
  /** `kind` 不同（配置组 vs 数据组）。 */
  | 'kind-mismatch'
  /** 同为一种 kind，但组 id 不同（同一远端根被另一个逻辑组占用）。 */
  | 'id-mismatch'
  /** kind 与 id 都相同，但实例身份（instanceId）不同。 */
  | 'instance-mismatch'
  /** 远端描述符读不到（网络 / 权限），无法判断归属。 */
  | 'unreadable'
  /** 认领写入失败（远端只读 / 无权限）。 */
  | 'claim-failed'
  /** 本组实例身份尚未确定（没有读到任何候选），本轮不判定、也不认领。 */
  | 'local-unset';


/** 本组身份：kind + 显示用 id + 不可变实例身份。 */
export interface GroupIdentity {
  kind: SyncGroupKind;
  id: string;
  instanceId: string;
  /** 数据组所属应用，写入 alias 文件时用于展示；配置组忽略。 */
  appId?: string;
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

/** 只接受 UUID 形态（v4 随机 / v5 确定性都合法），避免把任意字符串当成身份写进会被同步的内容。 */
export function isValidGroupInstanceId(value: unknown): value is string {
  return typeof value === 'string' && INSTANCE_ID_RE.test(value.trim());
}

// ---------------------------------------------------------------------------
// Deterministic group identity (UUID v5)
// ---------------------------------------------------------------------------

/**
 * 命名空间 UUID：只在派生算法内部使用，**不得修改** —— 改一个字节就会让所有
 * 已按确定性规则建立的组算出另一个身份。
 */
const IDENTITY_NAMESPACE = '5f6a2f0c-9a4e-4b6e-8c3f-2c1d9b7a0e11';

/** hex → 16 字节 UUID。 */
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 纯 JS SHA-1（不依赖 WebCrypto，保证浏览器 / Node / 测试运行时结果一致）。 */
function sha1(bytes: Uint8Array): Uint8Array {
  const ml = bytes.length;
  const withPad = (((ml + 9 + 63) >> 6) << 6);
  const block = new Uint8Array(withPad);
  block.set(bytes);
  block[ml] = 0x80;
  const view = new DataView(block.buffer);
  // 长度按 64 位大端写；这里只支持 < 2^32 字节的输入（足够）。
  view.setUint32(withPad - 4, ml * 8, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i += 1) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = ((x << 1) | (x >>> 31)) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  return out;
}

/** 派生身份的输入：配置组用 `profile`，数据组用 `appId + groupId`。 */
export interface DerivedIdentityInput {
  /** 配置组：profile 名（缺省 `config`）；数据组忽略。 */
  profile?: string;
  /** 数据组：应用 id；配置组忽略。 */
  appId?: string;
  /** 数据组：组 id；配置组忽略。 */
  groupId?: string;
}

/**
 * 确定性组身份（UUID v5）。
 *
 * 规则（与 GROUP-IDENTITY-INIT 的「第一期」一致）：
 *   - 配置组：`config:${profile}`（profile 缺省 `config`），因此同一个远端根
 *     无论被哪台设备、哪个应用先连上，算出来的身份都相同，不需要再「认领」；
 *   - 数据组：`data:${appId}:${groupId}`，不同应用的 `default` 不会撞在一起。
 *
 * 只在「本地 / 引导副本 / 所有远端根都没有身份」且确实有后端需要认领时使用；
 * 已有身份（含历史随机 UUID）一律沿用，绝不改写。
 */
export function deriveGroupInstanceId(
  kind: SyncGroupKind,
  input: DerivedIdentityInput = {},
): string {
  const name =
    kind === 'config'
      ? `zen-fs-config:v1:config:${(input.profile ?? 'config').trim() || 'config'}`
      : `zen-fs-config:v1:data:${(input.appId ?? '').trim()}:${(input.groupId ?? '').trim()}`;
  const ns = uuidToBytes(IDENTITY_NAMESPACE);
  const msg = new Uint8Array(ns.length + 1);
  msg.set(ns);
  msg[ns.length] = 0; // 分隔符，避免不同字段拼接产生歧义
  const nameBytes = utf8Bytes(name);
  const all = new Uint8Array(msg.length + nameBytes.length);
  all.set(msg);
  all.set(nameBytes, msg.length);

  const digest = sha1(all);
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
  const result = await bindRemoteGroupIdentityDetailed(remoteFS, identity);
  return result.state;
}

/** 远端 `group.json` 的可见字段（用于在界面上把三方身份都摆出来）。 */
export interface RemoteIdentitySnapshot {
  kind?: SyncGroupKind;
  id?: string;
  instanceId?: string;
  name?: string;
}

/** 归属校验的完整结果：既给判定，也给两侧身份，UI 可以直接展示与决策。 */
export interface IdentityBindingResult {
  state: RemoteIdentityState;
  /** 远端当前描述符（空仓库 / 读不到时为 null）。 */
  remote: RemoteIdentitySnapshot | null;
  local: GroupIdentity;
  conflict?: IdentityConflictReason;
  /** 命中方式：canonical（group.json）或 alias（.meta/aliases）。 */
  matchedVia?: 'canonical' | 'alias';
  /** 远端读不到（网络 / 权限），区别于“空仓库”。 */
  unreadable?: boolean;
  error?: string;
}

/**
 * `kind=config · id=config · 实例 ID 665532a0-…` 这类一行摘要。
 *
 * 实例 ID **给完整 UUID**：界面上要靠它区分「是同一个还是另一个」，
 * 截成前 8 位反而让人没法核对（`…` 也容易被误当成「同一个」）。
 */
export function summarizeIdentity(
  identity: { kind?: string; id?: string; instanceId?: string } | null | undefined,
): string {
  if (!identity) return '（无描述符）';
  const parts = [
    `kind=${identity.kind ?? '?'}`,
    `id=${identity.id ?? '?'}`,
    `实例 ID=${identity.instanceId ?? '（无）'}`,
  ];
  return parts.join(' · ');
}

/** instanceId 前 8 位，仅用于展示（永不作为比较依据）。 */
export function shortInstanceId(instanceId: string): string {
  return `${instanceId.slice(0, 8)}…`;
}

function snapshotOf(descriptor: GroupDescriptor | null): RemoteIdentitySnapshot | null {
  if (!descriptor) return null;
  return {
    kind: descriptor.kind,
    id: descriptor.id,
    instanceId: pickInstanceId(descriptor),
    ...(descriptor.name ? { name: descriptor.name } : {}),
  };
}

/**
 * 归属校验的详细版：返回 `match` / `claimed` / `conflict` 以及两侧完整身份。
 *
 * 判定顺序（决定界面上的“原因”文案）：
 *   1. 远端描述符读不到 → conflict(unreadable)；
 *   2. `kind` 不同 → conflict(kind-mismatch)；
 *   3. 远端有实例身份：与本地一致 → match；不一致 → conflict(
 *        本地 id 与远端不同 ? id-mismatch : instance-mismatch )；
 *   4. 远端无身份（老仓库）→ 认领（保留远端已有的 kind/id/name）。
 */
export async function bindRemoteGroupIdentityDetailed(
  remoteFS: any,
  identity: GroupIdentity,
  /** 已读到的远端描述符（`null` = 已确认空仓库）；`undefined` = 未读，函数自己读。 */
  prefetched?: GroupDescriptor | null,
): Promise<IdentityBindingResult> {
  let remote: GroupDescriptor | null = null;
  if (prefetched !== undefined) {
    remote = prefetched;
  } else {
    try {
      remote = await readGroupDescriptorStrict(remoteFS);
    } catch (err) {
      log.warn(`[GroupIdentity] failed to read remote ${identity.kind}/"${identity.id}" group.json:`, err);
      return {
        state: 'conflict',
        remote: null,
        local: identity,
        conflict: 'unreadable',
        unreadable: true,
        error: (err as Error)?.message ?? String(err),
      };
    }
  }

  const snapshot = snapshotOf(remote);
  const current = snapshot?.instanceId;

  if (snapshot?.kind && snapshot.kind !== identity.kind) {
    log.warn(
      `[GroupIdentity] remote kind "${snapshot.kind}" ≠ this group kind "${identity.kind}" — sync pair NOT created`,
    );
    return { state: 'conflict', remote: snapshot, local: identity, conflict: 'kind-mismatch' };
  }

  // 本组身份尚未分配（例如已注册的根全部读不到时有意不定身份）：
  // 既不拿空值去比对、也不去认领远端 —— 空身份写进远端会污染别的设备，
  // 拿临时值比对又会把「远端本来就有身份」误判成冲突。
  if (!isValidGroupInstanceId(identity.instanceId)) {
    return { state: 'conflict', remote: snapshot, local: identity, conflict: 'local-unset' };
  }
  const localInstanceId: string = identity.instanceId;

  if (isValidGroupInstanceId(current)) {
    if (current === localInstanceId) {
      return { state: 'match', remote: snapshot, local: identity, matchedVia: 'canonical' };
    }
    // 共享根：成员各自保留自己的 instanceId，在 `.meta/aliases/<instanceId>.json`
    // 里登记。canonical 组永远不需要 alias，因此这里只查本组自己的文件。
    const alias = await readGroupAlias(remoteFS, localInstanceId);
    if (
      alias
      && snapshot?.kind === 'data'
      && alias.kind === identity.kind
      && alias.id === identity.id
    ) {
      log.log(
        `[GroupIdentity] joined shared root as alias (remote ${summarizeIdentity(snapshot)}, ` +
        `alias ${identity.id}/${localInstanceId})`,
      );
      return { state: 'match', remote: snapshot, local: identity, matchedVia: 'alias' };
    }
    const reason: IdentityConflictReason =
      snapshot?.id && snapshot.id !== identity.id ? 'id-mismatch' : 'instance-mismatch';
    log.warn(
      `[GroupIdentity] backend belongs to another sync group ` +
        `(remote ${summarizeIdentity(snapshot)}, this group ${summarizeIdentity(identity)}) — sync pair NOT created`,
    );
    return { state: 'conflict', remote: snapshot, local: identity, conflict: reason };
  }

  // 没有 canonical 身份、却已经有 alias 文件：这是一个不完整的共享根，
  // 不能把本组认领成 canonical（否则会把已有成员的成员表架空）。
  if ((await readGroupAliases(remoteFS)).length > 0) {
    log.warn(
      `[GroupIdentity] remote root has aliases but no canonical instanceId — ` +
      `refusing to claim it (this group ${summarizeIdentity(identity)})`,
    );
    return { state: 'conflict', remote: snapshot, local: identity, conflict: 'instance-mismatch' };
  }

  // 老仓库 / 空仓库：没有实例身份 → 由先到者认领，之后归属固定。
  // 保留远端已有的 kind/id/name（老仓库的显示信息不被覆盖）。
  const next: GroupDescriptor = {
    schemaVersion: 2,
    kind: remote?.kind ?? identity.kind,
    id: remote?.id ?? identity.id,
    instanceId: localInstanceId,
    ...(remote?.name ?? identity.name ? { name: (remote?.name ?? identity.name) as string } : {}),
    ...((remote?.features ?? identity.features) ? { features: (remote?.features ?? identity.features)! } : {}),
  };
  try {
    await writeGroupDescriptor(remoteFS, next);
  } catch (err) {
    // 远端只读 / 无写权限时不能假装认领成功，否则下轮仍会被别的组抢走。
    log.warn(`[GroupIdentity] failed to claim remote root for "${identity.id}":`, err);
    return {
      state: 'conflict',
      remote: snapshot,
      local: identity,
      conflict: 'claim-failed',
      error: (err as Error)?.message ?? String(err),
    };
  }
  log.log(
    `[GroupIdentity] claimed remote root for ${identity.kind}/"${identity.id}" (instanceId=${localInstanceId})`,
  );
  return { state: 'claimed', remote: snapshot, local: identity };
}

/** 冲突解决动作。 */
export type IdentityResolutionMode =
  /** 只把本地实例身份对齐成远端的 instanceId（要求 kind 与 id 相同）。 */
  | 'adopt-remote-instance'
  /** 把远端 `group.json` 改写成本组的 kind/id/instanceId（要求 kind 相同）。 */
  | 'rewrite-remote-identity'
  /** 把本组写成远端根的 alias 成员，保留两侧身份，不改 `group.json`。 */
  | 'join-shared-root';

export interface IdentityResolutionResult {
  mode: IdentityResolutionMode;
  ok: boolean;
  reason?: string;
  /** adopt-remote-instance 成功后应落盘到本地的 instanceId。 */
  instanceId?: string;
  /** join-shared-root 成功后写入的 alias 实例身份。 */
  aliasInstanceId?: string;
  remote?: RemoteIdentitySnapshot | null;
}

/**
 * 用户确认后的身份对齐（绝不静默执行）。
 *
 * - `adopt-remote-instance`：仅当远端 kind/id 与本组完全一致时，把远端 instanceId
 *   当作本组身份（本地库名、引导副本路径不变，无损）。
 * - `rewrite-remote-identity`：仅当 kind 相同时，把远端 `group.json` 改写成本组
 *   身份；会影响到共享同一个远端根的其它副本，调用方必须先警告用户。
 */
export async function resolveRemoteIdentity(
  remoteFS: any,
  identity: GroupIdentity,
  mode: IdentityResolutionMode,
): Promise<IdentityResolutionResult> {
  let remote: GroupDescriptor | null = null;
  try {
    remote = await readGroupDescriptorStrict(remoteFS);
  } catch (err) {
    return { mode, ok: false, reason: `远端描述符读不到：${(err as Error)?.message ?? String(err)}` };
  }
  const snapshot = snapshotOf(remote);

  if (mode === 'join-shared-root') {
    if (identity.kind !== 'data' || snapshot?.kind !== 'data') {
      return {
        mode,
        ok: false,
        reason: `只有 data 组可以加入共享根（远端 kind=${snapshot?.kind ?? '?'}，本组 kind=${identity.kind}）`,
        remote: snapshot,
      };
    }
    const remoteInstanceId = snapshot.instanceId;
    if (!isValidGroupInstanceId(remoteInstanceId)) {
      return { mode, ok: false, reason: '远端没有 canonical 实例身份，不能作为共享根加入', remote: snapshot };
    }
    if (!isValidGroupInstanceId(identity.instanceId)) {
      return { mode, ok: false, reason: '本组 instanceId 无效，不能写 alias', remote: snapshot };
    }
    const alias: GroupAliasDescriptor = {
      schemaVersion: 2,
      kind: 'data',
      id: identity.id,
      instanceId: identity.instanceId,
      ...(identity.appId ? { appId: identity.appId } : {}),
    };
    try {
      await writeGroupAlias(remoteFS, alias);
    } catch (err) {
      return { mode, ok: false, reason: `写 alias 失败：${(err as Error)?.message ?? String(err)}`, remote: snapshot };
    }
    log.log(
      `[GroupIdentity] joined shared root as alias ${identity.id}/${identity.instanceId} ` +
      `(canonical ${summarizeIdentity(snapshot)})`,
    );
    return { mode, ok: true, aliasInstanceId: identity.instanceId, remote: snapshot };
  }

  if (mode === 'adopt-remote-instance') {
    const remoteInstanceId = snapshot?.instanceId;
    if (!isValidGroupInstanceId(remoteInstanceId)) {
      return { mode, ok: false, reason: '远端没有实例身份，无需对齐', remote: snapshot };
    }
    if (snapshot?.kind !== identity.kind) {
      return {
        mode,
        ok: false,
        reason: `远端 kind=${snapshot?.kind ?? '?'}，本组 kind=${identity.kind}：类型不同不能只对齐实例身份`,
        remote: snapshot,
      };
    }
    if (snapshot?.id !== identity.id) {
      return {
        mode,
        ok: false,
        reason: `远端 id=${snapshot?.id ?? '?'}，本组 id=${identity.id}：组 id 不同说明远端根被另一个逻辑组占用，不能对齐`,
        remote: snapshot,
      };
    }
    return { mode, ok: true, instanceId: remoteInstanceId, remote: snapshot };
  }

  // rewrite-remote-identity
  if (snapshot && snapshot.kind !== identity.kind) {
    return {
      mode,
      ok: false,
      reason: `远端 kind=${snapshot.kind}，本组 kind=${identity.kind}：类型不同不允许改写远端`,
      remote: snapshot,
    };
  }
  const next: GroupDescriptor = {
    schemaVersion: 2,
    kind: identity.kind,
    id: identity.id,
    instanceId: identity.instanceId,
    ...(identity.name ? { name: identity.name } : {}),
    ...(identity.features ? { features: identity.features } : {}),
  };
  try {
    await writeGroupDescriptor(remoteFS, next);
  } catch (err) {
    return { mode, ok: false, reason: `写远端失败：${(err as Error)?.message ?? String(err)}`, remote: snapshot };
  }
  log.log(
    `[GroupIdentity] rewrote remote identity to ${identity.kind}/"${identity.id}" (instanceId=${identity.instanceId})`,
  );
  return { mode, ok: true, remote: snapshot };
}

/** 从描述符里取已有身份；无效 / 缺失返回 `undefined`。 */
export function pickInstanceId(descriptor: { instanceId?: string } | null | undefined): string | undefined {
  const value = descriptor?.instanceId;
  return isValidGroupInstanceId(value) ? value : undefined;
}
