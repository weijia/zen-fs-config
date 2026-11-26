# 同步组设计说明：配置组 / 数据组 / 元数据

> 版本：2026-11-21
> 依据：
> `zen-fs-config`
> 、
> `zen-fs-sync`
> 、
> `zen-fs-config-ui`
> 、
> `onenav`
> 当前源码（行号为复核时点）
> 复核：2026-11-21 逐条对照源码重核过一遍；引用的函数名优先于行号（行号会漂）
> 说明：Sections 1–10 只描述
> **代码实际行为**
> ；与设计意图不符处一律标注「现状」并给证据。第 11 节是改进方案（P2 里已落地的部分已显式标注，不算待办）。



***

## 0. 结论摘要



1. 系统里有两个层级的同步组：**配置同步组**（固定一个，id=`config`）和**数据同步组**（可多个，每个有自己的根，如 `/app_data/folders`）。

2. 两者共用同一套同步引擎（`SyncPair`）、同一套 `.meta/` 元数据约定、同一套墓碑账本；区别在于「谁宿主谁」和「同步根在哪」。

3. **身份文件&#x20;**`.meta/group.json`**&#x20;已经是「不参与同步」的**（`PERMANENT_SYNC_EXCLUSIONS`，config-repo.ts:456）。这是「元数据直读直写」在代码里唯一的既有先例。

4. **后端列表&#x20;**`.meta/backends/**`**&#x20;仍作为普通内容参与同步**：永久排除表里只有 `/.meta/group.json`（配置组 `config-repo.ts:456`；数据组 `3450` 另外还含 `.config`/`nodes`/`shared`）。后端列表不在其中，于是出现自指写入、跨设备互相覆盖、一次拓扑变更写多份副本。

5. 一次「加后端」的落盘次数按组不同：**配置组写 1 个文件**（`.meta/backends/{id}.json`），再经每条副本同步对复制到 N 个副本；**数据组写 2 个文件**（组根权威 `.meta/backends/{id}.json` + 配置组引导副本 `.config/app-data-groups/{appId}/{id}.json`），各自再随同步对扩散。此前「写三处」的说法不准确。

6. 删除后端带墓碑（`removeBackend` 先写墓碑再删文件）；**修改后端参数有&#x20;**`replaceBackend`**&#x20;/&#x20;**`replaceAppDataGroupBackend`**，但都是「拆旧对→重建」，不是原地 CAS，也不处理旧远端数据**。

7. 三种副本的信息量不同：`.meta/backends/{id}.json` 是权威全文（含凭证）；引导副本内联的是同一份 `AppDataBackendDescriptor`；`.meta/group.json` **不含**后端列表，只含 `instanceId` 等身份字段（见 §1.3 的更正）。

8. 本轮实测已修的三类问题（编码、lastError、UI 误报）见 §10；未修的设计级问题在 §11 给出方案与验收口径。



***

## 1. 结构与角色

### 1.1 三张表



| 概念    | 代码实体                                       | 本地存储                            | 职责                                        |
| ----- | ------------------------------------------ | ------------------------------- | ----------------------------------------- |
| 配置同步组 | `ConfigRepo`（`config-repo.ts`）             | IndexedDB，库名由 `idbStoreName` 传入 | 持有配置内容（`/.config/**`）、数据组引导副本、每个副本后端一条同步对 |
| 数据同步组 | `AppDataGroupImpl`（`config-repo.ts:4xxx`）  | 同上，每组一个库                        | 一个组的根路径下的内容，与它的每个后端各一条同步对                 |
| 同步引擎  | `SyncPair`（`zen-fs-sync/src/sync-pair.ts`） | 快照在内存                           | 双向快照 diff、冲突策略、过滤、pre/post hook、错误聚合      |
| 元数据层  | `group-meta.ts`（`/.meta/*`）                | 随组同步 / 被排除                      | 身份、后端清单、墓碑、版本、冲突归档                        |

配置组固定 id：`CONFIG_GROUP_ID = 'config'`（config-repo.ts:173）。数据组的 id 来自引导描述符（例 `default`）。

### 1.2 关系



```
配置同步组 (root = /)
├─ /.config/**                     应用/组配置内容
├─ /.config/app-data-groups/{appId}/{id}.json   引导副本（只含组元信息，无 backends）
├─ /.config/app-data-groups/{appId}/backends/{backendId}.json  应用后端（一文件一端点，带 groupId）
├─ /.meta/group.json               身份（不同步）
├─ /.meta/backends/{id}.json       配置组自己的副本后端清单（参与同步）
└─ 同步对：本地 ↔ 副本后端 A、B、C …

数据同步组 default (root = /app_data/folders)
├─ 业务数据文件
├─ /.meta/group.json               身份（不同步）
├─ /.meta/backends/{id}.json       本组后端清单（参与同步）
├─ /.meta/tombstones/**            删除账本（必须同步）
└─ 同步对：本地 ↔ 后端 a、b …
```

配置组是「数据组拓扑的宿主」：`connect()` 先建 `ConfigRepo`，再从 `listAppDataGroups()` 拉出引导描述符、逐个 `getAppDataGroup()` 实例化（connect.ts:219-252）。



***

## 2. 目录布局（按组根计算）



| 路径                                                             | 写入方                   | 当前是否参与同步                                                | 说明                                                      |
| -------------------------------------------------------------- | --------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| `/.meta/group.json`                                            | 身份流程（建对 / 认领 / 对齐）    | **否**（永久排除）                                             | `schemaVersion/kind/id/instanceId/profile/name/features`；不含后端列表 |
| `/.meta/backends/{id}.json`                                    | 组拓扑增删改                | **是**                                                   | 权威后端全文，含 `options`（凭证）与 `createdAt`                     |
| `/.meta/tombstones/{encoded}.json`                             | 删除路径                  | **是**                                                   | 删除意图的唯一账本，必须跨端可见                                        |
| `/.meta/versions/{encoded}.json`                               | `VersionStore.record` | 是（数据组 `features.versions` 开启时）                          | `{version, hash, author, timestamp}`                    |
| `/.meta/conflicts/{conflictId}/`                               | 冲突归档                  | 是                                                       | `source` / `target` / `meta.json` / `resolved`          |
| `/.meta/.deleted`、`/.meta/.conflicts`、`/.meta/app-data-groups` | 已停写                   | 是（当普通内容）                                                | `isDeletableLegacyMetaPath()` 允许清理（group-meta.ts:178）   |
| `/.config/**`                                                  | 仅配置组                  | 仅配置组；数据组完全不看（`CONFIG_ONLY_PREFIXES`，config-repo.ts:262） |                                                         |
| `/.config/config-sync-group.json`                              | 配置组                   | 是                                                       | 只有显示名（`ConfigSyncGroupDescriptor` 无 `backends`）         |
| `/.config/app-data-groups/{appId}/{id}.json`                   | 配置组                   | 是                                                       | 引导副本：`id/groupType/instanceId/name/features`（无 `backends`） |
| `/.config/app-data-groups/{appId}/backends/{backendId}.json`   | 配置组                   | 是                                                       | 应用后端：一文件一端点，文件内带 `groupId` |
| `/.config/backends/{id}.json`                                  | 旧路径                   | 是                                                       | 只做兼容清理（`removeBackendDescriptor`）                       |
| 业务数据                                                           | 应用                    | 是                                                       |                                                         |

