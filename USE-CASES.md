# zen-fs-config 使用场景（Use Cases）

> 抽出自 [REQUIREMENTS.md](./REQUIREMENTS.md) §7。架构按 §9 **D2**：通用同步组（GenericSyncGroup）基类 + 两种类型（config-sync / data-sync）。配置同步组承载 `.meta/app-data-groups/` 纳管数据同步组的配置。FRx / §8 #n / §9 Dn 指向 REQUIREMENTS.md。

## 核心模型

- **通用同步组（基类）**：本地主后端 + 远端副本集合 + 双向同步引擎；`addBackend / removeBackend / getBackends / flush / dispose` 通用。版本化 sidecar / 墓碑 / 冲突归档 为基类通用能力，两种同步组都开启。
- **两种同步组的定义**：
  - **配置同步组（config-sync group）**：具备通用同步能力，并额外承载 `.meta/app-data-groups/` —— 数据同步组的配置（描述符 + `accountBackendId` 引用）统一存放于此。
  - **数据同步组（data-sync group）**：与配置同步组能力完全一致，只是本身不承载 `app-data-groups` 纳管层。
- **两者的唯一区别**：只有**配置同步组**的 `.meta/app-data-groups/{appId}/{id}.json` 包含数据同步组的信息（描述符与后端配置）；数据同步组本身不含该纳管层。
- **首次启动（无 backendInfo）**：`connect(appId)` 一次创建**两个**同步组 —— 一个配置同步组（本地主后端）+ 一个数据同步组（本地主后端），并把该数据同步组登记进配置同步组的 `.meta/app-data-groups/{appId}/{id}.json`。
- **`connect(appId, { backendInfo?, groupType? })` 的两种接后端流程（二者并列，取决于你这次接的是哪类后端，互不依赖、不会先后触发）**：
  - 接到**配置同步组**后端：为配置同步组 `addBackend`；并读取配置同步组内数据同步组配置，据此为每个数据同步组 `addBackend`，使数据同步组连到其应有的后端。
  - 接到**数据同步组**后端：为数据同步组 `addBackend` 建立到该后端的双向同步；并把该后端信息写回配置同步组的 `.meta/app-data-groups/{appId}/{id}.json`，让配置同步组记住此数据同步组配置。
- **非阻塞**：`connect` 只建立本地主后端、登记拓扑、启动后台同步（`watch`/轮询）后立即返回，**不等待远端初始同步完成**，因此不会阻塞调用方其它代码。数据正确性由后台同步保证；`flush() / dispose()` 会等待挂起的后台同步收尾，作为一致性兜底。

## 本地存储（零配置可用）

无 `backendInfo`：配置同步组落隐式本地主后端（浏览器 IndexedDB / Node 设 `folderPath` 或 `ZEN_FS_CONFIG_HOME` → Folder，否则 InMemory）；数据同步组同理经 `resolveLocalPrimary`（各自独立本地库，见 §8 待定项 E）。

## UC1 首次启动 · 零配置本地（一次创建两个同步组）

1. `const app = await connect(appId)` —— 创建配置同步组本地主后端（无远端），同时创建一个数据同步组本地主后端（无远端）。
2. 配置同步组在创建该数据同步组后，写入 `.meta/app-data-groups/{appId}/{dataGroupId}.json` 描述符（`{ id, groupType: "data-sync", backends: [] }`）。
3. `app.setConfig('/ui/theme', 'dark')` —— 版本化写入本地，立即可读。
4. 通过 `app.getAppDataGroup(id)` 取得数据同步组句柄，其 `fs` 立即可用（纯本地）。

## UC2 接入配置同步组后端（顺带配置数据同步组）

> 与 UC3 **并列**：本次 `connect` 接的是配置同步组后端。两条路径只由"接哪类后端"决定，互不依赖、不会先后触发。

- `const app = await connect(appId, { backendInfo })`，远端是配置同步组：
  1. 为配置同步组 `addBackend(id, options)`：把整棵 config-sync fs（含 `.meta`/app-data-groups 拓扑）同步到该远端（后台进行，不阻塞）。
  2. 读取配置同步组内的数据同步组配置（`.meta/app-data-groups/{appId}/*`）；逐个为对应数据同步组 `addBackend`，使数据同步组连到该配置中声明的后端（凭证经 `accountBackendId` 由 `mergeAccountFields` 注入）。

## UC3 接入数据同步组后端（反写配置）

> 与 UC2 **并列**：本次 `connect` 直接接的是数据同步组后端（而非配置同步组），同样独立、不依赖 UC2 是否已发生过。

- `const g = await connect(appId, { backendInfo, groupType: 'data-sync' })` 接到一个数据同步组后端：
  1. 为该数据同步组 `addBackend(id, type, options)`：建立到该后端的双向同步（后台进行，不阻塞）。
  2. 把该数据同步组后端信息（`type / options / accountBackendId / description`）写回配置同步组的 `.meta/app-data-groups/{appId}/{id}.json`，使配置同步组成为该数据同步组配置的权威来源，下次走 UC2 时即可据此重新接回后端。

## UC4 配置版本化 / 冲突 / 删除（通用同步能力保障）

- 版本：`setConfig` 产生 sidecar（版本号 + 哈希 + 作者 + 时间）。
- 删除：标准 `fs.unlink` 即写墓碑，跨副本传播、GC（FR9）—— 墓碑逻辑内置在 chroot fs 的 `unlink` 中，对外仍是 node `fs` 接口，不再单独暴露 `deleteFile`。
- 冲突：双向写冲突进 `.meta/.conflicts/`，`resolveConflict` 合并（FR6）。

## UC5 账户复用 & 数据同步组纳管（核心管理层）

- 配置同步组 `.meta/backends/{id}.json` 存账户后端（含 token/owner）。
- 数据同步组描述符存 `.meta/app-data-groups/{appId}/{id}.json`，其 `backends[]` 用 `accountBackendId` 指回账户后端，自身只写存储位置。
- 实例化时 `mergeAccountFields` 把账户凭证合并进数据后端 options（凭证集中保管）。—— 属核心管理层（FR8）。

## UC6 重开

- 本地主后端在：仅 `connect(appId)` 即从本地 `.meta` 恢复配置同步组拓扑；其下 app-data-groups 描述符一并恢复，数据同步组按需实例化并连回各自后端（见 UC2）。
- 纯远端：传 `backendInfo` 从远端 `.meta` 恢复。

## UC7 后端类型 / 同步组管理（核心 + 可选 UI）

- 后端类型注册表与连接元数据在核心 `zen-fs-config`（`backend-registry`）；UI（若有）仅做连接表单等呈现（FR11）。
