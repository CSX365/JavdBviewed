/**
 * @file backupRangeFilter.test.ts
 * @description WebDAV 备份范围过滤：resolveBackupRange / filterBackupSnapshotByRange / computeBackupStats 单测
 * @module features/webdavSync
 */
import { describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '../../../utils/config';
import {
  computeBackupStats,
  filterBackupSnapshotByRange,
  resolveBackupRange,
  type WebdavBackupRangeState,
} from './backupCollector';

const ALL_CHECKED: WebdavBackupRangeState = {
  coreData: true,
  actorData: true,
  newWorksData: true,
  systemConfig: true,
  logsData: true,
};

function buildSnapshot(): any {
  return {
    version: '2.1',
    extensionVersion: '1.0.0',
    timestamp: '2026-09-27T00:00:00.000Z',
    settings: { webdav: { enabled: true } },
    data: { 'vid-1': { value: { updatedAt: 1 } } },
    userProfile: { name: 'u' },
    actorRecords: { 'actor-1': {} },
    logs: [{ id: 1 }],
    magnetPushLogs: [{ id: 2 }],
    importStats: { count: 3 },
    newWorks: { subscriptions: { s1: {} }, records: { r1: {} }, config: { c: 1 } },
    idb: {
      viewedRecords: [{ id: 'vid-1' }],
      actors: [{ id: 'actor-1' }],
      newWorks: [{ id: 'nw-1' }],
      magnets: [{ id: 'm-1' }],
      lists: [{ id: 'list-1' }],
      insightsViews: [{ id: 'iv-1' }],
      insightsReports: [{ id: 'ir-1' }],
      newWorksDailyStats: [{ id: 'ds-1' }],
      logs: [{ id: 1 }],
      magnetPushLogs: [{ id: 2 }],
    },
    storageAll: {
      [STORAGE_KEYS.SETTINGS]: { webdav: {} },
      [STORAGE_KEYS.VIEWED_RECORDS]: { 'vid-1': {} },
      [STORAGE_KEYS.USER_PROFILE]: { name: 'u' },
      [STORAGE_KEYS.MEDIA_WATCH_EVIDENCE]: { e1: {} },
      [STORAGE_KEYS.ACTOR_RECORDS]: { 'actor-1': {} },
      [STORAGE_KEYS.NEW_WORKS_SUBSCRIPTIONS]: { s1: {} },
      [STORAGE_KEYS.NEW_WORKS_RECORDS]: { r1: {} },
      [STORAGE_KEYS.NEW_WORKS_CONFIG]: { c: 1 },
      [STORAGE_KEYS.LOGS]: [{ id: 1 }],
      drive115_logs: [{ id: 3 }],
      magnetPushLogs_backup: [{ id: 2 }],
      [STORAGE_KEYS.LAST_IMPORT_STATS]: { count: 3 },
      [STORAGE_KEYS.RESTORE_BACKUP]: { point: 1 },
      'restore_backup_abc': { point: 2 },
      [STORAGE_KEYS.DASHBOARD_LAST_PAGE]: '/records',
      some_unmapped_key: { x: 1 },
    },
  };
}

describe('resolveBackupRange', () => {
  it('无键/空对象/非对象 → 5 项全收集（存量用户零行为变更）', () => {
    for (const raw of [undefined, null, {}, 'bad', 42]) {
      expect(resolveBackupRange(raw)).toEqual(ALL_CHECKED);
    }
  });

  it('显式 false 才过滤，显式 true 保留', () => {
    expect(resolveBackupRange({ coreData: false, logsData: false, actorData: true })).toEqual({
      coreData: false,
      actorData: true,
      newWorksData: true,
      systemConfig: true,
      logsData: false,
    });
  });

  it('部分键缺失时其余键按 !== false 解析（不混用 !! 语义）', () => {
    expect(resolveBackupRange({ coreData: false })).toEqual({
      coreData: false,
      actorData: true,
      newWorksData: true,
      systemConfig: true,
      logsData: true,
    });
  });
});

describe('filterBackupSnapshotByRange', () => {
  it('全勾 → 快照逐字段不变（与现行全量备份行为等价）', () => {
    const snapshot = buildSnapshot();
    expect(filterBackupSnapshotByRange(snapshot, ALL_CHECKED)).toEqual(snapshot);
  });

  it('取消日志数据 → 顶层/idb/storageAll 一致省略日志类键，其余保留', () => {
    const range = { ...ALL_CHECKED, logsData: false };
    const next = filterBackupSnapshotByRange(buildSnapshot(), range);
    expect(next).not.toHaveProperty('logs');
    expect(next).not.toHaveProperty('magnetPushLogs');
    expect(next.idb).not.toHaveProperty('logs');
    expect(next.idb).not.toHaveProperty('magnetPushLogs');
    expect(next.storageAll).not.toHaveProperty(STORAGE_KEYS.LOGS);
    expect(next.storageAll).not.toHaveProperty('drive115_logs');
    expect(next.storageAll).not.toHaveProperty('magnetPushLogs_backup');
    // 其余类别不受影响
    expect(next.data).toEqual(buildSnapshot().data);
    expect(next.idb.viewedRecords).toHaveLength(1);
    expect(next.settings).toBeDefined();
    expect(next.storageAll).toHaveProperty(STORAGE_KEYS.SETTINGS);
  });

  it('全取消 → 仅剩恒包含字段（lists/magnets）与结构字段，storageAll 仅剩未映射键', () => {
    const range = { coreData: false, actorData: false, newWorksData: false, systemConfig: false, logsData: false };
    const next = filterBackupSnapshotByRange(buildSnapshot(), range);
    for (const key of ['data', 'userProfile', 'actorRecords', 'logs', 'magnetPushLogs', 'importStats', 'settings', 'newWorks']) {
      expect(next, key).not.toHaveProperty(key);
    }
    expect(next.idb).toEqual({ magnets: [{ id: 'm-1' }], lists: [{ id: 'list-1' }] });
    expect(next.storageAll).toEqual({ some_unmapped_key: { x: 1 } });
    // 结构字段保留
    expect(next.version).toBe('2.1');
  });

  it('本地清单与磁链缓存恒包含（任何范围下均保留）', () => {
    const range = { coreData: false, actorData: false, newWorksData: false, systemConfig: false, logsData: false };
    const next = filterBackupSnapshotByRange(buildSnapshot(), range);
    expect(next.idb.lists).toEqual([{ id: 'list-1' }]);
    expect(next.idb.magnets).toEqual([{ id: 'm-1' }]);
  });

  it('restore_backup_* 动态键归 systemConfig；未映射 storageAll 键保守不过滤', () => {
    const range = { ...ALL_CHECKED, systemConfig: false };
    const next = filterBackupSnapshotByRange(buildSnapshot(), range);
    expect(next.storageAll).not.toHaveProperty(STORAGE_KEYS.RESTORE_BACKUP);
    expect(next.storageAll).not.toHaveProperty('restore_backup_abc');
    expect(next.storageAll).toHaveProperty('some_unmapped_key');
    // 未映射键在其它类别取消时同样保留
    const next2 = filterBackupSnapshotByRange(buildSnapshot(), { ...range, coreData: false });
    expect(next2.storageAll).toHaveProperty('some_unmapped_key');
  });

  it('storageAll 为 null/缺失时不抛错', () => {
    const snapshot = buildSnapshot();
    snapshot.storageAll = null;
    const next = filterBackupSnapshotByRange(snapshot, { ...ALL_CHECKED, logsData: false });
    expect(next.storageAll).toBeNull();
    const noStorageAll = buildSnapshot();
    delete noStorageAll.storageAll;
    expect(() => filterBackupSnapshotByRange(noStorageAll, ALL_CHECKED)).not.toThrow();
  });

  it('不修改入参快照（纯函数）', () => {
    const snapshot = buildSnapshot();
    const clone = JSON.parse(JSON.stringify(snapshot));
    filterBackupSnapshotByRange(snapshot, { ...ALL_CHECKED, logsData: false });
    expect(snapshot).toEqual(clone);
  });
});

describe('computeBackupStats', () => {
  it('全勾快照的 stats 与内容一致', () => {
    const snapshot = buildSnapshot();
    const stats = computeBackupStats(snapshot);
    expect(stats.idb.viewedRecords.count).toBe(1);
    expect(stats.idb.lists.count).toBe(1);
    expect(stats.idb.logs.count).toBe(1);
    expect(stats.storage.keys).toBe(16); // fixture storageAll 共 16 键
    expect(stats.storageViewedMapCount).toBe(1);
    expect(stats.storage.selectedKeysBytes.viewed).toBeGreaterThan(0);
  });

  it('过滤后快照中省略类别的 stats 计 0，且与内容一致', () => {
    const snapshot = filterBackupSnapshotByRange(buildSnapshot(), { ...ALL_CHECKED, logsData: false });
    const stats = computeBackupStats(snapshot);
    expect(stats.idb.logs.count).toBe(0);
    expect(stats.idb.magnetPushLogs.count).toBe(0);
    expect(stats.storage.selectedKeysBytes.logs).toBe(0);
    expect(stats.storage.selectedKeysBytes.magnetPushLogs).toBe(0);
    // 未过滤类别仍有值
    expect(stats.idb.viewedRecords.count).toBe(1);
    expect(stats.storage.keys).toBe(13); // 16 - 3 个日志类键
  });
});
