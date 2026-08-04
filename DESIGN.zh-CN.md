# zen-fs-config — 初始化与同步流程文档

本文档描述 zen-fs-config 的初始化流程、同步引擎内部机制、墓碑删除传播、后端去重等核心逻辑。

---

## 1. 初始化流程

### 1.1 Config-Sync Group（`createConfigRepo`）

```
createConfigRepo('my-app', options?)
  │
  ├─ 1. 创建 IndexedDB 后端（始终创建，ID = 'local-idb'）
  │     storeName = options.idbStoreName || `zen-fs-config-${appId}`
  │
  ├─ 2. 确保 /.meta/ 目录存在
  │
  ├─ 3. 写入 /.meta/group-type = "config-sync"（如不存在）
  │
  ├─ 4. 迁移旧版 .meta/backends.json → .meta/backends/*.json（如存在）
  │
  ├─ 5. 如果 options.backendInfo 提供了远程后端：
  │     ├─ 生成副本 ID（options.primaryBackendId 或自动生成）
  │     ├─ 去重检查：相同 type + options（稳定键）是否已注册？
  │     └─ 如非重复，写入描述符到 .meta/backends/{replicaId}.json
  │
  ├─ 6. 读取 .meta/backends/ 下所有后端描述符
  │     └─ 去重：移除重复项（相同 type + options，不同 ID）
  │        ├─ 直接删除所有副本上的重复文件
  │        └─ 创建墓碑 + 删除本地文件
  │
  ├─ 7. 确定 nodeId（显式参数 > 自动生成）
  │
  ├─ 8. 创建最终 ConfigRepo 实例（主后端 = 'local-idb'）
  │
  ├─ 9. setupSync：为每个副本后端：
  │     ├─ 创建后端实例（如 Gitee、RemoteStorage）
  │     ├─ 创建 SyncPair（IndexedDB ↔ 副本，双向同步）
  │     ├─ 注册冲突处理器
  │     └─ 注意：此时不调用 watch()（原因见 §1.2）
  │
  ├─ 10. 从 IndexedDB 加载配置缓存（快速，纯本地）
  │
  ├─ 11. initialSyncAndDedup() — 仅当存在副本时执行：
  │     ├─ unwatchAll()      — 安全措施：清除可能存在的过期快照
  │     ├─ syncAll()         — 完整双向同步（无缓存快照
  │     │                      → 每个文件都会被比较，远端独有文件
  │     │                      会被拉取到本地）
  │     ├─ readAllBackendDescriptors() — 对从远端拉取的重复描述符去重
  │     │   ├─ 直接删除所有副本上的重复文件
  │     │   └─ 为去重的描述符创建墓碑
  │     ├─ processTombstones() — 在所有副本上删除被去重的文件
  │     └─ watchAll()       — 开始监听后续变更
  │         （此时快照反映的是完全同步后的状态）
  │
  ├─ 12. syncMetaToReplicas() — 后台推送 .meta/ 变更
  │     （watcher 已在运行，这只是为了加速初始传播）
  │
  └─ 13. 返回 ConfigRepo 实例
```

### 1.2 为什么必须"先同步再 watch"（关键设计决策）

同步引擎（`zen-fs-sync`）使用**基于快照的变更检测**。当对 SyncPair 调用 `watch()` 时，会触发 `buildInitialSnapshots()`，该函数会：

1. 构建源端（IndexedDB）的快照 — 遍历所有文件，记录 `path`、`size`、`mtimeMs`
2. 构建目标端（远程后端）的快照 — 同样的过程
3. **合并**两端快照为一个 Map（`source ∪ target`）
4. 将合并后的快照缓存为 `sourceSnapshots`

在下一次 `syncAll()` 时，`syncBidirectional()` 会将当前合并快照与缓存快照比较。如果所有路径、大小、修改时间都匹配 → **判定"无变化" → 跳过同步**。

**问题所在**：`buildInitialSnapshots()` 只是*读取*文件元数据 — 它**不会复制任何文件**。如果远端有本地没有的文件（例如其他节点写入的重复后端描述符），合并快照会从远端侧包含这些文件。后续同步看到"合并快照中已有此文件"就跳过了 — 文件从未被真正复制到本地，本地的去重逻辑也永远不会执行。

**修复方案**：始终在 `watch()` **之前**执行完整的 `syncAll()`。没有缓存快照时，`syncBidirectional()` 会进行完整比较并复制所有缺失的文件。同步完成后，`watch()` 从已一致的状态构建快照。

