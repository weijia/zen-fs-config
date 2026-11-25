/**
 * Public V2 API: connectV2 / AppRepo / DataGroup.
 *
 * The V2 surface deliberately stays small:
 *
 *   connectV2(appId, options) -> AppRepo
 *   AppRepo.getDefaultDataGroup() -> DataGroup
 *   DataGroup.fs / addBackend() / onSyncEvent()
 *
 * It reuses the legacy `connect()` implementation internally and never creates
 * a second connection pool. The old connect()/ConfigRepo/AppDataGroup APIs stay
 * unchanged.
 */
import { connect } from './connect';
import { LOCAL_IDB_BACKEND_ID } from './config-repo';
import { hasBackend, getBackendMetadata } from './backend-registry';
import { assertValidBackendId } from './group-meta';
import type {
  AppDataBackendDescriptor,
  AppDataGroup,
  AppDataGroupDescriptor,
  ConnectOptions,
  ConnectResult,
  IConfigRepo,
  SyncGroupSyncEvent,
} from './types';
import type { SyncResult } from 'zen-fs-sync';

export interface DataBackendInput {
  /** Stable backend id. Omit to auto-generate. */
  id?: string;
  type: string;
  options: Record<string, unknown>;
  description?: string;
}

export interface AddBackendResult {
  backendId: string;
  /** false when the same id or endpoint was already present (idempotent). */
  addedBackend: boolean;
}

/** One data-sync pair's result, mirrored from `SyncResult`. */
export interface DataGroupSyncResult {
  filesCreated: number;
  filesUpdated: number;
  filesDeleted: number;
  filesSkipped: number;
  conflicts: unknown[];
  errors: unknown[];
  durationMs: number;
}

/** One pair's result from an explicit `flush()`, including its pair id. */
export interface DataGroupFlushResult extends DataGroupSyncResult {
  pairId: string;
}

/** Lightweight group list entry; no descriptors or backend credentials. */
export interface DataGroupInfo {
  id: string;
  name: string;
  /** true when the group declares at least one remote backend. */
  hasRemote: boolean;
}

export interface DataGroupSyncProgress {
  processed: number;
  total?: number;
  currentPath?: string;
  phase?: string;
}

export type DataGroupSyncEvent =
  | {
      type: 'sync:start';
      groupId: string;
      backendId: string;
      pairId: string;
      timestamp: number;
    }
  | {
      type: 'sync:progress';
      groupId: string;
      backendId: string;
      pairId: string;
      timestamp: number;
      progress: DataGroupSyncProgress;
    }
  | {
      type: 'sync:end';
      groupId: string;
      backendId: string;
      pairId: string;
      timestamp: number;
      result: DataGroupSyncResult;
    }
  | {
      type: 'sync:error';
      groupId: string;
      backendId: string;
      pairId: string;
      timestamp: number;
      error: string;
    }
  | {
      type: 'conflict';
      groupId: string;
      backendId: string;
      pairId: string;
      timestamp: number;
      conflict: unknown;
    };

export interface DataGroup {
  readonly id: string;
  readonly fs: AppDataGroup['fs'];
  addBackend(input: DataBackendInput): Promise<AddBackendResult>;
  /** Sync this group's pairs now and return one result per pair. */
  flush(): Promise<DataGroupFlushResult[]>;
  /**
   * Delete a group-relative path through the group's tombstone-aware path.
   * Prefer this over fs.promises.unlink so the deletion propagates and cannot
   * be resurrected by the next sync.
   */
  deleteFile(path: string): Promise<void>;
  onSyncEvent(handler: (event: DataGroupSyncEvent) => void): () => void;
}

export interface AppRepo {
  readonly appId: string;
  getDefaultDataGroup(): Promise<DataGroup>;
  /** Load an existing group by id. Never creates a group. */
  getDataGroup(id: string): Promise<DataGroup>;
  /** Existing groups on this device, for an app-side group picker. */
  listDataGroups(): Promise<DataGroupInfo[]>;
}

export interface ConfigBackendInput {
  id?: string;
  type: string;
  options: Record<string, unknown>;
  description?: string;
}

