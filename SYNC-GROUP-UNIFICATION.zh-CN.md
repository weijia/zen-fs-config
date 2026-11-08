# 配置同步组与数据同步组统一 — 技术设计文档

| 项 | 内容 |
|---|---|
| 状态 | 已实现（0.6.0）：数据组自描述（`.meta/backends/`）为权威，配置组只保留引导副本 |
| 版本 | v3（2026-11-05 修订：数据组后端定义改为自描述权威；配置组描述符降级为引导副本；`updatedAt` 停止写入；规范化序列化） |
| 日期 | 2026-11-05 |
| 范围 | `zen-fs-config`（核心）、`zen-fs-config-ui`（呈现）、`dir-struct-gen`（产品层兼容性） |
| 关联文档 | [REQUIREMENTS.md](./REQUIREMENTS.md) §9 D2、FR0/FR1/FR2/FR9；[DESIGN.zh-CN.md](./DESIGN.zh-CN.md) |
| 结论强度 | 代码事实均标注文件与行号；标有「推断」的段落未经运行验证 |

---

## 0. 结论摘要（TL;DR）

1. **组的统一抽象**：一个同步组 = 本地主存储 + 若干远端副本 + 通用 `.meta/` + 该组自己的后端定义。配置组与数据组是**同一基座上的两个能力位**，不是「配置组 ⊃ 数据组」：配置组 `configHost=true`（能承载 `.config`），数据组 `appData=true`（能被登记为数据组）。详见 §0.1。
2. **数据组的后端定义是自描述、且为权威**：`.meta/backends/{backendId}.json` 随数据组同步，任何设备连上任意一个数据后端都能读到完整拓扑。配置组的 `.config/app-data-groups/{appId}/{id}.json` 降级为**引导副本**（bootstrap copy），只用于「新设备只有配置组凭据」和「数据组尚未写出自己的 `.meta/backends/`」两种场景，字段 `backends` 长期保留、不删除。
3. **删除靠墓碑，冲突时墓碑优先**：后端删除走「写墓碑 + `unlink`」；若同一 id 既有墓碑又有描述符条目，**墓碑优先**（防止删除被复活）。
4. **不得把时间/版本写进同步内容**：`updatedAt` 已停止写入（`GroupDescriptor.updatedAt` 标 `@deprecated`，`schemaVersion: 2` 起不写、读侧忽略）；不持久化任何 `backendsRevision`；「是否需要写」用**规范化投影字节比较**，不用哈希、不用递增计数器。详见 §4.4。
5. **规范化序列化是跨设备一致的前提**：固定字段顺序、`backends` 按 id 排序、`options` 递归按 key 排序、不做本地化/Unicode 归一化、2 空格缩进 + `\n`、UTF-8 无 BOM、结尾不加换行。实现见 [canonical-json.ts](file:///C:/codes/nodejs/zen-fs-config/src/canonical-json.ts)。
6. **远端布局**：同根 + 通用 `.meta/` + 配置专属 `.config/`，不采用 `groups/<groupId>`（§3.1–§3.4）。
7. **落地状态**：Phase 0（墓碑/版本/冲突下沉）与本次数据组自描述已在 0.6.0 完成；Phase 1 的 `SyncGroupHandle` 统一接口仍部分待做（§6）。

### 0.1 组的统一抽象（读后文布局前请先看这节）

```ts
// 一个组 = 本地主存储 + 若干远端副本 + 通用 .meta + 该组自己的后端定义
interface SyncGroup {
  localPrimary: Backend;          // 本地主存储（配置组 fullFS / 数据组裸 primary）
  replicas: Backend[];            // 远端副本
  meta: '.meta/';                 // 通用：group.json / tombstones / versions / conflicts
  backends: '.meta/backends/';    // 该组自己的后端定义（权威）
  filter: SyncFilter;             // 差异只有这一处：配置组无 filter，数据组排除 .config/nodes/shared
}
```

**两个能力位互不蕴含**：

| 能力位 | 含义 | 配置组 | 数据组 |
|---|---|---|---|
| `configHost` | 能承载 `.config/`（数据组登记、引导副本、`group-type`），pair 同步整棵 `/` | ✅ | ❌ |
| `appData` | 能被登记为数据组，pair 排除 `/.config`、`/nodes`、`/shared` | ❌ | ✅ |

因此「配置组是数据组的超集」这一说法**不成立**：配置组多出「能当配置宿主」，数据组多出「能作为数据组被登记」。两者是同一基座的两个能力位。

> 实现层面当前仍是 `ConfigRepoImpl` / `AppDataGroupImpl` 两个类各写一份近似逻辑（历史上导致同一 bug 要修两遍，例如目录删除、`.keep`/`.mtime`）。合并为单一 `SyncGroup` 类**不在本轮范围**，记入 §9 后续演进。

---

## 1. 背景与现状

### 1.1 两套组的职责

| 维度 | 配置同步组（`ConfigRepoImpl`） | 数据同步组（`AppDataGroupImpl`） |
|---|---|---|
| 定位 | 配置仓库；数据组的**登记处与引导副本**（`configHost`）；节点配置发布 | 纯文件同步通道，承载应用数据（`appData`）；**自身后端拓扑的权威**来自 `.meta/backends/` |
| 生命周期入口 | `createConfigRepo()` / `connect()` 返回 `repo` | 由配置组 `createAppDataGroup()` 创建，`connect()` 恢复；独立顶层入口已标 `@deprecated`（[connect.ts#L58-L72](file:///C:/codes/nodejs/zen-fs-config/src/connect.ts#L58-L72)） |
| 本地主存储 | `resolveLocalPrimary(appId, 'config')`（浏览器 `IndexedDB`，Node 可选 `Folder`，否则 `InMemory`）([folder-backend.ts#L174-L206](file:///C:/codes/nodejs/zen-fs-config/src/folder-backend.ts#L174-L206)) | `resolveLocalPrimary(appId, 'data', { groupId })`；`default` 组沿用旧路径 `data/{appId}` 与旧库名 `zen-fs-config-data-{appId}`，**非 default 组按 groupId 隔离**：Node `data/{appId}/{groupId}`、浏览器 `zen-fs-config-data-{appId}-{groupId}` |
| 直接暴露的 fs | `repo.fs`（chroot）与 `repo.rootFS` | `group.fs`（chroot 到组根，[config-repo.ts#L2291-L2292](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L2291-L2292)） |
| 专属能力 | 配置读写、节点配置、冲突、版本、墓碑、拓扑、账户复用 | 仅 `fs` + 后端增删 + 同步状态 |

### 1.2 存储布局（当前事实）

**配置组**（远端根 `/`，路径常量见 [config-repo.ts#L51-L79](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L51-L79)）：

```
/
├─ .meta/
│  ├─ group.json                      # 统一组描述符 { schemaVersion:2, kind:'config', id, name?, features }
│  ├─ backends/{id}.json              # **权威后端描述符**（配置组与数据组统一位置）
│  ├─ backends.json                   # 更旧格式（pre-0.4.0，仅读迁移）
│  ├─ app-data-groups/{appId}/{id}.json   # 旧镜像（只读兼容，不再写）
│  ├─ tombstones/{encoded}.json       # 墓碑（删除状态的唯一凭据）
│  ├─ versions/...                    # 版本
│  └─ conflicts/...                   # 冲突归档
├─ .config/
│  ├─ group-type                      # 'config-sync'
│  ├─ backends/{id}.json              # 历史位置：**不再读取**，删除后端时尽力清理
│  ├─ config-sync-group.json          # 显示名
│  └─ app-data-groups/{appId}/{id}.json   # 数据组**登记 + 引导副本**（唯一写入位置）
├─ nodes/{nodeId}/...                 # 节点配置
├─ shared/...                         # 共享配置
└─ <app 配置数据>
```

**数据组**（每个组自己的本地主存储，同步到该组配置的远端副本）：

```
/
├─ .meta/
│  ├─ group.json                      # { schemaVersion:2, kind:'data', id, name?, features }
│  ├─ backends/{id}.json              # **权威后端定义**（随数据组同步）
│  ├─ tombstones/  versions/  conflicts/
├─ nodes/  shared/  .config/          # 不参与数据组同步（filter 排除）
└─ <用户数据>
```

数据组 pair 的 `filter.excludePrefixes = ['/.config', '/nodes', '/shared']`（[config-repo.ts#L89](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L89)），`.meta/` 保留在同步区；`group.fs` 仍隐藏并拒写 `.meta`、`.config`（隐藏 ≠ 不同步）。

> 版本 sidecar 不是目录，而是与数据文件同目录的 `<name>.version`（[version.ts#L19-L41](file:///C:/codes/nodejs/zen-fs-config/src/version.ts#L19-L41)）；墓碑文件名由路径编码：`/a/b.json` → `a__b++json.json`（[config-repo.ts#L94-L100](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L94-L100)）。

### 1.2.1 目录结构（权威关系与读取优先级）

**总览**

```
/
├─ .meta/                                # 两组共享的元数据（参与数据组同步）
│  ├─ group.json                         # 组自描述（kind / id / features）
│  ├─ backends/{id}.json                 # ★权威：所有组的后端描述符（配置组 + 数据组）
│  ├─ tombstones/{encodedPath}.json      # ★权威：删除状态（唯一凭据）
│  ├─ versions/{encodedPath}.json        # 数据组版本记录
│  ├─ conflicts/{conflictId}/            # 冲突归档
│  ├─ app-data-groups/{appId}/{id}.json  # 旧镜像：只读兼容，不再写入
│  ├─ backends.json                      # 更旧单文件拓扑：只读迁移
│  └─ .deleted/                          # 历史归档：不读不写，按普通内容对待
├─ .config/                              # 配置组专属（数据组 filter 排除）
│  ├─ group-type                         # 'config-sync' | 'data-sync'
│  ├─ config-sync-group.json             # 配置组显示名
│  ├─ app-data-groups/{appId}/{id}.json  # ★登记权威：数据组登记 + 引导副本
│  └─ backends/{id}.json                 # 历史位置：不再读取，删除后端时尽力清理
├─ nodes/{nodeId}/...                    # 节点配置（配置组）
├─ shared/...                            # 共享配置（配置组）
└─ <用户数据 / app 配置>
```

**职责与权威关系**

| 目录 / 文件 | 职责 | 权威？ | 读取优先级 | 参与数据组同步 |
|---|---|---|---|---|
| `.meta/backends/{id}.json` | 所有同步组的后端列表（含凭据） | ✅ 唯一权威 | 唯一来源，无回退 | 是 |
| `.config/backends/{id}.json` | 0.6.x 及更早的配置组后端位置 | ❌ 历史残留 | **不读** | 否 |
| `.meta/app-data-groups/{appId}/{id}.json` | 0.6.x 的数据组登记镜像 | ❌ 历史镜像 | 仅当 `.config` 那份缺失/损坏时回退读 | 是 |
| `.config/app-data-groups/{appId}/{id}.json` | 数据组登记 + 新设备引导 | ✅ 登记权威 | 优先读 | 否 |
| `.meta/tombstones/{encoded}.json` | 删除状态 | ✅ 唯一凭据 | 唯一来源，无回退 | 是 |
| `.meta/.deleted/` | 0.6.x 墓碑归档 | ❌ | **不读不写** | 是（作为普通内容） |
| `.meta/versions/`、`.meta/conflicts/` | 版本 / 冲突 | ✅ | 新路径优先，旧 `.conflicts` 回退 | 是 |

**读写规则**

- **后端**：写入只落 `.meta/backends/{id}.json`；删除后端时写 `.meta/tombstones/...` 墓碑并删该文件，同时对 `.config/backends/{id}.json` 残留做尽力 unlink（清不掉不影响正确性——读侧根本不依赖它）。
- **数据组登记**：写入只落 `.config/app-data-groups/...`；`.meta/app-data-groups/...` 只读，用于兼容旧布局，并保证「只在 `.meta` 存在的坏描述符」仍能按 groupId 定位并删除。
- **墓碑**：写入只落 `.meta/tombstones/`；`.meta/.deleted/` 既不读也不写，历史文件按普通内容对待。
- **迁移**：不做懒迁移。`/.config/backends/` 中的旧条目不参与后端枚举，需要时由用户在 Backends 页重新添加（见 README / 手工重加指引）。

### 1.3 pair 构建方式

| | 配置组 | 数据组 |
|---|---|---|
| 源 | `this.fullFS`（本地 primary + 缓存 overlay） | 该组 `localFS` |
| 目标 | 每个副本后端（可包 `CachedFileSystem`） | 每个数据后端 |
| 方向 | `BiDirectional` | `BiDirectional` |
| 过滤器 | **无**（整棵 `/` 参与同步，含 `.meta`） | `excludePrefixes`（目标改为排除 `/.config`、保留 `.meta`，见 §4.1） |
| 墓碑钩子 | `preSyncHook` / `postSyncHook` 跑 `processTombstones()` | **无** |
| 冲突 | 注册冲突归档处理器 + `conflictStrategy: 'source-wins'` | 仅 `conflictStrategy: 'source-wins'`，无归档 |
| 时序 | 先 `syncAll()`，再 `watch` | 先 `syncAll()`，再 `watchAll()`（[#L2341-L2349](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L2341-L2349)） |

证据：[config-repo.ts#L1110-L1136](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L1110-L1136)、[#L1140-L1143](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L1140-L1143)、[#L2308-L2323](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L2308-L2323)。

### 1.4 墓碑 / 版本 / 冲突的现状差异（核心差距）

| 能力 | 配置组 | 数据组 |
|---|---|---|
| 墓碑 | 显式墓碑文件 `/.meta/.deleted/*.json`，`TombstoneMeta { path, deletedAt, deletedBy, confirmedBy }`（[types.ts#L54-L63](file:///C:/codes/nodejs/zen-fs-config/src/types.ts#L54-L63)）；`deleteFile()` 写墓碑 + 删主文件 + 删 sidecar + 触发后台同步（[#L488-L532](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L488-L532)）；同步前处理、全副本确认后 GC（[#L598-L669](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L598-L669)、[#L885-L919](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L885-L919)） | **无**。删除只靠 zen-fs-sync 内存快照差异，进程重启即失效（本轮前序调查结论） |
| 版本 | 每次写配置后 `incrementVersion` + `writeVersionSidecar`（[#L1168-L1187](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L1168-L1187)），用于冲突判定与人工恢复 | **无**（`group.fs` 是纯 chroot，未包版本层） |
| 冲突 | 归档到 `/.meta/.conflicts/`，提供 `listConflicts()` / `resolveConflict()` / `readConflictBackup()`（[types.ts#L449-L459](file:///C:/codes/nodejs/zen-fs-config/src/types.ts#L449-L459)、[config-repo.ts#L1245-L1260](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L1245-L1260)） | **无**归档、无接口（`AppDataGroup` 接口仅 300-341 行所列方法） |
| 删除接口 | `deleteFile()`（[types.ts#L487-L492](file:///C:/codes/nodejs/zen-fs-config/src/types.ts#L487-L492)） | 只能 `fs.unlink()`，且 chroot 是透传，不写墓碑（[context-fs.ts#L101-L103](file:///C:/codes/nodejs/zen-fs-config/src/context-fs.ts#L101-L103)） |
| 清理工具 | `purgeMtimeSidecars` / `purgeKeepFiles`（[#L727-L757](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L727-L757)） | 仅在 `init()` 内部自动调用，不对外暴露（[#L2264-L2289](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L2264-L2289)） |
| 后端状态 | 无 `getBackendSyncStates()` | 有 `getBackendSyncStates()`，可表达“描述符存在但连接失败”（[#L2371-L2373](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L2371-L2373)、[types.ts#L287-L297](file:///C:/codes/nodejs/zen-fs-config/src/types.ts#L287-L297)） |

> 说明：`deleteFile()` 与 `fs.unlink` 的关系在需求层已有目标态——FR9.1 要求“删除经标准 `fs.unlink`，chroot fs 内置墓碑逻辑，不再单独暴露 `deleteFile`”（[REQUIREMENTS.md#L153-L159](file:///C:/codes/nodejs/zen-fs-config/REQUIREMENTS.md#L153-L159)），与本次需求“`SyncGroupHandle` 需包含带墓碑的 `deleteFile`”存在**形态差异**。本文按 R3 保留 `deleteFile`，并要求二者共用同一墓碑实现；口径见 §7.2。

### 1.5 类型层面的现状

- `IConfigRepo`：约 40 个方法，其中配置专属占主体（[types.ts#L409-L599](file:///C:/codes/nodejs/zen-fs-config/src/types.ts#L409-L599)）。
- `AppDataGroup`：仅 `fs`、状态、`flush`、`dispose`、`addBackend/removeBackend/listBackends`（[types.ts#L300-L341](file:///C:/codes/nodejs/zen-fs-config/src/types.ts#L300-L341)）。
- 命名不对称：`updateConfigSyncGroupDescriptor(name)`（无 id）vs `updateAppDataGroupName(id, name)`；`replaceBackend` vs `replaceAppDataGroupBackend`。
- **接口泄漏**：`updateAppDataGroupDescriptor` 是实现类方法、`IConfigRepo` 未声明，UI 只能本地强造型绕过（[api.ts#L31-L39](file:///C:/codes/nodejs/zen-fs-config-ui/src/core/api.ts#L31-L39)）。

---

## 2. 已确认需求

| ID | 需求 | 说明 |
|---|---|---|
| R1 | 配置组与数据组**都具备** tombstones / versions / conflicts | 与 REQUIREMENTS §9 D2 决策 C 一致（[#L202](file:///C:/codes/nodejs/zen-fs-config/REQUIREMENTS.md#L202)） |
| R2 | 配置组是数据组的**能力超集**：额外承载 app 配置、节点配置、组描述符 | 配置载荷 = app 配置 + `/nodes` + `/shared` + `app-data-groups` + `backends` |
| R3 | `SyncGroupHandle` 必须包含 `listConflicts` / `resolveConflict`、带墓碑的 `deleteFile`、`purgeMtimeSidecars` / `purgeKeepFiles` | 这三类能力将成为**两种组的通用能力**，不再是配置专属 |
| R4 | 现有数据组 `basePath` 保持可用（不强制搬到 `groups/<groupId>`） | 已确认保留；组根 = 用户配置 basePath（§3） |
| R5 | 元数据（墓碑/版本/冲突）必须能跨设备生效 | 用户明确“两组都要”；元数据统一放在 `.meta/` 通用区并进入可同步区（§4.1） |

---

## 3. 候选远端布局

### 3.1 目标布局（推荐）

```
<basePath>/                            # 用户配置的远端根（Gitee rootPath / RemoteStorage basePath / WebDAV 目录）
├─ .meta/                              # 所有组通用的元数据区（可同步）
│  ├─ group.json                       # { schemaVersion, kind, groupId? }；kind: 'config' | 'data'
│  ├─ tombstones/{encodedPath}.json    # 墓碑（原 /.meta/.deleted）
│  ├─ versions/{encodedPath}.version   # 版本（原与文件同目录的 <name>.version）
│  └─ conflicts/{conflictId}/          # meta.json + source + target (+ resolved)（原 /.meta/.conflicts）
├─ .config/                            # 仅 config 组：配置专属管理元数据（不随数据组同步）
│  ├─ group-type                       # 'config-sync'
│  ├─ backends/{backendId}.json        # 拓扑 / 账号（含凭据）
│  ├─ config-sync-group.json           # 配置组显示名
│  └─ app-data-groups/{appId}/{groupId}.json   # 数据组描述符
├─ nodes/  shared/                     # 仅 config 组：配置内容（路径语义保持不变）
└─ <用户数据 / app 配置>                # data 组根；config 组的 app 配置也在此
```

**路径归属表**

| 路径 | 归属 | 权威？ | 是否参与数据组同步 | 说明 |
|---|---|---|---|---|
| `.meta/group.json` | 通用（每个组各一份） | ✅ 本组自描述 | 是 | `{ schemaVersion, kind, id, name?, features }`；**不写 `updatedAt`** |
| `.meta/backends/{id}.json` | 通用（每个组各一份） | ✅ **唯一权威** | 是 | 配置组与数据组共用同一位置 |
| `.config/backends/{id}.json` | 历史位置（0.6.x 及更早） | ❌ 残留 | **否** | 不再读取，仅删除时尽力清理 |
| `.config/app-data-groups/{appId}/{id}.json` | 配置组专属 | ✅ 登记权威 | **否** | 登记 + 新设备引导；`backends` 字段长期保留 |
| `.meta/app-data-groups/...` | 配置组专属（旧镜像） | ❌ | 否 | 只读兼容，不再写入 |
| `.meta/tombstones`、`.meta/versions`、`.meta/conflicts` | 通用 | ✅ | **是** | 两组都需要的跨设备删除/版本/冲突依据 |
| `nodes/`、`shared/` | 配置组专属（内容） | — | 否 | 由配置 API 读写，用户可见 |
| `<用户数据>` | 数据组 | ✅ | 是 | 产品层 `group.fs` 的可见范围 |
| `<app 配置>` | 配置组（内容） | — | 否 | 现状不变 |

**`.meta/group.json` schema（v2）**

```jsonc
{
  "schemaVersion": 2,
  "kind": "config" | "data",
  "id": "config" | "<groupId>",
  "name": "<显示名，可选>",
  "features": { "tombstones": true, "versions": false, "conflicts": false, "configHost": true, "appData": false }
}
```

- 写入幂等：规范化字节与磁盘相同则**零写入**；连续两次打开不会产生变更。
- `updatedAt` 为 deprecated 字段：0.6.0 起不写，读侧忽略；旧文件在下一次内容变化时被就地升级为 v2。
- 不写 `syncedAt` / `lastSyncAt` / `lastError` 之类的诊断信息 —— 它们只存在于本地状态或运行时内存（§4.4）。

**为什么选 `.config/` 而不是 `.meta/config/`**

1. `.meta` 保持“纯通用”，数据组不必理解 config 概念；两组共享同一套元数据语义。
2. 过滤规则简单且不易回归：数据组 `excludePrefixes = ['/.config', '/nodes', '/shared']`，`.meta` 完全保留。若采用 `.meta/config`，排除项虽可写成 `.meta/config`，但一旦有人（或旧代码）把 `.meta` 整棵排除，墓碑就会再次被挡掉——现有代码正是整棵排除（[#L89](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L89)）。
3. 迁移是“整棵子树搬迁 + 旧路径回退”，边界清晰；`.meta/config` 需要在 `.meta` 内部重排，容易与 `tombstones/versions/conflicts` 的改名叠加，回退分支更复杂。
4. 安全边界：`backends` 含 token 等凭据，与通用元数据分区，便于后续单独脱敏/加密/按需禁用同步。

> `.meta/config/` 作为备选保留在 §7.1 D1；若评审认为“所有元数据都应在 `.meta` 下”，可切换到该形态，但过滤与迁移方案不变。

### 3.2 不采用 `groups/<groupId>`

```
<basePath>/groups/{groupId}/...
```

原因：

1. **迁移成本高且不可中断**：所有既有远端路径都要移动；Gitee 是逐文件 commit，RemoteStorage 需重新 PUT，WebDAV 需 MOVE。任一文件失败即出现“半迁移”状态，而同步引擎会把缺失文件当删除/新增（前序调查已确认无持久化删除记忆）。
2. **用户可见结构改变**：用户在 Gitee/网盘里会多出一层 `groups/<id>`，与“组根就是应用数据目录”的产品语义冲突。
3. **类型探测要重写**：`connect()` 依赖读取 `/.meta/group-type`（[connect.ts#L21-L56](file:///C:/codes/nodejs/zen-fs-config/src/connect.ts#L21-L56)、[#L84-L144](file:///C:/codes/nodejs/zen-fs-config/src/connect.ts#L84-L144)）；改为遍历 `groups/*/group.json` 后，旧数据无法被识别。
4. **与需求定义冲突**：FR0/FR1/FR2 把差异定义为“是否承载 `app-data-groups`”，而不是“路径前缀”（[REQUIREMENTS.md#L67-L90](file:///C:/codes/nodejs/zen-fs-config/REQUIREMENTS.md#L67-L90)）。

**例外**：若确实需要“多个数据组共享同一个 basePath”，应通过**显式** `subPath` 选项（用户显式填写），并在 `addBackend` 做归属校验（§4.3），而不是由系统隐式追加 `groupId`。

### 3.3 备选记录（不推荐）

曾考虑引入独立通用元数据目录 `.group-meta/` 替代 `.meta/`，以区分配置专属内容。但该方案需要全量搬迁现有元数据，收益仅为命名清晰，因此**不再作为推荐项**，仅保留此记录以便追溯。

### 3.4 推荐结论

采用 **§3.1 布局**（同根 + 通用 `.meta/` + 配置专属 `.config/`），并把“同根多组”限制为**不允许**（见 §4.3 校验）；需要隔离时用显式 `subPath`。

---

## 4. 关键约束与风险

### 4.1 数据组过滤规则必须调整（最高优先级）

事实：数据组 pair 的 filter 排除了整个 `/.meta`（[#L89](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L89)、[#L2313-L2323](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L2313-L2323)），而 zen-fs-sync 的快照会用同一 filter 过滤两侧（[utils.ts#L52-L85](file:///C:/codes/nodejs/zen-fs-sync/src/utils.ts#L52-L85)）。因此“把墓碑写进 `.meta` 并指望它同步出去”在现有配置下**不可能生效**——这正是统一前必须先改规则的原因。

**目标规则**

```ts
// 数据组 pair
filter: {
  excludePrefixes: ['/.config', '/nodes', '/shared'],
  // 不再排除 /.meta；墓碑/版本/冲突必须进入可同步区
}
```

配套约束：

- **不能只是“删掉 `/.meta` 排除项”**：那样数据组会把配置专属的 `.config`（含 `backends` 凭据）以及配置内容一起拉进来；必须显式排除 `.config`、`nodes`、`shared`。
- **可见性与同步分离**：`group.fs`（chroot 视图）隐藏并拒写 `.meta` 与 `.config`，避免应用读到墓碑、覆盖元数据；但 **sync filter 不排除 `.meta`**。二者不能再用同一份 `excludePrefixes` 表达。
- **配置组 pair 保持不变**（无 filter、整棵 `/` 同步）：`.config` 与 `.meta` 都会同步到配置副本，与现状 `.meta` 的行为一致（[#L1110-L1136](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L1110-L1136)）。
- `.meta` 是否对应用可见属于 **chroot 层**行为，不改同步快照；否则“隐藏”会再次变成“不同步”。

> 推断（未运行验证）：该改动会让数据组远端多出 `.meta/`（墓碑/版本/冲突），需要逐个后端确认 `readdir` 不会把它当用户数据；同时需要验证 `.meta` 与 `<用户数据>` 同名冲突的极端情况（例如用户数据里已有 `.meta` 目录）。

### 4.2 `fullFS` 与裸 primary 不宜合并

- 配置组用 `this.fullFS` 作为 pair 源（[#L1110-L1112](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L1110-L1112)），其中含缓存 overlay；数据组用该组 `localFS`（[#L2291-L2292](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L2291-L2292)）。
- 合并会让数据组继承“缓存优先读取”的语义，改变离线行为与冲突判定；同时缓存键空间存在串味风险。
- 建议：**保留各自 primary**（与 D2 决策 E 一致，[REQUIREMENTS.md#L204](file:///C:/codes/nodejs/zen-fs-config/REQUIREMENTS.md#L204)），只统一能力层。

### 4.3 跨组唯一性校验缺失

事实：配置组按 `type + options` 去重（[#L1617-L1619](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L1617-L1619)）；数据组只按 `id` 去重（[#L2382-L2384](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L2382-L2384)）；**没有任何地方校验“同一 basePath 是否已被其他组占用”**。

风险：同根两组会互相覆盖 `.meta`（墓碑/版本/冲突）与 `.config`；若两组都开启墓碑，还会互相 GC 对方的墓碑。由于本次把 `.meta` 变为“通用可同步区”，该风险比之前更直接。
建议：`addBackend` / `createAppDataGroup` / `connect()` 增加“basePath 归属表”（可落在本地配置描述符中），冲突时拒绝并提示复用已有组或指定 `subPath`。

### 4.4 迁移风险（配置专属内容 → `.config/`，元数据子目录改名，版本 sidecar 集中化）

**需要搬迁的路径**

| 旧路径 | 新路径 | 说明 |
|---|---|---|
| `/.meta/backends.json`（pre-0.4.0 单文件） | `.meta/backends/{id}.json` | 启动时一次性迁移，迁完删旧文件 |
| `/.meta/app-data-groups/{appId}/{id}.json` | `.config/app-data-groups/{appId}/{groupId}.json` | 数据组引导副本（旧路径只读） |
| **（新增）数据组 `/.meta/backends/`** | **数据组自身 `/.meta/backends/{id}.json`（权威）** | 旧版本从不写它；首次启动从配置组引导副本**懒迁移回填**，不搬文件 |
| `/.meta/group-type` | `.config/group-type` | `connect()` 类型探测依赖 |
| `/.meta/config-sync-group.json` | `.config/config-sync-group.json` | 配置组显示名 |
| `/.meta/.deleted/*.json` | `.meta/tombstones/*.json` | 已完成改名；0.7 起旧目录既不读也不写，历史文件留存 |
| `/.meta/.conflicts/*` | `.meta/conflicts/*` | 仅改名 |
| `<file>.version`（与数据文件同目录） | `.meta/versions/{encodedPath}.version` | 路径语义变化，**必须双读回退** |

**迁移顺序（数据组自描述，已在 0.6.0 实现）**

1. `AppDataGroupImpl.init()` 先读**自己的** `.meta/backends/`；
2. 目录不存在（旧版本从未写过）→ 用配置组 `.config` 描述符里的 `backends` 回填，并写入数据组；
3. 目录存在（哪怕为空）→ 以数据组为准，**不再信任**引导副本；
4. 回刷引导副本时按规范化字节比较，相同则不写；`backends` 字段长期保留（不做清理）。

**具体风险**

- 版本 sidecar 集中化后，读取必须“先新路径、后旧 sidecar”；否则版本判定会重置，冲突策略退化为 `source-wins`（旧 sidecar 还在，但新代码读不到）。
- `.meta/backends` 是同步拓扑与登录凭据的唯一来源。0.7 起 `.config/backends` 不再读取：未迁移的旧部署升级后需在 Backends 页重新添加后端（凭据需重新填写）。
- `.meta` 在部分后端（Gitee）是逐文件 API；搬迁需要幂等、可重入、可断点续跑，并处理“搬到一半失败”的中间态。
- 半迁移态下同步引擎会把缺失文件当删除/新增（删除判定依赖内存快照，无持久化记忆），可能造成重复上传或误删。

**迁移与回退策略**

1. 读取顺序统一为“新路径 → 旧路径回退”，所有迁移项都必须有回退分支（先新后旧）。
2. 写入采用“一个发布周期双写（旧+新）”，再切默认，再清理旧路径。
3. 迁移工具按“读兼容（双读）→ 双写 → 切换默认 → 删除旧路径”四步实施；任一步失败可回退。
4. **兼容性边界（明确）**：原有代码“直接用”只适用于 `.meta` 的**通用部分**（墓碑/版本/冲突的语义与位置）；配置专属路径仍要迁移并保留读回退，**不能宣称零改动兼容**。

> 说明：`.meta/.deleted` → `.meta/tombstones`、`.meta/.conflicts` → `.meta/conflicts` 是可选改名；若希望进一步降低迁移面，可保留旧子目录名（见 §7.1 D2 的实施范围）。

### 4.5 多设备离线删除

- 删除依赖墓碑 + GC；GC 的确认集合只覆盖“当前已注册副本”，离线副本不在集合内（[#L842-L874](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L842-L874)、[#L885-L919](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L885-L919)）。
- 数据组启用墓碑后，体量更大（每个删除 = 一个墓碑文件），GC 与对账成本上升；同时“离线端后重连回传”的风险放大。
- 需要：墓碑保留期（`tombstoneTtl`）与“最后确认时间”策略；删除与修改并发时“删除胜出”的语义要显式记录（当前同步引擎删除分支不比较 mtime/内容，见前序调查）。

### 4.6 数据组开启版本/冲突后的写入放大

- 版本集中到 `.meta/versions/` 后，每个数据文件写操作会多一次远端 PUT/GET（元数据文件），Gitee 是 commit-per-write，成本明显。
- 版本目录必须参与数据组同步（否则冲突判定跨设备失效），因此不能像 `.config` 那样排除；这会增加数据组副本的元数据体量。
- 冲突归档要求“同版本不同哈希”判定，前提是版本 sidecar 完整；数据量大时建议：按需开启（`features.versions`）、或批量/延迟写 sidecar（需同步引擎支持，属新增能力）。

---

### 4.7 变更判定（陈旧判定）字段与白/黑名单

**结论：只用内容派生的投影字节比较，不持久化任何哈希 / revision / 时间戳。**

为什么不能用时间戳或递增计数器：

1. **会成环**：把 `updatedAt` / `syncedAt` / `backendsRevision` 写进随同步走的内容，写入本身就让内容变化 → 触发对端同步 → 对端再写一次 → 无限抖动/写放大。现状 `group.json` 每次 `init()` 写 `Date.now()` 就是这个 bug，已在 0.6.0 修掉。
2. **哈希也会自指**：若哈希被纳入自身计算输入，则「写哈希 → 内容变 → 哈希变 → 再写」同样成环。因此**不持久化哈希**；若未来因诊断需要保留 `backendsRevision`，必须排除该字段自身，并写明「哈希是 `backends[]` 的纯函数，不是文件的函数」。
3. **计数器双向互抬**：双向同步下两端各自 +1，永远无法收敛。

**判定方式**：把候选描述符规范化序列化后，与目标文件现有内容**逐字节比较**，相同则不写。写入前 `createdAt` 取 `min(existing, incoming)`，保证时间戳不会在两端抖动。规范化必须跨设备确定（固定 key 顺序、`backends` 按 id 排序、`options` 递归排序、不做本地化/Unicode 归一化），否则会出现「语义相同、字节不同」的互刷。

**可以进同步内容（白名单）**

| 字段 | 位置 | 说明 |
|---|---|---|
| `schemaVersion` / `kind` / `id` / `name` / `features` | `.meta/group.json` | 语义字段 |
| `id` / `type` / `options` / `description` / `accountBackendId` | `.meta/backends/*.json`、`.config/app-data-groups/*.json` | 拓扑与凭据（独立模式凭据内联，不做脱敏） |
| `createdAt` | 后端描述符 | 仅用于同远端去重「保留最老者」；不参与判定，合并取 `min` |

**不得进同步内容（黑名单）**

| 字段/信息 | 正确位置 |
|---|---|
| `updatedAt`（语义为「最近一次写/同步时刻」） | 本地存储或运行时内存；`GroupDescriptor.updatedAt` 已 deprecated |
| `syncedAt` / `lastSyncAt` | 本地状态（IndexedDB / `localStorage` / 本地-only 目录） |
| `lastError` / 同步耗时 / 最后成功时间 | 运行时内存（`getBackendSyncStates()`）或本地状态 |
| `backendsRevision` / 任何全局版本号 / 内容哈希 | **不落盘** |

> 本地-only 目录若存在，必须同时在 pair 的 `excludePrefixes` 与 chroot 的 `hiddenPrefixes` 中，确保既不参与同步、也不对应用可见。

---

## 5. `SyncGroupHandle` 接口草案

### 5.1 设计原则

- **`kind` 是结构判别符**（`'config' | 'data'`），驱动 `connect()` 路由与 UI 卡片类型。
- **`features` 是能力开关**，由 `kind` + 组描述符中的 `capabilities` 推导，**不单独持久化**（避免两份真相）；用于 UI 控制“是否显示冲突/版本入口”。
- common 方法 = 两种组都具备的能力（含本次新增的墓碑/版本/冲突/purge）。
- config 扩展 = 配置载荷与节点配置（超集部分）。

### 5.2 草案

```ts
export type SyncGroupKind = 'config' | 'data';

export interface SyncGroupFeatures {
  tombstones: boolean;
  versions: boolean;
  conflicts: boolean;
  /** 是否承载 app 配置 / 节点配置 / 组描述符（= kind==='config'） */
  configHost: boolean;
  /** 是否允许作为 app 数据目录被产品层直接读写（数据组恒 true） */
  appData: boolean;
}

export interface SyncGroupHandle {
  readonly groupId: string;
  readonly appId: string;
  readonly kind: SyncGroupKind;
  /** 派生值，不落盘 */
  readonly features: SyncGroupFeatures;
  /** 用户可编辑显示名 */
  readonly name?: string;

  /** 组视图（隐藏 `.meta` 与 `.config`，拒写元数据路径） */
  readonly fs: typeof import('node:fs');

  // --- 同步生命周期 ---
  getSyncStatuses(): Map<string, SyncPairStatus>;
  getBackendSyncStates(): Map<string, BackendSyncState>;   // 配置组当前缺失，需补齐
  flush(): Promise<SyncResult[]>;
  dispose(): Promise<void>;

  // --- 后端管理 ---
  addBackend(id: string, type: string, options: Record<string, unknown>, description?: string): Promise<void>;
  removeBackend(id: string): Promise<void>;
  listBackends(): AppDataBackendDescriptor[];
  rename(name: string): Promise<void>;

  // --- 删除与元数据（R3 通用能力） ---
  /** 写墓碑（`.meta/tombstones/{encoded}.json`）+ 删除文件 + 删除版本记录 + 触发后台同步 */
  deleteFile(path: string): Promise<void>;
  listConflicts(): Promise<ConflictArchive[]>;
  resolveConflict(conflictId: string, mergedContent: unknown): Promise<void>;
  readConflictBackup(conflictId: string, fileType: 'source' | 'target' | 'resolved'): Promise<string>;
  purgeMtimeSidecars(options?: { root?: string; dryRun?: boolean }): Promise<MtimePurgeResult>;
  purgeKeepFiles(options?: { root?: string; dryRun?: boolean }): Promise<KeepPurgeResult>;
}

/** 配置组：SyncGroupHandle 的超集 */
export interface ConfigSyncGroupHandle extends SyncGroupHandle {
  readonly kind: 'config';
  readonly features: SyncGroupFeatures & { configHost: true };

  load(rawConfig: string): Promise<void>;
  setConfig(path: string, data: unknown): void;
  setNodeConfig(nodeId: string, path: string, data: unknown): Promise<void>;
  publishNodeConfig(nodeId: string, options?: { root?: string }): Promise<void>;
  peekNodeConfig<T = unknown>(nodeId: string, path: string): Promise<T>;

  getBackends(): Promise<BackendsMeta | null>;
  updateBackends(meta: BackendsMeta): Promise<void>;
  syncMetaToReplicas(): Promise<void>;
  ensureGroupType(type: 'config-sync' | 'data-sync'): Promise<void>;
  getGroupType(): Promise<'config-sync' | 'data-sync' | null>;

  // 数据组纳管（返回值改为通用句柄，UI 不再区分类型）
  createAppDataGroup(id: string, backends: AppDataBackendDescriptor[]): Promise<SyncGroupHandle>;
  getAppDataGroup(id: string): Promise<SyncGroupHandle>;
  listAppDataGroups(): Promise<AppDataGroupDescriptor[]>;
  removeAppDataGroup(id: string): Promise<void>;
}

/** 统一入口：连接结果不再只有 repo/dataGroup 两个互斥字段 */
export interface ConnectResult {
  groupType: 'config-sync' | 'data-sync';
  /** config 组（若远端本身是 data-sync，则为本地-only 的宿主组） */
  configGroup: ConfigSyncGroupHandle;
  /** 全部组（config 组在前；数据组按描述符顺序） */
  groups: SyncGroupHandle[];
  dataGroup?: SyncGroupHandle;   // 兼容字段：默认数据组
}
```

### 5.3 兼容与适配

- `ConfigRepo` 继续作为 `ConfigSyncGroupHandle` 的实现（现方法大多已具备），只需要：
  - 新增 `kind` / `features` / `groupId`（固定 `'config'`）/ `rename()`；
  - 新增 `getBackendSyncStates()`；
  - 补齐 `listConflicts` 等在 handle 上暴露（现已存在）。
- `AppDataGroupImpl` 实现 `SyncGroupHandle`，需要新增：
  - `kind='data'`、`features`、`name`；
  - 墓碑/版本/冲突存储与接口（Phase 0 的核心工作）；
  - `rename()`（现由父组 `updateAppDataGroupName` 承担）。
- `dir-struct-gen` 现有的 `d.dataGroup.fs` 契约保持不变（[app.js#L1660-L1667](file:///C:/codes/nodejs/FluentOS-On-Web/dir-struct-gen/app.js#L1660-L1667)），`connect()` 保留 `repo` + `dataGroup` 兼容字段至少一个版本。
- **路径兼容**：配置组内部对 `.config/*` 的读取必须回退到旧 `/.meta/*`；`.meta/tombstones|conflicts` 的读取回退到 `.meta/.deleted|.conflicts`；版本读取回退到旧 `<file>.version`（§4.4 清单）。句柄接口不变，但底层路径解析必须是“新 → 旧”。
- **能力补齐后**：配置组也实现 `listConflicts` / `resolveConflict` / `deleteFile`（已存在）/ `purge*`（已存在）；数据组补齐这些方法后，UI 才可用 `features` 统一驱动。

---

## 6. 分阶段落地顺序

### Phase 0 — 补能力（不改模型）

| 工作 | 可验证点 |
|---|---|
| 配置组新增 `getBackendSyncStates()` | 构造一个选项非法（缺 token）的副本描述符：它出现在 `getBackendSyncStates()` 且 `error` 非空，且**不**出现在 `getSyncStatuses()`（与 [types.ts#L287-L297](file:///C:/codes/nodejs/zen-fs-config/src/types.ts#L287-L297) 语义一致） |
| 抽出共用 `TombstoneStore` / `VersionStore` / `ConflictStore`（从 `ConfigRepoImpl` 内部逻辑下降） | 配置组行为零回归：现有 `dedup-fix` 墓碑用例全绿 |
| 数据组接入三者，按 `capabilities` 开启 | 数据组 `deleteFile()` 后在本地生成墓碑文件；其它副本 `flush()` 后文件消失且**不复活**（跨设备验证） |
| 数据组暴露 `purgeMtimeSidecars` / `purgeKeepFiles` | 手工 `dryRun` 能列出泄漏 sidecar；`options.root` 生效 |
| 数据组冲突归档 | 两端同 path 不同内容 → `.meta/conflicts/` 出现 `meta.json` + `source` + `target`；`listConflicts()` 可读 |

### Phase 1 — 统一模型与描述符

| 工作 | 可验证点 |
|---|---|
| `SyncGroupHandle` / `ConfigSyncGroupHandle` 落地；`connect()` 增加 `groups` | 单测：同一份 data-sync 远端 `connect()` 后 `groups[0].kind='config'`（本地-only）、`groups[1].kind='data'` |
| 描述符 v2：`.meta/group.json`（通用）+ `.meta/backends/*.json`（**配置与数据统一**） | `/.meta/backends.json` 仍可读（一次性迁移）；`.config/backends/*` 不再读取也不写入；`getGroupType()` 优先读 `.config/group-type`、回退 `/.meta/group-type` |
| **数据组自描述（0.6.0 已完成）**：数据组写自己的 `.meta/backends/{id}.json` 并作为权威；配置组描述符降级为引导副本；删除写墓碑；冲突墓碑优先 | 单测 `data-group-self-description.test.ts`：写入、懒迁移回填、墓碑裁剪、重复打开字节不变 |
| **规范化序列化 + 幂等写（0.6.0 已完成）**：`serialize(parse(bytes)) === bytes`；构造顺序无关；投影相同零写入 | 单测同上；`updatedAt` 不再出现在 `group.json` |
| 统一命名 API：`rename()`、`replaceBackend(id, type, options)` | 配置组与数据组同签名；UI 不再有两条改名路径 |
| 跨组 basePath 归属校验 | 同一 Gitee repo+rootPath 第二次接入被拒绝，错误信息指明已有组 id |

### Phase 2 — UI 收敛

| 工作 | 可验证点 |
|---|---|
| `configurator` 的 `configBackends / dataGroups / dataBackends` 三份状态 → 单一 `groups` | 组件只渲染一张组卡片列表；`kind`/`features` 驱动按钮（配置组显示节点/冲突入口，数据组不显示 config 专属入口） |
| 移除 `GroupMode` 的 `config-sync`/`data-sync` 分支（保留 `initial`） | 现有 `configurator` 中 `data-sync|dataGroup|dataGroups` 约 47 处分支（[configurator.ts](file:///C:/codes/nodejs/zen-fs-config-ui/src/core/configurator.ts)）收敛为 ≤10 处 |
| 产品层回归 | `dir-struct-gen` 不改代码即可启动、读写、同步（`app.js#L1660-L1667` 路径不变） |

### Phase 3 — 迁移与清理

| 工作 | 可验证点 |
|---|---|
| 配置专属元数据迁移：`/.meta/{backends,app-data-groups,group-type,config-sync-group.json}` → `.config/`；`/.meta/.deleted` → `.meta/tombstones`、`/.meta/.conflicts` → `.meta/conflicts`、`<file>.version` → `.meta/versions`（迁移工具：双读 → 双写 → 切换 → 清理） | 用旧版本创建的远端在新代码下打开：配置、节点、冲突、墓碑、版本全部可达；迁移中断后重跑幂等；任一阶段可回退到旧路径 |
| 数据组 `excludePrefixes` 改为 `['/.config','/nodes','/shared']`（`.meta` 入同步，fs 视图隐藏） | 两台设备离线删除场景：A 删文件 → B 上线 → B 文件消失且不复活；A 从未拿到 `.config` 中的凭据 |
| 清理旧路径与 `@deprecated` 导出 | `dist` 构建通过；`vitest` 全绿；`npm run build` 全目标通过 |

---

## 7. 待决策项

### 7.1 待决策（仅两项）

| ID | 议题 | 选项 | 建议 | 影响 |
|---|---|---|---|---|
| D1 | 配置专属目录用哪个名字 | A `.config/`；B `.meta/config/` | **A `.config/`**：`.meta` 保持纯通用、数据组过滤规则简单、凭据与通用元数据分区（§3.1） | 名字写入常量，影响 §3.1 布局、§4.1 过滤规则、§4.4 迁移清单与 Phase 3；选 B 需在 `.meta` 内重排且回退分支更复杂 |
| D2 | 迁移是否一次性完成（以及改名范围） | A 一次性；B 双读/双写分版本；可选：是否同时把 `.deleted→tombstones`、`.conflicts→conflicts`、版本集中到 `.meta/versions` | **B 双读/双写**，至少一个发布周期；改名项可按需缩小范围（仅搬迁配置专属目录、保留旧子目录名） | 一次性失败无法回退；改名项越多，回退分支与验证面越大 |

### 7.2 已确认，不作为决策项

- **`basePath`**：保留现状，组根 = 用户配置 basePath，不新增 `groups/<groupId>`（§3.2）。
- **墓碑/版本/冲突跨设备同步**：已确认两组都要，因此 `.meta` 通用区必须进入同步，数据组 filter 必须放行 `.meta`（§4.1）。
- **`.group-meta/` 方案**：不再作为推荐项，仅在 §3.3 保留一句备选记录。
- **删除接口形态**：R3 要求 `SyncGroupHandle` 暴露带墓碑的 `deleteFile()`；FR9.1 的目标态是“`fs.unlink` 内置墓碑、不再单独暴露 `deleteFile`”。两者**共用同一墓碑实现**，handle 先保留 `deleteFile`，`unlink` 内置墓碑作为后续演进；这是实现口径，不新增架构决策。
- **数据组是否默认开启 versions/conflicts**：R1 的“具备能力”按“能力可用 + 可配置开启”理解；默认关（写入放大，§4.6），配置组恒开。若评审要求默认全开，需要重新评估成本。

---

## 8. 限制与未验证项

1. **本方案无任何现有测试覆盖**：`SyncGroupHandle`、`.config/` 布局、数据组墓碑/版本/冲突均为新增设计；现有用例只覆盖配置组墓碑（`dedup-fix`）与组类型探测（`group-type`）。
2. **代码推断（未运行验证）**：
   - 数据组开启墓碑后与 `excludePrefixes` 的交互（§4.1）——需要最小集成用例（两个组 + 三台设备）验证。
   - GC 与离线副本的竞态（§4.5）——需模拟“副本离线 → 删除 → GC → 副本上线”。
   - 迁移工具在 Gitee 逐文件 commit 下的中断恢复行为。
3. **未覆盖的后端差异**：RemoteStorage 的目录清单缓存（`patchDirListingEntry`）、Gitee 的 `.mtime` 侧车联动删除（`remove()` 内删 sidecar）、WebDAV 的 manifest `removed` 字段——三者对 `.meta`（可见性/清理）与 `.config`（隐藏与拒写）的策略需逐个核对。
4. **性能未评估**：数据组启用版本 sidecar 后的请求放大，以及墓碑数量增长对 `processTombstones()` 的扫描成本（当前每次 `flush` 全量扫描）。
5. **删除接口口径已按 §7.2 收敛**：`deleteFile()` 与 `fs.unlink` 内置墓碑共用同一实现；若实现分叉，会出现“两套删除语义”（显式删除才写墓碑、直接 unlink 不写）。
6. **兼容性范围（再次明确）**：原有代码“直接用”只适用于 `.meta` 通用部分；配置专属路径与版本集中化必须迁移并带读回退。此外，本方案**未验证**“旧客户端 + 新客户端同时读写同一远端”的互操作（双写期的并发行为未知）。

---

## 9. 后续演进

| 议题 | 收益 | 风险 / 前置条件 |
|---|---|---|
| **合并为单一 `SyncGroup` 类**（`ConfigRepoImpl` / `AppDataGroupImpl` → 一个基类 + capability flags） | 消除双份近似逻辑：历史上同一个 bug 要修两遍（目录删除、`.keep`/`.mtime` 清理、墓碑处理顺序）。新能力（如 `listDeclaredBackends()`、自描述后端）只需实现一次 | 两套本地主存储（`fullFS`：primary + 缓存 overlay vs 裸 primary）与两套迁移路径必须保留语义；`connect()` 类型探测、`excludePrefixes`、chroot 钩子差异要逐项对齐；需完整回归（当前 195 个单测） |
| 数据组 `features.versions` / `conflicts` 默认开启 | 冲突归档可用 | 写入放大（§4.6）；需按需开启 |
| 墓碑 GC 与离线设备的竞态 | — | 当前 `confirm` 只覆盖已知后端；离线设备上线时若墓碑已被 GC，理论上仍可复活（§8.2） |
| 旧客户端（只写引导副本）与新客户端并行期 | — | 新客户端以数据组 `.meta/backends` 为权威；旧客户端只改描述符时，新客户端不会合并这些改动（§8.6） |

---

## 附录 A — 关键代码位置索引

> 行号以 0.6.0 为准（本次改动使部分行号整体后移）。

| 主题 | 位置 |
|---|---|
| 规范化序列化（固定字段序 / backends 按 id / options 递归排序） | [canonical-json.ts](file:///C:/codes/nodejs/zen-fs-config/src/canonical-json.ts) |
| `group.json` 读写（幂等、无 `updatedAt`） | [group-meta.ts#L104-L135](file:///C:/codes/nodejs/zen-fs-config/src/group-meta.ts#L104-L135) |
| 数据组权威后端定义读写（id 校验 / 懒迁移 / 墓碑优先） | [group-meta.ts#L136-L233](file:///C:/codes/nodejs/zen-fs-config/src/group-meta.ts#L136-L233)、[config-repo.ts#L3120-L3195](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L3120-L3195) |
| 数据组 `init()`（先读 `.meta/backends`、回刷引导副本） | [config-repo.ts#L2920-L3005](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L2920-L3005) |
| 配置组目录常量 / 排除前缀 | [config-repo.ts#L51-L79](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L51-L79)、[#L89](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L89) |
| 配置组 pair（`fullFS` + 墓碑钩子） | [config-repo.ts#L1110-L1136](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L1110-L1136) |
| 配置组冲突归档 | [config-repo.ts#L1245-L1260](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L1245-L1260) |
| 墓碑写入 / 处理 / GC | [config-repo.ts#L488-L532](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L488-L532)、[#L598-L669](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L598-L669)、[#L885-L919](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L885-L919) |
| 数据组实现（本地主存储/filter/先同步后监听） | [config-repo.ts#L2211-L2262](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L2211-L2262)、[#L2291-L2323](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L2291-L2323)、[#L2341-L2349](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L2341-L2349) |
| 数据组描述符与版本 sidecar | [config-repo.ts#L1916-L1929](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L1916-L1929) |
| 数据组后端增删 / 状态 | [config-repo.ts#L2362-L2446](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L2362-L2446) |
| 删除数据组用墓碑防复活 | [config-repo.ts#L2165-L2175](file:///C:/codes/nodejs/zen-fs-config/src/config-repo.ts#L2165-L2175) |
| 类型定义（`IConfigRepo` / `AppDataGroup` / `BackendSyncState`） | [types.ts#L287-L341](file:///C:/codes/nodejs/zen-fs-config/src/types.ts#L287-L341)、[#L409-L599](file:///C:/codes/nodejs/zen-fs-config/src/types.ts#L409-L599) |
| 统一入口与类型探测 | [connect.ts#L21-L56](file:///C:/codes/nodejs/zen-fs-config/src/connect.ts#L21-L56)、[#L84-L200](file:///C:/codes/nodejs/zen-fs-config/src/connect.ts#L84-L200) |
| 本地主存储选择 | [folder-backend.ts#L174-L206](file:///C:/codes/nodejs/zen-fs-config/src/folder-backend.ts#L174-L206) |
| 版本 sidecar 路径规则 | [version.ts#L19-L41](file:///C:/codes/nodejs/zen-fs-config/src/version.ts#L19-L41) |
| fs 透传（无墓碑） | [context-fs.ts#L101-L103](file:///C:/codes/nodejs/zen-fs-config/src/context-fs.ts#L101-L103) |
| 同步引擎删除判定依赖内存快照 | [sync-pair.ts#L67-L68](file:///C:/codes/nodejs/zen-fs-sync/src/sync-pair.ts#L67-L68)、[#L565-L636](file:///C:/codes/nodejs/zen-fs-sync/src/sync-pair.ts#L565-L636) |
| UI 分组状态与渲染 | [types.ts#L22-L38](file:///C:/codes/nodejs/zen-fs-config-ui/src/types.ts#L22-L38)、[configurator.ts#L971-L985](file:///C:/codes/nodejs/zen-fs-config-ui/src/core/configurator.ts#L971-L985)、[#L1107-L1230](file:///C:/codes/nodejs/zen-fs-config-ui/src/core/configurator.ts#L1107-L1230) |
| UI 接口强造型绕过 | [api.ts#L31-L39](file:///C:/codes/nodejs/zen-fs-config-ui/src/core/api.ts#L31-L39) |
| 产品层依赖 `dataGroup.fs` | [app.js#L1660-L1667](file:///C:/codes/nodejs/FluentOS-On-Web/dir-struct-gen/app.js#L1660-L1667) |

## 附录 B — 与既有需求文档的对应关系

| 本文 | REQUIREMENTS | 说明 |
|---|---|---|
| R1 / §1.4 | §9 D2 决策 C、FR0.1 | 需求已规定“两组都开启墓碑/版本/冲突”，代码尚未实现 |
| R2 | FR1.7 / FR2.1 / D2 | 配置组的超集职责即 `app-data-groups` 纳管层 |
| §3 远端布局 | 未在需求中规定 | **新增设计**，需同步回写 REQUIREMENTS |
| §4.1 过滤器与可见性分离 | 未在需求中规定 | **新增设计**，与 FR9 删除传播直接相关 |
| §7.2 删除接口 | FR9.1（`fs.unlink` 内置墓碑） | 保留 `deleteFile` 作为 handle 能力，二者共用同一墓碑实现；`unlink` 内置墓碑作为后续演进 |
| §7.2 默认开关 | R1 | “具备能力”按“可用 + 可配置”理解：数据组默认关、配置组恒开 |
