# zen-fs-config — Design Document

## 1. Overview

zen-fs-config is a distributed configuration management library built on top of:
- **ZenFS** (`@zenfs/core`) — Virtual file system with pluggable backends
- **zen-fs-cache** — Caching layer with ETag/304 revalidation
- **zen-fs-sync** — Sync engine for mirroring configs across backends

It allows multiple application instances (programs) running on different nodes to share configuration through a network of ZenFS backends, with per-app isolation, shared config spaces, node-local config, and conflict safety.

zen-fs-config supports two types of **sync groups**, each backed by a multi-backend sync network but serving different purposes:

- **Config-sync group** — Synchronizes the configuration repository itself: backend topology, app configs, shared configs, node-local configs. This is the "meta layer."
- **Data-sync group** — Synchronizes application data only. A data-sync group can be used standalone, or referenced by a config-sync group as an app's data storage layer.

A config-sync group can reference one or more data-sync groups per app, allowing apps to store bulk data on separate backends (e.g., a different repo/branch under the same account) while keeping configuration management unified.

## 2. Architecture

### 2.1 Three-Layer Stack

```
Application code
    ↓ (reads/writes via standard node:fs API)
ConfigRepo (this library)
    ├─ zen-fs-cache  →  CachedFileSystem (ETag/TTL read cache)
    ├─ ZenFS VFS      →  Context-isolated fs per app (chroot)
    └─ zen-fs-sync   →  Change detection + conflict resolution
        ├─ Backend X (replica)
        ├─ Backend Y (replica)
        └─ Backend Z (replica)
```

### 2.2 IndexedDB as Local Primary (Offline-First)

Every program instance uses **IndexedDB** as its local primary backend. All config reads and writes target IndexedDB directly, ensuring offline availability and fast local access.

User-provided backends (Gitee, S3, RemoteStorage, etc.) are added as **replicas** — they receive bi-directional sync with the local IndexedDB but are never the direct target of config operations.

```
Program A → Primary = IndexedDB (local), Replicas = [Gitee, S3]
Program B → Primary = IndexedDB (local), Replicas = [Gitee, S3]
```

This means:
- Config is always available offline (IndexedDB persists in the browser)
- Remote backends accelerate multi-device sync, not local access
- Re-opening the app requires zero backend parameters — IndexedDB + `.meta/backends/` contain everything needed

### 2.3 Self-Describing Configuration

Backend topology and sync rules are stored **inside** the configuration repository (in `.meta/`), not passed as external parameters. This means any node that can read the config repo can bootstrap the entire sync network.

