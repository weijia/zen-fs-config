# zen-fs-config 需求文档（Requirements / PRD）

> 本文档定义 `zen-fs-config` 的功能需求、非功能需求、使用场景与验收标准。
> 配套文档：[DESIGN.md](./DESIGN.md)（架构与设计）、[USE-CASES.md](./USE-CASES.md)（使用场景/用户旅程）、[README.md](./README.md)（快速上手）、[PROMPT.md](./PROMPT.md)（AI 使用提示词）。
> 状态：基于现有实现整理并标注已知缺口（见 §8）。

## 1. 文档目的与范围

本文档描述 `zen-fs-config` 作为一个**分布式配置 / 数据管理库**应当满足的需求。范围覆盖：

- 两种同步组的创建、使用与恢复（config-sync / data-sync）
- 统一入口 `connect()` 的自动组类型探测
- 本地持久化与"重开恢复"行为
- 后端拓扑的自描述、去重、账户复用
- 冲突安全、删除传播、缓存、节点本地配置、扩展点

不在本文档范围：具体后端（Gitee/GitHub/WebDAV/RemoteStorage）的实现细节；UI 呈现层（若有，归 `zen-fs-config-ui`，仅做连接表单等界面，不含逻辑）。

> **架构方向（§9 D2）**：本文档 FR/术语仍按**当前实现（config-sync / data-sync 两类 repo）**描述；目标架构为**通用同步组（GenericSyncGroup）基类 + 两种类型实现**（config-sync 承载 `.meta/app-data-groups/` 纳管数据同步组配置，见 §9 D2），届时 FR1/FR2 等将统一表述。

## 2. 背景与问题

多个程序实例（节点）需要共享配置与数据。直接读写远端仓库存在：离线不可用、并发写冲突、拓扑硬编码、凭据散落等问题。`zen-fs-config` 基于 ZenFS + zen-fs-sync，提供：

- **离线优先**：本地主后端承载所有读写，远端仅作副本。
- **自描述拓扑**：后端连接信息存进仓库自身，新节点读完即可重建同步网络。
- **冲突安全**：冲突内容归档而非静默覆盖。

## 3. 目标与非目标

### 3.1 目标（Goals）

- G1：提供配置同步组（config-sync），管理应用配置、共享配置、节点配置。
- G2：提供数据同步组（data-sync），承载纯应用数据的多后端同步。
- G3：提供组类型自动路由入口 `connect()`，按 `.meta/group-type` 自动分发到正确工厂（注意：非覆盖全部启动场景的统一生命周期入口，见 FR3.4）。
- G4：本地主后端持久化，重开时无需外部参数即可恢复拓扑与数据（config-sync）。
- G5：冲突安全，任何一方内容不丢失，可恢复。
- G6：可扩展后端与序列化器。

### 3.2 非目标（Non-goals）

- NG1：不做服务端 / 中心协调器，纯客户端库。
- NG2：不内置远端仓库托管，用户自备 Git/WebDAV/RemoteStorage 等。
- NG3：不做强一致的分布式事务，采用最终一致 + 冲突归档。

## 4. 关键概念与术语

