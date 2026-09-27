/**
 * @file backupCollector.ts
 * @description backupCollector
 * @module features/webdavSync
 */
import { logsGetAll as idbLogsGetAll, magnetPushLogsGetAll as idbMagnetPushLogsGetAll, initDB } from '../../../platform/storage/indexedDb';
import { resolveChromeStorageAssetPolicy } from '../../../shared/dataAssets/assetRegistry';
import { STORAGE_KEYS } from '../../../utils/config';
import { getSettings, getValue } from '../../../utils/storage';
import type { WebDAVClientLog } from '../infrastructure/webdavClient';

export interface WebDAVBackupCollectorOptions {
  logger?: WebDAVClientLog;
}

export function byteSizeOf(value: any): number {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return new TextEncoder().encode(s).length;
  } catch {
    return 0;
  }
}

export function omitLocalOnlyStorageKeys(value: Record<string, any>): Record<string, any> {
  const next = { ...(value || {}) };
  for (const key of Object.keys(next)) {
    if (resolveChromeStorageAssetPolicy(key)?.webdav.backup !== true) {
      delete next[key];
    }
  }
  return next;
}

export type WebdavBackupRangeState = {
  coreData: boolean;
  actorData: boolean;
  newWorksData: boolean;
  systemConfig: boolean;
  logsData: boolean;
};

/**
 * 解析备份范围（settings.webdav.backupRange）的生效值。
 * 键缺失 / 整个 backupRange 键不存在 = 5 项全收集（与现行「无条件全量备份」行为一致，
 * 存量用户零行为变更）；仅显式持久化 false 的类别才被过滤。
 * 统一 `!== false` 语义，不复用表单层 normalize 的 `!!` 语义
 * （否则从未保存过设置的存量用户会意外丢失新作品/日志备份）。
 */
export function resolveBackupRange(raw: unknown): WebdavBackupRangeState {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    coreData: r.coreData !== false,
    actorData: r.actorData !== false,
    newWorksData: r.newWorksData !== false,
    systemConfig: r.systemConfig !== false,
    logsData: r.logsData !== false,
  };
}

/**
 * storageAll 键 → 备份类别映射（与 UI「备份数据范围」5 复选框口径一致）。
 * 未列入映射的键保守策略=不过滤（宁多勿丢，避免映射漏列导致静默丢数据）。
 */
const STORAGE_KEY_BACKUP_CATEGORY: Record<string, keyof WebdavBackupRangeState> = {
  // 核心数据：观看记录、用户资料
  [STORAGE_KEYS.VIEWED_RECORDS]: 'coreData',
  [STORAGE_KEYS.USER_PROFILE]: 'coreData',
  [STORAGE_KEYS.MEDIA_WATCH_EVIDENCE]: 'coreData',
  // 演员数据：演员库
  [STORAGE_KEYS.ACTOR_RECORDS]: 'actorData',
  // 新作品数据：订阅和记录
  [STORAGE_KEYS.NEW_WORKS_SUBSCRIPTIONS]: 'newWorksData',
  [STORAGE_KEYS.NEW_WORKS_RECORDS]: 'newWorksData',
  [STORAGE_KEYS.NEW_WORKS_CONFIG]: 'newWorksData',
  // 系统配置：拓展设置、域名配置、搜索引擎等
  [STORAGE_KEYS.SETTINGS]: 'systemConfig',
  [STORAGE_KEYS.LAST_IMPORT_STATS]: 'systemConfig',
  [STORAGE_KEYS.RESTORE_BACKUP]: 'systemConfig',
  [STORAGE_KEYS.WEBDAV_LAST_SELECTED_BACKUP]: 'systemConfig',
  [STORAGE_KEYS.PRIVACY_STATE]: 'systemConfig',
  [STORAGE_KEYS.ADV_SEARCH_PRESETS]: 'systemConfig',
  [STORAGE_KEYS.EMBY_LIBRARY_STATE]: 'systemConfig',
  [STORAGE_KEYS.DRIVE115_LIBRARY_STATE]: 'systemConfig',
  [STORAGE_KEYS.MEDIA_115_CLEANUP_LIST]: 'systemConfig',
  [STORAGE_KEYS.MEDIA_CLEANUP_STATE]: 'systemConfig',
  [STORAGE_KEYS.MEDIA_DELETION_HISTORY]: 'systemConfig',
  [STORAGE_KEYS.DASHBOARD_LAST_PAGE]: 'systemConfig',
  'cloud_sync_settings_v1': 'systemConfig',
  'cloud_auto_sync_settings_v1': 'systemConfig',
  // 日志数据：操作日志（含 115 磁力推送记录）
  [STORAGE_KEYS.LOGS]: 'logsData',
  'drive115_logs': 'logsData',
  'magnetPushLogs_backup': 'logsData',
};