External input at startup is limited to: **which backend to connect to** and optionally **bootstrap data** (if the repo doesn't exist yet).

### 2.4 Sync Group Types

A **sync group** is a set of backends that synchronize with each other. There are two types:

```
┌─────────────────────────────────────────────────────────────────┐
│  Config-Sync Group                                              │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ .meta/backends/         ← config-sync backends        │       │
│  │ .meta/app-data-groups/  ← references to data-sync     │       │
│  │ /{appId}/                ← app config data            │       │
│  │ /shared/                 ← shared config              │       │
│  │ /nodes/                  ← node-local config          │       │
│  └──────────────────────────────────────────────────────┘       │
│                          │ references                            │
│                          ▼                                       │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ Data-Sync Group (per-app)                             │       │
│  │ .meta/backends/         ← data-sync backends          │       │
│  │ /                        ← app data files             │       │
│  └──────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

**Config-sync group**:
- Synced content: `.meta/` (topology), `/{appId}/` (app config), `/shared/`, `/nodes/`
- Backends: full credentials + storage location (e.g., Gitee: token + owner + repo + branch)
- Can reference data-sync groups via `.meta/app-data-groups/{appId}/`

**Data-sync group**:
- Synced content: application data files only (no config meta layer)
- Backends: full credentials + storage location, but typically reusing the same account as a config-sync backend with a different storage target (e.g., same token/owner, different repo/branch)
- Can be used standalone (no config-sync group needed)
- Can be referenced by a config-sync group as an app's data storage

**Group type detection**: When connecting to a backend, the library reads `.meta/group-type` to determine the group type. If the file is absent, the backend is treated as a new empty group and the caller decides which type to create.

| `.meta/group-type` | Behavior |
|---|---|
| `config-sync` | Full system: IndexedDB primary + config replicas + optional data-sync groups |
| `data-sync` | Lightweight: data backends only, direct read/write, no config meta layer |
| absent | New empty backend; caller decides group type at creation time |

## 3. File System Structure

### 3.1 Config-Sync Group

```
/
├─ .meta/                               [synced to replicas]
│  ├─ group-type                        Group type marker: "config-sync"
│  ├─ backends/                         Backend topology (one file per backend)
│  │  ├─ local-idb.json                 { id, type, options, description }
│  │  ├─ gitee-prod.json
│  │  └─ ...
│  ├─ app-data-groups/                  References to data-sync groups (per app)
│  │  └─ {appId}/
│  │     └─ {dataGroupId}.json          { groupType: "data-sync", backends: [...] }
│  ├─ .deleted/                         Tombstones for deletion propagation
│  │  └─ {encoded-path}.json
│  └─ .conflicts/                       Conflict archives (safekeeping)
│     └─ {timestamp}_{path}/
│        ├─ meta.json
│        ├─ source
│        └─ target
│
├─ {appId}/                             [synced: owner → replicas]
│  ├─ db.json
│  ├─ cache.json
│  └─ .db.json.version                  Sidecar version file
│
├─ shared/                              [synced: bi-directional]
│  ├─ feature-flags.json
│  ├─ api-version.json
│  └─ .feature-flags.json.version
│
└─ nodes/                               [not synced by default]
   ├─ {nodeId}/
   │  ├─ local.json                     Node-local config
   │  └─ env.json
   └─ .node-id                           Current node's ID (auto-generated)
```

### 3.2 Data-Sync Group

```
/
├─ .meta/                               [synced to replicas]
│  ├─ group-type                        Group type marker: "data-sync"
│  └─ backends/                         Data backend topology (one file per backend)
│     ├─ gitee-data-1.json              { id, type, options, description }
│     └─ gitee-data-2.json
│
└─ (application data files)             [synced: bi-directional]
   ├─ documents/
   │  ├─ note-1.json
   │  └─ note-2.json
   └─ media/
      └─ config.json
```

A data-sync group has a much simpler structure: no version sidecars, no tombstones, no conflict archives — just raw data files and a minimal `.meta/` for backend topology and group type identification.

### 3.3 Directory Semantics (Config-Sync Group)

| Directory | Sync Direction | Conflict Risk | Purpose |
|---|---|---|---|
| `/{appId}/` | Bi-directional (primary ↔ replicas) | Low (single device) | Per-app private config |
| `/shared/` | Bi-directional | Possible (multiple writers) | Cross-app shared config |
| `/nodes/` | None (by default) | None | Per-node local config |
| `/.meta/` | Bi-directional | None (topology files) | Backend topology, tombstones, conflict archives |

### 3.4 Config-to-File Mapping

Each config key maps to one file. The mapping is straightforward:

- `setConfig('/db/host', { hostname: 'localhost' })` → writes file `/app-a/db/host.json` with content `{"hostname":"localhost"}`
- `getConfig('/db/host')` → reads file `/app-a/db/host.json`, parses based on extension
- Path is relative to the app's root (`/{appId}/`), with `.json` extension appended automatically
- If path already has an extension (e.g., `/readme.md`), the extension is preserved

### 3.5 Serialization

The serializer is determined by file extension:

| Extension | Serialize | Deserialize |
|---|---|---|
| `.json` (default) | `JSON.stringify` | `JSON.parse` |
| `.yaml` | YAML dump | YAML parse |
| `.toml` | TOML dump | TOML parse |
| `.txt` / no struct extension | `String(data)` | Return as string |

Users can inject a custom `ConfigSerializer` for other formats.

## 4. Backend Topology (`.meta/backends/*.json`)

Each backend is stored as an individual JSON file in `.meta/backends/`. This allows atomic add/remove operations without rewriting the entire topology.

**`.meta/backends/local-idb.json`** (always present):
```json
{
  "id": "local-idb",
  "type": "IndexedDB",
  "options": { "storeName": "zen-fs-config-my-app" },
  "description": "Local IndexedDB primary backend"
}
```

**`.meta/backends/gitee-prod.json`** (user-added replica):
```json
{
  "id": "gitee-prod",
  "type": "Gitee",
  "options": { "token": "...", "owner": "...", "repo": "...", "branch": "main" },
  "description": "Production Gitee config repo"
}
```

The local IndexedDB backend (`local-idb`) is always the primary — all config operations target it directly. All other backends are replicas with bi-directional sync.

**Migration**: If a legacy `.meta/backends.json` file exists (pre-0.4.0), it is automatically migrated to individual files on startup.

## 4.1 App Data Groups (`.meta/app-data-groups/{appId}/`)

A config-sync group can reference data-sync groups on behalf of specific apps. Each reference is stored as a JSON file under `.meta/app-data-groups/{appId}/`.

**`.meta/app-data-groups/my-app/data-store-1.json`**:
```json
{
  "id": "data-store-1",
  "groupType": "data-sync",
  "backends": [
    {
      "id": "gitee-data",
      "type": "Gitee",
      "options": { "token": "...", "owner": "...", "repo": "my-app-data", "branch": "main" },
      "accountBackendId": "gitee-prod",
      "description": "App data on Gitee (reuses gitee-prod account)"
    }
  ]
}
```

### Account Reuse

The `accountBackendId` field (optional) references a config-sync backend whose account fields (e.g., `token`, `owner`, `baseUrl` for Gitee/GitHub) are reused. When present, the data-sync backend's `options` only need to specify the **storage location** fields (e.g., `repo`, `branch`); account fields are merged in from the referenced config-sync backend at creation time.

When `accountBackendId` is absent or null, the data-sync backend must provide a complete set of options (including credentials).

The `accountFields` metadata for each backend type (registered via `BackendMetadata.accountFields`) determines which fields are "account" vs "storage location":

| Backend Type | Account Fields | Storage Location Fields |
|---|---|---|
| Gitee | `token`, `owner`, `baseUrl` | `repo`, `branch` |
| GitHub | `token`, `owner`, `baseUrl` | `repo`, `branch` |
| WebDAV | `url`, `username`, `password` | `rootPath` |
| RemoteStorage | `userAddress`, `token` | (none) |

### Standalone Data-Sync Group

A data-sync group can also be used **without** a config-sync group. In this case:

1. The user provides a single backend configuration (e.g., Gitee: token + owner + repo + branch)
2. The library connects and reads `.meta/group-type` → `"data-sync"`
3. The app directly reads/writes data files on these backends
4. No config meta layer, no version sidecars, no tombstones — just raw data sync

Multiple data-sync backends can be registered within a single data-sync group, providing redundancy and multi-device sync for app data.

## 5. Sync Rules (`.meta/sync-rules.json`)

```json
{
  "version": 1,
  "rules": [
    {
      "prefix": "/app-a/",
      "direction": "one-way",
      "conflictStrategy": "source-wins",
      "replicas": ["local-idb", "remote-s3"]
    },
    {
      "prefix": "/app-b/",
      "direction": "one-way",
      "conflictStrategy": "source-wins",
      "replicas": ["local-idb", "remote-s3"]
    },
    {
      "prefix": "/shared/",
      "direction": "bi-directional",
      "conflictStrategy": "merge",
      "replicas": ["local-idb", "remote-s3"]
    },
    {
      "prefix": "/nodes/",
      "direction": "none"
    },
    {
      "prefix": "/.meta/",
      "direction": "none"
    }
  ]
}
```

- Private app directories (`/{appId}/`): one-way push, no conflict possible
- Shared directory (`/shared/`): bi-directional, conflict possible, merge strategy
- Nodes and meta: excluded from sync

## 6. Versioning & Change Detection

### 6.1 Sidecar Version Files

Each config file has a companion version file:

```
/app-a/db.json              →  Config content
/app-a/.db.json.version     →  Version metadata
```

Version file content:
```json
{
  "version": 5,
  "hash": "sha256:a1b2c3d4...",
  "author": "app-a",
  "timestamp": 1689686400000
}
```

### 6.2 Comparison Logic (extends zen-fs-sync's FileSnapshot)

| Condition | Action |
|---|---|
| hash same | Skip (content unchanged) |
| hash different, version different | Higher version wins |
| hash different, version same | **Conflict** → conflict safety mechanism |
| version/hash missing | Fall back to mtime+size comparison (backward compat) |

### 6.3 Version Increment

On each write:
1. Read current version file (if exists)
2. Increment version by 1
3. Compute SHA-256 hash of new content
4. Set author to current instance's `{appId}/{nodeId}`
5. Write config file first, then version file

Crash recovery: on startup, if hash in version file doesn't match actual file content, auto-increment version and update hash.

## 7. Conflict Safety Mechanism

When a conflict is detected (same version, different hash on `/shared/` files):

### 7.1 Archive Both Versions

Both conflicting versions are saved to `.meta/.conflicts/` before any resolution:

```
.meta/.conflicts/1689686400000_shared-feature-flags.from-app-a.to-app-b.json
```

Archive file content:
```json
{
  "conflictPath": "/shared/feature-flags.json",
  "timestamp": 1689686400000,
  "sourceAuthor": "app-a/server-1",
  "targetAuthor": "app-b/server-2",
  "sourceContent": { "darkMode": true, "newFeature": true },
  "targetContent": { "darkMode": false, "newFeature": false },
  "sourceVersion": 3,
  "targetVersion": 3
}
```

### 7.2 Resolution Strategies

After archiving, resolve according to the configured strategy:

| Strategy | Behavior |
|---|---|
| `source-wins` | Source content overwrites target. Target content archived. |
| `target-wins` | Target content preserved. Source content archived. |
| `merge` | JSON deep merge. Both originals archived. Non-JSON falls back to source-wins. |

### 7.3 Event Notification

zen-fs-sync emits a `conflict` event with full conflict details. Application can:
- Accept the auto-resolved result
- Read `.meta/.conflicts/` archives to manually merge
- Call `configRepo.resolveConflict(conflictId, mergedContent)` to submit a custom merge

**Guarantee**: Neither side's content is ever lost. Recovery is always possible from `.meta/.conflicts/`.

## 8. Node-Local Configuration

Some configs are specific to a single node and should not be auto-synced.

### 8.1 Storage

Node-local configs live under `/nodes/{nodeId}/`. The `/nodes/` directory is excluded from sync rules (`direction: "none"`).

```
/nodes/server-1/
  ├─ local.json        →  { "ip": "10.0.0.1", "cpuCount": 8 }
  └─ env.json          →  { "NODE_ENV": "production" }
```

### 8.2 Node ID Source

Priority order:
1. Explicit parameter: `createConfigRepo('app-a', { nodeId: 'server-1', ... })`
2. Environment variable: `process.env.NODE_ID`
3. Auto-generated: random ID written to `/nodes/.node-id` on first startup

### 8.3 API

```typescript
// Write node-local config (no sync, local only)
repo.setNodeConfig('server-1', '/local.json', { ip: '10.0.0.1' });

// Read node-local config
const config = repo.getNodeConfig<{ ip: string }>('server-1', '/local.json');

// Publish node config to sync backends (one-time, for debugging)
const result = await repo.publishNodeConfig('server-1');
// or publish specific files only:
const result = await repo.publishNodeConfig('server-1', { paths: ['/local.json'] });

// Peek at other nodes' published configs (read-only)
const otherConfig = repo.peekNodeConfig<{ ip: string }>('server-2', '/local.json');
```

| API | Write Target | Persisted | Synced | Purpose |
|---|---|---|---|---|
| `getConfig` / `setConfig` | CachedFS → auto-sync to replicas | Yes | Yes | Normal config |
| `getNodeConfig` / `setNodeConfig` | CachedFS → no sync | Yes (primary backend only) | No | Node-private config |
| `publishNodeConfig` | One-time manual sync | Yes | Yes (one-time) | Debug: push to other backends |
| `peekNodeConfig` | CachedFS read | N/A | N/A | Read other nodes' published config |

## 9. ConfigRepo Interface

```typescript
interface ConfigRepo {
  /** Application ID (e.g., "app-a") */
  readonly appId: string;
  /** Node ID (e.g., "server-1") */
  readonly nodeId: string;
  /** ZenFS-compatible fs object (node:fs API), context-isolated to own directories */
  readonly fs: typeof import('node:fs');

  /** Load/reload config from raw string (for initial setup) */
  load(rawConfig: string): Promise<void>;

  /** Read config value */
  getConfig<T>(path: string): T;

  /** Write config value (auto-synced) */
  setConfig(path: string, data: any): void;

  /** Read node-local config */
  getNodeConfig<T>(nodeId: string, path: string): T;

  /** Write node-local config (no auto-sync) */
  setNodeConfig(nodeId: string, path: string, data: any): void;

  /** Publish node-local config to sync backends (one-time, for debugging) */
  publishNodeConfig(nodeId: string, options?: {
    paths?: string[];
  }): Promise<SyncResult>;

  /** Peek at another node's published config (read-only) */
  peekNodeConfig<T>(nodeId: string, path: string): T;

  /** Manually flush all pending sync */
  flush(): Promise<SyncResult[]>;

  /** Get sync status for all sync pairs */
  getSyncStatuses(): Map<string, SyncPairStatus>;

  /** Resolve a conflict with custom merged content */
  resolveConflict(conflictId: string, mergedContent: any): Promise<void>;

  /** List conflict archives */
  listConflicts(): Promise<ConflictArchive[]>;

  /** Read backend topology (aggregated from .meta/backends/*.json) */
  getBackends(): Promise<BackendsMeta | null>;

  /** Write backend topology (writes each backend as individual file) */
  updateBackends(meta: BackendsMeta): Promise<void>;

  /** Dynamically add a replica backend */
  addBackend(id: string, type: string, options: Record<string, unknown>, description?: string): Promise<void>;

  /** Dynamically remove a replica backend */
  removeBackend(id: string): Promise<void>;

  /** Delete a file with tombstone (propagates deletion to all backends) */
  deleteFile(path: string): Promise<void>;

  /** Sync .meta/ files to all replicas */
  syncMetaToReplicas(): Promise<void>;

  // --- App Data Storage (data-sync groups) ---

  /**
   * Create a data-sync group for this app, referencing a config-sync backend's account.
   * The data-sync group gets its own set of backends (typically reusing an account
   * from a config-sync backend but with different storage location like repo/branch).
   *
   * @param id Data group ID (e.g., "data-store-1")
   * @param backends Array of backend descriptors for the data-sync group.
   *                 Each can optionally specify `accountBackendId` to reuse credentials.
   */
  createAppDataGroup(
    id: string,
    backends: AppDataBackendDescriptor[],
  ): Promise<AppDataGroup>;

  /**
   * Get an existing data-sync group for this app.
   * Returns a handle with its own fs for reading/writing data files.
   */
  getAppDataGroup(id: string): Promise<AppDataGroup>;

  /** List all data-sync groups registered for this app. */
  listAppDataGroups(): Promise<AppDataGroupDescriptor[]>;

  /** Remove a data-sync group (stops sync, removes descriptor). */
  removeAppDataGroup(id: string): Promise<void>;

  /** Dispose: stop sync, release resources */
  dispose(): Promise<void>;
}

