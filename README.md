# zen-fs-config

Distributed configuration management library built on [ZenFS](https://github.com/weijia/zen-fs), with IndexedDB as the offline-first local primary backend and user-provided remote backends as replicas that sync automatically. Supports app isolation, shared spaces, node-local config, and conflict-safe operations.

> **Architecture direction (REQUIREMENTS §9 D2)**: the core uses a **GenericSyncGroup base with two type implementations** — `config-sync` (versioning/tombstone/conflict + hosts `.meta/app-data-groups/`) and `data-sync` (plain file sync, optionally governed as an app-data-group under config-sync); **backend-type management and data-backend info persistence stay in the core `zen-fs-config` (UI is presentation-only)**. This document describes the **current implementation (two classes)**; the target architecture follows D2.

**GitHub**: https://github.com/weijia/zen-fs-config
**NPM**: `zen-fs-config`
**Design doc**: [DESIGN.md](./DESIGN.md)

## Features

- **Offline-first** — IndexedDB is always the primary backend; reads and writes work without network
- **Multi-backend sync** — Add any number of remote replicas (Gitee, GitHub, RemoteStorage, WebDAV, etc.) with automatic bi-directional sync
- **App isolation** — Each app gets its own namespace under `/{appId}/`
- **Shared spaces** — Cross-app shared config under `/shared/`
- **Node-local config** — Per-device settings under `/nodes/{nodeId}/`, synced to backends by the main bidirectional pair (each node isolated by its `nodeId` subdirectory)
- **Self-describing topology** — Backend configuration is stored as files in `.meta/backends/`, so re-opening a repo restores everything automatically
- **Conflict safety** — Conflicts are archived instead of silently overwritten; JSON deep-merge is available as a strategy
- **Version tracking** — Every config file has a version sidecar with version number and SHA-256 hash
- **Caching layer** — Optional ETag/TTL caching via `zen-fs-cache` to reduce remote API calls

## Installation

```bash
# Core dependencies (always required)
npm install zen-fs-config @zenfs/core @zenfs/dom zen-fs-sync

# Optional cloud backends — peer dependencies, install only the ones you actually use
npm install zen-fs-github           # GitHub (repo/branch) replica
npm install zen-fs-gitee            # Gitee (repo/branch) replica
npm install zen-fs-remotestoragejs # RemoteStorage replica
```

> `@zenfs/dom` provides the IndexedDB backend (required in browser environments). `zen-fs-cache` is an optional dependency for remote request caching.
>
> **Cloud backends are optional peer dependencies, installed by you (the consumer), not bundled by `zen-fs-config`.** The core *pre-registers* the `GitHub`, `Gitee`, and `RemoteStorage` backend **types** (so you can pass `type: 'Gitee'`, etc. straight to `addBackend`/`connect` without calling `registerBackend`), but it does **not** ship their implementations. You must `npm install` the matching package yourself; otherwise `createBackend()` throws a clear "package not installed — run `npm install <pkg>`" hint. This keeps the core bundle small and avoids forcing an internet dependency on everyone.

## Usage via `<script>` tag (no build step)

A self-contained browser bundle is published at `dist/zen-fs-config.js`. It bundles the **core** dependencies (`@zenfs/core`, `@zenfs/dom`, `zen-fs-sync`, `zen-fs-cache`) and exposes the library on the global `window.ZenFSConfig`. No npm install, no bundler — just drop it into any HTML page. **Cloud backends (GitHub / Gitee / RemoteStorage) are NOT bundled** — see the section below to enable them in `<script>` mode with **no import map required**.

```html
<script src="https://unpkg.com/zen-fs-config/dist/zen-fs-config.js"></script>
<script>
  (async () => {
    const { connect } = window.ZenFSConfig;

    // IndexedDB primary backend is created automatically
    const { repo } = await connect('my-app');

    repo.setConfig('greeting.json', { msg: 'hello' });
    const cfg = await repo.getConfig('greeting.json');
    console.log(cfg); // { msg: 'hello' }
  })();
</script>
```

> The browser bundle includes a pure-JS SHA-256 fallback, so version tracking works even in non-secure contexts (plain HTTP) where `crypto.subtle` is unavailable.

### Enabling cloud backends (GitHub / Gitee / RemoteStorage) in `<script>` mode — **no import map required**

The self-contained core bundle does **not** include the cloud backend implementations — they are optional peer packages kept out of the core to keep the bundle small. The good news: **all three cloud packages now ship a browser global (UMD) build**, so in a no-build `<script>` page you can enable them with plain `<script>` tags — **no import map and no bundler needed**:

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

Global build → global variable mapping:
- `zen-fs-gitee` → `window.ZenFSGitee` (build: `dist/zen-fs-gitee.global.js`)
- `zen-fs-github` → `window.ZenFSGitHub` (build: `dist/zen-fs-github.global.js`; v1.1.3+)
- `zen-fs-remotestoragejs` → `window.ZenFSRemoteStorage` (build: `dist/zen-fs-remotestoragejs.global.js`)

`zen-fs-config` auto-detects these globals (`window.ZenFSGitee` / `window.ZenFSGitHub` / `window.ZenFSRemoteStorage`) and uses them directly, skipping the bare `import()`. Because all three packages declare a `browser`/`unpkg` field, a bare package URL (e.g. `https://unpkg.com/zen-fs-github`) also returns the global build — so you may shorten the three `<script>` lines to bare URLs if you prefer.

**Alternative — import map (optional, only if you want ESM semantics).** Instead of global scripts, you can map the bare package names to an ESM CDN so the bundle's dynamic `import()` resolves them. This is entirely optional — the UMD globals above are simpler and need no import map:

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

## Quick Start

### 1. Initialize (zero-configuration)

```typescript
import { connect } from 'zen-fs-config';

// Creates an IndexedDB primary backend automatically
const { repo } = await connect('my-app');

// Read/write config (synchronous API, served from IndexedDB)
repo.setConfig('/database', { host: 'localhost', port: 5432 });
const db = repo.getConfig<{ host: string; port: number }>('/database');
```

### 2. Write config values

```typescript
// You can write as many config files as you like under the app root
repo.setConfig('/cache', { ttl: 3600, maxSize: '100MB' });
repo.setConfig('/feature-flags', { newUI: true, beta: false });
```

### 3. Add a remote replica backend

```typescript
// GitHub / Gitee / RemoteStorage are pre-registered by the core — no registerBackend needed.
// Install the package first (e.g. `npm install zen-fs-gitee` — see Installation), then:
await repo.addBackend('gitee-prod', 'Gitee', {
  token: 'your-token',
  owner: 'your-name',
  repo: 'config-repo',
  branch: 'main',
}, 'Production Gitee config repo');
// ↑ auto-syncs bi-directionally with the local IndexedDB primary
```

### 4. Automatic sync

```typescript
// Writing to IndexedDB triggers auto-sync to all replicas
repo.setConfig('/database', { host: 'new-host', port: 5432 });

// Manual flush (usually not needed — sync is automatic)
await repo.flush();
```

### 5. Re-open on next page load

```typescript
// Just pass the appId — IndexedDB restores everything
const { repo } = await connect('my-app');

// Config is readable immediately (offline)
const db = repo.getConfig<{ host: string; port: number }>('/database');

// Registered replicas reconnect and sync automatically
const backends = await repo.getBackends();
console.log(backends?.backends.map(b => b.id)); // ['local-idb', 'gitee-prod', ...]
```

### 6. Initialize with a backend from the start

```typescript
const { repo } = await connect('my-app', {
  primaryBackendId: 'gitee-prod',
  backendInfo: {
    type: 'Gitee',
    options: { token: 'xxx', owner: 'xxx', repo: 'xxx', branch: 'main' },
  },
  idbStoreName: 'my-app-config', // custom IndexedDB store name
});

// Next time you don't need to pass backend info again
const { repo: repo2 } = await connect('my-app');
```

## Unified entry point: `connect()`

If you don't know in advance whether a backend holds a config-sync repo or a
data-sync group, use the unified `connect()` entry point. It always anchors on
a config-sync repo (which hosts the data groups) and, when the backend is a
data-sync backend, attaches it to the default app data group. There is no
separate standalone data-sync entry — data groups are always
managed by a config-sync repo via `createAppDataGroup` (decision A / T5).

```typescript
import { connect } from 'zen-fs-config';

// 1. No backendInfo → local-only, defaults to config-sync
const { groupType, repo } = await connect('my-app');

// 2. With a remote backend → detect group type automatically
const result = await connect('my-app', {
  backendInfo: { type: 'Gitee', options: { token, owner, repo, branch } },
});
if (result.groupType === 'data-sync') {
  // result.dataGroup — a config-managed data group (result.repo is its host)
} else {
  // result.repo — a ConfigRepo
}
```

Detection & dispatch rules:

- Always creates (or reuses) a **config-sync `ConfigRepo`** as the anchor.
- Reads `/.meta/group-type` from the backend: `config-sync` → connect the repo to that backend; `data-sync` → attach the backend to the default app data group inside the config-sync repo.
- If that file is absent (a brand-new backend), falls back to `options.groupType` (default `config-sync`).
- If you pass `options.groupType` and it conflicts with the backend's actual type, `connect()` throws a `Group type mismatch` error.
- The returned `ConnectResult` always carries `groupType` and `repo` (the config-sync repo). It also carries `dataGroup` (the default app data group) on first launch and when a data-sync backend was connected.

| Method | Description |
|--------|-------------|
| `connect(appId, options?)` | Unified entry: always returns a `ConfigRepo`, optionally with a default data group |

`connect()` accepts the same options as `createConfigRepo` (`backendInfo`, `primaryBackendId`, `idbStoreName`, `nodeId`, `folderPath`, `cache`, `serializer`, `onConflict`, `syncPollIntervalMs`) plus `groupType`. On Node.js, pass `folderPath` (or set `ZEN_FS_CONFIG_HOME`) to enable local disk persistence.

## Directory Structure

```
/
├── {appId}/              # App-private config (auto-synced to replicas)
├── shared/               # Cross-app shared config (bi-directional sync)
├── nodes/{nodeId}/       # Node-local config (synced; namespaced by nodeId)
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

> **Entry point**: use the unified `connect(appId, options?)` (see above) to obtain a `ConfigRepo`. `createConfigRepo` is still exported as a lower-level factory but `connect` is recommended — it also handles data-sync groups and Node.js local persistence (`folderPath` / `ZEN_FS_CONFIG_HOME`).

### ConfigRepo

| Method | Description |
|--------|-------------|
| `getConfig<T>(path)` | Synchronously read app config (from IndexedDB) |
| `setConfig(path, data)` | Synchronously write app config (async persistence + auto-sync) |
| `addBackend(id, type, options, desc?)` | Dynamically add a replica backend with auto bi-directional sync |
| `removeBackend(id)` | Remove a replica backend and stop syncing |
| `getBackends()` | Read backend topology (aggregated from `.meta/backends/*.json`) |
| `getNodeConfig<T>(nodeId, path)` | Asynchronously read node-local config |
| `setNodeConfig(nodeId, path, data)` | Write node-local config (local primary; synced to replicas via main pair) |
| `publishNodeConfig(nodeId)` | Explicit one-shot push of node config to all backends (auto-sync also covers it) |
| `peekNodeConfig<T>(nodeId, path)` | Read another node's config (from the synced-in local copy) |
| `flush()` | Manually trigger all pending syncs |
| `listConflicts()` | List all archived conflicts |
| `resolveConflict(id, merged)` | Resolve a conflict with merged content |
| `fs.promises.*` | Standard fs API, chrooted to `/{appId}/` |
| `dispose()` | Stop syncing and release resources |

### Backend Registration

zen-fs-config bundles two built-in backends (no install needed):
- **IndexedDB** — local primary backend (based on `@zenfs/dom`)
- **InMemory** — in-memory backend (based on `@zenfs/core`), useful for testing

Three **cloud backend types are pre-registered by the core** (lazy-loaded on first use): `GitHub` (`zen-fs-github`), `Gitee` (`zen-fs-gitee`), and `RemoteStorage` (`zen-fs-remotestoragejs`). You do **not** need to call `registerBackend` for them — just install the matching package (see Installation) and pass `type: 'Gitee'`, etc. to `addBackend`/`connect`. `registerBackend` is only needed to add a *fully custom* backend or to override a built-in registration:

```typescript
import { registerBackend } from 'zen-fs-config';

// Example: override the built-in Gitee registration with a custom factory
registerBackend('Gitee', async (options) => {
  const { Gitee } = await import('zen-fs-gitee');
  return Gitee.create(options);
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
- **Remote backends are replicas** — added via `addBackend()` or `connect({ backendInfo })`
- **Auto-sync** — changes to IndexedDB automatically propagate to all replicas
- **Self-describing topology** — backend configuration lives in `.meta/backends/`, one JSON file per backend

## Dependencies

| Package | Description | Required |
|---------|-------------|----------|
| `@zenfs/core >=2.3.0` | ZenFS virtual file system | Yes |
| `@zenfs/dom >=1.0.0` | IndexedDB backend (browser) | Yes (browser) |
| `zen-fs-sync >=0.4.7` | Cross-backend sync engine | Yes |
| `zen-fs-cache >=1.0.0` | ETag/TTL caching layer | No (optional) |
| `zen-fs-github` | GitHub replica backend (**optional peer**) | No |
| `zen-fs-gitee` | Gitee replica backend (**optional peer**) | No |
| `zen-fs-remotestoragejs` | RemoteStorage replica backend (**optional peer**) | No |

## License

MIT
