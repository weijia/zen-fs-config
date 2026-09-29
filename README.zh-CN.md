# zen-fs-config

基于 ZenFS 的分布式配置管理库。以 IndexedDB 为本地主后端（offline-first），用户提供的远程后端作为副本自动同步。支持应用隔离、共享空间、节点本地配置和冲突安全。

> **架构方向（REQUIREMENTS §9 D2）**：核心采用**通用同步组（GenericSyncGroup）基类 + 两种类型实现**——`config-sync`（版本化/墓碑/冲突，并承载 `.meta/app-data-groups/`）与 `data-sync`（纯文件同步，可经配置同步组以 app-data-groups 纳管）；**后端类型管理与数据后端信息写入仍留在核心 `zen-fs-config`（UI 仅做呈现）**。本文档描述的是**当前实现（两类 repo）**，目标架构以 D2 为准。

**GitHub**: https://github.com/weijia/zen-fs-config
**NPM**: `zen-fs-config`
**设计文档**: [DESIGN.md](./DESIGN.md)

## 功能特性

- **离线优先** — IndexedDB 始终是主后端；读写在无网络时也能工作
- **多后端同步** — 可添加任意数量的远程副本（Gitee、GitHub、RemoteStorage、WebDAV 等），自动双向同步
- **应用隔离** — 每个 appId 拥有独立的配置空间
- **共享空间** — `/shared/` 目录在所有设备间同步
- **节点本地配置** — 按 `/nodes/{nodeId}/` 存放的每设备配置，随主同步对双向同步到后端（各节点以 `nodeId` 子目录隔离）
- **自描述拓扑** — 后端配置以文件形式存于 `.meta/backends/`，重新打开仓库时自动恢复全部状态

## 安装

```bash
# 核心依赖（始终需要）
npm install zen-fs-config @zenfs/core @zenfs/dom zen-fs-sync

# 可选云后端 —— 对等依赖，仅安装你实际用到的
npm install zen-fs-github           # GitHub（仓库/分支）副本
npm install zen-fs-gitee            # Gitee（仓库/分支）副本
npm install zen-fs-remotestoragejs # RemoteStorage 副本
```

> `@zenfs/dom` 提供 IndexedDB 后端（浏览器环境必需）。`zen-fs-cache` 为可选依赖。
>
> **云后端是可选对等依赖，由你（使用者）自行安装，`zen-fs-config` 并不打包它们。** 核心会**预注册** `GitHub`、`Gitee`、`RemoteStorage` 这三种后端**类型**（因此你可以直接把 `type: 'Gitee'` 等传给 `addBackend`/`connect`，无需调用 `registerBackend`），但**不包含它们的实现包**。你必须自己 `npm install` 对应包；否则 `createBackend()` 会抛出明确的"未安装——请运行 `npm install <pkg>`"提示。这样可保持核心包体积精简，也不会强制所有人都带上网络依赖。

## 通过 `<script>` 标签直接使用（无需构建）

包内置了一个自包含的浏览器构建 `dist/zen-fs-config.js`，它把**核心**依赖（`@zenfs/core`、`@zenfs/dom`、`zen-fs-sync`、`zen-fs-cache`）打包在一起，并将库挂载到全局变量 `window.ZenFSConfig`。无需 npm install、无需打包工具，直接放入任意 HTML 页面即可。**云后端（GitHub / Gitee / RemoteStorage）并不包含在自包含包内**——见下方小节，了解如何在 `<script>` 模式下启用它们（**无需 import map**）。

```html
<script src="https://unpkg.com/zen-fs-config/dist/zen-fs-config.js"></script>
<script>
  (async () => {
    const { connect } = window.ZenFSConfig;

    // 自动创建 IndexedDB 主后端
    const { repo } = await connect('my-app');

    repo.setConfig('greeting.json', { msg: 'hello' });
    const cfg = await repo.getConfig('greeting.json');
    console.log(cfg); // { msg: 'hello' }
  })();
</script>
```

> 浏览器构建包含纯 JS 实现的 SHA-256 回退，因此即使在 `crypto.subtle` 不可用的非安全上下文（普通 HTTP）中，版本追踪也能正常工作。

### 在 `<script>` 模式下启用云后端（GitHub / Gitee / RemoteStorage）—— **无需 import map**