| 术语 | 含义 |
|---|---|
| 通用同步组（Generic Sync Group） | 同步组的抽象基类：承载本地主后端、远端副本集合与双向同步引擎；`type` 标记类型。版本化 sidecar / 墓碑 / 冲突归档为**基类通用能力，两种类型均开启**；两种类型的唯一区别是配置同步组额外承载 `.meta/app-data-groups/` 纳管层 |
| 同步组类型（group type） | 组自身的 `type` 字段：`config-sync` / `data-sync` |
| 配置同步组（Config Sync Group） | 通用同步组子类：具备版本 sidecar、墓碑、冲突归档（与 data-sync 同为基类通用能力），并**额外承载** `.meta/app-data-groups/`（数据同步组的配置）|
| 数据同步组（Data Sync Group） | 通用同步组子类：与配置同步组能力完全一致（同样开启版本 sidecar / 墓碑 / 冲突），**唯一区别是不承载** `.meta/app-data-groups/` 纳管层；**一律由配置同步组以 `app-data-groups` 纳管创建（不提供独立顶层入口）** |
| 应用数据组（App Data Group） | 配置同步组下登记的某数据同步组的配置项（存于 `.meta/app-data-groups/{appId}/{id}.json`）|
| 本地主后端（Primary） | config-sync 固定 IndexedDB；data-sync 由 `resolveLocalPrimary`（浏览器 IndexedDB / Node 设 `folderPath` 或 `ZEN_FS_CONFIG_HOME` → Folder，否则 InMemory）|
| 副本（Replica） | 用户接入的远端后端，与本地主后端双向同步 |
| 自描述拓扑 | 后端连接信息存于 `.meta/backends/*.json`，可被任意节点读取重建 |
| 组类型标记 | 组自身的 `type`：`config-sync` / `data-sync` |
| Sidecar 版本文件 | 每个配置文件的 `.{file}.version`，含 version/hash/author/timestamp |
| 墓碑（Tombstone） | `.meta/.deleted/` 中的删除标记，保证删除跨后端传播 |
| 冲突归档 | `.meta/.conflicts/`，保存冲突双方内容 |
| 账户复用 | data-sync 后端复用 config-sync 后端的账户字段（token/owner 等） |
| nodeId | 节点标识，调用者负责持久化（库不再写 `/nodes/.node-id`） |

## 5. 功能需求（FR）

### FR0 — 通用同步组（Generic Sync Group，基类）

- FR0.1：提供本地主后端 + 一组远端副本 + 双向同步引擎（zen-fs-sync）的抽象；版本 sidecar / 墓碑 / 冲突归档为**基类通用能力，两种类型均开启**；两种类型的唯一区别是配置同步组额外承载 `.meta/app-data-groups/` 纳管层。
- FR0.2：提供通用后端管理：`addBackend/removeBackend`、`getBackends`、`flush`、`getSyncStatuses`、`dispose`；`type` 字段标记组类型供 `connect` 路由。

### FR1 — 配置同步组（config-sync，继承 FR0）

- FR1.1：配置同步组经**推荐入口 `connect()`** 创建/获取（当 `backendInfo` 指向 config-sync 或默认新建时返回 `repo`）。本地主后端固定为 IndexedDB（store 名默认 `zen-fs-config-{appId}`）。（底层工厂 `createConfigRepo` 非推荐外部入口，见 DESIGN。）
- FR1.2：提供 `getConfig/setConfig`（同步 API，从 IndexedDB 读；写入后异步自动同步到副本）。
- FR1.3：提供 `getNodeConfig/setNodeConfig`（节点本地配置，随主同步对双向同步到后端，按 `/nodes/{nodeId}/` 区分）。
- FR1.4：提供 `publishNodeConfig/peekNodeConfig`（一次性发布 / 只读查看其它节点配置）。
- FR1.5：提供 `addBackend(id, options)` / `removeBackend(id)`（动态增删副本，`type` 由 `options` 自动推断，自动双向同步）。
- FR1.6：提供 `getBackends()` 聚合拓扑、`flush()`、`listConflicts/resolveConflict`；删除经标准 `fs.unlink`（内置墓碑，见 FR9），不再单独暴露 `deleteFile`。
- FR1.7：提供应用数据组 `createAppDataGroup/getAppDataGroup/listAppDataGroups/removeAppDataGroup`。

**验收**：`setConfig` 后本地立即可读；副本后端在 watch 周期内自动收到变更；`addBackend` 后初始同步先发生再开始 watch。

### FR2 — 数据同步组（data-sync，继承 FR0，一律由配置同步组纳管）

- FR2.1：**数据同步组不提供独立顶层入口**；一律经由配置同步组的 `createAppDataGroup(appId, id, options?)` 创建并登记到 `.meta/app-data-groups/{appId}/{id}.json`，由配置同步组统一纳管其存在、拓扑与账户复用（决策 A）。本地主后端经 `resolveLocalPrimary`（浏览器 IndexedDB / Node `Folder` / 否则 InMemory），与 config-sync 一致。
- FR2.2：提供 `fs`（标准 node:fs API，chroot 到组根），供直接读写数据文件。
- FR2.3：提供 `addBackend/removeBackend`、`listBackends`、`flush`、`getSyncStatuses`、`dispose`；接入后端时其配置（id/type/options/accountBackendId）**回写**到配置同步组的 `.meta/app-data-groups/{appId}/{id}.json`，作为权威配置源。
- FR2.4：作为配置同步组下挂的"应用数据组"被纳管（从 `.meta/app-data-groups/{appId}/{id}.json` 实例化）；不再支持脱离配置同步组的独立创建。
- FR2.5：结构简单（仅 `.meta/backends/` + 数据文件），能力与 config-sync 一致（同样具备版本 sidecar / 墓碑 / 冲突）；与 config-sync 的唯一区别是不承载 `.meta/app-data-groups/` 纳管层。