/**
 * A data-sync group handle. Provides direct file system access
 * to the app's data storage, independent of the config-sync layer.
 */
interface AppDataGroup {
  readonly groupId: string;
  readonly appId: string;
  /** Direct fs for reading/writing data files (chroot to this group's root) */
  readonly fs: typeof import('node:fs');
  /** Get sync status for this data group's sync pairs */
  getSyncStatuses(): Map<string, SyncPairStatus>;
  /** Manually flush pending sync */
  flush(): Promise<SyncResult[]>;
  /** Stop sync and release resources */
  dispose(): Promise<void>;
}

/** Descriptor for a backend within a data-sync group. */
interface AppDataBackendDescriptor {
  id: string;
  type: string;
  options: Record<string, unknown>;
  /** Optional: reuse account fields from a config-sync backend */
  accountBackendId?: string;
  description?: string;
}
```

## 10. Initialization

The recommended entry point is `connect`, which auto-detects the group type. The lower-level `createConfigRepo` and `createDataSyncGroup` are also available for explicit control.

### `connect` (recommended — auto-detect)

```typescript
import { connect } from 'zen-fs-config';

// User provides a backend — connect auto-detects config-sync vs data-sync
const result = await connect('my-app', {
  backendInfo: {
    type: 'Gitee',
    options: { token: '...', owner: '...', repo: '...', branch: 'main' },
  },
});

