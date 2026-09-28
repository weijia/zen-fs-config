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

不在本文档范围：具体后端（Gitee/GitHub/WebDAV/RemoteStorage）的实现细节、UI 层（见 `zen-fs-config-ui`）。

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
| 同步组（Sync Group） | 一组相互同步的后端集合，分 config-sync 与 data-sync |
| 本地主后端（Primary） | config-sync 固定为 IndexedDB；data-sync 为 InMemory |
| 副本（Replica） | 用户接入的远端后端，与本地主后端双向同步 |
| 自描述拓扑 | 后端连接信息存于 `.meta/backends/*.json`，可被任意节点读取重建 |
| 组类型标记 | `.meta/group-type`：`config-sync` / `data-sync` / 缺失 |
| Sidecar 版本文件 | 每个配置文件的 `.{file}.version`，含 version/hash/author/timestamp |
| 墓碑（Tombstone） | `.meta/.deleted/` 中的删除标记，保证删除跨后端传播 |
| 冲突归档 | `.meta/.conflicts/`，保存冲突双方内容 |
| 账户复用 | data-sync 后端复用 config-sync 后端的账户字段（token/owner 等） |
| nodeId | 节点标识，调用者负责持久化（库不再写 `/nodes/.node-id`） |

## 5. 功能需求（FR）

### FR1 — 配置同步组（config-sync）

- FR1.1：`createConfigRepo(appId, options?)` 创建配置同步组；本地主后端固定为 IndexedDB（store 名默认 `zen-fs-config-{appId}`）。
- FR1.2：提供 `getConfig/setConfig`（同步 API，从 IndexedDB 读；写入后异步自动同步到副本）。
- FR1.3：提供 `getNodeConfig/setNodeConfig`（节点本地配置，默认不同步）。
- FR1.4：提供 `publishNodeConfig/peekNodeConfig`（一次性发布 / 只读查看其它节点配置）。
- FR1.5：提供 `addBackend/removeBackend`（动态增删副本，自动双向同步）。
- FR1.6：提供 `getBackends()` 聚合拓扑、`deleteFile()`（带墓碑）、`flush()`、`listConflicts/resolveConflict`。
- FR1.7：提供应用数据组 `createAppDataGroup/getAppDataGroup/listAppDataGroups/removeAppDataGroup`。

**验收**：`setConfig` 后本地立即可读；副本后端在 watch 周期内自动收到变更；`addBackend` 后初始同步先发生再开始 watch。

### FR2 — 数据同步组（data-sync）

- FR2.1：`createDataSyncGroup(appId, options?)` 创建独立数据同步组；本地主后端为 **InMemory**。
- FR2.2：提供 `fs`（标准 node:fs API，chroot 到组根），供直接读写数据文件。
- FR2.3：提供 `addBackend/removeBackend`、`listBackends`、`flush`、`getSyncStatuses`、`dispose`。
- FR2.4：可被 config-sync 通过 `createAppDataGroup` 引用，作为某应用的独立数据存储。
- FR2.5：结构简单（仅 `.meta/backends/` + 数据文件），无版本 sidecar、无墓碑、无冲突归档。

**验收**：写入数据文件后，组内的所有后端双向同步；可作为 config-sync 的应用数据层使用。

### FR3 — 组类型自动路由入口 `connect()`（注意：非"统一生命周期入口"）

- FR3.1：`connect(appId, options?)` 若有 `backendInfo`，先临时连上远端读 `.meta/group-type`：
  - `config-sync` → 返回 `{ groupType, repo }`
  - `data-sync` → 返回 `{ groupType, dataGroup }`
  - 缺失 → 回退到 `options.groupType`（默认 `config-sync`）新建
- FR3.2：若 `options.groupType` 与远端实际类型冲突，抛 `Group type mismatch`。
- FR3.3：无 `backendInfo` 时，按 `options.groupType`（默认 `config-sync`）创建本地组，等价于 `createConfigRepo(appId)`。
- FR3.4（边界，重要）：`connect` 只统一了"**组类型探测与工厂分发**"，并不统一"启动生命周期"。它本身**不是**覆盖所有起点的统一入口：
  - **data-sync 此前需 `backendInfo` 重连（B 落地后消除）**：在决策 B 落地前，因 data-sync 本地主后端为 InMemory（FR4.2），重开无本地记忆，`connect(appId)` 单独调用无法恢复组；B 落地后 data-sync 本地主后端改为持久化，亦能"只传 appId"恢复，与 config-sync 对齐。剩余不统一点仅剩"尚不知道后端"的引导场景（见下条）。
  - **"尚不知道后端"的引导场景 `connect` 覆盖不了**：首跑时若后端尚未确定（如引导流程里让用户选/填存储位置，或账户复用只先有存储位置），调用方手里没有 `backendInfo`，`connect` 既不能建 data-sync 也不能合理建 config-sync（除非纯本地）。这类"后端发现 / 首次配置向导"必须由调用方在 `connect` 之外自行编排，`connect` 只是"给我后端、我路由"的薄门面。