/**
 * connectV2 keeps the config-sync options of the legacy connect() but never
 * accepts data backends: data backends belong to a DataGroup and are added via
 * DataGroup.addBackend().
 */
export interface ConnectV2Options extends Omit<ConnectOptions, 'backendInfo'> {
  backendInfo?: {
    type: string;
    options: Record<string, unknown>;
  };
  /** Extra config-sync replicas. The first one becomes the primary replica. */
  configBackends?: ConfigBackendInput[];
  /** Must not be used with connectV2; kept out of the type on purpose. */
  dataBackends?: never;
}

/** A raw connection carrying the appId needed to wrap it as an AppRepo. */
export type UiConnection = ConnectResult & { appId: string };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ConnectV2Error extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ConnectFailedError extends ConnectV2Error {
  constructor(message: string) {
    super(message, 'CONNECT_FAILED');
  }
}

export class ConfigNotReadyError extends ConnectV2Error {
  constructor(message: string) {
    super(message, 'CONFIG_NOT_READY');
  }
}

export class InvalidBackendError extends ConnectV2Error {
  constructor(message: string) {
    super(message, 'INVALID_BACKEND');
  }
}

export class BackendAlreadyExistsError extends ConnectV2Error {
  constructor(message: string) {
    super(message, 'BACKEND_ALREADY_EXISTS');
  }
}

export class BackendEndpointConflictError extends ConnectV2Error {
  constructor(message: string) {
    super(message, 'BACKEND_ENDPOINT_CONFLICT');
  }
}

export class BackendIdentityError extends ConnectV2Error {
  constructor(message: string) {
    super(message, 'BACKEND_IDENTITY_ERROR');
  }
}

export class DataGroupCreateError extends ConnectV2Error {
  constructor(message: string) {
    super(message, 'DATA_GROUP_CREATE_FAILED');
  }
}

export class DataGroupBackendError extends ConnectV2Error {
  constructor(message: string) {
    super(message, 'DATA_GROUP_BACKEND_FAILED');
  }
}

export class DataGroupNotFoundError extends ConnectV2Error {
  constructor(message: string) {
    super(message, 'DATA_GROUP_NOT_FOUND');
  }
}

export class DataGroupOperationError extends ConnectV2Error {
  constructor(message: string) {
    super(message, 'DATA_GROUP_OPERATION_FAILED');
  }
}

// ---------------------------------------------------------------------------
// Connection <-> AppRepo identity
// ---------------------------------------------------------------------------

const connectionToRepo = new WeakMap<object, AppRepo>();
const repoToConnection = new WeakMap<object, UiConnection>();

/**
 * Wrap a raw connect() result as an AppRepo, preserving object identity: the
 * same connection always yields the same AppRepo wrapper.
 */
export function connectionToAppRepo(connection: UiConnection): AppRepo {
  const existing = connectionToRepo.get(connection);
  if (existing) return existing;
  const repo = new AppRepoImpl(connection);
  connectionToRepo.set(connection, repo);
  repoToConnection.set(repo, connection);
  return repo;
}

/**
 * Get the raw connection behind an AppRepo. Intended for zen-fs-config-ui;
 * product code should only use AppRepo.
 */
export function getUiConnection(repo: AppRepo): UiConnection {
  const connection = repoToConnection.get(repo as object);
  if (!connection) {
    throw new ConnectV2Error(
      'getUiConnection() received an AppRepo that was not created by connectV2()',
      'UNKNOWN_APP_REPO',
    );
  }
  return connection;
}

// ---------------------------------------------------------------------------
// AppRepo
// ---------------------------------------------------------------------------

class AppRepoImpl implements AppRepo {
  readonly appId: string;
  private readonly repo: IConfigRepo;
  private defaultGroupPromise: Promise<DataGroup> | null = null;
  private readonly groups = new Map<string, DataGroupImpl>();
  private readonly groupPromises = new Map<string, Promise<DataGroupImpl>>();