// result.groupType → "config-sync" or "data-sync"
// result.repo      → ConfigRepo (if config-sync)
// result.dataGroup → DataSyncGroup (if data-sync)
```

### Zero-parameter (offline-first)

```typescript
import { createConfigRepo } from 'zen-fs-config';

// No parameters needed — IndexedDB is always created as primary
const repo = await createConfigRepo('my-app');

// Config is immediately available from IndexedDB
repo.setConfig('/db/host', { hostname: 'localhost', port: 3306 });
```

### With initial replica backend

```typescript
const repo = await createConfigRepo('my-app', {
  // Optional: provide a remote backend as initial replica
  primaryBackendId: 'gitee-prod',
  backendInfo: {
    type: 'Gitee',
    options: { token: '...', owner: '...', repo: '...', branch: 'main' },
  },
  // Optional: customize IndexedDB store name
  idbStoreName: 'my-app-config',
  // Optional: node ID (auto-detected if not provided)
  nodeId: 'server-1',
});

// Later, add more backends dynamically
await repo.addBackend('s3-backup', 'S3Bucket', {
  bucket: 'app-config',
  region: 'us-east-1',
}, 'S3 backup');

// Remove a backend
await repo.removeBackend('gitee-prod');

// Cleanup
await repo.dispose();
```

### Re-opening (zero parameters)

```typescript
// On subsequent opens, just pass appId
// IndexedDB + .meta/backends/ contain all state
const repo = await createConfigRepo('my-app');

// All previously added backends are automatically reconnected
const backends = await repo.getBackends();
// backends.backends = [{ id: 'local-idb', ... }, { id: 's3-backup', ... }]
```

### Standalone Data-Sync Group (no config layer)

```typescript
import { createDataSyncGroup } from 'zen-fs-config';

// User provides a data backend directly — no config-sync layer needed
const dataGroup = await createDataSyncGroup('my-app', {
  backendInfo: {
    type: 'Gitee',
    options: { token: '...', owner: '...', repo: 'my-app-data', branch: 'main' },
  },
});