**验收**：经配置同步组 `createAppDataGroup` 创建的数据组，其所有后端双向同步；无独立顶层入口可绕过配置同步组创建数据组。

### FR3 — 组类型自动路由入口 `connect()`（注意：非"统一生命周期入口"）

- FR3.1：`connect(appId, options?)` 若有 `backendInfo`，先临时连上远端读 `.meta/group-type`：
  - `config-sync` → 返回 `{ groupType, repo }`
  - `data-sync` → 返回 `{ groupType, dataGroup }`
  - 缺失 → 回退到 `options.groupType`（默认 `config-sync`）新建
- FR3.2：若 `options.groupType` 与远端实际类型冲突，抛 `Group type mismatch`。
- FR3.3：无 `backendInfo` 时（**首次启动**），`connect` 默认**一次创建两个同步组**——一个配置同步组 + 一个数据同步组，并把该数据同步组登记进配置同步组的 `.meta/app-data-groups/{appId}/{id}.json`。
- FR3.4（边界，重要）：`connect` 只统一了"**组类型探测与工厂分发**"，并不统一"启动生命周期"。它本身**不是**覆盖所有起点的统一入口：
  - **data-sync 此前需 `backendInfo` 重连（B 落地后消除）**：在决策 B 落地前，因 data-sync 本地主后端为 InMemory（FR4.2），重开无本地记忆，`connect(appId)` 单独调用无法恢复组；B 落地后 data-sync 本地主后端改为持久化，亦能"只传 appId"恢复，与 config-sync 对齐。剩余不统一点仅剩"尚不知道后端"的引导场景（见下条）。
  - **"尚不知道后端"的引导场景 `connect` 覆盖不了**：首跑时若后端尚未确定（如引导流程里让用户选/填存储位置，或账户复用只先有存储位置），调用方手里没有 `backendInfo`，`connect` 既不能建 data-sync 也不能合理建 config-sync（除非纯本地）。这类"后端发现 / 首次配置向导"必须由调用方在 `connect` 之外自行编排，`connect` 只是"给我后端、我路由"的薄门面。

- FR3.5（非阻塞）：`connect` 仅建立本地主后端、登记拓扑、启动后台同步（watch/轮询）即返回，**不等待远端初始同步完成**，因此不阻塞调用方其它代码；数据正确性由后台同步保证，`flush()/dispose()` 会等待挂起的后台同步收尾作为一致性兜底。

**验收**：调用方无需预先知道后端里是哪种组，传 `backendInfo` 即可正确路由；类型冲突给出明确报错而非静默误建。首次启动（无 backendInfo）一次建出 config-sync + data-sync 两个组；`connect` 返回不阻塞调用方其它代码（同步在后台进行）。但不应宣传为"统一入口"——它不替代首跑引导（见 FR3.4）。

### FR4 — 本地持久化与重开恢复