补一个表里没列的标记文件：`/.config/group-type`（新布局）与 `/.meta/group-type`（旧布局），由 `connect()` 的探测只读，内容只有 `config-sync` / `data-sync` 两个值，不含身份。

路径编码（`encodeMetaPath`，group-meta.ts:284）：`/a/b.json` → `a__b++json`（去前导 `/`、`/`→`__`、`.`→`++`）；墓碑文件名在编码结果后再拼 `.json`，即 `a__b++json.json`；`decodeMetaPath`（297-302）为其逆。目录墓碑路径不能带尾斜杠（`normalizeTombstonePath`）。

### 2.1 更正：后端列表并不存在「三份全文」

`GroupDescriptor`（types.ts:335）字段仅 `schemaVersion / kind / id / instanceId / name / features`，**没有&#x20;**`backends`。带内联后端列表的是 `AppDataGroupDescriptor`（types.ts:282，`backends: AppDataBackendDescriptor[]`）。因此准确的落点是：



* 权威全文：`/.meta/backends/{id}.json`（组根内）

* 独立文件：`/.config/app-data-groups/{appId}/backends/{backendId}.json`（配置组根内，一文件一端点，带 `groupId`）

* `.meta/group.json`：只存身份

之前口头说的「`.meta/group.json` 里有一份内联 backends」不成立，以本节为准。



***

## 3. 配置同步组

### 3.1 连接流程（`connect()` → `setupReplica()`）

先澄清语义：`connect()` **不是「恢复一个已存在的连接」**，它每次调用都会新建一个 `ConfigRepo` 对象（内存里的同步对、快照都是新的），持久状态只有两处 —— 本地 IndexedDB 和远端。一次调用同时做了三件事：

1. **幂等打开本地仓**：挂载 IDB 主存储（已有数据就复用）、建 `/.meta/`、纠正被污染的描述符、迁移旧 `backends.json`、全局 purge 泄漏的 `.mtime`/`.keep`；
2. **注册/恢复远端拓扑**：读 `.meta/backends/*`，若传了 `backendInfo` 且该 id 还不在列表里就写成副本（4851-4869）；
3. **建同步对并首同步**：`setupSync()` 逐副本建对（4911），后台 `syncMetaToReplicas()` 推一轮（4935-4944）。

所以「初始化」在代码里不是独立步骤：`createConfigRepo` 明确**初始化不预置身份**（4795-4798），`instanceId` 只在接入第一个后端 / 用户显式设置 / 采纳远端身份时才写。`connect()` 既会创建空仓壳，也会在同一个调用里把远端挂上。



1. 先做**类型探测**：`probeGroupTypeDetailed()`（connect.ts 的三态探测段）用**待连接的远端**的 `type+options` 临时 `createBackend` 一个实例（不是本地仓），在它身上严格读 `/.meta/group.json`（`readGroupDescriptorStrict`），没有 kind 再依次读 `/.config/group-type`、`/.meta/group-type`；读完在 `finally` 里 `dispose()`。

2. **已实现（原为静默降级，见 §3.1.1）**：探测结果三分（`unreachable` / `empty` / `marked`+`occupied`）：
   - `unreachable`（临时实例建不起来，或 strict 读抛非 NotFound）→ 抛 `RemoteUnreachableError`，**不建任何本地组**；
   - `empty` 且既没有 `initGroupType` 也没有 `groupType`（旧调用方的显式选择）→ 抛 `NeedsInitError`，由 UI 询问用户；
   - 有类型可判（`marked` / `occupied` / 已显式确认初始化）→ 继续：显式类型与远端不一致抛 `Group type mismatch`，一致则照常走下面的 `config-sync` / `data-sync` 分支。

* `config-sync`：仍把 `backendInfo` 传给 `createConfigRepo`，照常连该后端，身份校验随后判 `unreadable` 并跳过配对；

* `data-sync`：建 local-only 配置仓；若本地**一个描述符都没有**才 `createAppDataGroup('default',[])`；有描述符但加载失败则明确拒绝（262-274）。

3. 身份校验的时机：**只在初始化建对时执行** —— 配置组在 `setupSync()` 里对每个非主副本调 `bindBackendIdentity()`（1683），数据组在 init 流程调 `checkBackendOwnership()`（3656）。远端有身份且 `instanceId` 不同 → `conflict`，**不建同步对**（`skippedBackends` 记原因，见 §5.2）。

4. 相同或远端尚无身份 → 由先到者认领（写 `/.meta/group.json`；认领失败按 `claim-failed` 上报，不假装成功）。

5. `groupType === 'data-sync'` 且已有 dataGroup 时，若 `${type}-primary` 不在已连接列表里就 `addBackend`（275-278）。

6. `setupReplica(id,type,options)`（2308）：


   1. `createBackend({type,options})` → `backendToSyncableFS`

   2. `writeBackendDescriptor(desc)` → `/.meta/backends/{id}.json` + `.version` 侧车（2190-2201），同时更新内存缓存 `backendDescriptorCache`

   3. `syncEngine.addPair(fullFS ↔ backend)`：`BiDirectional`、`conflictStrategy='source-wins'`、`filter=syncFilter`、`root='/'`、`preSyncHook=invalidateTombstoneCache+processTombstones`、`postSyncHook=processTombstones+updateTombstoneConfirmations`

   4. 注册 conflict handler（2356-2359）→ `handleConflict` 归档；`trackSyncErrors`

   5. **先&#x20;**`syncMetaToReplicas()`**&#x20;再&#x20;**`watch()`（2364-2369；注释解释：先 watch 会让 `buildInitialSnapshots()` 缓存合并快照，`syncAll()` 直接跳过）。注意它是对全部副本各同步一轮，不是只同步新对。

7. 去重：同 `id` 直接拒绝；`type+options` 相同（`backendDedupKey`）也拒绝（2284-2297）。**但运行时&#x20;**`addBackend`**&#x20;不调身份校验**：2277-2300 只做去重就进 `setupReplica`；数据组 4507 同样只在 init 阶段校验（见 §11 P0-6）。

注意顺序：**先写描述符，再建 pair、再首同步**。这样首次同步就会把描述符上传到该后端，对端后续能读到完整拓扑；反过来（先同步后写）会先出现一次「拓扑缺失」的窗口。

### 3.1.1 探测为空：三态分离、用户确认与当前实现

**旧实现（已修复）**：「远端不可达」和「远端是空仓库」在探测环节被合并成同一个 `null`：



* 临时后端实例建好之后，读 `/.meta/group.json` 抛错 → `catch {}` 吞掉（旧 `detectGroupTypeDetailed`）
* 读 `/.config/group-type` / `/.meta/group-type` 抛错 → 循环里的 `catch {}` 吞掉
* 两者都失败 → `return { groupType: null, remote: null }`