// Read/write data files directly
await dataGroup.fs.promises.writeFile('/notes/todo.json', JSON.stringify({ task: 'buy milk' }));
const data = JSON.parse(await dataGroup.fs.promises.readFile('/notes/todo.json', 'utf-8'));

// Add more data backends later (multi-backend sync)
await dataGroup.addBackend('gitee-backup', 'Gitee', {
  token: '...', owner: '...', repo: 'my-app-data-backup', branch: 'main',
});

// Cleanup
await dataGroup.dispose();
```

### Config-Sync with App Data Group (account reuse)

```typescript
const repo = await createConfigRepo('my-app', {
  backendInfo: {
    type: 'Gitee',
    options: { token: '...', owner: '...', repo: 'configs', branch: 'main' },
  },
});

// Create a data-sync group that reuses the config backend's account
// but stores data in a different repo
await repo.createAppDataGroup('data-store-1', [
  {
    id: 'gitee-data',
    type: 'Gitee',
    accountBackendId: 'gitee-prod',  // reuse token + owner from this config backend
    options: { repo: 'my-app-data', branch: 'main' },  // only storage location
  },
]);

// Get the data group handle for direct file access
const dataGroup = await repo.getAppDataGroup('data-store-1');
await dataGroup.fs.promises.writeFile('/cache.json', '{"key":"value"}');
```

## 11. Initialization Flow

### 11.1 Config-Sync Group (`createConfigRepo`)

```
createConfigRepo('my-app', options?)
  │
  ├─ 1. Create IndexedDB backend (always, ID = 'local-idb')
  │     storeName = options.idbStoreName || `zen-fs-config-${appId}`
  │
  ├─ 2. Ensure /.meta/ directory exists
  │
  ├─ 3. Write /.meta/group-type = "config-sync" (if not exists)
  │
  ├─ 4. Migrate legacy .meta/backends.json → .meta/backends/*.json (if exists)
  │
  ├─ 5. If options.backendInfo provided:
  │     ├─ Generate replica ID (options.primaryBackendId or auto)
  │     ├─ Dedup check: same type + options (stable key) already registered?
  │     └─ Write descriptor to .meta/backends/{replicaId}.json (if not duplicate)
  │
  ├─ 6. Read all backend descriptors from .meta/backends/
  │     └─ Dedup: remove duplicates (same type + options, different ID)
  │        ├─ Delete duplicate files on ALL replicas directly
  │        └─ Create tombstone + delete local file
  │
  ├─ 7. Determine nodeId (explicit parameter > auto-generated)
  │
  ├─ 8. Create final ConfigRepo instance (primary = 'local-idb')
  │
  ├─ 9. setupSync: for each replica backend:
  │     ├─ Create backend instance (e.g., Gitee, RemoteStorage)
  │     ├─ Create SyncPair(IndexedDB ↔ replica, bi-directional)
  │     ├─ Register conflict handler
  │     └─ NOTE: Does NOT call watch() yet (see §11.4 for why)
  │
  ├─ 10. Load config cache from IndexedDB (fast, local-only)
  │
  ├─ 11. initialSyncAndDedup() — only if replicas exist:
  │     ├─ unwatchAll()      — safety: clear any stale snapshots
  │     ├─ syncAll()         — full bidirectional sync (no cached snapshot
  │     │                      → every file is compared, remote-only files
  │     │                      are pulled to local)
  │     ├─ readAllBackendDescriptors() — dedup duplicates pulled from remote
  │     │   ├─ Delete dup files on ALL replicas directly
  │     │   └─ Create tombstones for deduped descriptors
  │     ├─ processTombstones() — delete deduped files on all replicas
  │     └─ watchAll()       — start monitoring for future changes
  │         (snapshots now reflect the fully synced state)
  │
  ├─ 12. syncMetaToReplicas() — background push of .meta/ changes
  │     (watchers already running, this just speeds up initial propagation)
  │
  └─ 13. Return ConfigRepo instance
```

### 11.2 Why "Sync Before Watch" (Critical Design Decision)

The sync engine (`zen-fs-sync`) uses **snapshot-based change detection**. When `watch()` is called on a SyncPair, it triggers `buildInitialSnapshots()` which:

1. Builds a snapshot of the source (IndexedDB) — walks all files, records `path`, `size`, `mtimeMs`
2. Builds a snapshot of the target (remote backend) — same process
3. Caches **separate** snapshots: `prevSrcSnap` (source) and `prevTgtSnap` (target)

On the next `syncAll()`, `syncBidirectional()` compares each side's current snapshot with its own previous snapshot independently. If both sides are unchanged → **"unchanged" → skip sync entirely**.

**The problem**: `buildInitialSnapshots()` only *reads* file metadata — it does NOT copy any files. So if the remote has files that the local doesn't (e.g., duplicate backend descriptors written by another node), the cached snapshots reflect the un-synced state. The subsequent sync sees "snapshots already match this state" and skips — the file is never actually copied to local, and local-only dedup logic never runs.

**The fix**: Always perform a full `syncAll()` **before** `watch()`. With no cached snapshot, `syncBidirectional()` does a complete comparison and copies all missing files. After sync completes, `watch()` builds snapshots from the now-consistent state.

This pattern is applied in three places:
- `createConfigRepo()` → `initialSyncAndDedup()` (sync → dedup → watch)
- `addBackend()` → `syncMetaToReplicas()` then `watch()` (sync → watch)
- `AppDataGroupImpl.connect()` → `syncAll()` then `watchAll()` (sync → watch)

### 11.3 `flush()` — Manual Sync Trigger

```
flush()
  │
  ├─ 1. processTombstones()
  │     For each tombstone in /.meta/.deleted/:
  │     ├─ Delete the actual file on primary (in case re-created)
  │     ├─ Delete the actual file on ALL replicas
  │     └─ Delete version sidecars on all replicas
  │
  ├─ 2. syncAll()
  │     For each SyncPair (IndexedDB ↔ replica):
  │     ├─ Build current snapshots of both sides
  │     ├─ Compare with cached snapshot (if any)
  │     ├─ Detect changes: Created / Modified / Deleted
  │     ├─ Resolve conflicts (source-wins strategy)
  │     └─ Copy files in both directions as needed
  │
  ├─ 3. readAllBackendDescriptors() — post-sync dedup
  │     Sync may have pulled duplicate backend descriptors from remote.
  │     Re-run dedup to catch and remove them.
  │     ├─ Delete dup files on ALL replicas directly
  │     └─ Create tombstones for deduped descriptors
  │
  ├─ 4. processTombstones() — process any new tombstones from step 3
  │
  ├─ 5. updateTombstoneConfirmations()
  │     Mark each tombstone as confirmed by all replica backends
  │
  ├─ 6. gcTombstones()
  │     Remove tombstones confirmed by ALL backends in the topology
  │
  └─ Return SyncResult[] (one per sync pair)
```

### 11.4 Tombstone-Based Deletion Propagation

When a file is deleted via `deleteFile(path)`:

```
deleteFile('/.meta/backends/old-backend.json')
  │
  ├─ 1. Write tombstone: /.meta/.deleted/++meta__backends__old-backend++json.json
  │     { path, deletedAt, deletedBy, confirmedBy: [primaryBackendId] }
  │
  ├─ 2. Delete the actual file on primary (IndexedDB)
  │
  └─ 3. Delete version sidecar (.old-backend.json.version) on primary
```

On the next `processTombstones()` (called by `flush()` or `initialSyncAndDedup()`):

```
For each tombstone:
  ├─ Delete file on primary (in case sync re-created it)
  ├─ Delete file on ALL replicas
  ├─ Delete version sidecar on ALL replicas
  └─ Tombstone file itself is synced to replicas via syncAll()
     → Late-joining replicas see the tombstone and delete the file
```

**Why tombstones?** Without them, bi-directional sync treats a deleted local file as "missing → needs to be copied from remote". The tombstone explicitly signals "this file was intentionally deleted" so all replicas honor the deletion. Tombstones are garbage-collected after all backends confirm receipt.

### 11.5 Backend Deduplication

When `readAllBackendDescriptors()` detects two backends with the same `type` + `options` (using stable key ordering) but different IDs:

```
Detected: rs-1 and rs-2 have identical type + options
  │
  ├─ 1. Keep the one with the earliest mtime (created first)
  │
  ├─ 2. For each duplicate:
  │     ├─ Delete descriptor file on ALL replicas directly
  │     │   (prevents sync from pulling it back)
  │     ├─ Delete version sidecar on ALL replicas
  │     └─ Create tombstone + delete local file
  │
  └─ 3. Return deduplicated list (duplicates removed)
```

The stable key function (`backendDedupKey`) sorts object keys recursively, so `{ token: 'a', owner: 'b' }` and `{ owner: 'b', token: 'a' }` produce the same key and are correctly detected as duplicates.

### 11.6 Dynamic Backend Management

**`addBackend(id, type, options)`**:

```
  ├─ 1. Dedup check: reject if same type+options already registered
  ├─ 2. Create backend instance
  ├─ 3. Write descriptor to .meta/backends/{id}.json
  ├─ 4. Create SyncPair (IndexedDB ↔ new replica, bi-directional)
  ├─ 5. syncMetaToReplicas() — full sync FIRST (pull + push)
  └─ 6. watch(pairId) — start monitoring AFTER sync completes
```

**`removeBackend(id)`**:

```
  ├─ 1. Delete descriptor file on the remote backend DIRECTLY
  │     (must happen before removing sync pair — otherwise can't reach remote)
  ├─ 2. Delete version sidecar on remote
  ├─ 3. Create tombstone + delete local descriptor file
  ├─ 4. Remove sync pair (stops watching + disposes)
  ├─ 5. Remove from replicaBackends map
  ├─ 6. Dispose backend instance
  ├─ 7. processTombstones() — propagate deletion to remaining replicas
  └─ 8. flush() — sync + GC tombstones
```

### 11.7 Watch Mode (Auto-Sync)

After initialization, each SyncPair runs in **watch mode** with hybrid change detection:

```
watch() triggers:
  │
  ├─ 1. Register onChange callbacks (if backend supports it)
  │     Local backends (IndexedDB) push change notifications
  │     → triggers debounced sync (default 300ms)
  │
  ├─ 2. buildInitialSnapshots()
  │     ├─ BiDirectional: cache separate source and target snapshots
  │     └─ OneWay: cache source snapshot only
  │
  └─ 3. Start poll timers (if backend supports shouldSync)
       ├─ Remote backends poll shouldSync() every pollIntervalMs (default 30min)
       └─ Fallback: if no onChange and no shouldSync, poll every interval
```

**State guard**: If `unwatch()` is called during `buildInitialSnapshots()` (which is async), the snapshots are discarded — they won't be cached. This prevents stale snapshots from causing sync skips.

**Snapshot comparison** in `syncBidirectional()`:
1. Build current snapshots of both sides (via `getSnapshot()`)
2. Compare each side independently against its own previous snapshot:
   - `srcChanged = !snapshotsEqual(prevSrcSnap, currentSrcSnap)`
   - `tgtChanged = !snapshotsEqual(prevTgtSnap, currentTgtSnap)`
   - If neither changed and both previous snapshots exist → skip sync entirely
3. Cache current snapshots as `prevSrcSnap` and `prevTgtSnap` for next comparison
4. If either side changed, proceed with full diff and file operations

**Key difference from previous design**: The old approach merged source and target snapshots into a single map (`source ∪ target`), which lost information about which filesystem a file belonged to. The new approach keeps them separate, enabling precise per-side change detection and bidirectional deletion propagation (see §11.10).

### 11.8 Standalone Data-Sync Group (`createDataSyncGroup`)

```
createDataSyncGroup('my-app', options?)
  │
  ├─ 1. Connect to user-provided backend (options.backendInfo)
  │
  ├─ 2. Read /.meta/group-type
  │     ├─ "data-sync" → existing group, read .meta/backends/ for all data backends
  │     ├─ absent      → new group, write /.meta/group-type = "data-sync"
  │     └─ "config-sync" → error: this is a config-sync backend, use createConfigRepo()
  │
  ├─ 3. Create IndexedDB as local primary (for offline access)
  │
  ├─ 4. Setup sync: IndexedDB ↔ each data backend (bi-directional)
  │     NOTE: Does NOT watch yet — sync first
  │
  ├─ 5. syncAll() — pull data from remote backends
  │
  ├─ 6. watchAll() — start monitoring AFTER sync completes
  │
  └─ 7. Return DataSyncGroup handle with direct fs access
```

### 11.9 Unified Entry Point (`connect`)

`createConfigRepo` and `createDataSyncGroup` are lower-level factory functions. The recommended entry point is `connect`, which auto-detects the group type and dispatches to the appropriate factory:

```
connect('my-app', options?)
  │
  ├─ 1. Connect to user-provided backend (options.backendInfo)
  │
  ├─ 2. Read /.meta/group-type
  │
  ├─ "config-sync" → dispatch to createConfigRepo()
  │                  return { groupType: "config-sync", repo }
  │
  ├─ "data-sync"   → dispatch to createDataSyncGroup()
  │                  return { groupType: "data-sync", dataGroup }
  │
  └─ absent        → new empty backend
     ├─ options.groupType === "data-sync" → dispatch to createDataSyncGroup()
     ├─ options.groupType === "config-sync" (or omitted) → dispatch to createConfigRepo()
     └─ default: config-sync
```

**Usage**:

```typescript
import { connect } from 'zen-fs-config';

// Auto-detect: connects to backend, reads group-type, dispatches accordingly
const result = await connect('my-app', {
  backendInfo: {
    type: 'Gitee',
    options: { token: '...', owner: '...', repo: '...', branch: 'main' },
  },
});

if (result.groupType === 'config-sync') {
  // result.repo is a ConfigRepo — full config system
  const repo = result.repo;
  repo.setConfig('/db/host', { hostname: 'localhost' });
} else {
  // result.dataGroup is a DataSyncGroup — lightweight data-only system
  const dataGroup = result.dataGroup;
  await dataGroup.fs.promises.writeFile('/data.json', '{"key":"value"}');
}

// Explicit override (skip detection, force a specific group type)
const result = await connect('my-app', {
  backendInfo: { type: 'Gitee', options: {...} },
  groupType: 'data-sync',  // force data-sync even if backend has no group-type yet
});
```

**Return type**:

```typescript
interface ConnectResult {
  /** Detected or forced group type */
  groupType: 'config-sync' | 'data-sync';
  /** Present when groupType === "config-sync" */
  repo?: ConfigRepo;
  /** Present when groupType === "data-sync" */
  dataGroup?: DataSyncGroup;
}
```

**Offline / zero-parameter mode**: When no `backendInfo` is provided, `connect` defaults to `config-sync` and creates an IndexedDB-only repo (same as `createConfigRepo` with no options).

### 11.10 Snapshot Optimization Design

This section describes three interrelated optimizations to the sync engine's snapshot mechanism.

#### 11.10.1 FS-Provided `createSnapshot()`

The `SyncableFS` interface now includes an optional `createSnapshot()` method:

```typescript
interface SyncableFS {
  // ... existing methods ...