- FR4.1（config-sync）：本地主后端 IndexedDB 持久保存配置数据与拓扑；重开时**仅传 `appId`**（不传 `backendInfo`）即可恢复全部副本并自动重连同步。
- FR4.2（data-sync）：本地主后端由 `resolveLocalPrimary` 选择——浏览器 `IndexedDB`；Node 在显式 `folderPath` 或环境变量 `ZEN_FS_CONFIG_HOME` 时启用持久化 `Folder` 后端（见 §10 T2），否则回退 `InMemory`（向后兼容、无磁盘状态）。开启持久化后即支持与 config-sync 一致的"只传 `appId` 重开"——拓扑与数据落本地，重开时自动恢复并自动重连远端副本。**已实现（见 §10 T1/T2）；Node 持久化默认为 opt-in，避免破坏既有 Node 行为与测试。**
  - **背景（为何此前是 InMemory，非缺陷）**：InMemory 是 Node/Browser 都能跑的**可移植默认**——代码注释 `data-sync-group.ts:249` 写作 `(InMemory in Node.js)`，暗示浏览器侧 IndexedDB 持久化本被预想但**未实现**；data-sync 承载任意体积 fs 数据，全量本地持久化本是**存储成本**取舍。注意"避免本地陈旧态与远端冲突"**不是**理由：同步按最新数据收敛、老数据被远端覆盖，真冲突走 FR6 归档+策略；反而 InMemory 会在重开时丢弃未推送的本地离线写。决策 B 已采纳"为换取无参重开与离线写不丢，接受该存储成本"。
  - **修正（重要）**：FR4.2 旧文称"开启持久化后与 config-sync 一致的'只传 `appId` 重开'"——**该宣称对独立 data-sync 组不成立**。持久化 `Folder` 仅保住数据文件，拓扑重开仍需传 `backendInfo`（详见 §8 #4 / UC4）。作为 config-sync 下挂的 AppDataGroup 时由 config-sync 恢复，不受此限。
- FR4.3：库应保证"本地有/没有配置"对调用方透明——同一入口在两种情况下都能正确工作（恢复是内部完成）。

**验收**：config-sync 与 data-sync 在开启本地持久化（浏览器默认 IndexedDB / Node 设 `folderPath` 或 `ZEN_FS_CONFIG_HOME`）后，刷新/重启均**仅传 `appId`** 即可读到旧值、旧副本自动重连。

### FR5 — 后端拓扑自描述与去重

- FR5.1：每个后端存为 `.meta/backends/{id}.json`（原子增删，不重写整份拓扑）。
- FR5.2（config-sync）：`addBackend` 必须按 **`type + options`（稳定 key，递归排序字段顺序）** 去重 —— 相同配置不同 id 应拒绝并提示复用已有 id；`readAllBackendDescriptors` 在读取时也应删除重复（保留最早 mtime）。
- FR5.3（data-sync 组）：**当前仅按 `id` 去重**，不按参数去重（已知缺口，见 §8）。

**验收**：config-sync 下 `addBackend('b','Gitee',{owner:'x',token:'y'})` 与 `addBackend('c','Gitee',{token:'y',owner:'x'})` 视为重复；data-sync 组下两者会被当作两个独立后端。

### FR6 — 冲突安全

- FR6.1：检测到同版本不同哈希（典型在 `/shared/` 双向写）时，先将双方内容归档到 `.meta/.conflicts/`，再按策略解决。
- FR6.2：策略含 `source-wins` / `target-wins` / `merge`（JSON 深合并；非 JSON 回退 source-wins）。
- FR6.3：提供 `listConflicts()` / `resolveConflict(id, merged)` 供人工介入。
- FR6.4：不变量——任何一方内容都不被静默丢弃，可从归档恢复。

**验收**：双向写冲突后 `listConflicts()` 非空，且 `resolveConflict` 后内容生效且无数据丢失。

### FR7 — 节点本地配置

- FR7.1：`/nodes/{nodeId}/` 随主同步对双向同步（无 `direction: none` 排除；同步不按节点隔离）。
- FR7.2：`setNodeConfig` 写本地主后端，经主同步对最终一致地同步到副本；`publishNodeConfig` 显式立即推送；`peekNodeConfig` 读已同步进本地的其它节点配置副本。
- FR7.3：**`nodeId` 由调用者持久化**（如 localStorage），库不再自写 `.node-id`；调用方应通过"自身是否存过 nodeId"判断首跑。

**验收**：`setNodeConfig` 后不出现在副本；`publishNodeConfig` 后可被其它节点 `peekNodeConfig` 读到。

### FR8 — 账户复用（Account Reuse）

- FR8.1：data-sync 后端可声明 `accountBackendId`，复用对应 config-sync 后端的账户字段（token/owner/baseUrl 等）。
- FR8.2：复用后 data-sync 后端只需提供存储位置字段（repo/branch/rootPath 等）。
- FR8.3：提供 `mergeAccountFields(type, sourceOptions, targetOptions)`（不覆盖已有字段）与 `listAccountBackends()`。

**验收**：创建 data-sync 后端时只填存储位置即可成功接入，且与 config-sync 共用同一账户凭证。