自包含核心包**不包含**云后端实现——它们是可选对等依赖，为保持包体积精简而被排除在核心之外。好消息是：**三个云包现在都已发布浏览器全局（UMD）构建**，因此在无编译的 `<script>` 页面里，你只需用普通的 `<script>` 标签即可启用它们——**无需 import map、也无需打包器**：

```html
<script src="https://unpkg.com/zen-fs-gitee/dist/zen-fs-gitee.global.js"></script>
<script src="https://unpkg.com/zen-fs-github/dist/zen-fs-github.global.js"></script>
<script src="https://unpkg.com/zen-fs-remotestoragejs/dist/zen-fs-remotestoragejs.global.js"></script>
<script src="https://unpkg.com/zen-fs-config/dist/zen-fs-config.js"></script>
<script>
  (async () => {
    const { connect } = window.ZenFSConfig;
    const { repo } = await connect('my-app', {
      backendInfo: { type: 'Gitee', options: { token, owner, repo, branch } },
    });
  })();
</script>
```

构建文件 → 全局变量映射：
- `zen-fs-gitee` → `window.ZenFSGitee`（构建文件：`dist/zen-fs-gitee.global.js`）
- `zen-fs-github` → `window.ZenFSGitHub`（构建文件：`dist/zen-fs-github.global.js`；v1.1.3+）
- `zen-fs-remotestoragejs` → `window.ZenFSRemoteStorage`（构建文件：`dist/zen-fs-remotestoragejs.global.js`）

`zen-fs-config` 会自动识别这些全局变量（`window.ZenFSGitee` / `window.ZenFSGitHub` / `window.ZenFSRemoteStorage`）并直接使用，跳过裸 `import()`。由于三个包都声明了 `browser`/`unpkg` 字段，裸包名 URL（如 `https://unpkg.com/zen-fs-github`）同样会返回全局构建——如果你愿意，也可以把前面三行 `<script>` 简写成裸 URL。

**备选 —— import map（可选，仅当你需要 ESM 语义时）**。如果不想用全局脚本，也可以把裸包名映射到 ESM CDN，由包内的动态 `import()` 去解析。这完全是可选的——上面的 UMD 全局方式更简单，且不需要 import map：

```html
<script type="importmap">
{
  "imports": {
    "zen-fs-github": "https://esm.sh/zen-fs-github",
    "zen-fs-gitee": "https://esm.sh/zen-fs-gitee",
    "zen-fs-remotestoragejs": "https://esm.sh/zen-fs-remotestoragejs"
  }
}
</script>
<script src="https://unpkg.com/zen-fs-config/dist/zen-fs-config.js"></script>
<script>
  (async () => {
    const { connect } = window.ZenFSConfig;
    const { repo } = await connect('my-app', {
      backendInfo: { type: 'Gitee', options: { token, owner, repo, branch } },
    });
  })();
</script>
```

## 快速开始

### 1. 初始化（零参数）

```typescript
import { connect } from 'zen-fs-config';

// 不传任何后端参数，自动创建 IndexedDB 本地主后端
const { repo } = await connect('my-app');

// 读写配置（同步 API，从 IndexedDB 读取）
repo.setConfig('/database', { host: 'localhost', port: 5432 });
const db = repo.getConfig<{ host: string; port: number }>('/database');
```

### 2. 设置新的配置

```typescript
repo.setConfig('/cache', { ttl: 3600, maxSize: '100MB' });
repo.setConfig('/feature-flags', { newUI: true, beta: false });
```

### 3. 增加数据后端（副本）

```typescript
// GitHub / Gitee / RemoteStorage 已由核心预注册，无需 registerBackend。
// 先安装对应包（如 `npm install zen-fs-gitee`，见「安装」），然后：
await repo.addBackend('gitee-prod', 'Gitee', {
  token: 'your-token',
  owner: 'your-name',
  repo: 'config-repo',
  branch: 'main',
}, '生产环境 Gitee 配置仓库');
// ↑ 自动与本地 IndexedDB 主后端双向同步
```

### 4. 自动同步

```typescript
// setConfig 写入 IndexedDB 后，自动同步到所有副本后端
repo.setConfig('/database', { host: 'new-host', port: 5432 });

// 手动触发同步（通常不需要，同步是自动的）
await repo.flush();
```