  /**
   * Optional: Build a filesystem snapshot.
   * Returns a map of relative path → {size, mtimeMs} for all files under root.
   * Returns null if the filesystem is unreachable.
   *
   * Backends that can provide a more efficient snapshot than the generic
   * walkFiles+stat approach should implement this method.
   */
  createSnapshot?(root: string, filter?: SyncFilter): Promise<Map<string, FileSnapshot> | null>;
}
```

The sync engine's `getSnapshot()` helper dispatches to the FS-provided method when available, falling back to the generic `buildSnapshot()` (walkFiles + stat) otherwise:

```typescript
private async getSnapshot(fs: SyncableFS): Promise<Map<string, FileSnapshot> | null> {
  if (fs.createSnapshot) {
    return fs.createSnapshot(this.root, this.options.filter);
  }
  return buildSnapshot(fs, this.root, this.options.filter);
}
```

**Optimization examples**:
- **Gitee/GitHub**: Use Git tree API to fetch all file metadata in a single request instead of walking files one by one
- **IndexedDB**: Use `getAll()` for batch querying instead of individual `stat()` calls
- **InMemory**: Directly iterate the internal Map (no async I/O overhead)

Backends that do not implement `createSnapshot()` are fully supported — the generic fallback produces identical results.

#### 11.10.2 Separate Source and Target Snapshots

**Previous design** (merged snapshots):
- `buildInitialSnapshots()` merged source and target into a single map: `sourceSnapshots = new Map([...srcSnap, ...tgtSnap])`
- `syncBidirectional()` compared `currentMerged` with the cached merged snapshot
- **Problem**: The merged map lost which filesystem a file belonged to. A file present on target but not source could be "new on target" or "deleted from source" — the merged snapshot couldn't distinguish.

**New design** (separate snapshots):
- `buildInitialSnapshots()` caches two independent maps: `prevSrcSnap` and `prevTgtSnap`
- `syncBidirectional()` compares each side independently:
  ```
  srcChanged = !snapshotsEqual(prevSrcSnap, currentSrcSnap)
  tgtChanged = !snapshotsEqual(prevTgtSnap, currentTgtSnap)
  if (!srcChanged && !tgtChanged && prevSrcSnap && prevTgtSnap) → skip sync
  ```
- Each side's change is detected independently, preserving file-location information

#### 11.10.3 Bidirectional Deletion Propagation

When a file exists on one side but not the other, the sync engine uses previous snapshots to distinguish "created" from "deleted":

```
File on target, not on source:
  ├─ Was it on source in the previous snapshot (prevSrcSnap)?
  │   ├─ Yes → file was deleted from source → delete from target too (propagate deletion)
  │   └─ No  → file was created on target → copy to source