此模式在三个地方应用：
- `createConfigRepo()` → `initialSyncAndDedup()`（同步 → 去重 → watch）
- `addBackend()` → 先 `syncMetaToReplicas()` 再 `watch()`（同步 → watch）
- `AppDataGroupImpl.connect()` → 先 `syncAll()` 再 `watchAll()`（同步 → watch）

### 1.3 `flush()` — 手动同步触发

```
flush()
  │
  ├─ 1. processTombstones()
  │     遍历 /.meta/.deleted/ 中的每个墓碑：
  │     ├─ 删除主后端上的实际文件（防止被同步重新创建）
  │     ├─ 删除所有副本上的实际文件
  │     └─ 删除所有副本上的版本 sidecar 文件
  │
  ├─ 2. syncAll()
  │     对每个 SyncPair（IndexedDB ↔ 副本）：
  │     ├─ 构建两端当前快照
  │     ├─ 与缓存快照比较（如有）
  │     ├─ 检测变更：Created / Modified / Deleted
  │     ├─ 解决冲突（source-wins 策略）
  │     └─ 按需双向复制文件
  │
  ├─ 3. readAllBackendDescriptors() — 同步后去重
  │     同步可能从远端拉取了重复的后端描述符。
  │     重新执行去重以捕获并移除它们。
  │     ├─ 直接删除所有副本上的重复文件
  │     └─ 为去重的描述符创建墓碑
  │
  ├─ 4. processTombstones() — 处理步骤 3 产生的新墓碑
  │
  ├─ 5. updateTombstoneConfirmations()
  │     将每个墓碑标记为已由所有副本后端确认
  │
  ├─ 6. gcTombstones()
  │     移除已由拓扑中所有后端确认的墓碑
  │
  └─ 返回 SyncResult[]（每个同步对一个）
```

### 1.4 墓碑删除传播机制

当通过 `deleteFile(path)` 删除文件时：

```
deleteFile('/.meta/backends/old-backend.json')
  │
  ├─ 1. 写入墓碑：/.meta/.deleted/++meta__backends__old-backend++json.json
  │     { path, deletedAt, deletedBy, confirmedBy: [primaryBackendId] }
  │
  ├─ 2. 删除主后端上的实际文件（IndexedDB）
  │
  └─ 3. 删除主后端上的版本 sidecar（.old-backend.json.version）
```

在下一次 `processTombstones()`（由 `flush()` 或 `initialSyncAndDedup()` 调用）时：

```
对每个墓碑：
  ├─ 删除主后端上的文件（防止同步重新创建）
  ├─ 删除所有副本上的文件
  ├─ 删除所有副本上的版本 sidecar
  └─ 墓碑文件本身通过 syncAll() 同步到副本
     → 后加入的副本看到墓碑后会删除对应文件
```

**为什么需要墓碑？** 没有墓碑的话，双向同步会将本地已删除的文件视为"缺失 → 需要从远端复制"。墓碑明确表示"此文件是被有意删除的"，使所有副本尊重删除操作。墓碑在所有后端确认收到后被垃圾回收。

### 1.5 后端去重逻辑

当 `readAllBackendDescriptors()` 检测到两个后端具有相同的 `type` + `options`（使用稳定键排序）但不同 ID 时：

```
检测到：rs-1 和 rs-2 具有完全相同的 type + options
  │
  ├─ 1. 保留 mtime 最早的（最先创建的）
  │
  ├─ 2. 对每个重复项：
  │     ├─ 直接删除所有副本上的描述符文件
  │     │   （防止同步将其拉回）
  │     ├─ 删除所有副本上的版本 sidecar
  │     └─ 创建墓碑 + 删除本地文件
  │
  └─ 3. 返回去重后的列表（重复项已移除）
```

稳定键函数（`backendDedupKey`）递归排序对象键，因此 `{ token: 'a', owner: 'b' }` 和 `{ owner: 'b', token: 'a' }` 会生成相同的键，被正确检测为重复。

### 1.6 动态后端管理

**`addBackend(id, type, options)`**：

```
  ├─ 1. 去重检查：拒绝相同 type+options 的已注册后端
  ├─ 2. 创建后端实例
  ├─ 3. 写入描述符到 .meta/backends/{id}.json
  ├─ 4. 创建 SyncPair（IndexedDB ↔ 新副本，双向同步）
  ├─ 5. syncMetaToReplicas() — 先完整同步（拉取 + 推送）
  └─ 6. watch(pairId) — 同步完成后再开始监听
```

**`removeBackend(id)`**：