**验收**：调用方无需预先知道后端里是哪种组，传 `backendInfo` 即可正确路由；类型冲突给出明确报错而非静默误建。但不应宣传为"统一入口"——它不替代首跑引导、也不为 data-sync 提供无参重开。

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

- FR7.1：`/nodes/{nodeId}/` 默认 `direction: none`，不参与自动同步。
- FR7.2：`setNodeConfig` 只写本地主后端；`publishNodeConfig` 一次性推送；`peekNodeConfig` 只读查看其它节点。
- FR7.3：**`nodeId` 由调用者持久化**（如 localStorage），库不再自写 `.node-id`；调用方应通过"自身是否存过 nodeId"判断首跑。

**验收**：`setNodeConfig` 后不出现在副本；`publishNodeConfig` 后可被其它节点 `peekNodeConfig` 读到。

### FR8 — 账户复用（Account Reuse）

- FR8.1：data-sync 后端可声明 `accountBackendId`，复用对应 config-sync 后端的账户字段（token/owner/baseUrl 等）。
- FR8.2：复用后 data-sync 后端只需提供存储位置字段（repo/branch/rootPath 等）。
- FR8.3：提供 `mergeAccountFields(type, sourceOptions, targetOptions)`（不覆盖已有字段）与 `listAccountBackends()`。

**验收**：创建 data-sync 后端时只填存储位置即可成功接入，且与 config-sync 共用同一账户凭证。

### FR9 — 删除传播（墓碑）

- FR9.1：`deleteFile(path)` 写墓碑到 `.meta/.deleted/` 并物理删除本地文件，**先于**同步执行。
- FR9.2：`flush()` 处理墓碑：在所有副本上删除实际文件 → 同步 → 更新确认 → GC（全后端确认后删除墓碑本身）。
- FR9.3：不能用 `fs.unlink()` 替代 `deleteFile()`，否则同步会把远端文件拉回。

**验收**：`deleteFile` 后所有副本最终都删除该文件且不再被同步重建；全副本确认后墓碑被 GC。

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

1. **data-sync 组的参数级去重缺失**：`DataSyncGroup.addBackend` / `AppDataGroupImpl.addBackend` 仅按 `id` 去重，不按 `type+options`。建议补齐 `backendDedupKey` 校验（与 config-sync 对齐）。
2. **首跑判断 API（`hasLocalConfig`）归属待定**：建议增加便捷方法，但**只能面向 config-sync**，原因：
   - config-sync 本地主后端是 IndexedDB（持久），`hasLocalConfig(appId)` 可静态检查该 appId 的 IndexedDB store 是否存在 / 是否非空 —— 这是唯一能可靠回答"本机是否已有配置"的 repo。
   - **data-sync 当前无"本地配置"可查**：决策 B（见 §9）落地前其本地是 InMemory，每次启动都是空的；B 落地后 data-sync 本地亦持久，因此 `hasLocalConfig` 是否也扩展到 `DataSyncGroup` 可一并决定（建议先仅 `ConfigRepo`，保持 API 简单，data-sync 仍回退到 `nodeId` + 远端探测）。
   - 对 data-sync 的"首跑"判定不能靠本地配置，而要靠：(a) 调用方自己持久化的 `nodeId`（FR7.3）；(b) 连上远端后远端 `.meta/group-type` / `.meta/backends` 是否存在（存在 = 组已在别处建过，非首次）。
   - 结论：建议暴露 `ConfigRepo.hasLocalConfig(appId)`（静态，查 IndexedDB）作为 config-sync 首跑依据；data-sync 不提供该方法，统一回退到 `nodeId` + 远端探测。
3. **Node.js 环境主后端（data-sync 持久化的前置）**：`createConfigRepo` 硬编码 IndexedDB（浏览器专属），Node 下需显式提供主后端或兜底。该磁盘后端同样供 data-sync 持久化（决策 B / §9）使用——落地后 config-sync 与 data-sync 在 Node 下均可用同一 `Folder` 后端**保存数据文件**；但 data-sync 的"只传 `appId` 重开（拓扑恢复）"**仍未实现**（见 #4）。
4. **独立 data-sync 组"只传 `appId` 重开"未实现（拓扑不重建）**：`createDataSyncGroup` 的无 `backendInfo` 分支（`data-sync-group.ts:376`）只建空组、不读取本地已持久化的 `.meta/backends/*.json` 重建同步对；带 `backendInfo` 的分支是从**远端**（非本地）`.meta/backends/` 恢复拓扑。即 FR4.2 / §9 D1 宣称的"data-sync 与 config-sync 对齐、只传 appId 重开"**当前不成立**——本地 `Folder` 只保住了数据文件，拓扑重开仍依赖每次传 `backendInfo`。修复方向：无 `backendInfo` 时从本地主后端读 `.meta/backends/` 重建同步对（对齐 config-sync 的 init 行为）；或明确文档：独立 data-sync 重开必传 `backendInfo`。作为 config-sync 下挂的 AppDataGroup 不受此限（由 config-sync 恢复）。

