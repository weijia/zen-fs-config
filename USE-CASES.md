# zen-fs-config 使用场景（Use Cases / 用户旅程）

> 本文件从 [REQUIREMENTS.md](./REQUIREMENTS.md) 的 §7 抽出，便于单独维护与评审。
> 用例中的功能需求编号（FRx）、缺口编号（§8 #n）、决策（§9 Dn）均指向 REQUIREMENTS.md。

本章以**真实用户操作顺序**组织，区分两类"增加配置"：
- **加后端（连接配置）**：登记一个远端副本 / 数据后端（连接凭证 + 存储位置）
- **写配置数据（业务配置）**：通过 `setConfig` 等读写实际配置值

> 调用方如需在初始化时判断"是否首跑 / 是否已登记远端副本"，统一用 `getBackends()`
> 本地读取拓扑（`remotes = backends.filter(b => b.id !== 'local-idb')`，`remotes.length === 0`
> 即尚未配置任何远端副本）。该判断**只看已登记副本、与远端是否连通无关**；若需判断
> 首跑本身，应结合调用方自己持久化的 `nodeId`。详见各用例中的嵌入说明。

> **架构前提（重要）**：`config-sync` 是**必选根（root）**——配置、后端拓扑、账户复用
> （`accountBackendId`）、应用数据组目录（`.meta/app-data-groups/`）、首跑判断
> （`hasLocalConfig`）全部挂在它身上。`data-sync` 只是**可选数据层**：推荐作为 config-sync
> 下挂的数据存储（见 UC7 方式 A），或作为独立裸 `fs` 数据通道（代价见 UC7 方式 B）。
> 不要指望只建 data-sync 组就能获得配置能力。

### UC1 首次启动 · 空仓库引导（核心用例）

统一入口 `connect(appId)` 返回 `repo`（config-sync 实例），后续操作全部挂在 `repo` 上。

1. `const { repo } = await connect(appId)` — 建本地 config-sync 根（空仓库，无副本）。
2. `const meta = await repo.getBackends()`；若 `meta.backends` 仅含 `local-idb`，UI 显示"添加后端"引导（首跑判断）。
3. 用户提交表单 → `await repo.addBackend(id, type, options)` — `type` 为远端存储后端类型（Gitee/GitHub/WebDAV…），登记副本并初始同步，把远端配置拉到本地。注：此步只给 config-sync 根加副本；data-sync 组不在此创建，后续用 `repo.createAppDataGroup(id, [...])` 作为数据层挂上（见 UC7）。
4. 读写配置：`repo.getConfig` / `repo.setConfig`；节点配置 `repo.setNodeConfig`。

### UC2 首次启动 · 直接带远端（跳过引导）

- 应用初始化即传 `backendInfo`：`createConfigRepo(appId, { backendInfo })` / `connect(appId, { backendInfo })` → 初始同步一次性拉齐，无需先走 UC1 的空仓库引导。

### UC3 用户持续增删改配置数据

- `repo.setConfig` 写入后本地立即可读、自动异步同步到副本。
- 删除用 `repo.deleteFile`（走墓碑跨副本传播），**不可用** `fs.unlink()`。
- 节点配置 `repo.setNodeConfig` 默认不同步，`repo.publishNodeConfig` 一次性发布、`repo.peekNodeConfig` 只读查看其它节点。

### UC4 重开 · 已有配置/数据自动恢复

- config-sync：**仅传 `appId`**。`createConfigRepo(appId)` / `connect(appId)` 从本地主后端（IndexedDB / Node `Folder`）读 `.meta/backends` 自动恢复并重连所有副本，配置立即可读。**不要**重复传 `backendInfo`（重复添加会被去重拒绝或报已存在）。
- data-sync：**当前重开必须传 `backendInfo`**（且显式 `groupType: 'data-sync'`）。无 `backendInfo` 分支（`data-sync-group.ts:376`）只建空组、不重建同步对；带 `backendInfo` 时从**远端** `.meta/backends/` 恢复拓扑。持久化 `Folder` 后端只保住数据文件、未保住拓扑重开——即 FR4.2 / §9 D1 宣称的"只传 `appId` 重开"**对 data-sync 尚未落地**（已知缺口，见 REQUIREMENTS.md §8 #4）。作为 config-sync 下挂的 AppDataGroup 时由 config-sync 负责恢复，不受此限。

### UC5 增加第二个 / 多个后端（冗余）

- 在已有副本基础上再 `await repo.addBackend(...)`，数据在多个后端间双向同步；`repo.addBackend` 按 `type + options`（稳定 key）去重，相同配置不同 id 会被拒绝。

### UC6 多设备冲突与删除传播

- 双向写冲突（典型 `/shared/`）→ `repo.listConflicts()` / `repo.resolveConflict(id, merged)`，冲突双方归档于 `.meta/.conflicts/`，内容不丢失。
- 删除传播 → `repo.deleteFile` 写墓碑，全副本确认后 GC（FR6 / FR9）。
- 注意：data-sync 组当前**无**冲突归档 / 墓碑（见 FR2.5 与 REQUIREMENTS.md §8 缺口）。

### UC7 数据同步组（data-sync）— 两种消费方式

- **方式 A（推荐）：作为 config-sync 的数据层**。`repo.createAppDataGroup(id, [{ type, options, accountBackendId? }])` 在 config-sync 下建立 data-sync 组：
  - 后端可声明 `accountBackendId` 复用 config-sync 后端的账户字段（FR8），只需填存储位置；
  - 组的引用登记于 `.meta/app-data-groups/` 统一目录，config-sync 重开时一并恢复；
  - 首跑判断、拓扑恢复全部由 config-sync 兜底。
- **方式 B（独立）：`createDataSyncGroup(appId, { backendInfo, groupType: 'data-sync' })`** 提供裸 `fs` 直接读写数据文件。代价（无 config-sync 作根）：
  - **无配置 API**：仅裸 `fs`，无版本 sidecar / 墓碑 / 冲突归档 / 节点配置；
  - **账户复用失效**：`accountBackendId` 解析只查 config-sync（`config-repo.ts:1567`），独立组无根可查，每个后端须自带完整凭证；
  - **无统一目录**：各组各自为政，无"本 app 有哪些数据组"入口；
  - **首跑判断不适用**：`hasLocalConfig`（T4）仅 config-sync；
  - **`connect` 默认陷阱**：不带 `groupType: 'data-sync'` 会在远端误写 `group-type=config-sync`（`connect.ts:119`）；
  - **重开需 `backendInfo`**：见 UC4，独立组"只传 `appId` 重开"未实现。
