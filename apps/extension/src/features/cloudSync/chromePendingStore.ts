/**
 * @file chromePendingStore.ts
 * @description 待推送变更队列（本机 local-only）
 * @module features/cloudSync
 */
import type { SyncEntity } from '@javdb/sync-protocol';
import { CLOUD_SESSION_STORAGE_KEY } from './chromeTokenStore';
import { CLOUD_SETTINGS_STORAGE_KEY } from './cloudSettingsStorage';

export const CLOUD_PENDING_STORAGE_KEY = 'cloud_sync_pending_v1';
export const CLOUD_PENDING_DELTA_STORAGE_KEY = 'cloud_sync_pending_delta_v1';

let pendingMutationQueue: Promise<void> = Promise.resolve();
let pendingBaseSnapshot: SyncEntity[] | null = null;
let pendingDeltaSnapshot: Record<string, SyncEntity> | null = null;

const UNSYNCABLE_LOG_TYPES = new Set(['log', 'magnet_push_log']);

function entityKey(type: string, id: string): string {
  return `${type}\0${id}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nextValue]) => `${JSON.stringify(key)}:${stableStringify(nextValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

async function readPendingStorage(): Promise<{ base: SyncEntity[]; delta: Record<string, SyncEntity> }> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([CLOUD_PENDING_STORAGE_KEY, CLOUD_PENDING_DELTA_STORAGE_KEY], (res) => {
        const base = res?.[CLOUD_PENDING_STORAGE_KEY];
        const delta = res?.[CLOUD_PENDING_DELTA_STORAGE_KEY];
        resolve({
          base: Array.isArray(base) ? (base as SyncEntity[]) : [],
          delta: delta && typeof delta === 'object' && !Array.isArray(delta)
            ? delta as Record<string, SyncEntity>
            : {},
        });
      });
    } catch {
      resolve({ base: [], delta: {} });
    }
  });
}

async function writePending(values: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(values, () => resolve());
    } catch {
      resolve();
    }
  });
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 判断当前是否具备 Cloud 推送条件：存在会话，或已保存凭据（baseUrl + accountIdentifier）。
 * 每次入队前直接读 storage，不做任何缓存，避免登录后漏入队；
 * 不满足条件时跳过入队——首次登录时 ensureInitialPending 会从本地全量重建，无数据丢失。
 */
async function canQueuePending(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([CLOUD_SESSION_STORAGE_KEY, CLOUD_SETTINGS_STORAGE_KEY], (res) => {
        const session = res?.[CLOUD_SESSION_STORAGE_KEY];
        const hasSession =
          !!session && typeof session === 'object' && isNonEmptyString((session as { accessToken?: unknown }).accessToken);

        const settings = res?.[CLOUD_SETTINGS_STORAGE_KEY];
        const hasCredentials =
          !!settings &&
          typeof settings === 'object' &&
          isNonEmptyString((settings as { baseUrl?: unknown }).baseUrl) &&
          isNonEmptyString((settings as { accountIdentifier?: unknown }).accountIdentifier);

        resolve(hasSession || hasCredentials);
      });
    } catch {
      resolve(false);
    }
  });
}

async function loadPendingSnapshots(): Promise<void> {
  if (pendingBaseSnapshot === null || pendingDeltaSnapshot === null) {
    const pending = await readPendingStorage();
    pendingBaseSnapshot = pending.base;
    pendingDeltaSnapshot = pending.delta;
  }
}

function pendingEntities(): SyncEntity[] {
  const map = new Map((pendingBaseSnapshot ?? []).map((entity) => [entityKey(entity.type, entity.id), entity]));
  for (const [key, entity] of Object.entries(pendingDeltaSnapshot ?? {})) {
    map.set(key, entity);
  }
  return [...map.values()].filter((entity) => !UNSYNCABLE_LOG_TYPES.has(entity.type));
}

function enqueuePendingMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = pendingMutationQueue.then(mutation, mutation);
  pendingMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function listCloudPending(): Promise<SyncEntity[]> {
  await pendingMutationQueue;
  await loadPendingSnapshots();
  return pendingEntities();
}

/** 按 type+id 覆盖写入 pending（后者覆盖前者） */
export async function upsertCloudPending(entities: SyncEntity[]): Promise<void> {
  const syncableEntities = entities.filter((entity) => !UNSYNCABLE_LOG_TYPES.has(entity.type));
  if (!syncableEntities.length) return;
  if (!(await canQueuePending())) return;
  await enqueuePendingMutation(async () => {
    await loadPendingSnapshots();
    const effective = new Map(
      pendingEntities().map((entity) => [entityKey(entity.type, entity.id), entity]),
    );
    const changed = syncableEntities.filter((entity) => {
      const current = effective.get(entityKey(entity.type, entity.id));
      return !current || stableStringify(current) !== stableStringify(entity);
    });
    if (!changed.length) return;
    for (const entity of changed) {
      pendingDeltaSnapshot![entityKey(entity.type, entity.id)] = entity;
    }
    await writePending({ [CLOUD_PENDING_DELTA_STORAGE_KEY]: pendingDeltaSnapshot });
  });
}

export async function clearCloudPending(
  keys: Array<{ type: string; id: string }>,
): Promise<void> {
  if (!keys.length) return;
  await enqueuePendingMutation(async () => {
    await loadPendingSnapshots();
    const drop = new Set(keys.map((k) => entityKey(k.type, k.id)));
    pendingBaseSnapshot = pendingEntities().filter((entity) => !drop.has(entityKey(entity.type, entity.id)));
    pendingDeltaSnapshot = {};
    await writePending({
      [CLOUD_PENDING_STORAGE_KEY]: pendingBaseSnapshot,
      [CLOUD_PENDING_DELTA_STORAGE_KEY]: pendingDeltaSnapshot,
    });
  });
}

/**
 * 首次同步：若 pending 为空，把当前本地全量实体入队，便于首推到空 Cloud。
 */
export async function ensureInitialPending(snapshot: SyncEntity[]): Promise<number> {
  return enqueuePendingMutation(async () => {
    await loadPendingSnapshots();
    if (pendingEntities().length > 0) return 0;
    if (!snapshot.length) return 0;
    pendingBaseSnapshot = [...snapshot];
    pendingDeltaSnapshot = {};
    await writePending({
      [CLOUD_PENDING_STORAGE_KEY]: pendingBaseSnapshot,
      [CLOUD_PENDING_DELTA_STORAGE_KEY]: pendingDeltaSnapshot,
    });
    return snapshot.length;
  });
}