```
  ├─ 1. 直接删除远程后端上的描述符文件
  │     （必须在移除同步对之前执行 — 否则无法访问远程）
  ├─ 2. 删除远程上的版本 sidecar
  ├─ 3. 创建墓碑 + 删除本地描述符文件
  ├─ 4. 移除同步对（停止监听 + 释放资源）
  ├─ 5. 从 replicaBackends 映射中移除
  ├─ 6. 释放后端实例
  ├─ 7. processTombstones() — 向剩余副本传播删除
  └─ 8. flush() — 同步 + GC 墓碑
```

### 1.7 Watch 模式（自动同步）

初始化完成后，每个 SyncPair 以 **watch 模式**运行，采用混合变更检测：

```
watch() 触发：
  │
  ├─ 1. 注册 onChange 回调（如后端支持）
  │     本地后端（IndexedDB）推送变更通知
  │     → 触发防抖同步（默认 300ms）
  │
  ├─ 2. buildInitialSnapshots()
  │     ├─ 双向：合并 source + target 快照
  │     └─ 单向：仅快照 source
  │
  └─ 3. 启动轮询定时器（如后端支持 shouldSync）
       ├─ 远程后端每 pollIntervalMs（默认 30 分钟）轮询 shouldSync()
       └─ 兜底：如无 onChange 且无 shouldSync，按间隔轮询
```

**状态守卫**：如果在 `buildInitialSnapshots()`（异步操作）执行期间调用了 `unwatch()`，快照会被丢弃 — 不会被缓存。这防止了过期快照导致同步跳过。

**快照比较** 在 `syncBidirectional()` 中的逻辑：
1. 构建两端当前快照
2. 合并为 `currentMerged = source ∪ target`
3. 与缓存的 `sourceSnapshots` 比较：
   - 如果所有路径 + mtime + size 都匹配 → "无变化" → 跳过
   - 否则 → 执行完整差异比较和文件操作
4. 缓存 `currentMerged` 供下次比较

### 1.8 独立 Data-Sync Group（`createDataSyncGroup`）

```
createDataSyncGroup('my-app', options?)
  │
  ├─ 1. 连接到用户提供的后端（options.backendInfo）
  │
  ├─ 2. 读取 /.meta/group-type
  │     ├─ "data-sync" → 已有组，读取 .meta/backends/ 获取所有数据后端
  │     ├─ 不存在     → 新组，写入 /.meta/group-type = "data-sync"
  │     └─ "config-sync" → 错误：这是配置同步后端，请使用 createConfigRepo()
  │
  ├─ 3. 创建 IndexedDB 作为本地主后端（用于离线访问）
  │
  ├─ 4. 建立同步：IndexedDB ↔ 每个数据后端（双向）
  │     注意：此时不 watch — 先同步
  │
  ├─ 5. syncAll() — 从远程后端拉取数据
  │
  ├─ 6. watchAll() — 同步完成后再开始监听
  │
  └─ 7. 返回 DataSyncGroup 句柄，提供直接 fs 访问
```

### 1.9 统一入口（`connect`）

`createConfigRepo` 和 `createDataSyncGroup` 是底层工厂函数。推荐使用 `connect` 入口，它自动检测组类型并分派到相应的工厂：

```
connect('my-app', options?)
  │
  ├─ 1. 连接到用户提供的后端（options.backendInfo）
  │
  ├─ 2. 读取 /.meta/group-type
  │
  ├─ "config-sync" → 分派到 createConfigRepo()
  │                  返回 { groupType: "config-sync", repo }
  │
  ├─ "data-sync"   → 分派到 createDataSyncGroup()
  │                  返回 { groupType: "data-sync", dataGroup }
  │
  └─ 不存在        → 新的空后端
     ├─ options.groupType === "data-sync" → 分派到 createDataSyncGroup()
     ├─ options.groupType === "config-sync"（或省略）→ 分派到 createConfigRepo()
     └─ 默认：config-sync
```

---

## 2. 同步引擎内部机制

### 2.1 SyncPair 状态机

```
                ┌─────────┐
                │  Idle   │ ← 初始状态 / unwatch 后
                └────┬────┘
                     │ watch()
                     ▼
                ┌──────────┐
        ┌──────│ Watching │ ← 监听中（有轮询定时器）
        │       └────┬─────┘
        │            │ sync() 或 onChange 触发
        │            ▼
        │       ┌──────────┐
        │       │ Syncing  │ ← 同步进行中
        │       └────┬─────┘
        │            │ 同步完成
        │            ▼
        └────────→ Watching
                     │ unwatch()
                     ▼
                   Idle

  特殊状态：
  Disposed — 已销毁，不可恢复
```