于是「实例建得起来、但读不到身份文件」时不会中止，而是继续走到「新后端」分支：建一个本地 `ConfigRepo`（IndexedDB），`options.groupType` 若为 `data-sync` 还会顺带 `createAppDataGroup('default', [])`。UI 上表现为「没有远端也冒出一个本地组」，而用户本来期待的是「连不上就报错；是空库也要先问我」。

**当前实现（已落地并通过 296 项测试）**：`probeGroupTypeDetailed()` 换用 `readGroupDescriptorStrict()`（只把 `ENOENT/ENOTDIR/NotFoundError/errno=-2` 当 `null`），返回 `unreachable | empty | marked | occupied`；`connect()` 据状态分流：



* `unreachable` → 抛 `RemoteUnreachableError`（带后端类型与失败原因），**不建任何本地组**；
* `empty` → 未传 `initGroupType`（且未传旧字段 `groupType`）时抛 `NeedsInitError`（`code=NEEDS_INIT`、`requiresInit=true`），由 UI 弹确认框；用户选定后带 `initGroupType` 重调；
* `marked` / `occupied` → 按探测类型继续；显式类型与远端不一致抛 `Group type mismatch`；
* `occupied` 但 `kind` 非法 → 直接报错，拒绝猜。

**流程**（当前实现）：



```
connect(backendInfo)
│
├─① createBackend(type, options) 建临时实例
│    └─ 抛错（凭证无效 / 构造期网络失败） ──▶ 中止，不建任何本地组（RemoteUnreachableError）
│
├─② readGroupDescriptorStrict + group-type 标记
│    ├─ 抛错（非 NotFound） ───────────────▶ 中止（同上）
│    ├─ null，且无 group-type 标记 ────────▶ empty（未初始化）
│    ├─ null，但有 group-type 标记 ────────▶ marked（按标记类型继续，身份待认领）
│    └─ 有 group.json ──▶ kind 与请求类型一致？
│                          ├─ 否 ──▶ GroupTypeMismatch，中止
│                          └─ 是 ──▶ occupied
│
├─③ empty 分支
│    └─ 调用方传了 initGroupType？
│         ├─ 否 ──▶ 返回 needsInit（远端根 / 文件数 / 建议类型）──▶ UI 询问用户
│         │        ├─ 取消 ──────────────▶ 结束，不建组
│         │        ├─ 确认 config-sync ──▶ 带 initGroupType=config-sync 重调 connect
│         │        └─ 确认 data-sync ────▶ 带 initGroupType=data-sync 重调 connect
│         └─ 是 ──▶ 按该类型建组
│
└─④ marked / occupied / 已确认初始化 ──▶ 建 repo，逐副本身份校验
     ├─ conflict ──▶ 跳过该后端（不建对），记 skippedBackends
     └─ match / claimed ──▶ 建同步对 → 首同步 → watch
```



| 探测结果          | 判据                                                                         | 行为                     | 会建本地组？                   |
| ------------- | -------------------------------------------------------------------------- | ---------------------- | ------------------------ |
| `unreachable` | `createBackend` 抛错，或 strict 读抛出非 NotFound 错误                               | 中止并报错                  | 否                        |
| `empty`       | `group.json` 严格读为 `null`，且无任何 group-type 标记                                | `needsInit`，等用户确认      | 仅在 `initGroupType` 显式给出时 |
| `marked`      | `group.json` 为 `null`，但 `/.config/group-type` 或 `/.meta/group-type` 存在且值合法 | 按标记类型继续，身份待认领          | 是                        |
| `occupied`    | `group.json` 的 `kind` 与请求类型一致                                              | 继续，由身份校验决定 match/claim | 是                        |
| `mismatch`    | `group.json` 的 `kind` 与请求类型不同                                              | 抛 `GroupTypeMismatch`  | 否                        |

**为什么「空库」必须问，而不能默认初始化**：



* 探测只看 `.meta` 标记，「空」不等于「没有内容」：根下可能已有用户文件，初始化等于把这些文件并入组并推到所有副本。

* 初始化会写入 `instanceId` 身份，之后别的设备只能按这个身份认领 —— 属于不可逆的身份决定。

* 把不可达误判为空库，等于在一个其实有身份的仓库上另写一份身份；反过来，把别人的库当空库认领，会把两套数据合并。

**API（已实现）**：



```
probeGroupTypeDetailed(type, options) -> {
  state: 'unreachable'|'empty'|'marked'|'occupied',
  groupType: 'config-sync'|'data-sync'|null,   // marked/occupied 时给出
  remote: { kind, id, instanceId, name } | null,
  error?: string
}
// 已从包入口导出：probeGroupTypeDetailed / NeedsInitError / RemoteUnreachableError

connect({ backendInfo, groupType?, initGroupType?, ... })
  - empty 且 initGroupType、groupType 都没传 → 抛 NeedsInitError（code=NEEDS_INIT）
  - initGroupType 存在 → 按该类型走 createConfigRepo / createAppDataGroup
```

兼容说明：`options.groupType` 保留为「调用方期望的类型」（用于与远端比对），**在空库场景下仍被当作旧调用方已做出的显式选择**（不再有 `?? 'config-sync'` 的隐式默认）。新调用方应改用 `initGroupType`。

剩余待修细节：`isNotFoundError`（525-530）在 code/name/errno 都不匹配时，会用消息正则 `/no such file|not found|不存在/i` 兜底。若某后端把 401/403 的报错文案写成 "not found"，就会被当成本地不存在的文件 → 误判成 `empty`。建议 strict 判定只认结构化的 code/name/errno，不解析 message。

三种状态（已分开）：



| 远端实际状态       | 当前行为               |
| ------------ | ------------------ |
| 空仓库（未初始化）    | 抛 `NeedsInitError` → UI 询问，确认后才带 `initGroupType` 建组 |
| 不可达（网络 / 鉴权） | 抛 `RemoteUnreachableError`，不建任何本地组 |
| 已被别的组占用      | 类型不一致抛 `Group type mismatch`；一致则建 repo 后由身份校验决定是否配对 |

对比：真正的归属校验 `bindRemoteGroupIdentityDetailed()` 是**区分**不可读的（`conflict:'unreadable'`，group-identity.ts:169-181），不会认领；问题只在于它发生在建 repo / 建组之后。

另一条会被误读为「凭空建组」的路径是「本地模式」：`connect()` 不传 `backendInfo` 时走 Case 1，直接建一个 local-only 的 `ConfigRepo`（connect.ts:140-187）。onenav 的 `resolveDataGroup()` 在没有任何已连接实例时就会兜底调 `connect(appId)`，所以「完全没配后端」时也会出现一个空配置仓 —— 这是「本地优先」的有意设计，但它和上面的静默降级混在一起，看起来就像「连不上也建组」。

### 3.1.2 connect() 的耗时构成（实测）

**阶段日志已加**（`config-repo.ts` 的 `createConfigRepo`）：`[connect-timing] start / local-primary / local-purge / local-meta / descriptors / load / setupSync / version-migrate / ready`（defer 模式下 `load` 之后是 `return`），单位 ms，从进入工厂开始计。

实测数据：



