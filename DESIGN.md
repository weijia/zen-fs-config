# zen-fs-config — Design Document

## 1. Overview

zen-fs-config is a distributed configuration management library built on top of:
- **ZenFS** (`@zenfs/core`) — Virtual file system with pluggable backends
- **zen-fs-cache** — Caching layer with ETag/304 revalidation
- **zen-fs-sync** — Sync engine for mirroring configs across backends

It allows multiple application instances (programs) running on different nodes to share configuration through a network of ZenFS backends, with per-app isolation, shared config spaces, node-local config, and conflict safety.

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

## 3. File System Structure

```
/
├─ .meta/                               [synced to replicas]
│  ├─ backends/                          Backend topology (one file per backend)
│  │  ├─ local-idb.json                  { id, type, options, description }
│  │  ├─ gitee-prod.json
│  │  └─ ...
│  ├─ .deleted/                          Tombstones for deletion propagation
│  │  └─ {encoded-path}.json
│  └─ .conflicts/                        Conflict archives (safekeeping)
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

### 3.1 Directory Semantics

| Directory | Sync Direction | Conflict Risk | Purpose |
|---|---|---|---|
| `/{appId}/` | Bi-directional (primary ↔ replicas) | Low (single device) | Per-app private config |
| `/shared/` | Bi-directional | Possible (multiple writers) | Cross-app shared config |
| `/nodes/` | None (by default) | None | Per-node local config |
| `/.meta/` | Bi-directional | None (topology files) | Backend topology, tombstones, conflict archives |

### 3.2 Config-to-File Mapping

Each config key maps to one file. The mapping is straightforward:

- `setConfig('/db/host', { hostname: 'localhost' })` → writes file `/app-a/db/host.json` with content `{"hostname":"localhost"}`
- `getConfig('/db/host')` → reads file `/app-a/db/host.json`, parses based on extension
- Path is relative to the app's root (`/{appId}/`), with `.json` extension appended automatically
- If path already has an extension (e.g., `/readme.md`), the extension is preserved

### 3.3 Serialization

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

  /** Dispose: stop sync, release resources */
  dispose(): Promise<void>;
}
```

## 10. Initialization

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

## 11. Initialization Flow

```
createConfigRepo('my-app', options?)
  │
  ├─ 1. Create IndexedDB backend (always, ID = 'local-idb')
  │     storeName = options.idbStoreName || `zen-fs-config-${appId}`
  │
  ├─ 2. Ensure /.meta/ directory exists
  │
  ├─ 3. Migrate legacy .meta/backends.json → .meta/backends/*.json (if exists)
  │
  ├─ 4. Ensure local-idb descriptor exists in .meta/backends/
  │
  ├─ 5. If options.backendInfo provided:
  │     ├─ Generate replica ID (options.primaryBackendId or auto)
  │     └─ Write descriptor to .meta/backends/{replicaId}.json (if not exists)
  │
  ├─ 6. Read all backend descriptors from .meta/backends/
  │
  ├─ 7. Determine nodeId (explicit > env > auto-generated .node-id file)
  │
  ├─ 8. Create ConfigRepo with primary = 'local-idb'
  │
  ├─ 9. setupSync: for each backend (except local-idb):
  │     ├─ Create backend instance
  │     ├─ Create SyncPair(IndexedDB, replica, bi-directional)
  │     └─ syncEngine.watch(pairId)
  │
  ├─ 10. syncMetaToReplicas: push .meta/ changes to all replicas
  │
  └─ 11. Load config cache from IndexedDB
```

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