### 2.2 双向同步算法（`syncBidirectional`）

```
syncBidirectional()
  │
  ├─ 1. 并行构建两端快照
  │     srcSnap = buildSnapshot(source)  → Map<path, {size, mtimeMs}>
  │     tgtSnap = buildSnapshot(target)  → Map<path, {size, mtimeMs}>
  │     如任一端不可达（返回 null）→ 跳过同步
  │
  ├─ 2. 快照快速比较
  │     currentMerged = new Map([...srcSnap, ...tgtSnap])
  │     如有缓存 sourceSnapshots：
  │       如 currentMerged 与 sourceSnapshots 完全一致（路径+mtime+size）
  │       → 判定"无变化"，直接返回（跳过同步）
  │
  ├─ 3. 缓存当前合并快照
  │     sourceSnapshots = currentMerged
  │
  ├─ 4. 遍历所有路径（srcSnap ∪ tgtSnap 的并集）
  │     对每个路径：
  │     ├─ 两端都有：
  │     │   ├─ mtime/size 相同 → 跳过
  │     │   └─ mtime/size 不同 → 冲突检测
  │     │       ├─ 内容相同 → 跳过（仅更新 mtime）
  │     │       └─ 内容不同 → 冲突解决（source-wins / merge）
  │     ├─ 仅 source 有 → 复制到 target（Created）
  │     └─ 仅 target 有 → 复制到 source（反向 Created）
  │
  └─ 5. 返回 SyncResult
       { filesCreated, filesUpdated, filesDeleted, filesSkipped, conflicts }
```

### 2.3 变更检测策略

同步引擎使用**混合变更检测**模式：

| 检测方式 | 适用场景 | 触发机制 | 延迟 |
|---------|---------|---------|------|
| `onChange` 回调 | 本地后端（IndexedDB） | 文件写入后主动推送 | 300ms 防抖 |
| `shouldSync` 轮询 | 远程后端（Gitee、RemoteStorage） | 定时检查远端是否有变更 | 30 分钟 |
| 兜底轮询 | 两端都不支持上述接口 | 定时全量同步 | 30 分钟 |

`onChange` 优先级最高：本地写入后 300ms 防抖触发同步，同时将变更推送到所有副本。`shouldSync` 用于检测远端的外部变更（其他节点写入的文件）。

### 2.4 冲突解决

当同一文件在两端都有修改且内容不同时：

| 策略 | 行为 |
|-----|------|
| `source-wins`（默认） | 源端内容覆盖目标端，目标端内容归档到 `.meta/.conflicts/` |
| `target-wins` | 保留目标端内容，源端内容归档 |
| `merge` | JSON 深度合并，双方原始内容都归档；非 JSON 文件回退为 source-wins |

冲突归档保证任何一方的内容都不会丢失，始终可以从 `.meta/.conflicts/` 恢复。

---

## 3. 版本管理

### 3.1 Sidecar 版本文件

每个配置文件都有配套的版本文件：

```
/app-a/db.json              →  配置内容
/app-a/.db.json.version     →  版本元数据
```

版本文件内容：
```json
{
  "version": 5,
  "hash": "sha256:a1b2c3d4...",
  "author": "app-a/server-1",
  "timestamp": 1689686400000
}
```

### 3.2 版本递增

每次写入时：
1. 读取当前版本文件（如存在）
2. 版本号 +1
3. 计算新内容的 SHA-256 哈希
4. 设置 author 为当前实例的 `{appId}/{nodeId}`
5. 先写配置文件，再写版本文件

崩溃恢复：启动时如果版本文件中的哈希与实际文件内容不匹配，自动递增版本号并更新哈希。

---

## 4. 文件系统结构

### 4.1 Config-Sync Group

```
/
├─ .meta/                               [同步到副本]
│  ├─ group-type                        组类型标记："config-sync"
│  ├─ backends/                         后端拓扑（每个后端一个文件）
│  │  ├─ local-idb.json                 { id, type, options, description }
│  │  ├─ gitee-prod.json
│  │  └─ ...
│  ├─ app-data-groups/                  数据同步组引用（按应用）
│  │  └─ {appId}/
│  │     └─ {dataGroupId}.json
│  ├─ .deleted/                         删除墓碑（跨后端删除传播）
│  │  └─ {encoded-path}.json
│  └─ .conflicts/                       冲突归档（双方内容都保存）
│
├─ {appId}/                             [双向同步]
│  ├─ db.json
│  └─ .db.json.version                  版本 sidecar 文件
│
├─ shared/                              [双向同步，跨应用共享]
│  └─ feature-flags.json
│
└─ nodes/                               [默认不同步]
   └─ {nodeId}/
      ├─ local.json                     节点本地配置
      └─ env.json
```

