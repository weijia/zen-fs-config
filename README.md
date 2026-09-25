# zen-fs-config

Distributed configuration management library built on [ZenFS](https://github.com/weijia/zen-fs), with IndexedDB as the offline-first local primary backend and user-provided remote backends as replicas that sync automatically. Supports app isolation, shared spaces, node-local config, and conflict-safe operations.

**GitHub**: https://github.com/weijia/zen-fs-config
**NPM**: `zen-fs-config`
**Design doc**: [DESIGN.md](./DESIGN.md)

## Features

- **Offline-first** — IndexedDB is always the primary backend; reads and writes work without network
- **Multi-backend sync** — Add any number of remote replicas (Gitee, GitHub, RemoteStorage, WebDAV, etc.) with automatic bi-directional sync
- **App isolation** — Each app gets its own namespace under `/{appId}/`
- **Shared spaces** — Cross-app shared config under `/shared/`
- **Node-local config** — Per-device settings under `/nodes/{nodeId}/` that never sync
- **Self-describing topology** — Backend configuration is stored as files in `.meta/backends/`, so re-opening a repo restores everything automatically
- **Conflict safety** — Conflicts are archived instead of silently overwritten; JSON deep-merge is available as a strategy
- **Version tracking** — Every config file has a version sidecar with version number and SHA-256 hash
- **Caching layer** — Optional ETag/TTL caching via `zen-fs-cache` to reduce remote API calls

## Installation

```bash
npm install zen-fs-config @zenfs/core @zenfs/dom zen-fs-sync
```

> `@zenfs/dom` provides the IndexedDB backend (required in browser environments). `zen-fs-cache` is an optional dependency for remote request caching.

## Usage via `<script>` tag (no build step)

A self-contained browser bundle is published at `dist/index.browser.js`. It bundles **all** dependencies (`@zenfs/core`, `@zenfs/dom`, `zen-fs-sync`, `zen-fs-cache`) and exposes the library on the global `window.ZenFSConfig`. No npm install, no bundler — just drop it into any HTML page:

```html
<script src="https://unpkg.com/zen-fs-config/dist/index.browser.js"></script>
<script>
  (async () => {
    const { createConfigRepo } = window.ZenFSConfig;

    // IndexedDB primary backend is created automatically
    const repo = await createConfigRepo('my-app');

    repo.setConfig('greeting.json', { msg: 'hello' });
    const cfg = await repo.getConfig('greeting.json');
    console.log(cfg); // { msg: 'hello' }
  })();
</script>
```

> The browser bundle includes a pure-JS SHA-256 fallback, so version tracking works even in non-secure contexts (plain HTTP) where `crypto.subtle` is unavailable.

## Quick Start

### 1. Initialize (zero-configuration)

```typescript
import { createConfigRepo } from 'zen-fs-config';

// Creates an IndexedDB primary backend automatically
const repo = await createConfigRepo('my-app');

// Read/write config (synchronous API, served from IndexedDB)
repo.setConfig('/database', { host: 'localhost', port: 5432 });
const db = repo.getConfig<{ host: string; port: number }>('/database');
```

### 2. Add a remote replica backend

```typescript
import { registerBackend } from 'zen-fs-config';
import { Gitee } from 'zen-fs-gitee';

// Register the backend type first
registerBackend('Gitee', async (options) => {
  return Gitee.create(options);
});

// Dynamically add a replica — auto-syncs bi-directionally with local IndexedDB
await repo.addBackend('gitee-prod', 'Gitee', {
  token: 'your-token',
  owner: 'your-name',
  repo: 'config-repo',
  branch: 'main',
}, 'Production Gitee config repo');
```

### 3. Automatic sync

```typescript
// Writing to IndexedDB triggers auto-sync to all replicas
repo.setConfig('/database', { host: 'new-host', port: 5432 });

// Manual flush (usually not needed — sync is automatic)
await repo.flush();
```

### 4. Re-open on next page load

```typescript
// Just pass the appId — IndexedDB restores everything
const repo = await createConfigRepo('my-app');

// Config is readable immediately (offline)
const db = repo.getConfig<{ host: string; port: number }>('/database');

// Registered replicas reconnect and sync automatically
const backends = await repo.getBackends();
console.log(backends?.backends.map(b => b.id)); // ['local-idb', 'gitee-prod', ...]
```

### Initialize with a backend from the start

```typescript
const repo = await createConfigRepo('my-app', {
  primaryBackendId: 'gitee-prod',
  backendInfo: {
    type: 'Gitee',
    options: { token: 'xxx', owner: 'xxx', repo: 'xxx', branch: 'main' },
  },
  idbStoreName: 'my-app-config', // custom IndexedDB store name
});

// Next time you don't need to pass backend info again
const repo2 = await createConfigRepo('my-app');
```

## Directory Structure

```
/
├── {appId}/              # App-private config (auto-synced to replicas)
├── shared/               # Cross-app shared config (bi-directional sync)
├── nodes/{nodeId}/       # Node-local config (never synced)
└── .meta/
    ├── backends/          # Backend topology (one file per backend)
    │   ├── local-idb.json
    │   ├── gitee-prod.json
    │   └── ...
    ├── .deleted/          # Deletion tombstones (propagate deletes across backends)
    └── .conflicts/        # Conflict archives (both sides preserved)
```

Each config file has a sidecar version file: `db.json` → `.db.json.version` (version number + SHA-256 hash).

## Core API

### ConfigRepo

| Method | Description |
|--------|-------------|
| `createConfigRepo(appId, options?)` | Create a config repo. IndexedDB is always primary; `backendInfo` becomes a replica. |
| `getConfig<T>(path)` | Synchronously read app config (from IndexedDB) |
| `setConfig(path, data)` | Synchronously write app config (async persistence + auto-sync) |
| `addBackend(id, type, options, desc?)` | Dynamically add a replica backend with auto bi-directional sync |
| `removeBackend(id)` | Remove a replica backend and stop syncing |
| `getBackends()` | Read backend topology (aggregated from `.meta/backends/*.json`) |
| `getNodeConfig<T>(nodeId, path)` | Asynchronously read node-local config |
| `setNodeConfig(nodeId, path, data)` | Asynchronously write node-local config (not synced) |
| `publishNodeConfig(nodeId)` | One-time push of node config to all backends |
| `peekNodeConfig<T>(nodeId, path)` | Read-only view of another node's published config |
| `flush()` | Manually trigger all pending syncs |
| `listConflicts()` | List all archived conflicts |
| `resolveConflict(id, merged)` | Resolve a conflict with merged content |
| `fs.promises.*` | Standard fs API, chrooted to `/{appId}/` |
| `dispose()` | Stop syncing and release resources |

### Backend Registration

zen-fs-config includes two built-in backends:
- **IndexedDB** — local primary backend (based on `@zenfs/dom`), no registration needed
- **InMemory** — in-memory backend (based on `@zenfs/core`), useful for testing

Register custom backends:

```typescript
import { registerBackend } from 'zen-fs-config';

// Register Gitee backend
registerBackend('Gitee', async (options) => {
  const { Gitee } = await import('zen-fs-gitee');
  return Gitee.create(options);
});

// Register RemoteStorage backend
registerBackend('RemoteStorage', async (options) => {
  const { createRemoteStorageFileSystem } = await import('zen-fs-remotestoragejs');
  return createRemoteStorageFileSystem(options);
});
```

## Architecture

```
Application code
    ↓ (reads/writes via standard fs API)
ConfigRepo
    ├─ IndexedDB (local primary, always)
    │   └─ All config operations target IndexedDB first
    └─ zen-fs-sync → Bi-directional sync
        ├─ Replica 1 (e.g. Gitee)
        ├─ Replica 2 (e.g. RemoteStorage)
        └─ Replica 3 (e.g. GitHub)
```

- **IndexedDB is the only primary backend** — all reads and writes go directly to IndexedDB, guaranteeing offline availability
- **Remote backends are replicas** — added via `addBackend()` or `createConfigRepo({ backendInfo })`
- **Auto-sync** — changes to IndexedDB automatically propagate to all replicas
- **Self-describing topology** — backend configuration lives in `.meta/backends/`, one JSON file per backend

## Dependencies

| Package | Description | Required |
|---------|-------------|----------|
| `@zenfs/core >=2.3.0` | ZenFS virtual file system | Yes |
| `@zenfs/dom >=1.0.0` | IndexedDB backend (browser) | Yes (browser) |
| `zen-fs-sync >=0.4.7` | Cross-backend sync engine | Yes |
| `zen-fs-cache >=1.0.0` | ETag/TTL caching layer | No (optional) |

## License

MIT
