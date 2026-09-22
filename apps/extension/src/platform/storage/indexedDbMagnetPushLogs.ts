/**
 * @file indexedDbMagnetPushLogs.ts
 * @description magnetPushLogs 表操作与保留策略 —— 自 indexedDb.ts 门面拆出（架构棘轮：门面持续收缩）
 * @module platform/storage
 *
 * 对外 API 不变：indexedDb.ts 仍 re-export 本模块全部导出，现有调用方无需改动。
 */
import { initDB, resetDBConnection } from './indexedDbConnection';
import { getSettings } from '../../utils/storage';
import type { PersistedMagnetPushLogEntry } from './indexedDbSchema';

function normalizeMagnetPushLog(entry: any): PersistedMagnetPushLogEntry {
  const ts = typeof entry?.timestamp === 'number' ? entry.timestamp : Date.now();
  const normalized: PersistedMagnetPushLogEntry = {
    type: entry?.type,
    videoId: String(entry?.videoId || ''),
    message: String(entry?.message || ''),
    timestamp: ts,
    timestampMs: ts,
    timestampISO: new Date(ts).toISOString(),
    source: 'DRIVE115',
    category: 'DRIVE115',
    data: entry?.data,
  };
  if (typeof entry?.id === 'number' && Number.isFinite(entry.id)) {
    normalized.id = entry.id;
  }
  return normalized;
}

async function ensureMagnetPushLogsStore(): Promise<void> {
  const db = await initDB();
  if (db.objectStoreNames.contains('magnetPushLogs')) return;
  db.close();
  resetDBConnection();
  await initDB();
}

export async function magnetPushLogsAdd(entry: any): Promise<number> {
  await ensureMagnetPushLogsStore();
  const db = await initDB();
  const v = normalizeMagnetPushLog(entry);
  try {
    console.info('[115Trace] idb:magnet-log:add:normalized', {
      traceId: (v.data as any)?.traceId || (v.data as any)?.correlationId || '',
      correlationId: (v.data as any)?.correlationId || '',
      taskId: (v.data as any)?.taskId || '',
      type: v.type,
      videoId: v.videoId,
      timestampMs: v.timestampMs,
      hasData: !!v.data,
    });
  } catch {}
  const id = await db.add('magnetPushLogs', v as any);
  const persisted = typeof id === 'number' ? { ...v, id } : v;
  try {
    console.info('[115Trace] idb:magnet-log:add:done', {
      traceId: (v.data as any)?.traceId || (v.data as any)?.correlationId || '',
      correlationId: (v.data as any)?.correlationId || '',
      taskId: (v.data as any)?.taskId || '',
      id,
      type: v.type,
      videoId: v.videoId,
    });
  } catch {}
  try {
    const { scheduleEnqueue, enqueueMagnetPushLogChange } = await import('../../features/cloudSync/enqueueLocalChange');
    scheduleEnqueue(() => enqueueMagnetPushLogChange(persisted as unknown as Record<string, unknown>));
  } catch { /* Cloud 可选 */ }
  try { await magnetPushLogsEnforceRetention(); } catch {}
  return id as number;
}

export async function magnetPushLogsBulkAdd(entries: any[]): Promise<void> {
  if (!entries || entries.length === 0) return;
  await ensureMagnetPushLogsStore();
  const db = await initDB();
  const tx = db.transaction('magnetPushLogs', 'readwrite');
  const written: PersistedMagnetPushLogEntry[] = [];
  try {
    for (const e of entries) {
      const v = normalizeMagnetPushLog(e);
      const id = await tx.store.add(v as any);
      written.push(typeof id === 'number' ? { ...v, id } : v);
    }
    await tx.done;
    try {
      const { scheduleEnqueue, enqueueMagnetPushLogChanges } = await import('../../features/cloudSync/enqueueLocalChange');
      scheduleEnqueue(() => enqueueMagnetPushLogChanges(written as unknown as Array<Record<string, unknown>>));
    } catch { /* Cloud 可选 */ }
    try { await magnetPushLogsEnforceRetention(); } catch {}
  } catch (e) {
    try { await tx.done; } catch {}
    throw e;
  }
}