### 4.2 目录语义

| 目录 | 同步方向 | 冲突风险 | 用途 |
|-----|---------|---------|------|
| `/{appId}/` | 双向（主 ↔ 副本） | 低（单设备） | 应用私有配置 |
| `/shared/` | 双向 | 可能（多写入者） | 跨应用共享配置 |
| `/nodes/` | 无（默认） | 无 | 节点本地配置 |
| `/.meta/` | 双向 | 无（拓扑文件） | 后端拓扑、墓碑、冲突归档 |

## 5. 同步中的 mtime 保留

### 5.1 问题

同步引擎在将文件从源端复制到目标端时，调用 `writeFile(path, data)`。目标后端会设置自己的 mtime（通常是 `Date.now()`），丢失源文件的原始 mtime。这导致下一个同步周期检测到"已修改"的文件（源 mtime ≠ 目标 mtime），每次同步都触发不必要的复制。

### 5.2 解决方案

在 `SyncableFS` 接口上添加可选的 `writeFileWithMtime` 方法，未实现时自动回退到 `writeFile`：

```typescript
interface SyncableFS {
  // ... 现有方法 ...

  /**
   * 可选：写入文件时保留精确 mtime。
   * 如果实现此方法，同步引擎将使用它代替 writeFile，
   * 传入源文件的 mtime 使目标端可以保留。
   * 不支持精确 mtime 的后端不应实现此方法 —
   * 同步引擎会回退到普通 writeFile。
   */
  writeFileWithMtime?(path: string, data: string | Uint8Array, mtime: number): Promise<void>;
}
```

### 5.3 同步引擎（zen-fs-sync）

中心化的辅助函数处理回退逻辑：

```javascript
async function writeFileWithMtimeFallback(fs, path, data, mtimeMs) {
  if (mtimeMs !== undefined && typeof fs.writeFileWithMtime === "function") {
    await fs.writeFileWithMtime(path, data, mtimeMs);
  } else {
    await fs.writeFile(path, data);
  }
}
```

此辅助函数在 `copyFile()`、`syncOneWay()` 和 `writeFileBoth()` 中使用。源文件的 mtime 通过 `stat()` 获取，然后传递给目标端。

### 5.4 适配器（zen-fs-config）

所有三个 `SyncableFS` 适配器都实现了 `writeFileWithMtime`：

| 适配器 | 实现方式 |
|---|---|
| `backendToSyncableFS` | 将 `{ mtime }` 作为 options 传给 `backend.writeFile()` — 后端的 `writeFile` 调用 `touch()` 设置 mtime |
| `zenfsPromisesToSyncableFS` | 先 `promises.writeFile()`，再用 `promises.utimes()` 作为回退（部分 VFS 后端不支持 writeFile 中传 mtime） |
| `cachedFSToSyncableFS` | 将 `{ mtime }` 作为 options 传给 `cached.writeFile()` — mtime 透传到底层后端 |

### 5.5 RemoteStorage 后端（zen-fs-remotestoragejs）

`writeFileWithMtime` 委托给 `writeFile(path, data, { mtime })`，后者写入 `.mtime` sidecar 文件以保留毫秒级精度的 mtime（详见 RemoteStorage DESIGN.md §2）。

### 5.6 数据流

```
源文件: /app-a/db.json (mtime=1700000000123)
  │
  ├─ 同步引擎: stat("/app-a/db.json") → mtimeMs=1700000000123
  ├─ 同步引擎: readFile("/app-a/db.json") → data
  ├─ 同步引擎: writeFileWithMtimeFallback(target, "/app-a/db.json", data, 1700000000123)
  │   ├─ target 有 writeFileWithMtime? → 是 → target.writeFileWithMtime(path, data, 1700000000123)
  │   │                                    → backend.writeFile(path, data, { mtime: 1700000000123 })
  │   │                                    → touch(path, { mtimeMs: 1700000000123 })
  │   └─ target 有 writeFileWithMtime? → 否 → target.writeFile(path, data) [回退]
  │
  └─ 目标文件: /app-a/db.json (mtime=1700000000123) ← 已保留！
     → 下次同步: source.mtimeMs === target.mtimeMs → 跳过（无多余复制）
```
