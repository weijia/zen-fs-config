# zen-fs-config 需求文档（Requirements / PRD）

> 本文档定义 `zen-fs-config` 的功能需求、非功能需求、使用场景与验收标准。
> 配套文档：[DESIGN.md](./DESIGN.md)（架构与设计）、[README.md](./README.md)（快速上手）、[PROMPT.md](./PROMPT.md)（AI 使用提示词）。
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
- G3：提供统一入口 `connect()`，按 `.meta/group-type` 自动路由到正确组类型。
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

### FR3 — 统一入口 `connect()`（自动组类型探测）

- FR3.1：`connect(appId, options?)` 若有 `backendInfo`，先临时连上远端读 `.meta/group-type`：
  - `config-sync` → 返回 `{ groupType, repo }`
  - `data-sync` → 返回 `{ groupType, dataGroup }`
  - 缺失 → 回退到 `options.groupType`（默认 `config-sync`）新建
- FR3.2：若 `options.groupType` 与远端实际类型冲突，抛 `Group type mismatch`。
- FR3.3：无 `backendInfo` 时，按 `options.groupType`（默认 `config-sync`）创建本地组，等价于 `createConfigRepo(appId)`。

**验收**：调用方无需预先知道后端里是哪种组，传 `backendInfo` 即可正确路由；类型冲突给出明确报错而非静默误建。

### FR4 — 本地持久化与重开恢复

- FR4.1（config-sync）：本地主后端 IndexedDB 持久保存配置数据与拓扑；重开时**仅传 `appId`**（不传 `backendInfo`）即可恢复全部副本并自动重连同步。
- FR4.2（data-sync）：本地主后端为 InMemory，**不持久化**；重开时本地无数据，需再次传入 `backendInfo` 重新连远端并按远端 `.meta/backends/` 恢复后端拓扑。
- FR4.3：库应保证"本地有/没有配置"对调用方透明——同一入口在两种情况下都能正确工作（恢复是内部完成）。

**验收**：config-sync 刷新页面后 `getConfig` 仍可读到旧值、旧副本自动重连；data-sync 刷新后需重新 `connect/backendInfo` 才能读到数据。

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

## 7. 使用场景（Scenarios）

### 场景 A：本地无任何配置（首跑 / 新设备）

- A1（接远端）：`connect(appId, { backendInfo })` 或 `createConfigRepo(appId, { backendInfo })`。初始同步把远端配置拉到本地 IndexedDB，并写出 `.meta/backends/{id}.json`。
- A2（纯本地）：`createConfigRepo(appId)` 后用 `addBackend` 补远端。

### 场景 B：本地已有配置（重开 / 刷新）

- B1（config-sync）：**仅传 `appId`**。`createConfigRepo(appId)` / `connect(appId)` 从 IndexedDB 读 `.meta/backends` 自动恢复并重连副本。**不要**重复传 `backendInfo`（重复添加会被去重拒绝或报已存在）。
- B2（data-sync）：本地 InMemory 不持久，仍需传 `backendInfo` 重新连远端，按远端 `.meta/backends` 恢复后端拓扑。

### 场景 C：调用方判断"是否首跑 / 本地有无配置"

- C1：库设计上使调用方**无需主动判断**——统一入口对两种状态兼容。
- C2：确需判断时可用：`getBackends()`（是否已有远端副本）、`getConfig(path)`（某配置是否存在）、以及调用方自己持久化的 `nodeId`（存在即非首跑）。
- C3：当前**没有** `isFirstRun()/hasLocalConfig()` 专用 API（见 §8 缺口）。

### 场景 D：多后端冗余、冲突、删除

- 同 FR5/FR6/FR9 验收路径。

## 8. 已知缺口与待办（Open Items）

1. **data-sync 组的参数级去重缺失**：`DataSyncGroup.addBackend` / `AppDataGroupImpl.addBackend` 仅按 `id` 去重，不按 `type+options`。建议补齐 `backendDedupKey` 校验（与 config-sync 对齐）。
2. **`connect()` 文档此前缺失**：已在 README 补充（见 README "Unified entry point: connect()"）。
3. **data-sync 本地不持久**：`createDataSyncGroup` 用 InMemory 作主后端，重开必须重连远端；若需本地持久恢复，可考虑支持 IndexedDB 主后端或回读远端拓扑（当前 backendInfo 分支已读远端 `.meta/backends`，可用）。
4. **首跑判断 API 缺失**：建议增加 `repo.hasLocalConfig()` / 静态 `isFirstRun(appId)` 之类便捷方法。
5. **Node.js 环境主后端**：`createConfigRepo` 硬编码 IndexedDB（浏览器专属），Node 下需显式提供主后端或兜底。

## 9. 验收总表

| 需求 | 验收要点 |
|---|---|
| FR1 config-sync | setConfig 本地立即可读、副本自动同步、拓扑可增删 |
| FR2 data-sync | fs 直读写、组内多后端双向同步 |
| FR3 connect | 自动探测组类型路由、类型冲突报错 |
| FR4 持久化/恢复 | config-sync 仅 appId 恢复；data-sync 需重连远端 |
| FR5 去重 | config-sync 按 type+options 去重；data-sync 仅 id（缺口） |
| FR6 冲突安全 | 归档 + 策略 + 可恢复 |
| FR7 节点配置 | 默认不同步、可发布/查看 |
| FR8 账户复用 | data-sync 只填存储位置即可接入 |
| FR9 删除传播 | 墓碑跨副本删、GC |
| FR10 缓存 | 零下载重校验、持久热启动 |
| FR11 扩展 | 自定义后端/序列化/冲突回调 |

## 10. 依赖

| 包 | 角色 | 必需 |
|---|---|---|
| `@zenfs/core` | 虚拟文件系统 | 是 |
| `@zenfs/dom` | IndexedDB 后端（浏览器） | 浏览器必需 |
| `zen-fs-sync` | 跨后端同步引擎 | 是 |
| `zen-fs-cache` | ETag/TTL 缓存层 | 可选 |

## 11. License

MIT