/**
 * 按备份范围过滤快照（纯函数）。
 * 语义：未勾选类别的对应键从顶层/idb/storageAll 一致地「省略」（不写空值）；
 * 「键存在（即使空）」=存在，恢复侧行为与旧版完全一致（全量旧备份恢复行为不变）。
 * idb.lists（本地清单，用户硬要求「始终包含」）与 idb.magnets（磁链缓存，cache 类，
 * 不属于任何复选框描述域）恒包含，不参与勾选过滤。
 */
export function filterBackupSnapshotByRange(snapshot: any, range: WebdavBackupRangeState): any {
  const next: any = { ...snapshot };
  // 顶层字段
  if (!range.coreData) {
    delete next.data;
    delete next.userProfile;
  }
  if (!range.actorData) {
    delete next.actorRecords;
  }
  if (!range.newWorksData) {
    delete next.newWorks;
  }
  if (!range.systemConfig) {
    delete next.settings;
    delete next.importStats;
  }
  if (!range.logsData) {
    delete next.logs;
    delete next.magnetPushLogs;
  }
  // idb 字段（lists/magnets 恒留）
  const idb: Record<string, any> = { ...(next.idb || {}) };
  if (!range.coreData) {
    delete idb.viewedRecords;
    delete idb.insightsViews;
    delete idb.insightsReports;
  }
  if (!range.actorData) {
    delete idb.actors;
  }
  if (!range.newWorksData) {
    delete idb.newWorks;
    delete idb.newWorksDailyStats;
  }
  if (!range.logsData) {
    delete idb.logs;
    delete idb.magnetPushLogs;
  }
  next.idb = idb;
  // storageAll：逐键映射过滤，restore_backup_* 动态键归 systemConfig，未映射键保守保留
  if (next.storageAll && typeof next.storageAll === 'object') {
    const kept: Record<string, any> = {};
    for (const [key, value] of Object.entries(next.storageAll as Record<string, any>)) {
      const category = key.startsWith(`${STORAGE_KEYS.RESTORE_BACKUP}_`)
        ? 'systemConfig'
        : STORAGE_KEY_BACKUP_CATEGORY[key];
      if (!category || range[category]) {
        kept[key] = value;
      }
    }
    next.storageAll = kept;
  }
  return next;
}