* 本地部分（vitest + Folder 主库、0 副本）：首次 `ready` ≈ 51ms，热启动 ≈ 8ms；耗时主要在两次本地全量 purge（约 20–30ms）。
* 真实网络（浏览器内实测资源耗时）：RemoteStorage `/.meta/group.json` 读取 237ms；`/.sync.lock` 连续 4 次 279–378ms；Gitee API 640–819ms。

结论：**慢的从来不是「本地建仓」，而是 `setupSync()` 里逐副本 `bindBackendIdentity()` 的远端身份读。** 这段原本串行、每次启动都跑 —— 即使本地已有完整数据、上次也连过，它仍然不会省掉。`migrateLegacyVersionSidecars()` 只在本地真的找到旧 `.x.version` 侧车时才会碰远端（干净仓库实测 0 次请求）。已经放到后台的只有 `startBackgroundSync()` 与 `syncMetaToReplicas()`。

已实现的优化（本轮）：



1. **复用探测结果**：`connect()` 把探测时读到的 `group.json` 通过 `prefetchedRemote` 传给 `createConfigRepo` → `setupSync`，同一 `type+options` 的副本不再读第二次（只剩「写描述符前的幂等比对」那一次，且认领后也没有了）。`prefetch-identity.test.ts` 断言：有预取 1 次读、无预取 2 次读。
2. **并发校验**：`setupSync` 拆成两阶段 —— 阶段 1 用 `Promise.all` 并发建实例 + 并发 `bindBackendIdentity`，阶段 2 再按顺序 `addPair`。多副本时延迟不再相加。
3. 顺带修掉一个真实 bug：`readAllBackendDescriptors()` 之前把 `backendDescriptorCache` 直接指向返回数组，`writeBackendDescriptor()` 的 `push` 会让调用方的列表凭空多一项 → 同一个 id 被建两次同步对（本次调试中实测到）；现在缓存与返回值是两个数组，`setupSync` 也按 id 去重。

仍未做（可选）：用「上次校验通过的 `instanceId`」做乐观建对。`BackendDescriptor` 目前只有 `id/type/options/description`，没有这个字段；而且建了 pair 到校验出冲突之间必须给同步加门控，风险较高，暂不实现。真正落地的是下面的 defer 模式。

注意：onenav 当前用的是 npm 版 `zen-fs-config`，本节改动要经过发版或 `patch-deps` 补丁后才会生效。

### 3.1.3 deferReplicaSetup：把建对挪到后台，用两个信号交接

`connect()` 的职责收窄成三件事：**探测远端组类型 → 本地建仓（含配置缓存 load）→ 立即返回**。副本的 `createBackend`、归属校验、`addPair`、首同步、watch 全部交给后台。

```text
connect(type, options)
  ├─ probeGroupTypeDetailed()          // 远端读一次 group.json / group-type
  ├─ NeedsInit / Unreachable / mismatch // 该报的错仍然同步报
  ├─ createConfigRepo({ deferReplicaSetup: true })
  │    ├─ 本地 purge / meta / descriptors / load
  │    ├─ startReplicaSetupInBackground(...)   // 不 await
  │    └─ return repo          ← 信号 ①：connect 已返回
  └─ return { replicasPending: true, whenReplicasReady() }

后台（startReplicaSetupInBackground）
  ├─ setupSync(): 并发 createBackend + bindBackendIdentity（可能 skipped: conflict）
  ├─ migrateLegacyVersionSidecars()（仅当有副本、且未显式关闭）
  ├─ replicaCount > 0 → startBackgroundSync() + syncMetaToReplicas()
  └─ 汇总 { ready, skipped, failed }     ← 信号 ②：副本就绪
```

两个信号的分工：

* **已返回**：`connect()` resolve。此时 `repo` 可用 —— `getConfig/setConfig`、`listBackends()`（描述符已落盘）、`getAppDataGroups()` 都能读；但 `replicaCount === 0`、`listSyncPairs()` 为空，**任何「同步状态」类 UI 都必须显示「远端校验中」，不能把空列表当成「没有后端」**。`ConnectResult.replicasPending` 就是这一位。
* **已就绪**：`ConnectResult.whenReplicasReady()`（=`repo.whenReplicasReady()`）resolve 出 `ReplicaSetupSummary`：
  - `ready`: 成功建对的 backendId 列表；
  - `skipped`: `{ backendId, reason }` —— 归属冲突、描述符非法等「这台不该建对」的情况，**不再从 connect 抛出**；
  - `failed`: `{ backendId, error }` —— 建实例/网络失败。

  未开 defer 时这个方法存在且立刻 resolve（读当前状态），调用方可以无分支地统一 `await`。

**为什么校验完成前一对都不建**：`addPair` 本身是廉价同步操作，贵的是它前面的远端身份读；但如果先建对再校验，冲突时就得「建了又拆」，而且拆之前同步可能已经把错误身份的数据推上去。改成「校验通过才建对」后，不存在这个窗口，也就不需要给同步加闸门。代价就是必须让消费方认上面两个信号。

**生命周期**：`dispose()` 与 `flush()` 开头都会 `await replicaSetupPromise`，避免后台建对晚到、把 pair 挂到已销毁的 syncEngine 上，也避免 `flush()` 跑在 0 个 pair 上。defer 模式下 `createConfigRepo` 的 `load()` 提前到 `setupSync` 之前（纯本地，不依赖副本）。

**消费方接入**：

* `zen-fs-config-ui`：已接入（未发版，靠本地源码 / patch-deps）。`connectGroup()` 新增 `deferReplicaSetup` 透传；configurator 的连接**默认开 defer**，并在状态行上分三种形态 —— 没有实例：「未连接 · 该组没有当前会话的实例」；`replicasPending`：「远端校验中 · connect 已返回，副本尚未建对」；就绪后：正常 `同步对 N（监听 M）…`，详情行追加 `后台建对 就绪 X · 跳过 Y（backendId: reason）· 失败 Z`。旧 npm 版没有这两个字段，UI 按可选字段读取，老版本行为不变（立即返回、0 个 pair）。
* 尚未接入：onenav 的 `resolveDataGroup()`（依赖 `hasRemoteBackend()`，空列表会触发兜底 `connect(appId)`）、filebrowser 的 `waitForGroupReady()`、admin 列表页 —— 都需要从「列表里有没有」改成「等信号② / 认 pending」。
* 是否把 defer 作为 onenav 的默认仍在讨论：对首屏速度有利，但所有「同步状态」读侧必须同步改造，否则会把「校验中」误显示成「无远端」。


### 3.1.4 同步事件：`onSyncEvent()`（FR12）

库层不再让调用方靠轮询猜「这轮同步到底做了什么」，而是在既有 per-pair 状态簿记处直接派发事件。

```ts
const unsubscribe = repo.onSyncEvent((event) => {
  // event.type: 'sync:end' | 'sync:error'
  // event.groupKind: 'config' | 'data'
  // event.groupId / backendId / pairId / timestamp
  // sync:end → event.result（SyncResult：filesCreated/Updated/Deleted/Skipped、conflicts、errors、durationMs）
  // sync:error → event.error（错误消息）
});
```

要点：

