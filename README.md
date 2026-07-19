# zen-fs-config

基于 ZenFS 的分布式配置管理库。多个应用实例通过任意 ZenFS 后端共享配置，支持应用隔离、共享空间、节点本地配置和冲突安全。

**GitHub**: https://github.com/weijia/zen-fs-config
**NPM**: `zen-fs-config`
**设计文档**: [DESIGN.md](./DESIGN.md)

## 安装

```bash
npm install zen-fs-config @zenfs/core zen-fs-cache zen-fs-sync
```

## 快速开始

```typescript
import { createConfigRepo, registerBackend } from 'zen-fs-config';
import { InMemory } from '@zenfs/core';

// 1. 注册自定义后端（可选，InMemory 已内置）
registerBackend('InMemory', async (options) => {
  return InMemory.create({ maxSize: options.maxSize as number ?? 100 * 1024 * 1024 });
});

// 2. 创建配置仓库
const repo = await createConfigRepo('my-app', {
  primaryBackendId: 'local-memory',
  backendInfo: {
    type: 'InMemory',
    options: { label: 'my-app-config' },
  },
  cache: { storeType: 'MemoryCacheStore', ttlMs: 60_000 },
  bootstrap: {
    backends: [
      { id: 'local-memory', type: 'InMemory', options: { label: 'primary' } },
    ],
    syncRules: [
      { prefix: '/my-app/', direction: 'one-way', conflictStrategy: 'source-wins', replicas: ['local-memory'] },
      { prefix: '/shared/', direction: 'bi-directional', conflictStrategy: 'merge', replicas: ['local-memory'] },
      { prefix: '/nodes/', direction: 'none' },
    ],
  },
});

// 3. 读写配置（同步 API，从内存缓存读取）
repo.setConfig('/database', { host: 'localhost', port: 5432 });
const db = repo.getConfig<{ host: string; port: number }>('/database');

// 4. 节点本地配置（异步 API，不自动同步）
await repo.setNodeConfig('node-1', '/debug', { level: 'verbose' });
const debug = await repo.getNodeConfig('node-1', '/debug');

// 5. 发布节点配置到同步后端（用于调试）
await repo.publishNodeConfig('node-1');

// 6. 清理
await repo.dispose();
```

## 目录结构

```
/
├── {appId}/           # 应用私有配置（单向同步，每个应用只能读写自己的）
├── shared/            # 跨应用共享配置（双向同步，merge 冲突策略）
├── nodes/{nodeId}/    # 节点本地配置（不同步，除非手动 publish）
└── .meta/
    ├── backends.json  # 后端拓扑（自描述，任意后端可引导）
    ├── sync-rules.json
    └── .conflicts/    # 冲突归档（双方内容都保存，永不丢失）
```

每个配置文件有 sidecar 版本文件：`db.json` → `.db.json.version`（版本号 + SHA-256 哈希）。

## 核心 API

| 方法 | 说明 |
|---|---|
| `getConfig<T>(path)` | 同步读取应用配置（从内存缓存） |
| `setConfig(path, data)` | 同步写入应用配置（异步持久化 + 自动同步） |
| `getNodeConfig<T>(nodeId, path)` | 异步读取节点本地配置 |
| `setNodeConfig(nodeId, path, data)` | 异步写入节点本地配置（不同步） |
| `publishNodeConfig(nodeId)` | 将节点配置一次性同步到所有后端 |
| `peekNodeConfig<T>(nodeId, path)` | 只读查看其他节点的已发布配置 |
| `flush()` | 手动触发所有同步 |
| `listConflicts()` | 列出所有冲突归档 |
| `resolveConflict(id, merged)` | 用合并内容解决冲突 |
| `fs.promises.*` | 标准 fs API，chroot 隔离到 `/{appId}/` 和 `/shared/` |
| `dispose()` | 停止同步、释放资源 |

## 后端注册

```typescript
import { registerBackend } from 'zen-fs-config';

// 注册 S3 后端
registerBackend('S3Bucket', async (options) => {
  const { S3Bucket } = await import('@zenfs/core');
  return S3Bucket.create(options);
});

// 注册自定义后端
registerBackend('my-custom', async (options) => {
  return {
    readFile: (path) => { /* ... */ },
    writeFile: (path, data) => { /* ... */ },
    readdir: (path) => { /* ... */ },
    stat: (path) => { /* ... */ },
    exists: (path) => { /* ... */ },
    mkdir: (path) => { /* ... */ },
    unlink: (path) => { /* ... */ },
    rmdir: (path) => { /* ... */ },
    rename: (old, newPath) => { /* ... */ },
  };
});
```

## 依赖

| 包 | 说明 |
|---|---|
| `@zenfs/core >=2.3.0` | ZenFS 虚拟文件系统 |
| `zen-fs-cache >=1.0.0` | ETag/TTL 缓存层 |
| `zen-fs-sync >=0.1.0` | 跨后端同步引擎 |

## License

MIT