/** 从（过滤后的）快照派生 stats，保证 stats 与备份实际内容一致；被省略的类别计 0。 */
export function computeBackupStats(snapshot: any): any {
  const sizeOf = (value: unknown): number => (value === undefined ? 0 : byteSizeOf(value));
  const storageAll: Record<string, any> = snapshot.storageAll && typeof snapshot.storageAll === 'object'
    ? snapshot.storageAll
    : {};
  const entries = Object.entries(storageAll);
  const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
  return {
    storage: {
      keys: entries.length,
      selectedKeysBytes: {
        settings: sizeOf(snapshot.settings),
        viewed: sizeOf(snapshot.data),
        userProfile: sizeOf(snapshot.userProfile),
        actorRecords: sizeOf(snapshot.actorRecords),
        newWorks: {
          subscriptions: sizeOf(snapshot.newWorks?.subscriptions),
          records: sizeOf(snapshot.newWorks?.records),
          config: sizeOf(snapshot.newWorks?.config),
        },
        logs: sizeOf(snapshot.logs),
        magnetPushLogs: sizeOf(snapshot.magnetPushLogs),
        importStats: sizeOf(snapshot.importStats),
      },
      topKeysBySize: entries
        .map(([k, v]) => ({ key: k, bytes: byteSizeOf(v) }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 50),
    },
    idb: {
      viewedRecords: { count: countOf(snapshot.idb?.viewedRecords) },
      actors: { count: countOf(snapshot.idb?.actors) },
      newWorks: { count: countOf(snapshot.idb?.newWorks) },
      magnets: { count: countOf(snapshot.idb?.magnets) },
      lists: { count: countOf(snapshot.idb?.lists) },
      insightsViews: { count: countOf(snapshot.idb?.insightsViews) },
      insightsReports: { count: countOf(snapshot.idb?.insightsReports) },
      newWorksDailyStats: { count: countOf(snapshot.idb?.newWorksDailyStats) },
      logs: { count: countOf(snapshot.idb?.logs) },
      magnetPushLogs: { count: countOf(snapshot.idb?.magnetPushLogs) },
    },
    storageViewedMapCount: snapshot.data ? Object.keys(snapshot.data || {}).length : 0,
  } as any;
}

export async function collectBackupData(options: WebDAVBackupCollectorOptions = {}): Promise<any> {
  const settings = await getSettings();

  const [
    recordsToSync,
    userProfile,
    actorRecords,
    importStats,
    newWorksSubscriptions,
    newWorksRecords,
    newWorksConfig,
  ] = await Promise.all([
    getValue(STORAGE_KEYS.VIEWED_RECORDS, {}),
    getValue(STORAGE_KEYS.USER_PROFILE, null),
    getValue(STORAGE_KEYS.ACTOR_RECORDS, {}),
    getValue(STORAGE_KEYS.LAST_IMPORT_STATS, null),
    getValue(STORAGE_KEYS.NEW_WORKS_SUBSCRIPTIONS, {}),
    getValue(STORAGE_KEYS.NEW_WORKS_RECORDS, {}),
    getValue(STORAGE_KEYS.NEW_WORKS_CONFIG, {}),
  ]);

  const logs = await idbLogsGetAll().catch(async () => await getValue(STORAGE_KEYS.LOGS, []));
  const magnetPushLogs = await idbMagnetPushLogsGetAll().catch(async () => await getValue('magnetPushLogs_backup' as any, []));

  let idbViewed: any[] = [];
  let idbActors: any[] = [];
  let idbNewWorks: any[] = [];
  let idbMagnets: any[] = [];
  let idbLists: any[] = [];
  let idbInsightsViews: any[] = [];
  let idbInsightsReports: any[] = [];
  let idbNewWorksDailyStats: any[] = [];
  try {
    const db = await initDB();
    try { idbViewed = await db.getAll('viewedRecords'); } catch {}
    try { idbActors = await db.getAll('actors'); } catch {}
    try { idbNewWorks = await db.getAll('newWorks'); } catch {}
    try { idbMagnets = await db.getAll('magnets'); } catch {}
    try { idbLists = await db.getAll('lists'); } catch {}
    try { idbInsightsViews = await db.getAll('insightsViews'); } catch {}
    try { idbInsightsReports = await db.getAll('insightsReports'); } catch {}
    try { idbNewWorksDailyStats = await db.getAll('newWorksDailyStats'); } catch {}
  } catch {}

  let storageAll: Record<string, any> | null = null;
  try {
    const all = await new Promise<Record<string, any>>((resolve) => {
      try { chrome.storage.local.get(null, (res) => resolve(res || {})); } catch { resolve({}); }
    });
    storageAll = omitLocalOnlyStorageKeys(all);
  } catch {}

  const snapshot = {
    version: '2.1',
    extensionVersion: chrome.runtime.getManifest().version,
    timestamp: new Date().toISOString(),
    settings,
    data: recordsToSync,
    userProfile,
    actorRecords,
    logs,
    magnetPushLogs,
    importStats,
    newWorks: {
      subscriptions: newWorksSubscriptions,
      records: newWorksRecords,
      config: newWorksConfig,
    },
    idb: {
      viewedRecords: idbViewed,
      actors: idbActors,
      newWorks: idbNewWorks,
      magnets: idbMagnets,
      lists: idbLists,
      insightsViews: idbInsightsViews,
      insightsReports: idbInsightsReports,
      newWorksDailyStats: idbNewWorksDailyStats,
      logs,
      magnetPushLogs,
    },
    storageAll,
  } as any;

  // 按 settings.webdav.backupRange 过滤（键缺失=全收集=存量用户零行为变更）；
  // stats 从过滤后的快照派生，保证与实际内容一致；backupRange 标记供诊断与真机取证。
  const range = resolveBackupRange(settings.webdav?.backupRange);
  const filteredSnapshot = filterBackupSnapshotByRange(snapshot, range);
  filteredSnapshot.backupRange = { ...range };
  filteredSnapshot.stats = computeBackupStats(filteredSnapshot);
  const stats = filteredSnapshot.stats;

  options.logger?.('INFO', 'Prepared backup snapshot', {
    version: snapshot.version,
    backupRange: filteredSnapshot.backupRange,
    storageViewedCount: stats.storageViewedMapCount,
    idbViewedCount: stats.idb.viewedRecords.count,
    idbActorsCount: stats.idb.actors.count,
    idbNewWorksCount: stats.idb.newWorks.count,
    idbMagnetsCount: stats.idb.magnets.count,
    idbListsCount: stats.idb.lists.count,
    idbInsightsViewsCount: stats.idb.insightsViews.count,
    idbInsightsReportsCount: stats.idb.insightsReports.count,
    idbNewWorksDailyStatsCount: stats.idb.newWorksDailyStats.count,
    logsCount: stats.idb.logs.count,
    magnetPushLogsCount: stats.idb.magnetPushLogs.count,
    storageKeys: stats.storage.keys,
  });

  return filteredSnapshot;
}
