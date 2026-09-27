/**
 * @file restoreCategoryPresence.test.ts
 * @description 恢复存在性守卫 backupContainsCategory 纯函数测试：
 * 「键存在（即使空值/空数组）=存在 → 旧版恢复行为不变」；「键缺失 = 跳过，不触碰本地数据」。
 */
import { describe, expect, it } from 'vitest';
import { backupContainsCategory, type BackupPresenceCategory } from './restoreService';

const ALL_CATEGORIES: BackupPresenceCategory[] = [
  'viewed', 'actors', 'newWorks', 'lists', 'magnets', 'logs', 'magnetPushLogs',
];

function fullBackup(): any {
  return {
    data: { v1: { id: 'v1' } },
    userProfile: { uid: 'u1' },
    actorRecords: { a1: { id: 'a1' } },
    newWorks: { subscriptions: {}, records: {}, config: {} },
    logs: [{ id: 1, ts: 1 }],
    magnetPushLogs: [],
    idb: {
      viewedRecords: [{ id: 'v1' }],
      actors: [{ id: 'a1' }],
      newWorks: [],
      magnets: [],
      lists: [],
      logs: [{ id: 1, ts: 1 }],
      magnetPushLogs: [],
    },
  };
}

describe('backupContainsCategory（恢复存在性守卫）', () => {
  it('全量备份：7 个类别全部判定存在', () => {
    const backup = fullBackup();
    for (const category of ALL_CATEGORIES) {
      expect(backupContainsCategory(backup, category), category).toBe(true);
    }
  });

  it('日志数据被过滤（logs/magnetPushLogs 键缺失）：仅这两类判定缺失，其余不受影响', () => {
    const backup = fullBackup();
    delete backup.logs;
    delete backup.magnetPushLogs;
    delete backup.idb.logs;
    delete backup.idb.magnetPushLogs;
    expect(backupContainsCategory(backup, 'logs')).toBe(false);
    expect(backupContainsCategory(backup, 'magnetPushLogs')).toBe(false);
    for (const category of ALL_CATEGORIES) {
      if (category === 'logs' || category === 'magnetPushLogs') continue;
      expect(backupContainsCategory(backup, category), category).toBe(true);
    }
  });

  it('核心/演员/新作品/日志全部被过滤（lists/magnets 恒包含）：仅 lists/magnets 存在', () => {
    const backup: any = {
      data: { v1: { id: 'v1' } },
      userProfile: { uid: 'u1' },
      actorRecords: { a1: { id: 'a1' } },
      newWorks: { subscriptions: {}, records: {}, config: {} },
      logs: [],
      magnetPushLogs: [],
      idb: {
        viewedRecords: [],
        actors: [],
        newWorks: [],
        magnets: [],
        lists: [],
        insightsViews: [],
        insightsReports: [],
        newWorksDailyStats: [],
        logs: [],
        magnetPushLogs: [],
      },
    };
    const filtered = {
      idb: {
        viewedRecords: undefined,
        actors: undefined,
        newWorks: undefined,
        magnets: backup.idb.magnets,
        lists: backup.idb.lists,
        insightsViews: undefined,
        insightsReports: undefined,
        newWorksDailyStats: undefined,
        logs: undefined,
        magnetPushLogs: undefined,
      },
      storageAll: null,
    };
    expect(backupContainsCategory(filtered, 'lists')).toBe(true);
    expect(backupContainsCategory(filtered, 'magnets')).toBe(true);
    for (const category of ALL_CATEGORIES) {
      if (category === 'lists' || category === 'magnets') continue;
      expect(backupContainsCategory(filtered, category), category).toBe(false);
    }
  });

  it('旧版备份回退链：仅顶层 data 对象 → viewed 存在', () => {
    expect(backupContainsCategory({ data: { v1: {} } }, 'viewed')).toBe(true);
  });

  it('旧版备份回退链：仅顶层 viewed 对象 → viewed 存在', () => {
    expect(backupContainsCategory({ viewed: { v1: {} } }, 'viewed')).toBe(true);
  });

  it('键存在但值为空对象 data:{} → viewed 存在（键存在=存在，旧行为不变）', () => {
    expect(backupContainsCategory({ data: {} }, 'viewed')).toBe(true);
  });

  it('键存在但为空数组 idb.viewedRecords:[] → viewed 存在（全量旧备份恢复行为不变）', () => {
    expect(backupContainsCategory({ idb: { viewedRecords: [] } }, 'viewed')).toBe(true);
  });

  it('actorRecords 顶层对象 → actors 存在；newWorks 走 storageAll 键 → newWorks 存在', () => {
    expect(backupContainsCategory({ actorRecords: {} }, 'actors')).toBe(true);
    expect(backupContainsCategory({ storageAll: { new_works_subscriptions: {} } }, 'newWorks')).toBe(true);
  });

  it('magnetPushLogs 顶层回退 data.magnetPushLogs 数组 → 存在', () => {
    expect(backupContainsCategory({ data: { magnetPushLogs: [] } }, 'magnetPushLogs')).toBe(true);
  });

  it('logs 顶层数组回退（无 idb.logs）→ 存在', () => {
    expect(backupContainsCategory({ logs: [] }, 'logs')).toBe(true);
  });

  it('空备份对象：7 个类别全部判定缺失', () => {
    for (const category of ALL_CATEGORIES) {
      expect(backupContainsCategory({}, category), category).toBe(false);
    }
  });

  it('importData 为 null/undefined：全部缺失（不抛错）', () => {
    for (const category of ALL_CATEGORIES) {
      expect(backupContainsCategory(null, category), category).toBe(false);
      expect(backupContainsCategory(undefined, category), category).toBe(false);
    }
  });
});