### FR9 — 删除传播（墓碑）

- FR9.1：删除经**标准 `fs.unlink`（node:fs 接口）**完成；chroot fs 的 `unlink` 内置墓碑逻辑——写入 `.meta/.deleted/` 墓碑并物理删除本地文件，**先于**同步执行；不再单独暴露 `deleteFile`。
- FR9.2：`flush()` 处理墓碑：在所有副本上删除实际文件 → 同步 → 更新确认 → GC（全后端确认后删除墓碑本身）。
- FR9.3：用户可见删除必须且只应通过 `fs.unlink` 走墓碑路径；任何未接墓碑钩子的透传式 `unlink`（如内部 `.meta` 运维）不得用于用户数据删除，否则同步会把远端文件拉回。

**验收**：`fs.unlink` 后所有副本最终都删除该文件且不再被同步重建；全副本确认后墓碑被 GC。

### FR10 — 缓存

- FR10.1：远程副本后端默认被 `CachedFileSystem` 包装（IdbCacheStore，持久化到 IndexedDB）。
- FR10.2：后端实现 `getRevision()` 时按修订令牌零下载重校验；`ttlMs` 在 `getRevision` 存在时被忽略。
- FR10.3：可通过 `cache: false` / `{ storeType: 'MemoryCacheStore' }` / `{ ttlMs }` 调整策略。

**验收**：远端未变时重复读取零网络/零下载；页面刷新后缓存热启动。

### FR11 — 扩展点

- FR11.1：`registerBackend(type, factory, metadata?)` 注册自定义后端（含 `fields/defaultOptions/accountFields` 供 UI 表单生成）。
- FR11.2：自定义 `ConfigSerializer`（按扩展名解析）。
- FR11.3：`onConflict` 自定义冲突解决回调。

## 6. 非功能需求（NFR）

- NFR1 离线可用：config-sync 所有读写直接命中 IndexedDB，无网络也可工作。
- NFR2 性能：远程读取走 `getRevision` 重校验 + 缓存；同步用快照对比，未变更则跳过。
- NFR3 安全：凭据存于本地拓扑文件，按需提供；`nodeId` 不应包含敏感信息。
- NFR4 一致性：最终一致 + 冲突归档，不保证强一致。
- NFR5 健壮：初次写后崩溃，重启时比对 sidecar 哈希与实际内容，自动修正版本。

## 7. 使用场景（Use Cases / 用户旅程）

> 完整的用户旅程与用例（UC1–UC7、架构前提、`config-sync` 必选根说明）已抽到独立文件
> [USE-CASES.md](./USE-CASES.md)，便于单独维护与评审。本节仅保留索引，内容以该文件为准。

## 8. 已知缺口与待办（Open Items）

> 下列为**已知缺口**。重要说明：这些缺口的**结论均已由现有需求（FR）确定**，并非待决策项——它们属于"需求已规定结果、实现尚未完成"的缺口，对应 §10 的实现任务 **T3 / T4 / #5**。D2 待定项 D、E 实际已由实现落定（见各条）；#4 已由决策 A 消除（T5 已实现）；#3（Node 主后端）已由 T1/T2 实现。因此当前**无未决设计决策**，仅余实现工作。