File on source, not on target:
  ├─ Was it on target in the previous snapshot (prevTgtSnap)?
  │   ├─ Yes → file was deleted from target → delete from source too (propagate deletion)
  │   └─ No  → file was created on source → copy to target
```

**Without this mechanism**, deleting a file on one side would cause the sync engine to see "the other side still has it → copy it back", effectively undoing the deletion.

**Relationship with tombstones**: The tombstone mechanism (§11.4) and bidirectional deletion propagation operate at different layers and complement each other:

| Mechanism | Layer | Trigger | How It Works |
|-----------|-------|---------|--------------|
| Tombstone | `zen-fs-config` (application) | Application calls `deleteFile()` | Writes a `.meta/.deleted/` marker, physically deletes file on all replicas **before** sync runs |
| Deletion propagation | `zen-fs-sync` (engine) | Sync detects one-side-only file | Compares with previous snapshot to determine if file was created or deleted |

Tombstones handle application-initiated deletions (the common case). Deletion propagation handles deletions that bypass the tombstone flow — e.g., external modifications on the remote backend, or files removed by other sync mechanisms.

#### 11.10.4 `shouldSync()` vs Snapshot Comparison

These two mechanisms are complementary, not interchangeable:

| Mechanism | Purpose | Cost | When Used |
|-----------|---------|------|-----------|
| `shouldSync()` | Fast "has anything changed?" boolean | O(1) for remote (ETag/commit check) | `onRemotePoll()` — decide whether to trigger sync at all |
| Snapshot comparison | "What exactly changed?" detail | O(n) filesystem traversal | `syncBidirectional()` — decide what to copy/delete |

`shouldSync()` is **not** part of the snapshot comparison because:
1. `shouldSync()` updates its internal baseline after each call — calling it again during sync would return stale results
2. `shouldSync()` returning false doesn't guarantee the snapshot is unchanged — it means the FS's own change detection says nothing changed, which could miss edge cases
3. `shouldSync()` returning true doesn't tell us **which** files changed — snapshots are still needed for that

The two-level optimization works as follows:
1. **Level 1**: `shouldSync()` in remote poll → if false, skip sync trigger entirely (saves the O(n) snapshot build)
2. **Level 2**: Separate snapshot comparison in sync → if both sides unchanged, skip file operations (saves I/O)

## 12. Data Flow

### Read Path
```
Application
  → repo.fs.readFileSync('/db/host.json')
  → ZenFS Context (chroot to /app-a/)
  → CachedFileSystem.readFile('/app-a/db/host.json')
  → Cache hit (TTL)? → return cached bytes (0 network)
  → Cache miss/expired? → 304 revalidate with primary backend
  → Deserialize (JSON.parse for .json files)
  → Return typed object