* **挂载点**：`ConfigRepo.onSyncEvent()` 与 `AppDataGroupImpl.onSyncEvent()` 各自维护订阅集合；内部复用 `trackSyncErrors()` 已注册的 `sync:error` / `sync:end` 回调，在写完 `backendStates` 之后派发，因此 handler 里读 `getSyncStatuses()` / `getBackendSyncStates()` 已是本轮之后的状态。
* **每轮必发**：`sync:end` 在零变更轮也会发（`syncEngine.sync()` 里 `sync:end` 无条件 emit），调用方用 `result` 计数过滤；不另设「仅变更才发」，避免两种语义混用。
* **不波及同步**：单个 handler 抛错只 `log.warn`，不影响该轮同步与其它订阅者；`dispose()` 清空订阅集合。
* **覆盖所有建对路径**：启动建对（`setupSync`）、运行时 `addBackend()`、数据组 `init` 都走同一个 `trackSyncErrors()`，所以 defer 后台建对的 pair 同样有事件；`publishNodeConfig` 的临时 pair（`publish-{nodeId}`）不注册订阅，不产生事件。
* **UI 转发**：`configurator` 通过 `subscribeGroupSyncEvents()` 适配层订阅 repo 与每个数据组（老库无该方法时返回 `null`，静默降级），转成 `<sync-group-configurator>` 的 `sync` 事件 / React `onSync`；收到事件立即刷新状态行，不再等 2 秒轮询。重连与 `destroy()` 时统一取消订阅。

**为什么仍然不是「文件级变更推送」**：事件粒度是「一轮同步结束」，不是逐文件回调；远端变更能否被发现仍取决于该轮是否发生（本地 `onChange` 或 `syncPollIntervalMs` 远端轮询，默认 30 分钟）。要更快感知远端变化，仍需调小轮询间隔或主动 `flush()`。

### 3.2 读侧

`getBackends()`（2224）返回「隐式 `local-idb` + `.meta/backends/*`」；`listBackends()`（1511）返回内存缓存 `backendDescriptorCache` 的副本（写描述符时同步更新，2190-2206），不回读磁盘。隐式本地主库永不落盘为文件。



***

## 4. 数据同步组

### 4.1 创建

`createAppDataGroup(id, backends, options)`（≈config-repo.ts:3000-3089）：



1. 构造 `AppDataGroupImpl`（`backendsAreAuthoritative: true`）

2. `await group.init()`

3. 写引导副本 `.config/app-data-groups/{appId}/{id}.json`，内容 `{id, groupType:'data-sync', instanceId, name?, features?}`；后端逐个写 `app-data-groups/{appId}/backends/{backendId}.json`

4. 注册进 `appDataGroups` map

### 4.2 加后端（现状顺序，config-repo.ts:4507-4585）



1. `createBackend` + `addPair(localFS ↔ backend)`：`BiDirectional`、`source-wins`、`preSyncHook=runTombstonePass('preSync')`、`postSyncHook=runTombstonePass('postSync')+confirmTombstones()`

2. 清理同 id 的旧墓碑（`tombstones.remove`）

3. `writeBackendMetaDescriptor(localFS, desc)` → `/.meta/backends/{id}.json`（canonical 字节，`createdAt` 取 min 合并）；**写失败只&#x20;**`log.warn`**，不进&#x20;**`result.errors`**（4566-4568）**

4. `await sync()` → `watch()`

5. 回刷引导副本 `parent.updateAppDataGroupDescriptor(groupId, this._backends, {name, features})`

「先加后删」的骨架已有：**先建对 → 清旧墓碑 → 写权威文件 → 首同步 → 回刷引导副本**。缺的是「写失败可感知」和「原地 CAS」。

### 4.3 删后端（config-repo.ts:4587-4620）



1. 为 `/.meta/backends/{id}.json` 写墓碑

2. 在 pair 还挂着时跑一轮墓碑 pass —— 目的是把它**自己远端**的那份描述符副本也删掉

3. `removeBackendMetaDescriptor(localFS, id)`

4. 移除 pair、清状态、回刷引导副本

5. `dispose` 后端实例

墓碑不是多余的：如果先拆 pair 再删文件，该后端远端上的副本会留下，下次连上又被拉回来。

### 4.4 三种「后端列表」视图



| 方法                             | 含义                    | 用途                                              |
| ------------------------------ | --------------------- | ----------------------------------------------- |
| `listBackends()`               | 已成功连接的                | 运行时展示                                           |
| `listDeclaredBackends()`       | `_backends`，含连接失败的    | 声明式视图 / 回刷引导副本（回刷用 `_backends`，避免暂连失败的条目被悄悄丢掉）  |
| `readBackendMetaDescriptors()` | 磁盘 `.meta/backends/*` | 权威读；`null`= 目录不存在（可用引导副本回填），`[]`= 目录存在但为空（权威空表） |



***

## 5. 身份（instanceId）

### 5.1 语义



* 一个组创建时生成一次 UUID；**正常流程（连接 / 认领 / 同步）不改写它**，只有显式「采纳远端身份」会改（`setGroupInstanceId`，2683：先写本地 `.meta/group.json`，失败回滚）。types.ts:344-351 的「创建后不可变」指的就是不被普通流程改动。

* 它是**同步边界**：连任何远端前先比对该端 `.meta/group.json` 的 `instanceId`，不同就不建同步对 → 两个不同的组永远不会互相同步。

* 缺失 = 「未认领」的老仓库，由第一个连接者写入。

* 引导副本也携带 `instanceId`，让新设备在拿到任何数据后端连接之前就知道该组声明的身份（避免误认领别人的仓库）。

### 5.2 冲突处置（`group-identity.ts`）



| 动作                                | 语义                                                                                 | 代价                  |
| --------------------------------- | ---------------------------------------------------------------------------------- | ------------------- |
| 跳过 / 不建对                          | 默认行为                                                                               | 该后端不参与同步            |
| 采用远端实例身份（`adopt-remote-instance`） | 只改本组 `instanceId`，**不动任何数据**；可选 `rewriteRoots` 把所有副本的 `.meta/group.json` 一起改写为同一身份 | 本组与其它副本的关系需要重判      |
| 改写远端身份（`rewrite-remote-identity`） | 把本组身份写进远端                                                                          | 会让所有连到该远端的其它设备全部认不上 |

### 5.3 为什么身份文件不参与同步

`.meta/group.json` 一旦走普通内容同步（按 mtime 双向），身份就成了「谁最后写谁赢」，两台设备各持一个实例 ID 时会互相覆盖，远端 `instanceId` 反复变化，且全程绕开认领与冲突判定。所以它被固定排除，刷新墓碑排除表时也不得清掉（config-repo.ts:447-457）。



***

## 6. 同步机制（`SyncPair`）

### 6.1 一轮同步的顺序



```
emit('sync:start')       → 状态置 Syncing；已在 Syncing 则直接返回 lastResult（不重入）
preSyncHook()            → 例：processTombstones（先在副本上删真文件）；hookInProgress=true 期间抑制本地变更触发调度
  ↳ 取 source 快照 + target 快照
  ↳ 各自与上一轮快照比较，判断哪一侧发生了变化
  ↳ 无变化则本轮不产生任何变更（仍会走完 postHook）
  ↳ 逐路径决策：新增 / 修改 / 删除 / 冲突 / 跳过
postSyncHook()           → 例：processTombstones + updateTombstoneConfirmations（GC 不在这里，只在 flush 时做）
汇总 SyncResult → 写 lastError → totalSyncs++ → 状态回 Watching（有 pollTimers）或 Idle
```