1. **data-sync 参数级去重（结论已由 FR5.2 确定）**：`FR5.2` 已强制规定 `addBackend` 须按 `type+options` 去重；config-sync 已落地，`AppDataGroupImpl.addBackend` 当前仅按 `id` 去重（`FR5.3` 已知缺口）。**结论（无需再决策）**：data-sync 应与 config-sync 对齐，补齐 `backendDedupKey` 校验。实现待补 → **T3**。
2. **`hasLocalConfig` 归属（结论已由 FR2.1 / FR7.3 确定）**：`FR2.1` 规定 data-sync 一律由 config-sync 纳管（无独立存在）；`FR7.3` 规定首跑判定由调用方持久化的 `nodeId` 决定。**结论（无需再决策）**：仅提供 `ConfigRepo.hasLocalConfig(appId)`（静态查本地主后端）作为 config-sync 便捷首跑依据；**不扩展到 data-sync**——其存在由 config-sync 的 `app-data-groups` 描述符判定，无需独立方法，回退到 `nodeId` + 远端探测。实现待补 → **T4**。
3. ~~**Node.js 环境主后端（data-sync 持久化的前置）**~~ **【已由 T1/T2 实现】**：`Folder` 后端与 `resolveLocalPrimary` 已落地，配置同步组 / 应用数据组的本地主后端在 Node 下可选持久化，缺口消失。
4. ~~**独立 data-sync 组"只传 `appId` 重开"未实现（拓扑不重建）**~~ **【已由决策 A 消除 · T5 已实现】**：原独立 data-sync 入口无 `backendInfo` 分支只建空组、不重建拓扑；该入口已废除（决策 A / FR2.1，代码落地见 §10 T5），数据组一律由配置同步组经 `.meta/app-data-groups/{appId}/{id}.json` 创建并随 config-sync 启动恢复，不再存在独立重开路径，故本缺口消失。
5. **`addBackend` 的 `type` 自动推断（结论已由 FR1.5 确定）**：`FR1.5` 已规定目标签名为 `addBackend(id, options)`、`type` 由 `options` 自动推断。当前实现为 `addBackend(id, type, options)`（调用方须显式传 `type`）。**结论（无需再决策）**：改为 `addBackend(id, options)`，`type` 可选、缺省由 `options` 反查后端注册表推断。实现待补（尚未列入 §10 任务清单，建议补 T6）。

**D2 待定项（现状：A/B/C 已决策，D/E 已由实现落定，无未决项）：**

- **A. 独立 data-sync 是否保留【已决策：废除独立入口】**：数据同步组一律经配置同步组的 `app-data-groups` 纳管创建（见 FR2.1），独立顶层入口（自带 `.meta/backends`、完全脱离 config-sync）**废除**。由此 §8 #4（独立 data-sync "只传 appId 重开"缺口）随之消失——数据组由 config-sync 启动恢复，不再有独立重开路径。代码落地见 §10 T5。
- **B. `.meta/app-data-groups/{appId}/{id}.json` schema【已决策】**：配置同步组在该路径存**完整数据同步组描述符**（`{ id, groupType: "data-sync", backends: [{ id, type, options, accountBackendId? }] }`），含数据组自身后端列表；`accountBackendId` 指回 config-sync 账户后端以复用凭证。路径按 `{appId}` 分区，支持多 app 共存。
- **C. 基类可选能力开关【已决策】**：版本化 sidecar / 墓碑 / 冲突归档为**两种类型通用能力，默认均开启**；两种同步组的唯一区别是配置同步组额外承载 `.meta/app-data-groups/` 纳管层。data-sync 同样具备墓碑，保证其多副本间删除传播（避免 `fs.unlink` 被重同步拉回）。
- **D. 实例化连接是否独立【已决策：独立连接（由实现落定）】**：数据同步组从 `app-data-groups` 实例化时（`AppDataGroupImpl`，`config-repo.ts`），**独立建立自己的远端连接**——每个数据后端经 `createBackend()` 新建实例，并拥有独立的 `ZenFSSync` 引擎与本地主后端；`createBackend` 为无状态工厂（无连接池），传入的 `ConfigRepo` 父引用仅用于把拓扑回写 `.meta/app-data-groups`（FR2.3），**不共享 config-sync 已建连接实例**。仅凭证经 `accountBackendId` / `mergeAccountFields` 复用（凭证复用，非连接复用）。连接池化/复用可作为未来可选优化，但当前结构已确定为独立连接。
- **E. 本地主后端是否各自独立【已决策：各自独立（由实现落定）】**：`resolveLocalPrimary(appId, kind)` 以 `kind`（`'config'` / `'data'`）区分存储——浏览器为不同 IndexedDB 库（`zen-fs-config-config-{appId}` vs `zen-fs-config-data-{appId}`），Node 为不同 Folder 路径（`base/config/{appId}` vs `base/data/{appId}`）。config 与 data 各自独立的本地主后端，与"离线隔离、各自重开"一致；统一到单一本地库暂不做。

> 已完成 / 已决策（已移出本清单）：
> - `connect()` 文档此前缺失 → 已在 README 补充（"Unified entry point: connect()"）。
> - data-sync 是否本地持久化 → 已决策 **B**（与 config-sync 对齐），详见 §9 决策记录与 §10 实现任务清单。

## 9. 决策记录（Decision Log）