  constructor(connection: UiConnection) {
    if (!connection.repo) {
      throw new ConnectV2Error(
        'connectV2() requires a config-sync connection; no repo was returned',
        'CONNECT_FAILED',
      );
    }
    this.appId = connection.appId;
    this.repo = connection.repo;
  }

  async getDefaultDataGroup(): Promise<DataGroup> {
    if (this.defaultGroupPromise) {
      try {
        const current = await this.defaultGroupPromise;
        if (await this.stillExists(current.id)) return current;
        this.groups.delete(current.id);
        this.groupPromises.delete(current.id);
      } catch {
        // Resolution failed; retry below.
      }
      this.defaultGroupPromise = null;
    }

    this.defaultGroupPromise = this.resolveDefaultGroup();
    try {
      return await this.defaultGroupPromise;
    } catch (err) {
      this.defaultGroupPromise = null;
      throw err;
    }
  }

  async getDataGroup(id: string): Promise<DataGroup> {
    const groupId = id?.trim();
    if (!groupId) {
      throw new DataGroupNotFoundError('Data group id is required');
    }
    const groups = await this.repo.listAppDataGroups();
    const descriptor = groups.find((group) => group.id === groupId);
    if (!descriptor) {
      throw new DataGroupNotFoundError(`Data group "${groupId}" does not exist`);
    }
    return this.loadGroup(descriptor);
  }

  async listDataGroups(): Promise<DataGroupInfo[]> {
    const groups = await this.repo.listAppDataGroups();
    return groups.map((group) => ({
      id: group.id,
      name: group.name?.trim() || group.id,
      hasRemote: (group.backends ?? []).length > 0,
    }));
  }

  private async stillExists(id: string): Promise<boolean> {
    try {
      const groups = await this.repo.listAppDataGroups();
      return groups.some((group) => group.id === id);
    } catch {
      // A transient config read failure must not throw away a live group.
      return true;
    }
  }

  private async resolveDefaultGroup(): Promise<DataGroup> {
    let groups = await this.repo.listAppDataGroups();
    if (groups.length > 0) {
      return this.loadGroup(selectDefaultDescriptor(groups));
    }

    // No local descriptors does not mean "no groups": the config group may not
    // have finished its first pull. Waiting prevents creating an empty local
    // `default` that could later claim an existing remote group.
    await this.waitForConfigPull();

    groups = await this.repo.listAppDataGroups();
    if (groups.length > 0) {
      return this.loadGroup(selectDefaultDescriptor(groups));
    }

    return this.createDefaultGroup();
  }

  private async waitForConfigPull(): Promise<void> {
    let remoteCount = 0;
    try {
      const meta = await this.repo.getBackends();
      remoteCount = (meta?.backends ?? []).filter(
        (backend) => backend.id !== LOCAL_IDB_BACKEND_ID,
      ).length;
    } catch {
      // If the topology cannot be read, do not create a local group blindly.
      throw new ConfigNotReadyError(
        'Cannot read config-sync backends; refusing to create a local default data group',
      );
    }

    if (remoteCount === 0) return;

    let summary;
    try {
      summary = await this.repo.whenReplicasReady?.();
    } catch (err) {
      throw new ConfigNotReadyError(
        `Config replicas failed before initial pull: ${errorMessage(err)}`,
      );
    }

    if (summary && (summary.failed.length > 0 || summary.skipped.length > 0)) {
      const details = [
        ...summary.failed.map((item) => `${item.backendId}: ${item.error}`),
        ...summary.skipped.map((item) => `${item.backendId}: ${item.reason}`),
      ].join('; ');
      throw new ConfigNotReadyError(
        `Config group is not ready; refusing to create a local default data group (${details})`,
      );
    }

    try {
      // flush() awaits the background initial pull and pushes pending local
      // config. At this point no data-group descriptor exists, so this cannot
      // overwrite a remote data group.
      await this.repo.flush();
    } catch (err) {
      throw new ConfigNotReadyError(
        `Initial config pull did not complete: ${errorMessage(err)}`,
      );
    }
  }

