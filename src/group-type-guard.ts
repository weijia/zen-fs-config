/**
 * zen-fs-config — Group Type Guard
 *
 * `group-type` 一旦写入就代表这个组的身份：`config-sync`（配置组）还是
 * `data-sync`（数据组）。身份决定了目录布局、后端注册方式以及对端的接入方式，
 * 所以它**不能**被同步改写：
 *
 *  - 把配置组的 `group-type` 同步成 `data-sync` → 这个组会被当成数据组打开，
 *    后端描述符、加解密、目录结构全部按另一套规则解释；
 *  - 把数据组的 `group-type` 同步成 `config-sync` → 反方向同样错。
 *
 * 同理 `.meta/group.json` 的 `kind`（config/data）以及
 * `.config/app-data-groups/{appId}/{id}.json` 的 `groupType` 也是身份字段。
 *
 * 守则是「写一次」：目标端还没有该文件时允许写入（首次引导）；目标端已有值时，
 * 只有**相同**的值才允许重写（幂等写、字节级规范化差异都放过），不同值一律丢弃
 * 并告警。这样无论同步把哪个方向的旧值带过来，都不会把一端的身份改掉。
 */

import type { SyncableFS } from 'zen-fs-sync';
import { createLogger } from '@richard432/localstorage-logger';

const log = createLogger('zen-fs-config:group-type-guard');

/** 身份标记文件：内容是纯文本的组类型。 */
const GROUP_TYPE_FILES = new Set(['/.config/group-type', '/.meta/group-type']);

/** 统一组描述符：`kind` 字段区分 config / data。 */
const GROUP_DESCRIPTOR_FILE = '/.meta/group.json';

/** 数据组引导描述符：`groupType` 字段固定为 data-sync。 */
const APP_DATA_GROUP_DESCRIPTOR_RE = /^\/\.config\/app-data-groups\/[^/]+\/[^/]+\.json$/;

export interface GroupTypeBlock {
  /** 被守卫生效的一端，如 `local(IndexedDB)` 或 `InMemory(replica-a)`。 */
  side: string;
  path: string;
  /** 目标端现有身份值（如 `config-sync` / `kind:config`）。 */
  existing: string;
  /** 本次同步试图写入的身份值。 */
  incoming: string;
}

/** 守卫拦下写入时触发（便于上层统计/上报，默认只打日志）。 */
export type GroupTypeBlockHandler = (block: GroupTypeBlock) => void;

function decode(data: string | Uint8Array | ArrayBuffer): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  return new TextDecoder().decode(data);
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 从「路径 + 内容」里取出身份值；不是身份文件或解析不出身份时返回 null
 * （返回 null 表示不参与守卫，写入照常放行，避免误伤普通文件）。
 */
export function readGroupIdentity(path: string, data: string | Uint8Array | ArrayBuffer): string | null {
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const isGroupType = GROUP_TYPE_FILES.has(normalized);
  const isGroupDescriptor = normalized === GROUP_DESCRIPTOR_FILE;
  const isAppDataGroup = APP_DATA_GROUP_DESCRIPTOR_RE.test(normalized);
  // 先按路径过滤：普通文件的写入不该为守卫付出解码/解析成本。
  if (!isGroupType && !isGroupDescriptor && !isAppDataGroup) return null;

  const text = decode(data);
  if (isGroupType) {
    const value = text.trim();
    return value || null;
  }
  const parsed = safeParse(text);
  if (isGroupDescriptor) {
    return typeof parsed?.kind === 'string' ? `kind:${parsed.kind}` : null;
  }
  return typeof parsed?.groupType === 'string' ? `groupType:${parsed.groupType}` : null;
}

/** 读目标端现有身份；文件不存在/读不到时返回 null（视为可写入）。 */
async function readExistingIdentity(fs: SyncableFS, path: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return readGroupIdentity(path, raw as string);
  } catch {
    return null;
  }
}

/**
 * 给某一端的 SyncableFS 套上身份守卫。
 *
 * 只拦「改成另一个值」的写入；首次写入（目标端为空）与同值重写照旧放行。
 * 被拦时不抛异常——同步引擎会认为写入完成，避免把整条同步链拖进错误态，
 * 身份保护由日志 + onBlock 回调体现。
 */
export function wrapGroupTypeGuard(
  fs: SyncableFS,
  side: string,
  onBlock?: GroupTypeBlockHandler,
): SyncableFS {
  const reported = new Set<string>();
  // 以 fs 为原型，只覆盖写入方法：其它方法（readdir/stat/createSnapshot/onChange…）
  // 原样继承，`this` 仍指向这一层，不会丢失后端自身的可选能力。
  const guarded = Object.create(fs) as SyncableFS;
  const lastBlock = { current: null as GroupTypeBlock | null };
  (guarded as any).getLastBlockedGroupType = () => lastBlock.current;

  const allow = async (path: string, data: string | Uint8Array | ArrayBuffer): Promise<boolean> => {
    const incoming = readGroupIdentity(path, data);
    if (incoming === null) return true;
    const existing = await readExistingIdentity(fs, path);
    if (existing === null || existing === incoming) return true;

    const signature = `${side}|${path}|${existing}->${incoming}`;
    const block: GroupTypeBlock = { side, path, existing, incoming };
    lastBlock.current = block;
    if (!reported.has(signature)) {
      reported.add(signature);
      log.warn(
        `[GroupType] blocked group-type change on ${side}: ${path} ` +
        `would change "${existing}" → "${incoming}" — identity is write-once, ` +
        `the incoming value is dropped (fix the group wiring instead of syncing it)`,
      );
    }
    try {
      onBlock?.(block);
    } catch {
      /* 上报失败不影响写入路径 */
    }
    return false;
  };

  guarded.writeFile = async (path: string, data: string | Uint8Array): Promise<void> => {
    if (!(await allow(path, data))) return;
    return fs.writeFile(path, data);
  };

  if (typeof fs.writeFileWithMtime === 'function') {
    guarded.writeFileWithMtime = async (path: string, data: string | Uint8Array, mtime: number): Promise<void> => {
      if (!(await allow(path, data))) return;
      return fs.writeFileWithMtime!(path, data, mtime);
    };
  }

  guarded.backendName = sideLabel(fs.backendName, side);
  return guarded;
}

/** 日志里同时带原有端名与守卫标签，便于定位是哪一端被拦。 */
function sideLabel(name: string | undefined, side: string): string {
  if (!name) return side;
  return name.includes(side) ? name : `${name}·${side}`;
}