### 6.2 变更与删除的判定



* 两侧快照**各自**与自己的上一轮快照比较（不再用合并快照），因此能保留「这条变更属于哪一侧」。

* 删除判定依赖上一轮快照：


  * 路径在 source 快照里有、现在没有 → 判定「source 删了」→ 在 target 上 `unlink`

  * 路径从未在 source 出现过、现在只存在于 target → 判定「target 新增」→ 拷回 source

* 冲突判定比「双方都改」更窄：只有 `mtime` 相同而 `size` 不同、且内容确实不同时才进冲突分支（`sync-pair.ts:697-717`）；随后 `DefaultConflictResolver.resolve(conflictStrategy)`，`source-wins` = 本地侧胜，仍会写 target 并 push 到 `conflicts[]`。`mtime` 不同的两侧修改走普通 diff，根本不会产生 conflict 事件。

### 6.3 过滤

`SyncFilter.excludePrefixes`（`isPathAllowed`），同一数组实例被所有 pair 共享，因此原地更新即生效。内容：



* 永久项：配置组只有 `/.meta/group.json`（456）；数据组是 `.config`/`nodes`/`shared`/`/.meta/group.json`（3450 = `CONFIG_ONLY_PREFIXES` + `GROUP_DESCRIPTOR_FILE`）

* 动态项：每个墓碑路径 + 其 `${path}/` 前缀（目录墓碑靠它挡住整棵子树的残留）

### 6.4 错误与状态



* 每个文件失败都进 `result.errors`（带 `path`），并发不中断整轮。

* `lastError` 取 `errors[0]`，消息形如 `<path>: <原因>`；**本轮无错误且此前有错误 → 清空**（这是本轮修的点，见 §10.2）。原实现永不清除，历史错误会长期挂在 UI 上，看起来像「每次连接都报错」。

* 轮询：`pollIntervalMs` 决定周期（默认 30 分钟）。检测器**恒为&#x20;**`IncrementalDetector`（99，构造函数里写死）；`FullDetector` 只在 `detector/full.ts` 与包导出里存在、包内无任何实例化，注释「手动模式用全量」已过期（§10.8）。



***

## 7. 墓碑账本



| 项     | 规则                                                                             | 代码                    |
| ----- | ------------------------------------------------------------------------------ | --------------------- |
| 存储    | `/.meta/tombstones/{encodeMetaPath}.json`，唯一的删除记录                              | group-meta.ts:688     |
| 字段    | `path / deletedAt / deletedBy / confirmedBy`，目录墓碑多一个 `type:"directory"`；字节顺序固定 | group-meta.ts:100     |
| 重建豁免  | 本地该路径 mtime 晚于 `deletedAt + 3s` → 视为「删除后被重新写入」，撤销墓碑                            | group-meta.ts:806     |
| 保留期   | 普通 24h，占位类（`.keep` / `.keep.mtime` / `*.mtime`）10min                           | group-meta.ts:60-78   |
| 确认    | `confirmedBy` 只写「本轮现场核对确实不存在」的后端；删除失败不算确认                                      | group-meta.ts:846-870 |
| GC    | 保留期到 + 全部后端确认 + **GC 前现场复核**仍不存在，才删墓碑（连各副本上的墓碑文件一起删）                           | group-meta.ts:873     |
| 写入即撤销 | 对同路径（或其后代的目录墓碑）写入成功时立刻删墓碑并刷新排除表，不等下一轮 pass                                     | config-repo.ts:894    |
| 排除表联动 | 墓碑路径进 `excludePrefixes`；**禁止**为 `.keep` 占位排除父目录（会连带挡掉真实数据）                     | config-repo.ts:861    |

为什么要 24h：GC 的确认只覆盖本实例配置的后端，覆盖不到别的设备 / 标签页；墓碑被提前回收，滞后端会把自己的旧文件当「本地新增」推回去，删除被复活。

墓碑体可能被并发写坏（截断 + 另一份开头）。解析策略是**保守**：坏体也当「该路径已删除」，路径从文件名反解；能恢复的多个 JSON 对象全部收下、按 path 合并（group-meta.ts:402-448）。



***

## 8. 版本与冲突归档



* `VersionStore`（数据组）：`/.meta/versions/{encoded}.json`。`/.meta/**` 与 `*.version` 自身不记版本；内容 hash 不变则不写；变了 `version+1` 并记 `author/hash/timestamp`。

* 配置组保留历史 `<file>.version` 侧车（`incrementVersion` + `writeVersionSidecar`）。

* `ConflictStore`：`/.meta/conflicts/{ts}_{path}/`，写 `source`、`target`、`meta.json`；`resolve` 把合并内容写回目标路径 + 记版本 + 写 `resolved`；旧目录 `/.meta/.conflicts` 仍可读（新目录优先）。



***

## 9. 同步 / 更新方法（当前代码支持的操作口径）

### 9.1 新增后端



| 组   | 步骤                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 配置组 | 初次连接：`createConfigRepo` → `setupSync`（含身份校验）→ 逐副本建对；之后新增：`addBackend(id,type,options)`（只去重，**不校验身份**）→ `setupReplica` → `syncMetaToReplicas` → watch |
| 数据组 | `group.addBackend(id,type,options)` → 建对 → 清旧墓碑 → 写 `.meta/backends/{id}.json` → 首同步 → 回刷引导副本                                                        |

写完之后应当做的核对（现在没有自动做）：`.meta/backends/{id}.json` 是否可读、`options` 是否完整、首同步 `errors` 是否为空、引导副本内联列表里是否有该 id。

### 9.2 修改后端参数（有 replace，但不是 CAS）

代码里已有两个 replace API，之前的「没有 updateBackend、只能 remove+add」不成立：



| API                                                                      | 位置                  | 实际行为                                                                                                     |
| ------------------------------------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------- |
| `ConfigRepo.replaceBackend(id,type,options,description)`                 | config-repo.ts:2459 | `createBackend` 探活 → 同端点去重检查 → 拆旧 pair / 状态 → 复用 `setupReplica` 重建；旧远端数据不迁移                              |
| `replaceAppDataGroupBackend(groupId,backendId,type,options,description)` | 3167                | `live.dispose()` → 删 map → 以 `backendsAreAuthoritative:true` 重建描述符 → 首同步；失败回滚旧描述符。注释明写「同 id 换参数 = 换远端目标」 |

但语义要说清：



* 两者都是**全量重建**，没有「旧描述符是否已被别人改过」的比对（无 CAS）；失败回滚只有数据组那一处有。

* 「同 id 换远端目标」后，**旧目标上的副本既不清理也不迁移**，等于永久分叉；要搬数据必须走 §9.3 的「加新 → 校验 → 删旧」。

* 因此 replace 可以用于「换目标」，但「同目标改参数」仍需 CAS —— 见 §11 P0-1。

### 9.3 换权威后端 / 迁移数据