> 已完成 / 已决策（已移出本清单）：
> - `connect()` 文档此前缺失 → 已在 README 补充（"Unified entry point: connect()"）。
> - data-sync 是否本地持久化 → 已决策 **B**（与 config-sync 对齐），详见 §9 决策记录与 §10 实现任务清单。

## 9. 决策记录（Decision Log）

### D1 — data-sync 是否本地持久化：选 B（与 config-sync 对齐）
- **状态**：已决策（B）。
- **背景**：此前 `createDataSyncGroup` 本地主后端硬编码 `InMemory`（可移植默认，代码注释 `(InMemory in Node.js)` 暗示浏览器 IndexedDB 预想但未实现）。
- **选项**：
  - A 维持 InMemory：零本地存储成本；但 data-sync 无法"只传 `appId` 重开"、与 `connect` 统一叙事冲突（FR3.4）、重开丢弃未推送的本地离线写。
  - B 增加持久化本地主后端：浏览器 IndexedDB / Node 磁盘后端（见 Open Items #3），重开亦可"只传 `appId`"、离线写不丢；代价是大体积 fs 数据的本地存储成本。
- **决策**：选 B。接受存储成本，换取无参重开与离线写安全，并使两种组恢复路径一致。
- **影响**：FR4.2、FR3.4、FR4 验收已更新为目标态。
- **实现状态（已落地）**：新增 `Folder` 后端（`src/folder-backend.ts`）与 `resolveLocalPrimary`；`createConfigRepo`/`createDataSyncGroup`/`AppDataGroup` 的本地主后端经其选择。**Node 持久化默认 opt-in**（传 `folderPath` 或设 `ZEN_FS_CONFIG_HOME`），以保留既有 Node 行为与测试稳定性；浏览器仍默认 IndexedDB。详见 §10 T1/T2。

## 10. 实现任务清单（Implementation Backlog）

- **T1（data-sync 持久化主后端 · 决策 D1/B）【已实现】**：`createDataSyncGroup` 主后端改为 `resolveLocalPrimary`（浏览器 `IndexedDB` / Node 按需 `Folder`）；首跑仍需 `backendInfo` 建远端，之后开启持久化即仅传 `appId` 重开。拓扑落本地主后端。Node 持久化为 **opt-in**（避免破坏既有 Node 行为与测试）。剩余可选优化：大体积数据"仅缓存元数据/按需拉取"开关（原第 4 点）。
- **T2（Node 主后端）【已实现】**：新增 `src/folder-backend.ts`——基于 `node:fs` 的 `FolderStore`（`SyncMapStore`，每 key 一文件）+ 注册 `Folder` 后端（`wrapZenFSFileSystem`）。`node:fs`/`node:path` 经动态 import 注入，浏览器打包不受影响（已验证 tsup IIFE 构建通过）。`createConfigRepo` / `AppDataGroup` / `createDataSyncGroup` 的本地主后端均经 `resolveLocalPrimary` 选择。
  - 验证：`npm run build` 全目标通过；`vitest` 109/109 通过（含把 `dedup-fix` 测试 mock 迁到 `Folder` 后端）。
- **T3（data-sync 参数级去重）**：`DataSyncGroup.addBackend` / `AppDataGroupImpl.addBackend` 补 `backendDedupKey` 校验，与 config-sync 对齐（Open Items #1）。
- **T4（`hasLocalConfig` API）**：落地 `ConfigRepo.hasLocalConfig(appId)`（静态，查 IndexedDB）；是否扩展到 `DataSyncGroup` 待定（Open Items #2）。

## 11. 验收总表

| 需求 | 验收要点 |
|---|---|
| FR1 config-sync | setConfig 本地立即可读、副本自动同步、拓扑可增删 |
| FR2 data-sync | fs 直读写、组内多后端双向同步 |
| FR3 connect | 自动探测组类型路由、类型冲突报错 |
| FR4 持久化/恢复 | config-sync 仅 appId 恢复；data-sync 开启本地持久化（Node opt-in）后亦可仅 appId 恢复 |
| FR5 去重 | config-sync 按 type+options 去重；data-sync 仅 id（缺口） |
| FR6 冲突安全 | 归档 + 策略 + 可恢复 |
| FR7 节点配置 | 默认不同步、可发布/查看 |
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
