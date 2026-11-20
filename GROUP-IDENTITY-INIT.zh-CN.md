# 同步组实例身份（instanceId）初始化顺序 — 技术设计

| 项 | 内容 |
|---|---|
| 状态 | 库层已实施并测试通过（0.7.16 待发布）；UI 已接候选表与「设为该值」；admin 待接 |
| 版本 | v1.1（2026-11-20，更新实施记录） |
| 日期 | 2026-11-20 |
| 范围 | `zen-fs-config`（核心）、`zen-fs-config-ui`（呈现）、`zen-fs-config-admin`（诊断台） |
| 结论强度 | 代码事实标注文件与行号；「现状」段落均为实测证据 |

---

## 0. TL;DR

1. **身份必须先读后定**：`instanceId` 只能从「已有事实」里读出来；只有**所有候选都为空**时，才允许生成一次 UUID。
2. **一条逻辑组 = 一个 instanceId**：`kind` 与 `id` 共同定义「哪一条组」，`instanceId` 只是这条组在世界上的唯一标记。
3. **硬边界只有两条**：`kind` 不同（配置组 vs 数据组）、`id` 不同（另一个逻辑组）。这两条永远阻断，不可对齐、不可改写。
4. **`instanceId` 不一致不是错误，是「待裁决」**：绝不静默择一、绝不静默改写任何一方。把候选（本地 / 引导副本 / 每个远端根）全部摆到界面上，**由用户决定设成哪个值**，再执行。
5. **写回必须一次、且由用户触发**：用户确认后，一次动作完成「本地 `.meta/group.json` + 引导副本 + 本组所有 `kind`/`id` 相同的远端根」，逐根汇报成功/失败。

---

## 1. 现状（缺陷实证）

### 1.1 实际初始化顺序（数据组，0.7.14）

| # | 步骤 | 代码 |
|---|---|---|
| 1 | 建本地存储、墓碑/版本账本 | `config-repo.ts` `AppDataGroupImpl.init()` |
| 2 | 读 `.meta/backends/`（或从引导副本回填） | `loadBackendDescriptors()` |
| 3 | **定身份**：`createAppDataGroup` 无条件生成新 UUID | `config-repo.ts:2875` |
| 4 | 写本地 `.meta/group.json` | `writeOwnGroupDescriptor()` `:3423` |
| 5 | 逐后端 **才读远端** `group.json`，不同就跳过 | `checkBackendOwnership()` `:3456` |
| 6 | 建同步对（本地 `group.json` 此时才到达远端） | `init()` 后端循环 `:3760` |
| 7 | `createAppDataGroup` 把新 UUID 写进**共享引导副本** | `writeAppDataGroupDescriptorFile()` `:2894` |

配置组同源问题：`ensureGroupIdentity()` 读的是 `cachedFS`（本地缓存镜像），首次远端拉取未完成时读到空 → 直接生成（`:2536`）。

### 1.2 由此产生的失败链

```
环境 A 首次连接 → 生成 UUID_A → 写进根 R1 → 写进共享引导副本
环境 B 首次连接 → 生成 UUID_B → 读根 R1 发现 UUID_A → 冲突 → 跳过
                → 且把 UUID_B 写回共享引导副本（覆盖 UUID_A）
环境 A 下次打开 → 引导副本已是 UUID_B → 与根 R1 冲突 → 跳过
```

一组多根时更糟：每个根被不同环境在不同时间写，`R1` 与 `R2` 各持一个值，`instanceId` 是组级单值 → **无论采用哪个，另一个必然冲突**，对齐只是把冲突搬家。

### 1.3 线上实测（2026-11-20，onenav golf / admin golf）

同一逻辑组 `kind=data · id=remote-storage` 同时存在三个值：

| 位置 | instanceId |
|---|---|
| admin 本组 | `d25103f3-cdd4-401c-8bba-aaf3aaa99318` |
| RemoteStorage 根 `basePath=/app_data/golf` | `c5b50d9d-0174-4599-ba20-239d32375de2` |
| onenav 的 Gitee 根 | `665532a0-c5aa-43dc-844e-c4a74f82bea3` |

---

## 2. 不变式（实现必须满足）

| # | 不变式 | 违反后果 |
|---|---|---|
| I1 | 任何写入 `instanceId` 之前，必须先完成一次只读收集 | 新环境必然与远端冲突 |
| I2 | 一批候选中只要有 ≥1 个合法值，**禁止**生成新 UUID | 版本号式漂移，永远追不上 |
| I3 | 同一 `kind + id` 在任意时刻只应存在一个 `instanceId` | 多根互相打 |
| I4 | `kind` 或 `id` 不同 → 硬冲突，不参与身份裁决 | 把别的逻辑组的数据搬进来 |
| I5 | `instanceId` 不一致 → 只记录候选、不自动择一、不改写任何一方 | 静默覆盖别人的组身份 |
| I6 | 写回动作必须由用户触发；写失败逐条如实上报 | 假装成功，下一轮仍冲突 |