### 5. 再次打开时初始化

```typescript
// 重新打开页面时，只需传入 appId
// IndexedDB 中的配置和后端拓扑会自动恢复
const { repo } = await connect('my-app');

// 配置直接从 IndexedDB 读取（离线可用）
const db = repo.getConfig<{ host: string; port: number }>('/database');

// 已注册的副本后端会自动重新连接并同步
const backends = await repo.getBackends();
console.log(backends?.backends.map(b => b.id)); // ['local-idb', 'gitee-prod', ...]
```

### 6. 带初始后端初始化

```typescript
// 首次初始化时可以直接传入远程后端
const { repo } = await connect('my-app', {
  primaryBackendId: 'gitee-prod',  // 副本后端 ID
  backendInfo: {
    type: 'Gitee',
    options: { token: 'xxx', owner: 'xxx', repo: 'xxx', branch: 'main' },
  },
  idbStoreName: 'my-app-config',  // 自定义 IndexedDB store 名称
});

// 之后重新打开时不需要再传后端参数
const { repo: repo2 } = await connect('my-app');
```

## 统一入口：`connect()`

如果你事先不知道某个后端里放的是配置同步仓库（config-sync）还是数据同步组（data-sync），可以用统一的 `connect()` 入口。它**始终以配置同步组（ConfigRepo）为锚点**（数据组统一由其承载）；当后端是 data-sync 时，会把它挂到配置同步组下的默认数据组上。数据同步组不提供独立顶层入口——数据组一律由配置同步组经 `createAppDataGroup` 纳管（决策 A / T5）。

```typescript
import { connect } from 'zen-fs-config';

// 1. 不传 backendInfo → 纯本地，默认 config-sync
const { groupType, repo } = await connect('my-app');

// 2. 传入远程后端 → 自动探测组类型
const result = await connect('my-app', {
  backendInfo: { type: 'Gitee', options: { token, owner, repo, branch } },
});
if (result.groupType === 'data-sync') {
  // result.dataGroup — 由配置同步组纳管的数据组（result.repo 为对应的配置同步组）
} else {
  // result.repo — ConfigRepo
}
```

探测与分发规则：

- 始终创建（或复用）一个**配置同步组 `ConfigRepo`** 作为锚点。
- 读取后端上的 `/.meta/group-type`：`config-sync` → 将该后端连到配置同步组；`data-sync` → 把它挂到配置同步组下的默认数据组。
- 若该文件不存在（全新后端），回退到 `options.groupType`（默认 `config-sync`）。
- 如果你显式传了 `options.groupType`，且与后端实际类型不符，`connect()` 会抛出 `Group type mismatch` 错误。
- 返回的 `ConnectResult` 始终带 `groupType` 和 `repo`（配置同步组）；首次启动或接入 data-sync 后端时还带 `dataGroup`（默认数据组）。

| 方法 | 说明 |
|---|---|
| `connect(appId, options?)` | 统一入口：始终返回 `ConfigRepo`，可选附带默认数据组 |

`connect()` 接受与 `createConfigRepo` 相同的选项（`backendInfo`、`primaryBackendId`、`idbStoreName`、`nodeId`、`folderPath`、`cache`、`serializer`、`onConflict`、`syncPollIntervalMs`），另加 `groupType`。在 Node.js 上通过 `folderPath`（或设 `ZEN_FS_CONFIG_HOME`）开启本地磁盘持久化。

## 目录结构

```
/
├── {appId}/              # 应用私有配置（自动同步到副本）
├── shared/               # 跨应用共享配置（双向同步）
├── nodes/{nodeId}/       # 节点本地配置（同步；按 nodeId 命名空间隔离）
└── .meta/
    ├── backends/          # 后端拓扑（每个后端一个文件）
    │   ├── local-idb.json
    │   ├── gitee-prod.json
    │   └── ...
    ├── .deleted/          # 删除墓碑（跨后端删除传播）
    └── .conflicts/        # 冲突归档（双方内容都保存）
```

每个配置文件有 sidecar 版本文件：`db.json` → `.db.json.version`（版本号 + SHA-256 哈希）。

## 核心 API

> **入口**：用统一的 `connect(appId, options?)`（见上）获取 `ConfigRepo`。`createConfigRepo` 仍作为底层工厂导出，但推荐用 `connect`——它还统一处理 data-sync 组与 Node.js 本地持久化（`folderPath` / `ZEN_FS_CONFIG_HOME`）。