顺序应为：新后端加入并完成首同步（此时两处都有数据）→ 校验 → 把读侧切到新后端 → 旧后端 removeBackend（带墓碑）→ 观察一轮确认无复活。反向（先删后加）会丢数据。

### 9.4 删除组

UI 的「删除组」应走 `ConfigRepo.removeAppDataGroup`（删引导副本 + 销毁实例）。**现状坑**：实测点掉 `remotestorage-datastruct` 后 UI 仍在列，说明删除未完成或列表未刷新（§10.6）。

### 9.5 身份冲突修复

用 UI 的三种处置之一（§5.2）。只对齐 `instanceId`、不动数据，是本轮实测验证过的安全解。

### 9.6 bootstrap 漂移对账（目前需手工）

比对两处：组根 `/.meta/backends/*.json` 的 id 集合 vs 配置组 `/.config/app-data-groups/{appId}/backends/*.json` 里该 `groupId` 的 id 集合。差异含义：



* 只在 `.meta/` 有 → 该设备已加后端，但引导目录没回刷（新设备发现不到）

* 只在引导目录有 → 可能是老数据，或该后端文件被删后未回刷



***

## 10. 注意事项与已知坑（附证据）

### 10.1 `readFile` 编码串导致读不出远端清单（已修）

`zen-fs-config/backend-registry.ts` 的 `readFile(path, ...args)` 只在 `args[0] === 'utf-8'` 时解码；onenav 读侧 `fetch.ts` 传 `'utf8'` → `JSON.parse(Uint8Array)` 抛错被内层 catch 吞掉 → `docs=0`。修为 `readText()` 兼容 `'utf-8'|'utf8'|'UTF-8'|{encoding}` + `ArrayBuffer` 兜底。提交 `zen-fs-config 56a14d1`。

### 10.2 `lastError` 历史错误永不清除（已修）

`sync-pair.ts` 原实现只写不清 → UI 长期挂一条旧 `Gitee API 400`，但抓包确认连接全程无非 2xx、无非 GET 请求。改为「本轮无 errors 且已有 lastError → 清空」，并把失败路径拼进消息。提交 `zen-fs-sync 50c3277`。

### 10.3 依赖补丁没打到真实产物（已修）

`patch-deps` 原先只改 `zen-fs-config/dist/index.js`（CJS），而 vite 实际用 ESM 分块。现在按包遍历 `dist/**/*.js|mjs`，4 条补丁全命中，未命中即构建失败。

### 10.4 UI 误报「未连接」（已修）

`configurator.ts:loadDataGroups` 对「描述符存在但会话内无实例」直接标未连接；实际是连接与配置组拉取的时序。改为对已有描述符补载一次（仍只加载不创建），失败才降级。

### 10.5 `.meta/backends/**` 参与同步 → 自指与三方写（**未改，设计级**）

后端描述符是「描述同步拓扑的文件」，却被同步引擎当成普通内容：



* 加后端时，新 pair 的首同步会把「描述它自己」的文件上传到它自己

* 两台设备改同一后端 → 先后两次修改 mtime 不同，走普通 diff，`source-wins` 直接覆盖，**不产生 conflict 事件**（冲突的门是 mtime 相同 + size 不同）；即使进了冲突分支，`handleConflict` 归档后内容仍被本地覆盖

* 删除要额外写墓碑兜底（§4.3 的理由）

* 一次拓扑变更要写权威文件 + 回刷引导副本，两处之间没有事务；引导副本可能滞后（少一个后端），读侧无法判断它是「旧投影」还是「真实列表」

### 10.5.1 远端 `.meta/tombstones` 被一个 “文件” 占住（已清除）

2026-11-21 实测：配置组 Gitee 副本连续报 `Gitee API 400: {"message":"文件新建失败"}`，14 条错误全部落在 `/.meta/tombstones/*.json`。



* 现场核对：远端 `weijia432/configs` 的 `.meta/tombstones` **是一个文件**（内容是一份 `{id:"remote-storage", groupType:"data-sync", ...}` 的组描述符），不是目录 → 任何墓碑写入都被 400 拒绝。

* 后果：所有删除意图（含删组、删后端）都无法同步，且错误反复出现在「最后错误」里。

* 处置：备份该文件到本地后，用 Contents API 删除；随后 `.meta/tombstones` 恢复为目录，12 个待写墓碑全部落盘，配置组同步对 `errCount=0`。

* 代码侧建议（P0）：`createFile` 遇 400 且 `getFileSha` 判不存在时，再逐级探测**祖先路径**是否被文件占用，抛「远端路径 X 被文件占用（应为目录）」而不是裸 400 —— 否则这类「目录被文件占位」只能靠人工翻仓库才发现。

### 10.6 实测遗留项



| 现象                                          | 现状                                                           | 待办                                                    |
| ------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| 冷启动先显示「未连接数据同步组」                            | 已修（onenav `43b333bf`）：读侧先等连接就绪 ≤35s，再按 `/struct` 内容选组；空组自愈改挂 | 观察首屏耗时可接受                                             |
| 点「🗑 删除组」后该组仍在列表                            | 删除本身已生效（描述符已删），但 UI 持有旧实例直到刷新                                | `zen-fs-config-ui` 缺 `data-group-deleted` 事件，删除后应重新解析 |
| 配置组同步偶发 `+6 ~2 skip:4 冲突 2`                 | 疑似 tombstone / 占位类文件                                         | 取该轮 `changes` 明细确认                                    |
| 「清除本页同步组配置」时 IDB `deleteDatabase` 被 blocked | 未二次确认是否卡死页面                                                  | 复现并用 `onblocked` 释放连接                                 |

### 10.7 admin 旧 `index.html` 白屏（已缓解）

浏览器 / 代理缓存旧 index，引用了已删除的 assets → 白屏。已加 `staleAssetReload` 插件：脚本 / 样式加载失败时带 `__r=<ts>` 强制重取（sessionStorage 计数 ≤2 次防死循环）。提交 `zen-fs-config-admin d71e822`。

### 10.8 代码注释与实现不符（已同步注释，无行为变更）

复核 `zen-fs-sync/src/sync-pair.ts` 时发现两处注释写的是旧行为：



| 位置              | 旧注释                   | 实现                                                 |
| --------------- | --------------------- | -------------------------------------------------- |
| 检测器初始化          | 「watch 模式用增量，手动模式用全量」 | 恒为 `IncrementalDetector`（99）；`FullDetector` 包内无实例化 |
| `lastError` 赋值处 | 「干净同步不清除，保持最后错误语义」    | 本轮无 errors 且已有 lastError → 清空（167-171）             |

两处注释已按实现改正（纯注释，不改行为）。这也说明「注释 / 文档」不能当作行为依据，判断一律以代码为准。



***

## 11. 改进方案（待批准，未落代码）

### P0 正确性（先修这几条，不改架构）



1. **replace 补 CAS 与旧目标处置**：`replaceBackend`(2459) / `replaceAppDataGroupBackend`(3167) 已经是「拆对重建」，但既不比对旧描述符是否被别人改过，也不处理旧远端残留。补：写前比对 `.version`/sha，不一致即拒绝并报「有人先改了」；旧目标按显式策略清理或迁移；数据组写权威描述符失败目前只 `log.warn`（4566-4568），应可感知。