```

### Write Path (auto-synced)
```
Application
  → repo.setConfig('/db/host', { hostname: 'localhost' })
  → Serialize (JSON.stringify)
  → Write config file: /app-a/db/host.json
  → Write version file: /app-a/.db.host.json.version (version++, new hash)
  → CachedFileSystem.writeFile() →穿透 to primary backend → invalidate cache
  → zen-fs-sync watch detects change (poll + debounce)
  → Sync to replicas per sync-rules
```

### Write Path (node-local, no sync)
```
Application
  → repo.setNodeConfig('server-1', '/local.json', { ip: '10.0.0.1' })
  → Serialize + write to /nodes/server-1/local.json
  → zen-fs-sync ignores /nodes/ (direction: "none")
  → File stays local to primary backend only
```

### Publish (one-time sync)
```
Application
  → repo.publishNodeConfig('server-1')
  → Read /nodes/server-1/**/*
  → Create temporary SyncPair with filter: includePrefixes: ['/nodes/server-1/']
  → Execute one sync() call
  → Files pushed to replicas
  → Dispose temporary SyncPair
```

## 13. Peer Dependencies

| Package | Role | Version | Required |
|---|---|---|---|
| `@zenfs/core` | Virtual file system, backends, VFS, Context | >=2.3.0 | Yes |
| `@zenfs/dom` | IndexedDB backend (browser) | >=1.0.0 | Yes (browser) |
| `zen-fs-sync` | Cross-backend sync engine | >=0.1.0 | Yes |
| `zen-fs-cache` | Read caching with ETag/304 revalidation | >=1.0.0 | No (optional) |

## 14. Extension Points

### Custom Serializer
```typescript
import { createConfigRepo, type ConfigSerializer } from 'zen-fs-config';

const yamlSerializer: ConfigSerializer = {
  serialize(data: unknown): Uint8Array { ... },
  deserialize(raw: Uint8Array, path: string): unknown { ... },
  canHandle(path: string): boolean { return path.endsWith('.yaml'); }
};
```

### Custom Conflict Resolver
```typescript
const repo = await createConfigRepo('app-a', {
  ...
  onConflict: async (conflict) => {
    // Custom conflict resolution logic
    // Return merged content, or null to use default strategy
    return customMerge(conflict.sourceContent, conflict.targetContent);
  }
});
```

### Custom Backend Registry
```typescript
import { registerBackend } from 'zen-fs-config';

registerBackend('CustomStore', async (options) => {
  const { CustomStoreFS } = await import('custom-store-fs');
  return new CustomStoreFS(options);
});
```

## 15. License

MIT