  private async loadGroup(descriptor: AppDataGroupDescriptor): Promise<DataGroupImpl> {
    const cached = this.groups.get(descriptor.id);
    if (cached) return cached;
    const pending = this.groupPromises.get(descriptor.id);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const live = await this.repo.getAppDataGroup(descriptor.id);
        const group = new DataGroupImpl(this.repo, live, descriptor.id);
        this.groups.set(descriptor.id, group);
        return group;
      } catch (err) {
        throw new DataGroupCreateError(
          `Failed to load data group "${descriptor.id}": ${errorMessage(err)}`,
        );
      }
    })();
    this.groupPromises.set(descriptor.id, promise);
    try {
      return await promise;
    } finally {
      this.groupPromises.delete(descriptor.id);
    }
  }

  private async createDefaultGroup(): Promise<DataGroupImpl> {
    try {
      const live = await this.repo.createAppDataGroup('default', []);
      const group = new DataGroupImpl(this.repo, live, 'default');
      this.groups.set('default', group);
      return group;
    } catch (err) {
      // Another tab/device may have created it in the meantime. Re-read before
      // declaring failure.
      let groups: AppDataGroupDescriptor[] = [];
      try {
        groups = await this.repo.listAppDataGroups();
      } catch {
        // Fall through to the original error.
      }
      if (groups.length > 0) {
        return this.loadGroup(selectDefaultDescriptor(groups));
      }
      throw new DataGroupCreateError(
        `Failed to create local default data group: ${errorMessage(err)}`,
      );
    }
  }
}