### D1 — data-sync 是否本地持久化：选 B（与 config-sync 对齐）
- **状态**：已决策（B）。
- **背景**：此前独立 data-sync 入口本地主后端硬编码 `InMemory`（可移植默认，代码注释 `(InMemory in Node.js)` 暗示浏览器 IndexedDB 预想但未实现）。
- **选项**：
  - A 维持 InMemory：零本地存储成本；但 data-sync 无法"只传 `appId` 重开"、与 `connect` 统一叙事冲突（FR3.4）、重开丢弃未推送的本地离线写。
  - B 增加持久化本地主后端：浏览器 IndexedDB / Node 磁盘后端（见 Open Items #3），重开亦可"只传 `appId`"、离线写不丢；代价是大体积 fs 数据的本地存储成本。
- **决策**：选 B。接受存储成本，换取无参重开与离线写安全，并使两种组恢复路径一致。
- **影响**：FR4.2、FR3.4、FR4 验收已更新为目标态。
- **实现状态（已落地）**：新增 `Folder` 后端（`src/folder-backend.ts`）与 `resolveLocalPrimary`；`createConfigRepo` 与 `AppDataGroup` 的本地主后端均经其选择（独立 data-sync 入口已随决策 A 移除）。**Node 持久化默认 opt-in**（传 `folderPath` 或设 `ZEN_FS_CONFIG_HOME`），以保留既有 Node 行为与测试稳定性；浏览器仍默认 IndexedDB。详见 §10 T1/T2。

### D2 — 架构分层：通用同步组基类 + 两种类型实现
- **状态**：方向已定（细节待补，见 §8 待定项 A–E）。
- **决策**：以**通用同步组（GenericSyncGroup）**为基类，`config-sync` 与 `data-sync` 为其两种类型实现：
  - **基类**：承载本地主后端、远端副本集合、双向同步引擎（zen-fs-sync）、通用后端管理（`addBackend/removeBackend/getBackends/flush/dispose`）；组的 `type` 字段用于 `connect` 路由与自描述拓扑。`version sidecar / 墓碑 / 冲突归档` 作为**基类可选能力**，由子类决定开/关。
  - **配置同步组（config-sync）**：具备版本化/墓碑/冲突（与 data-sync 同为基类通用能力），并**额外承载** `.meta/app-data-groups/`——即数据同步组的配置信息（描述符 + `accountBackendId` 引用）存放处，统一纳管应用数据组的后端拓扑与账户复用。
  - **数据同步组（data-sync）**：与配置同步组能力完全一致（版本化/墓碑/冲突均为基类通用能力），**唯一区别是不承载** `.meta/app-data-groups/` 纳管层；**一律作为配置同步组下挂的"应用数据组"被纳管**（从 `.meta/app-data-groups/{appId}/{id}.json` 实例化），不提供独立创建入口（决策 A）。
  - **管理层在核心**：后端类型注册表（`backend-registry`）、`accountBackendId` 解析与 `mergeAccountFields`、`.meta/app-data-groups/` 编排全部在 `zen-fs-config`；UI（若有）仅做连接表单等呈现。
- **动机**：两类共享同一套同步引擎与版本化/墓碑/冲突能力（避免能力分裂与重复实现），唯一差异是配置同步组额外保管应用数据组的拓扑（`app-data-groups`）；账户复用与拓扑自描述自然成立。
- **待定**：D（实例化连接是否独立）、E（本地主后端是否各自独立）**实际已由实现落定**——D=各数据组独立建连接（不共享 config-sync 连接实例，仅凭证经 `accountBackendId` 复用），E=config/data 各自独立本地主后端（见 §8 待定项 D、E 与 `folder-backend.ts`）。（A 已决策废除独立入口、B schema、C 可选能力开关均已定。）
- **关联**：USE-CASES 已按本决策重写；REQUIREMENTS §4/§5/§11 术语与 FR 已对齐。

## 10. 实现任务清单（Implementation Backlog）

> 按 §9 **D2**（通用同步组基类 + 两类实现），下列任务基于当前两类实现；T3/T4 等在 D2 落地时纳入通用基类处理。