export async function magnetPushLogsQuery(params: {
  type?: 'push_start' | 'push_success' | 'push_failed' | 'ALL';
  fromMs?: number;
  toMs?: number;
  offset?: number;
  limit?: number;
  order?: 'asc' | 'desc';
  query?: string;
  status?: 'ALL' | 'SUCCESS' | 'FAILED';
}): Promise<{ items: PersistedMagnetPushLogEntry[]; total: number; }> {
  const { type = 'ALL', fromMs, toMs, offset = 0, limit = 100, order = 'desc', query = '', status = 'ALL' } = params || {} as any;
  await ensureMagnetPushLogsStore();
  const db = await initDB();
  try {
    console.info('[115Trace] idb:magnet-log:query:start', { type, fromMs, toMs, offset, limit, order, query, status });
  } catch {}
  const store = db.transaction('magnetPushLogs').store;
  const idx = store.index('by_timestamp');
  const dir = order === 'asc' ? 'next' : 'prev';
  const q = String(query || '').trim().toLowerCase();
  const items: PersistedMagnetPushLogEntry[] = [];
  let skipped = 0;
  let total = 0;
  for (let cursor = await idx.openCursor(undefined, dir); cursor; cursor = await cursor.continue()) {
    const v = cursor.value as PersistedMagnetPushLogEntry;
    if (fromMs != null && v.timestampMs < fromMs) continue;
    if (toMs != null && v.timestampMs > toMs) continue;
    if (type !== 'ALL' && v.type !== type) continue;
    if (status === 'SUCCESS' && v.type !== 'push_success') continue;
    if (status === 'FAILED' && v.type !== 'push_failed') continue;
    if (q) {
      const inMsg = String(v.message || '').toLowerCase().includes(q);
      let inData = false;
      try { inData = v.data ? JSON.stringify(v.data).toLowerCase().includes(q) : false; } catch { inData = false; }
      if (!inMsg && !inData) continue;
    }
    total++;
    if (skipped < offset) { skipped++; continue; }
    if (items.length < limit) items.push(v);
  }
  try {
    console.info('[115Trace] idb:magnet-log:query:done', { total, items: items.length, type, query, status, offset, limit });
  } catch {}
  return { items, total };
}

export async function magnetPushLogsClear(beforeMs?: number): Promise<void> {
  await ensureMagnetPushLogsStore();
  const db = await initDB();
  const tx = db.transaction('magnetPushLogs', 'readwrite');
  const idx = tx.store.index('by_timestamp');
  if (beforeMs == null) {
    await tx.store.clear();
  } else {
    for (let cursor = await idx.openCursor(IDBKeyRange.upperBound(beforeMs)); cursor; cursor = await cursor.continue()) {
      await cursor.delete();
    }
  }
  await tx.done;
}

export async function magnetPushLogsGetAll(): Promise<PersistedMagnetPushLogEntry[]> {
  await ensureMagnetPushLogsStore();
  const db = await initDB();
  return db.getAll('magnetPushLogs');
}

// S2-2 (cycle-7): retention 节流 —— 原实现每批日志写入后都执行「getSettings 读 + logs/magnetPushLogs 全索引扫描」
// （S2-1 归因实测：16 详情页一轮 441 次 LOGS_BULK → settings 读 443 次 + 全扫 441 次，全部落在 browser 进程原生侧，
//   是冷启动阶段 browser CPU 净增量 +35% 的主因）。
// 改为同一 SW 生命周期内至多 60s 执行一次；初始戳 0 保证首次调用必然执行，保留清理不丢失，只是延迟。
// （本模块拆出后 magnet 侧节流常量与时间戳独立维护，语义不变。）

const RETENTION_MIN_INTERVAL_MS = 60_000;
let lastMagnetPushRetentionAt = 0;

async function magnetPushLogsEnforceRetention(): Promise<void> {
  try {
    const now = Date.now();
    if (now - lastMagnetPushRetentionAt < RETENTION_MIN_INTERVAL_MS) return;
    lastMagnetPushRetentionAt = now;
    const settings = await getSettings();
    const logging: any = (settings as any)?.logging || {};
    let maxEntries = Number(logging.maxMagnetPushEntries ?? 10000);
    if (!Number.isFinite(maxEntries) || maxEntries <= 0) maxEntries = 10000;
    const db = await initDB();
    const total = await db.count('magnetPushLogs');
    if (total <= maxEntries) return;
    const toRemove = total - maxEntries;
    const tx = db.transaction('magnetPushLogs', 'readwrite');
    const idx = tx.store.index('by_timestamp');
    let removed = 0;
    for (let cursor = await idx.openCursor(undefined, 'next'); cursor && removed < toRemove; cursor = await cursor.continue()) {
      await cursor.delete();
      removed++;
    }
    await tx.done;
  } catch {}
}