2. **引导副本回刷后置**：数据组的写顺序固定为「建对 → 权威文件 → 首同步 → 校验 → 回刷引导副本」；失败时保留权威文件、把引导副本标记为 stale，而不是两边都写一半。

3. **写入校验**：`writeBackendMetaDescriptor` 只比 canonical 字节、不校验可读性；`writeBackendDescriptor`（配置组）写完只更新内存缓存、没有回读。补「回读 + JSON 解析 + id/type 一致」断言，失败即报错（现在最坏情况只是 `log.warn`）。

4. **删除组收尾（UI 侧）**：`removeAppDataGroup`（3357）本身已经 `dispose()` + 删新旧两条描述符路径（走 `deleteFile` 以便墓碑传播）；实测残留的原因是 UI 没有 `data-group-deleted` 事件、删除后不重新解析列表。

5. **探测三态化 + 空库必须由用户确认**（对应 §3.1.1）：**已完成** —— `probeGroupTypeDetailed` 用 `readGroupDescriptorStrict`，返回 `unreachable | empty | marked | occupied`；`unreachable` 抛 `RemoteUnreachableError` 且不建本地组；`empty` 抛 `NeedsInitError`（`code=NEEDS_INIT`），只有显式 `initGroupType`（旧调用方的 `groupType` 也视为显式）才建；入口包已导出 `probeGroupTypeDetailed` / 两个错误类。UI 侧也已改：`connectGroup` 首次不再预设 `groupType`，命中 `NEEDS_INIT` 时由 `views/init-confirm.ts` 弹「配置组 / 数据组 / 取消」。**剩余**：错误里还没有「根下已有文件数」；`localOnly` 显式标记未做；UI 弹窗要等新版 `zen-fs-config` 发版（或以补丁方式）才会在线上触发。

6. **运行时&#x20;**`addBackend`**&#x20;补归属校验**：初始化有 `bindBackendIdentity`（config 1683）/ `checkBackendOwnership`（data 3656），运行时新增完全没有（§3.1 第 7 条）。必须前置同样校验，`conflict` 即拒绝建对 —— 否则一个已被别的组占用的远端根会被运行时直接挂上来。

### P1 `.meta/backends/**` 退出自动同步，改直读直写

**做法**：把 `/.meta/backends` 加入 `PERMANENT_SYNC_EXCLUSIONS`（配置组与数据组各一处，且不被墓碑刷新逻辑清掉），随后的读 / 写改走「权威后端的通用 FS」。

**关键不是 API 形状，而是写哪个实例**：必须写后端自己的远端挂载（`remoteFS`），不能写被同步的本地镜像 —— 否则排除同步后写入永远到不了远端，形成静默分叉。

**必须一起决定的范围**（否则单独排除 backends 会留下不一致）：



| 路径                            | 建议           | 理由                                   |
| ----------------------------- | ------------ | ------------------------------------ |
| `.meta/backends/**`           | 排除，直读直写      | 拓扑描述文件，参与同步即自指                       |
| `.meta/group.json`            | 已排除，保持       | 身份唯一，不可「最后写赢」                        |
| `.config/app-data-groups/**`  | 排除自动同步，改显式回刷 | 它是投影，不是真相；写它就会触发配置组同步（Gitee 400 的来源） |
| `.meta/tombstones/**`         | **保持同步**     | 删除意图必须跨端可见，排除会让删除无法传播                |
| `.meta/versions/**`、`*.mtime` | 建议评估是否排除     | 它们是每设备本地事实，同步只会造成互相覆盖的抖动             |

**不做的部分**：不要把墓碑排除掉。删除账本是唯一跨端一致性来源，把它变成「本地事实」等于放弃删除传播。

### P2 唯一真相与投影（大部分已是现状）



1. 「唯一真相 = 组根 `/.meta/backends/{id}.json`」**已经实现**：`AppDataGroupImpl.init()` 里 `loadBackendDescriptors()` 优先读自身副本（4066-4074），目录不存在才用引导副本回填一次；`dedupeAppDataBackends()`（4125-4138）按端点去重、保留最旧。所以这一条不再是待办，剩余缺口是**引导副本回刷滞后、没有&#x20;**`stale`**&#x20;标记、没有对账**。

2. 引导副本只保留**引导必需**的最小信息（`id`、`type`、连接参数；`instanceId` 必须留），并能被判定为「过期投影」。

3. 读侧规则写死：目录存在 → 以目录为准；目录不存在 → 才允许用引导副本回填（`readBackendMetaDescriptors` 的 `null` vs `[]` 语义已经是这个形状）。

4. 提供一次显式「对账」动作（读两侧 → 输出差异报告 → 人工确认后单向覆盖），**不做自动收敛**：自动收敛在两个离线设备上等于随机丢一方。

### P3 协议与可观测



1. **写前 CAS**：比对 `.version`（配置组）或 `hash`（数据组 VersionStore），不一致即拒绝并报「有人先改了」。

2. **顺序固定**：写新 backend → 读回校验 → 切运行时 / 重建同步对 → 首同步校验 `errors` 为空 → 最后删旧。add-then-delete 只适用于「新增 / 迁移 / 替换」，不适用于「同 id 改参数」。

3. **两处写的自洽**：配置组是自指一处写；数据组跨两个远端根（数据组远端 + 配置组引导副本），中间态必须能被读侧解释（例如引导副本里带 `stale: true`）。

4. **可观测**：把「拓扑写入」单独计数与打点（成功 / 冲突 / 失败），不要混在 `result.errors` 里；UI 的「后端已跳过」需要能点开看原因（身份不符 / 连接失败 / CAS 失败）。

### 验收标准



* 加一个后端：配置组只产生 1 次权威写（再经同步对复制）；数据组 1 次权威写 + 1 次引导副本回刷；该后端首同步 `errors` 为空；另一台设备重连后能读到同一列表。

* 改一个后端参数（同 id、同目标）：`.version` 递增 1；引导副本与目录一致；并发方用旧值覆盖会被 CAS 拒绝。换目标时旧目标按显式策略清理或标注，不留静默分叉。

* 删一个后端：该后端远端上的 `.meta/backends/{id}.json` 消失；无墓碑复活；另一台设备不会把它拉回。

* 两台设备同时各加一个不同后端：远端最终是两个文件，不是一方覆盖另一方，也不是「谁后同步谁赢」。



***

## 12. 待决问题



1. 排除范围是否连带 `.config/app-data-groups/**` 与 `.meta/versions/**`（§11 P1 表格）。

2. 权威后端定谁：当前配置组源是 RemoteStorage（`/app_data/configs`），Gitee 是副本 —— 直读直写要选「哪一个是权威」，还是两边都写。

3. 引导副本的最小字段集：`token` 是否必须留在引导副本里（不留则新设备无法自动连上；留则凭证多一份落盘）。

4. 配置组残留的 `冲突 2` 是否属于墓碑 / 占位类噪声，需要先取明细再决定。

5. 「删除组」与「清除本地配置」两条清理路径是否会互相打架（IDB blocked 与列表残留可能是同一个根因）。