| 方法 | 说明 |
|---|---|
| `getConfig<T>(path)` | 同步读取应用配置（从 IndexedDB） |
| `setConfig(path, data)` | 同步写入应用配置（异步持久化 + 自动同步） |
| `addBackend(id, type, options, desc?)` | 动态添加副本后端，自动建立双向同步 |
| `removeBackend(id)` | 移除副本后端，停止同步 |
| `getBackends()` | 读取所有后端拓扑（从 `.meta/backends/*.json` 聚合） |
| `getNodeConfig<T>(nodeId, path)` | 异步读取节点本地配置 |
| `setNodeConfig(nodeId, path, data)` | 写入节点本地配置（写本地主后端，经主同步对同步到副本） |
| `publishNodeConfig(nodeId)` | 显式一次性推送节点配置到所有后端（自动同步已覆盖） |
| `peekNodeConfig<T>(nodeId, path)` | 只读查看其他节点的已发布配置 |
| `flush()` | 手动触发所有同步 |
| `listConflicts()` | 列出所有冲突归档 |
| `resolveConflict(id, merged)` | 用合并内容解决冲突 |
| `fs.promises.*` | 标准 fs API，chroot 隔离到 `/{appId}/` |
| `dispose()` | 停止同步、释放资源 |

### 后端注册

zen-fs-config 内置两个后端（无需安装）：
- **IndexedDB** — 本地主后端（基于 `@zenfs/dom`）
- **InMemory** — 内存后端（基于 `@zenfs/core`），用于测试

另有三种**云后端类型由核心预注册**（首次使用时懒加载）：`GitHub`（`zen-fs-github`）、`Gitee`（`zen-fs-gitee`）、`RemoteStorage`（`zen-fs-remotestoragejs`）。你**无需**为它们调用 `registerBackend`——只需先安装对应包（见「安装」），再把 `type: 'Gitee'` 等传给 `addBackend`/`connect` 即可。`registerBackend` 仅在你需要新增**完全自定义**的后端或覆盖内置注册时才用到：

```typescript
import { registerBackend } from 'zen-fs-config';

// 示例：用自定义工厂覆盖内置的 Gitee 注册
registerBackend('Gitee', async (options) => {
  const { Gitee } = await import('zen-fs-gitee');
  return Gitee.create(options);
});

// 示例：新增一个自定义后端（如 S3）
registerBackend('S3Bucket', async (options) => {
  const { S3Bucket } = await import('@zenfs/core');
  return S3Bucket.create(options);
});
```

## 架构概览

```
Application code
    ↓ (reads/writes via standard fs API)
ConfigRepo (this library)
    ├─ IndexedDB (local primary, always)
    │   └─ All config operations target IndexedDB first
    └─ zen-fs-sync → Bi-directional sync
        ├─ Replica X (e.g., Gitee)
        ├─ Replica Y (e.g., S3)
        └─ Replica Z (e.g., RemoteStorage)
```

- **IndexedDB 是唯一的主后端**：所有读写操作直接操作 IndexedDB，保证离线可用
- **远程后端是副本**：通过 `addBackend()` 或 `connect({ backendInfo })` 添加
- **自动同步**：对 IndexedDB 的修改会自动同步到所有副本后端
- **自描述拓扑**：后端配置存储在 `.meta/backends/` 目录中，每个后端一个 JSON 文件

## 依赖

| 包 | 说明 | 必需 |
|---|---|---|
| `@zenfs/core >=2.3.0` | ZenFS 虚拟文件系统 | 是 |
| `@zenfs/dom >=1.0.0` | IndexedDB 后端（浏览器） | 是（浏览器） |
| `zen-fs-sync >=0.1.0` | 跨后端同步引擎 | 是 |
| `zen-fs-cache >=1.0.0` | ETag/TTL 缓存层 | 否（可选） |
| `zen-fs-github` | GitHub 副本后端（**可选 peer**） | 否 |
| `zen-fs-gitee` | Gitee 副本后端（**可选 peer**） | 否 |
| `zen-fs-remotestoragejs` | RemoteStorage 副本后端（**可选 peer**） | 否 |

## License

MIT
