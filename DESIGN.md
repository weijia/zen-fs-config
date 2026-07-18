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

### 2.2 No Global Primary

Globally, all backends are equal peers — none is the "source of truth."

Locally, each program instance has a "primary backend" — the backend it directly reads/writes through. This is a per-instance choice, not a property of the backend itself.

```
Program A → Primary = Backend X, Replicas = [Y, Z]
Program B → Primary = Backend Y, Replicas = [X, Z]
Program C → Primary = Backend Z, Replicas = [X, Y]
```

### 2.3 Self-Describing Configuration

Backend topology and sync rules are stored **inside** the configuration repository (in `.meta/`), not passed as external parameters. This means any node that can read the config repo can bootstrap the entire sync network.

External input at startup is limited to: **which backend to connect to** and optionally **bootstrap data** (if the repo doesn't exist yet).

## 3. File System Structure

```
/
├─ .meta/                               [not synced]
│  ├─ backends.json                     Backend topology (self-describing)
│  ├─ sync-rules.json                   Sync rules
│  └─ .conflicts/                       Conflict archives (safekeeping)
│     └─ {timestamp}_{path}.from-{a}.to-{b}.json
│
├─ {appId}/                             [one-way: owner → replicas, no conflict]
│  ├─ db.json
│  ├─ cache.json
│  └─ .db.json.version                  Sidecar version file
│
├─ shared/                              [bi-directional, conflict possible]
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
| `/{appId}/` | One-way (owner → replicas) | None (single writer) | Per-app private config |
| `/shared/` | Bi-directional | Possible (multiple writers) | Cross-app shared config |
| `/nodes/` | None (by default) | None | Per-node local config |
| `/.meta/` | None | None | Topology, rules, conflict archives |

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

## 4. Backend Topology (`.meta/backends.json`)

```json
{
  "version": 1,
  "backends": [
    {
      "id": "local-idb",
      "type": "IndexedDB",
      "options": { "dbName": "app-config" },
      "description": "Browser local storage"
    },
    {
      "id": "remote-s3",
      "type": "S3Bucket",
      "options": { "bucket": "app-config-bucket", "region": "us-east-1" },
      "description": "Cloud backup"
    }
  ]
}
```

Each program instance selects one backend as its primary via `primaryBackendId`. Others become replicas.

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

  /** Dispose: stop sync, release cache FS */
  dispose(): Promise<void>;
}
```

## 10. Initialization

```typescript
import { createConfigRepo } from 'zen-fs-config';

const repo = await createConfigRepo('app-a', {
  // The only required external input: which backend to connect to
  primaryBackendId: 'local-idb',

  // Backend connection info (only for the primary)
  backendInfo: {
    type: 'IndexedDB',
    options: { dbName: 'app-a-config' }
  },

  // Node ID (optional, see §8.2 for auto-detection)
  nodeId: 'server-1',

  // Cache configuration (optional, defaults shown)
  cache: {
    storeType: 'MemoryCacheStore',
    ttlMs: 60000
  },

  // Bootstrap data (only used when .meta/backends.json doesn't exist)
  bootstrap: {
    backends: [
      { id: 'local-idb', type: 'IndexedDB', options: { dbName: 'app-config' } },
      { id: 'remote-s3', type: 'S3Bucket', options: { bucket: 'app-config' } }
    ],
    syncRules: [
      { prefix: '/app-a/', direction: 'one-way', conflictStrategy: 'source-wins', replicas: ['local-idb', 'remote-s3'] },
      { prefix: '/shared/', direction: 'bi-directional', conflictStrategy: 'merge', replicas: ['local-idb', 'remote-s3'] },
      { prefix: '/nodes/', direction: 'none' },
      { prefix: '/.meta/', direction: 'none' }
    ]
  }
});

// Normal config operations
repo.setConfig('/db/host', { hostname: 'localhost', port: 3306 });
const dbConfig = repo.getConfig<{ hostname: string; port: number }>('/db/host');

// Node-local config
repo.setNodeConfig('server-1', '/local.json', { ip: '10.0.0.1' });

// Publish for debugging (one-time sync)
await repo.publishNodeConfig('server-1');

// Cleanup
await repo.dispose();
```

## 11. Initialization Flow

```
createConfigRepo('app-a', { primaryBackendId: 'X', backendInfo: {...}, bootstrap: {...} })
  │
  ├─ 1. Connect to primary backend (backendId = 'X')
  │
  ├─ 2. Wrap with zen-fs-cache → CachedFileSystem(primaryBackend, cacheStore, { ttlMs })
  │
  ├─ 3. Configure ZenFS VFS: { '/': cachedFS }
  │
  ├─ 4. Read .meta/backends.json
  │     ├─ Exists → parse topology, create replica backend instances
  │     └─ Not exists → write bootstrap data to .meta/
  │
  ├─ 5. Read .meta/sync-rules.json
  │     ├─ Exists → parse rules
  │     └─ Not exists → use bootstrap syncRules
  │
  ├─ 6. For each rule with direction != 'none':
  │     ├─ Create SyncPair(
  │     │     source: cachedFS,
  │     │     target: replicaBackend,
  │     │     { direction, conflictStrategy, filter: { includePrefixes: [rule.prefix] } }
  │     │   )
  │     └─ syncEngine.watch(pairId)
  │
  ├─ 7. Determine nodeId (explicit > env > auto-generated .node-id file)
  │
  ├─ 8. Create ZenFS Context:
  │     ├─ Allowed paths: /{appId}/, /shared/, /nodes/{nodeId}/, /.meta/
  │     ├─ Root chroot: /{appId}/ (for getConfig/setConfig)
  │     └─ Full access for zen-fs-sync (unrestricted)
  │
  └─ 9. Return ConfigRepo { fs, appId, nodeId, ... }
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

| Package | Role | Version |
|---|---|---|
| `@zenfs/core` | Virtual file system, backends, VFS, Context | >=2.3.0 |
| `zen-fs-cache` | Read caching with ETag/304 revalidation | >=1.0.0 |
| `zen-fs-sync` | Cross-backend sync engine | >=0.1.0 |

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