---

## 3. 正确顺序

```
阶段 0  准备        建本地存储 / 账本 / 读 .meta/backends        （不碰身份）
阶段 1  只读收集    本地 group.json、引导副本、每个后端远端 group.json
阶段 2  硬边界      kind 不同 / id 不同 → 该根出局（不进裁决）
阶段 3  定身份      见 §3.1 决策表；全部为空时才生成一次
阶段 4  落盘一次    本地 .meta/group.json（+ 引导副本）
阶段 5  裁决/对齐   不一致 → 生成候选清单，等用户决定；用户确认后一次写回
阶段 6  建同步对    必须在身份一致之后
阶段 7  增量        新增后端只跑 1/2/5，不再重新定身份
```

### 3.1 定身份决策表

| 候选情况 | 结果 |
|---|---|
| 本地与引导副本一致 | 用该值（无需用户介入） |
| 只有一个来源有值 | 用该值（无需用户介入） |
| 多个来源、互相一致，且远端一致 | 用该值（无需用户介入） |
| 本地/引导副本一致，远端不同 | 用本地值作为**本组当前身份**，但冲突保持「待裁决」：不静默改写远端 |
| 本地与引导副本不一致 | **不由代码择一**：两个都进候选清单，等用户决定 |
| 全部为空（真空仓库） | 生成一次 UUID，并认领各空根 |
| 全部为空，且**本组一个后端都没有** | **不生成、不落盘**：身份留空（`undefined`），首个后端加入时再按本表决定 |

「认领空根」（远端没有身份）仍属正常路径，不算静默改写。

**空组不预置身份**（I7）：身份只用来裁决「谁能同步某个远端根」。没有后端就没有可裁决对象，
此时生成并落盘一个随机 UUID 只会污染后续判断 —— 等用户真的接入一个「远端已有身份」的根时，
这个随机值会伪装成「本组既有身份」而被迫走一次人工裁决。所以空组的 `.meta/group.json` 只有
`kind` / `id`，没有 `instanceId`；`setGroupInstanceId()` 依旧是用户显式设置身份的唯一入口。

### 3.2 「待裁决」的表现

- 每个不一致的后端仍被跳过（不建同步对，不搬运数据）；
- 界面上按根列出：`backendId`、远端 `kind/id/instanceId`、本组 `kind/id/instanceId`；
- 外加一张**候选表**：每个候选值来自哪里（本地 / 引导副本 / 某个根）、值本身、持有它的根数；
- 用户可执行的动作只有两个：
  1. **设为该值**（`setGroupInstanceId(value)`）：把该值写成本组身份（本地 + 引导副本），并**可选**把本组所有 `kind`/`id` 相同的根统一成该值；
  2. **放弃本页本地身份**：清本页配置后重连（已有能力）。

---

## 4. API 影响

| 变更 | 说明 |
|---|---|
| `createAppDataGroup` | 不再无条件生成；已有引导副本 / 本地描述符时沿用其 `instanceId`，都没有则留空交给 `init()` 裁决 |
| `AppDataGroupImpl.init()` | 拆成「只读收集 → 裁决 → 落盘 → 建对」四段；`checkBackendOwnership` 消费已读快照，不再重复读 |
| `getIdentityCandidates()` | 新增：返回候选清单（来源、值、持有根数）供 UI 展示 |
| `setGroupInstanceId(value, { rewriteRoots })` | 新增：用户确认后的唯一写入口；逐根返回结果 |
| `resolveBackendConflict()` | 保留，作为「按单根对齐」的兼容路径；语义等同 `setGroupInstanceId(远端值, { rewriteRoots: false })` |

---

## 5. 存量修复

升级后首次连接时：

1. 若本地与各根已经一致 → 无任何提示；
2. 若不一致 → 只显示候选与冲突，不做任何写入；
3. 用户选一个值 → 一次写回，逐根汇报；失败的根保留原样并标注原因（常见：远端只读 / 无写权限）。

---

## 6. 测试计划

| 用例 | 期望 |
|---|---|
| 空世界新建组 | 生成一次 UUID，认领所有空根 |
| 远端已有身份、本地新建 | **不生成新值**，直接沿用远端值 |
| 引导副本有值、远端不同 | 用引导副本值，远端冲突保持待裁决，且**不写远端** |
| 本地与引导副本不一致 | 两者都进候选，`getGroupInstanceId()` 不静默取值 |
| 一组两根各持不同值 | 两根均冲突，候选表含两个值，持有根数分别为 1 |
| `setGroupInstanceId` + `rewriteRoots` | 所有同 `kind`/`id` 根被写为统一值，逐个返回成功 |
| `kind` 不同 | 永远拒绝，不写远端 |
| `id` 不同 | 永远拒绝，不写远端 |

---

## 7. 与既有文档的关系