- **T1（data-sync 持久化主后端 · 决策 D1/B）【已实现】**：独立 data-sync 入口主后端改为 `resolveLocalPrimary`（浏览器 `IndexedDB` / Node 按需 `Folder`）；首跑仍需 `backendInfo` 建远端，之后开启持久化即仅传 `appId` 重开。拓扑落本地主后端。Node 持久化为 **opt-in**（避免破坏既有 Node 行为与测试）。剩余可选优化：大体积数据"仅缓存元数据/按需拉取"开关（原第 4 点）。
- **T2（Node 主后端）【已实现】**：新增 `src/folder-backend.ts`——基于 `node:fs` 的 `FolderStore`（`SyncMapStore`，每 key 一文件）+ 注册 `Folder` 后端（`wrapZenFSFileSystem`）。`node:fs`/`node:path` 经动态 import 注入，浏览器打包不受影响（已验证 tsup IIFE 构建通过）。`createConfigRepo` / `AppDataGroup` 的本地主后端均经 `resolveLocalPrimary` 选择。
  - 验证：`npm run build` 全目标通过；`vitest` 109/109 通过（含把 `dedup-fix` 测试 mock 迁到 `Folder` 后端）。
- **T3（data-sync 参数级去重 · 结论见 §8 #1 / FR5.2）**：`AppDataGroupImpl.addBackend` 补 `backendDedupKey` 校验，与 config-sync 对齐。
- **T4（`hasLocalConfig` API）**：落地 `ConfigRepo.hasLocalConfig(appId)`（静态，查本地主后端）作为 config-sync 便捷首跑依据；**不扩展到独立 data-sync 入口（已随决策 A 废除）**（由 FR2.1 / FR7.3 确定，见 §8 #2）。
- **T5（废除独立 data-sync 顶层入口 · 决策 A）【已实现】**：移除/降级顶层独立 data-sync 入口（保留为 `@deprecated` 导出），数据组一律经 `ConfigRepo.createAppDataGroup(appId, id, options?)` 创建并登记到 `.meta/app-data-groups/{appId}/{id}.json`；`connect` 始终以配置同步组为锚点——首启动建默认数据组，接入 data-sync 后端时把该后端挂到默认数据组并回写配置（见 FR2.3 / USE-CASES UC2 / UC3）；§8 #4 随之消除。`DESIGN.md`/`DESIGN.zh-CN.md`/`PROMPT.md`/`README.md`/`README.zh-CN.md` 已同步更新。

## 11. 验收总表

> 按 §9 **D2**（通用同步组基类 + 两类实现），FR0 为基类、FR1/FR2 为两类；下表暂保留拆分供追溯。

| 需求 | 验收要点 |
|---|---|
| FR0 通用同步组 | 基类引擎：本地主后端 + 副本双向同步、type 路由、通用后端管理 |
| FR1 config-sync | setConfig 本地立即可读、副本自动同步、拓扑可增删 |
| FR2 data-sync | 经 config-sync 纳管创建、fs 直读写、组内多后端双向同步、无独立顶层入口 |
| FR3 connect | 自动探测组类型路由、类型冲突报错、data-sync 后端配置回写 config-sync |
| FR4 持久化/恢复 | config-sync 仅 appId 恢复并顺带恢复其纳管的数据组；独立 data-sync 重开路径已废除（#4 消除 · T5 已实现） |
| FR5 去重 | config-sync 按 type+options 去重（FR5.2）；data-sync 仅 id（结论已由 FR5.2 确定须对齐，实现待补 T3） |
| FR6 冲突安全 | 归档 + 策略 + 可恢复 |
| FR7 节点配置 | 随主同步对双向同步（按 nodeId 区分）、可显式发布/查看 |
| FR8 账户复用 | data-sync 只填存储位置即可接入 |
| FR9 删除传播 | 墓碑跨副本删、GC |
| FR10 缓存 | 零下载重校验、持久热启动 |
| FR11 扩展 | 自定义后端/序列化/冲突回调 |

## 12. 依赖

| 包 | 角色 | 必需 |
|---|---|---|
| `@zenfs/core` | 虚拟文件系统 | 是 |
| `@zenfs/dom` | IndexedDB 后端（浏览器） | 浏览器必需 |
| `zen-fs-sync` | 跨后端同步引擎 | 是 |
| `zen-fs-cache` | ETag/TTL 缓存层 | 可选 |

## 11. License

MIT
