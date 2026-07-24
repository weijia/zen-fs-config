# zen-fs-config

基于 ZenFS 的分布式配置管理库。以 IndexedDB 为本地主后端（offline-first），用户提供的远程后端作为副本自动同步。支持应用隔离、共享空间、节点本地配置和冲突安全。

**GitHub**: https://github.com/weijia/zen-fs-config
**NPM**: `zen-fs-config`
**设计文档**: [DESIGN.md](./DESIGN.md)

## 安装

```bash
npm install zen-fs-config @zenfs/core @zenfs/dom zen-fs-sync
```

> `@zenfs/dom` 提供 IndexedDB 后端（浏览器环境必需）。`zen-fs-cache` 为可选依赖。

## 快速开始

### 1. 初始化（零参数）

```typescript
import { createConfigRepo } from 'zen-fs-config';

// 不传任何后端参数，自动创建 IndexedDB 本地主后端
const repo = await createConfigRepo('my-app');

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
import { registerBackend } from 'zen-fs-config';
import { Gitee } from 'zen-fs-gitee';

// 注册后端类型
registerBackend('Gitee', async (options) => {
  return Gitee.create(options);
});

// 动态添加副本后端，自动与本地 IndexedDB 双向同步
await repo.addBackend('gitee-prod', 'Gitee', {
  token: 'your-token',
  owner: 'your-name',
  repo: 'config-repo',
  branch: 'main',
}, '生产环境 Gitee 配置仓库');
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
const repo = await createConfigRepo('my-app');

// 配置直接从 IndexedDB 读取（离线可用）
const db = repo.getConfig<{ host: string; port: number }>('/database');

// 已注册的副本后端会自动重新连接并同步
const backends = await repo.getBackends();
console.log(backends?.backends.map(b => b.id)); // ['local-idb', 'gitee-prod', ...]
```

### 带初始后端初始化

```typescript
// 首次初始化时可以直接传入远程后端
const repo = await createConfigRepo('my-app', {
  primaryBackendId: 'gitee-prod',  // 副本后端 ID
  backendInfo: {
    type: 'Gitee',
    options: { token: 'xxx', owner: 'xxx', repo: 'xxx', branch: 'main' },
  },
  idbStoreName: 'my-app-config',  // 自定义 IndexedDB store 名称
});

// 之后重新打开时不需要再传后端参数
const repo2 = await createConfigRepo('my-app');
```

## 目录结构

```
/
├── {appId}/              # 应用私有配置（自动同步到副本）
├── shared/               # 跨应用共享配置（双向同步）
├── nodes/{nodeId}/       # 节点本地配置（不同步）
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

| 方法 | 说明 |
|---|---|
| `createConfigRepo(appId, options?)` | 创建配置仓库。IndexedDB 始终为主后端，`backendInfo` 作为副本 |
| `getConfig<T>(path)` | 同步读取应用配置（从 IndexedDB） |
| `setConfig(path, data)` | 同步写入应用配置（异步持久化 + 自动同步） |
| `addBackend(id, type, options, desc?)` | 动态添加副本后端，自动建立双向同步 |
| `removeBackend(id)` | 移除副本后端，停止同步 |
| `getBackends()` | 读取所有后端拓扑（从 `.meta/backends/*.json` 聚合） |
| `getNodeConfig<T>(nodeId, path)` | 异步读取节点本地配置 |
| `setNodeConfig(nodeId, path, data)` | 异步写入节点本地配置（不同步） |
| `publishNodeConfig(nodeId)` | 将节点配置一次性同步到所有后端 |
| `peekNodeConfig<T>(nodeId, path)` | 只读查看其他节点的已发布配置 |
| `flush()` | 手动触发所有同步 |
| `listConflicts()` | 列出所有冲突归档 |
| `resolveConflict(id, merged)` | 用合并内容解决冲突 |
| `fs.promises.*` | 标准 fs API，chroot 隔离到 `/{appId}/` |
| `dispose()` | 停止同步、释放资源 |

## 后端注册

zen-fs-config 内置两个后端：
- **IndexedDB** — 本地主后端（基于 `@zenfs/dom`），无需注册
- **InMemory** — 内存后端（基于 `@zenfs/core`），用于测试

注册自定义后端：

```typescript
import { registerBackend } from 'zen-fs-config';

// 注册 Gitee 后端
registerBackend('Gitee', async (options) => {
  const { Gitee } = await import('zen-fs-gitee');
  return Gitee.create(options);
});

// 注册 S3 后端
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
- **远程后端是副本**：通过 `addBackend()` 或 `createConfigRepo({ backendInfo })` 添加
- **自动同步**：对 IndexedDB 的修改会自动同步到所有副本后端
- **自描述拓扑**：后端配置存储在 `.meta/backends/` 目录中，每个后端一个 JSON 文件

## 依赖

| 包 | 说明 | 必需 |
|---|---|---|
| `@zenfs/core >=2.3.0` | ZenFS 虚拟文件系统 | 是 |
| `@zenfs/dom >=1.0.0` | IndexedDB 后端（浏览器） | 是（浏览器） |
| `zen-fs-sync >=0.1.0` | 跨后端同步引擎 | 是 |
| `zen-fs-cache >=1.0.0` | ETag/TTL 缓存层 | 否（可选） |

## License

MIT