- 组抽象与远端布局：见 [SYNC-GROUP-UNIFICATION.zh-CN.md](./SYNC-GROUP-UNIFICATION.zh-CN.md) §0.1；
- 本文只约束**身份从哪来、什么时候写、谁来决定**，不改变布局与同步对语义。

---

## 8. 实施记录（2026-11-20）

### 8.1 库层（`zen-fs-config`）

| 落点 | 实现 |
|---|---|
| `src/config-repo.ts` `createAppDataGroup()` | 先 `readAppDataGroupDescriptor(id)` 取引导副本的 `instanceId` 作为 `bootstrapInstanceId`；没有就留空，**不再无条件 `newGroupInstanceId()`** |
| `init()` 阶段 1 | 建实例 + `readGroupDescriptorStrict()` 预读每个远端根，只读不写；读失败记 `readError`、建实例失败记 `backendStates.error` 并跳过 |
| `init()` 阶段 2–3 | `finalizeIdentity(prepared)`：收集 `bootstrap` / `local` / 每个 `kind=data && id=groupId` 的远端候选；`instanceId` 为空的按 `bootstrap ?? local ?? 远端首个` 沿用，**全空才生成一次** |
| `init()` 阶段 4 | `writeOwnGroupDescriptor()`，字节相同则不写 |
| `init()` 阶段 6 | 建同步对消费同一份 `prepared` 快照，`checkBackendOwnership(instance, id, prefetched, readError)` 不再二次读远端 |
| 新增 `finalizeIdentity()` | 去重后多值 → `identityUnsettled = true` + `log.warn("waiting for the user to decide")`，**不择一、不改写** |
| 新增 `getIdentityCandidates()` / `isIdentityUnsettled()` | 候选清单（来源、值、持有根数）与待裁决标记 |
| 新增 `setGroupInstanceId(value, { rewriteRoots })` | 校验 UUID → 写本地 `group.json`（失败回滚）→ 回刷引导副本（失败只 warn）→ `rewriteRoots` 时逐根 read-判-写，`kind`/`id` 不同拒绝并给 `reason`，逐根返回 `before`/`ok`/`reason` |
| `checkBackendOwnership()` | 新增 `readError` 分支 → `conflict:'unreadable'` + `unreadable:true` + 原文错误信息 |
| `ConfigRepo` 侧 | 同名两个方法：候选只有 `source:'local'`（`kind:'config'`），写 `cachedFS` 的 `.meta/group.json`，`rewriteRoots` 时只改 `kind==='config'` 的副本根 |
| `DataSyncGroup`（弃用路径） | 同名两方法：只写本地描述符，`rewriteRoots` 恒为空，避免在无人群信息时伪造“对齐” |

### 8.2 测试（`src/__tests__/identity-init-order.test.ts`，8 条全通过）

1. 空世界只生成一次 UUID，重开后沿用；
2. 远端根已有身份 → 新建/重开都沿用，不生成新值；
3. 引导副本优先于本地；两者不一致 → `identityUnsettled = true`，远端保持原样；
4. 一组两根各持不同值 → 标记待裁决，两个根都不被改写；
5. `setGroupInstanceId(远端值, { rewriteRoots:true })` → 两根本地/远端统一，逐根汇报 `before`；
6. `kind`/`id` 不同的根 → `ok:false` + `reason` 含「另一个组」，该根保持原值；
7. 非法 UUID → `ok:false`、`roots: []`、不触碰任何文件；
8. 只改本组（`rewriteRoots:false`）→ 本地变更、远端不变；
9. **无后端的新建组** → `getGroupInstanceId()` 为 `undefined`、`.meta/group.json` 不含 `instanceId`；
10. **空组后加第一个“已有身份”的根** → 直接沿用它（不生成、不裁决、不冲突）。

全量基线：`31 → 32` 文件 / `272 → 282` 用例全绿；`tsc --noEmit` 无错误。

### 8.3 界面（`zen-fs-config-ui`）

- `src/core/api.ts`：`ConflictCapableHandle` 增 `getIdentityCandidates?` / `isIdentityUnsettled?` / `setGroupInstanceId?`（全部可选，兼容 0.7.15），配套 `IdentityCandidateInfo` / `SetGroupInstanceIdOutcome` 与三个包装函数；
- `src/core/configurator.ts`：新增「实例 ID 不一致」块 —— 列出每个来源的**完整** UUID、持有根数、本组当前值，每个不同值给两个按钮（`本组设为该值（不改远端）` / `设为该值并统一本组所有根`）；确认框写明写入范围与将被改写的根，执行后逐根汇报 ✔/✘ 并刷新；
- 只有候选去重后 >1 个值时才渲染，单一值不占版面。

### 8.4 尚未完成

- admin 诊断台展示候选表（只读）；
- 配置组 `ensureGroupIdentity()` 仍读 `cachedFS` 首次读空即生成，需按同一顺序改造；
- 版本发布与三仓部署（0.7.16 / 0.3.34）。