function selectDefaultDescriptor(
  groups: AppDataGroupDescriptor[],
): AppDataGroupDescriptor {
  return groups.find((group) => group.id === 'default') ?? groups[0]!;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// DataGroup
// ---------------------------------------------------------------------------

class DataGroupImpl implements DataGroup {
  readonly id: string;
  readonly fs: AppDataGroup['fs'];
  private readonly repo: IConfigRepo;
  private readonly group: AppDataGroup;

  constructor(repo: IConfigRepo, group: AppDataGroup, id: string) {
    this.repo = repo;
    this.group = group;
    this.id = id;
    this.fs = group.fs;
  }

  async addBackend(input: DataBackendInput): Promise<AddBackendResult> {
    const type = input.type?.trim();
    if (!type) throw new InvalidBackendError('Backend type is required');
    if (!hasBackend(type)) {
      throw new InvalidBackendError(`Backend type "${type}" is not registered`);
    }
    if (!input.options || typeof input.options !== 'object') {
      throw new InvalidBackendError('Backend options must be an object');
    }
    if (input.id) {
      if (input.id === LOCAL_IDB_BACKEND_ID) {
        throw new InvalidBackendError(
          `"${LOCAL_IDB_BACKEND_ID}" is the implicit local primary and cannot be added`,
        );
      }
      assertValidBackendId(input.id);
    }

    const declared = this.listDeclaredBackends();
    const byId = input.id ? declared.find((backend) => backend.id === input.id) : undefined;
    if (byId) {
      return { backendId: byId.id, addedBackend: false };
    }

    const endpointKey = backendEndpointKey(type, input.options);
    const sameEndpoint = declared.find(
      (backend) => backendEndpointKey(backend.type, backend.options) === endpointKey,
    );
    if (sameEndpoint) {
      return { backendId: sameEndpoint.id, addedBackend: false };
    }

    await this.assertEndpointUnusedElsewhere(type, input.options);

    const id = input.id ?? generateBackendId(type, declared);
    try {
      await this.group.addBackend(id, type, input.options, input.description);
    } catch (err) {
      throw new DataGroupBackendError(
        `Failed to add backend "${id}" to data group "${this.id}": ${errorMessage(err)}`,
      );
    }
    return { backendId: id, addedBackend: true };
  }

  async flush(): Promise<DataGroupFlushResult[]> {
    try {
      const results = await this.group.flush();
      return (results ?? []).map((result) => ({
        pairId: result.pairId,
        ...normalizeSyncResult(result),
      }));
    } catch (err) {
      throw new DataGroupOperationError(
        `Failed to flush data group "${this.id}": ${errorMessage(err)}`,
      );
    }
  }

  async deleteFile(path: string): Promise<void> {
    try {
      await this.group.deleteFile(path);
    } catch (err) {
      throw new DataGroupOperationError(
        `Failed to delete "${path}" from data group "${this.id}": ${errorMessage(err)}`,
      );
    }
  }

  onSyncEvent(handler: (event: DataGroupSyncEvent) => void): () => void {
    const subscribe = (this.group as {
      onSyncEvent?: (cb: (event: SyncGroupSyncEvent) => void) => () => void;
    }).onSyncEvent;
    if (typeof subscribe !== 'function') {
      return () => { /* older AppDataGroup: no events */ };
    }
    return subscribe.call(this.group, (event) => {
      const mapped = mapSyncEvent(event, this.id);
      if (mapped) handler(mapped);
    });
  }

  private listDeclaredBackends(): AppDataBackendDescriptor[] {
    const list = (this.group as {
      listDeclaredBackends?: () => AppDataBackendDescriptor[];
    }).listDeclaredBackends;
    if (typeof list === 'function') {
      return list.call(this.group);
    }
    return [];
  }

  private async assertEndpointUnusedElsewhere(
    type: string,
    options: Record<string, unknown>,
  ): Promise<void> {
    const key = backendEndpointKey(type, options);
    const configMeta = await this.repo.getBackends().catch(() => null);
    for (const backend of configMeta?.backends ?? []) {
      if (backend.id === LOCAL_IDB_BACKEND_ID) continue;
      if (backendEndpointKey(backend.type, backend.options) === key) {
        throw new BackendEndpointConflictError(
          `Backend endpoint is already used by config group backend "${backend.id}"`,
        );
      }
    }

    const groups = await this.repo.listAppDataGroups().catch(() => []);
    for (const descriptor of groups) {
      if (descriptor.id === this.id) continue;
      for (const backend of descriptor.backends ?? []) {
        if (backendEndpointKey(backend.type, backend.options) === key) {
          throw new BackendEndpointConflictError(
            `Backend endpoint is already used by data group "${descriptor.id}" backend "${backend.id}"`,
          );
        }
      }
    }
  }
}

function mapSyncEvent(
  event: SyncGroupSyncEvent,
  groupId: string,
): DataGroupSyncEvent | null {
  const base = {
    groupId,
    backendId: event.backendId,
    pairId: event.pairId,
    timestamp: event.timestamp,
  };

  switch (event.type) {
    case 'sync:start':
      return { type: 'sync:start', ...base };
    case 'sync:progress':
      if (!event.progress) return null;
      return { type: 'sync:progress', ...base, progress: event.progress };
    case 'sync:end':
      return {
        type: 'sync:end',
        ...base,
        result: normalizeSyncResult(event.result),
      };
    case 'sync:error':
      return {
        type: 'sync:error',
        ...base,
        error: event.error ?? 'sync failed',
      };
    case 'conflict':
      return { type: 'conflict', ...base, conflict: event.conflict };
    default:
      return null;
  }
}

function normalizeSyncResult(result?: SyncResult): DataGroupSyncResult {
  return {
    filesCreated: result?.filesCreated ?? 0,
    filesUpdated: result?.filesUpdated ?? 0,
    filesDeleted: result?.filesDeleted ?? 0,
    filesSkipped: result?.filesSkipped ?? 0,
    conflicts: result?.conflicts ?? [],
    errors: result?.errors ?? [],
    durationMs: result?.durationMs ?? 0,
  };
}

function backendEndpointKey(type: string, options: Record<string, unknown>): string {
  const identityFields = getBackendMetadata(type)?.identityFields;
  const picked: Record<string, unknown> = {};
  if (identityFields && identityFields.length > 0) {
    for (const field of identityFields) picked[field] = options[field];
  } else {
    Object.assign(picked, options);
  }
  return `${type}:${stableStringify(picked)}`;
}

function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value as object)) return '"[circular]"';
  seen.add(value as object);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, seen)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item, seen)}`)
    .join(',')}}`;
}

function generateBackendId(type: string, existing: AppDataBackendDescriptor[]): string {
  const prefix = type.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'backend';
  let id = `${prefix}-${Date.now().toString(36)}`;
  let suffix = 1;
  while (existing.some((backend) => backend.id === id)) {
    id = `${prefix}-${Date.now().toString(36)}-${suffix++}`;
  }
  return id;
}

// ---------------------------------------------------------------------------
// connectV2
// ---------------------------------------------------------------------------

const connectCache = new Map<string, Promise<AppRepo>>();

/**
 * Connect as a config-sync repo and return the small AppRepo surface.
 *
 * Internally calls the legacy connect() once; there is no separate pool. The
 * cache key includes appId + connection options so repeated calls with the
 * same topology share the same repo instance.
 */
export async function connectV2(
  appId: string,
  options: ConnectV2Options = {},
): Promise<AppRepo> {
  const normalized = normalizeOptions(options);
  const key = `${appId}\u0000${stableStringify(normalized)}`;

  const cached = connectCache.get(key);
  if (cached) return cached;

  const pending = createConnection(appId, normalized).catch((err) => {
    connectCache.delete(key);
    throw err instanceof ConnectV2Error
      ? err
      : new ConnectFailedError(errorMessage(err));
  });
  connectCache.set(key, pending);
  return pending;
}

async function createConnection(
  appId: string,
  options: NormalizedConnectV2Options,
): Promise<AppRepo> {
  const { configBackends, connectOptions } = options;

  let result: ConnectResult;
  try {
    result = await connect(appId, connectOptions);
  } catch (err) {
    throw new ConnectFailedError(
      `connectV2("${appId}") failed: ${errorMessage(err)}`,
    );
  }

  if (!result.repo) {
    throw new ConnectFailedError(
      `connectV2("${appId}") did not return a config-sync repo`,
    );
  }

  await addExtraConfigBackends(result.repo, configBackends);

  return connectionToAppRepo({ ...result, appId });
}

async function addExtraConfigBackends(
  repo: IConfigRepo,
  backends: ConfigBackendInput[],
): Promise<void> {
  if (backends.length === 0) return;

  let existing: AppDataBackendDescriptor[] = [];
  try {
    const meta = await repo.getBackends();
    existing = (meta?.backends ?? []) as AppDataBackendDescriptor[];
  } catch {
    // Let addBackend() surface the real failure.
  }

  for (const backend of backends) {
    const id = backend.id ?? generateBackendId(backend.type, existing);
    const byId = existing.find((item) => item.id === id);
    if (byId) continue;
    const key = backendEndpointKey(backend.type, backend.options);
    if (
      existing.some(
        (item) => backendEndpointKey(item.type, item.options) === key,
      )
    ) {
      continue;
    }
    try {
      await repo.addBackend(id, backend.type, backend.options, backend.description);
      existing = [
        ...existing,
        {
          id,
          type: backend.type,
          options: backend.options,
          description: backend.description,
        } as AppDataBackendDescriptor,
      ];
    } catch (err) {
      throw new DataGroupBackendError(
        `Failed to add config backend "${id}": ${errorMessage(err)}`,
      );
    }
  }
}

interface NormalizedConnectV2Options {
  connectOptions: ConnectOptions;
  configBackends: ConfigBackendInput[];
}

function normalizeOptions(options: ConnectV2Options): NormalizedConnectV2Options {
  const {
    configBackends = [],
    backendInfo,
    dataBackends: _ignored,
    ...rest
  } = options as ConnectV2Options & {
    dataBackends?: unknown;
  };
  void _ignored;

  const extra = configBackends.map((backend) => ({ ...backend }));
  let primary = backendInfo;

  if (!primary && extra.length > 0) {
    const first = extra.shift()!;
    primary = { type: first.type, options: first.options };
    if (!rest.primaryBackendId && first.id) rest.primaryBackendId = first.id;
  }

  return {
    connectOptions: {
      ...rest,
      ...(primary ? { backendInfo: primary } : {}),
    },
    configBackends: extra,
  };
}
