/**
 * @file webdavBackupRangeRestore.test.ts
 * @description WebDAV 备份范围生效后的恢复安全红线：
 * 备份文件中缺失某类别（用户取消过该类别的备份）时，恢复不得触碰本地数据
 * （尤其 replace 模式不得清空本地）；键存在（即使空数组）= 存在，旧版全量备份恢复行为不变。
 */
import { describe, expect, it, vi } from 'vitest';

interface FakeDeps {
  viewedReplaceAll: ReturnType<typeof vi.fn>;
  logsClear: ReturnType<typeof vi.fn>;
  logsBulkAdd: ReturnType<typeof vi.fn>;
  logsGetAll: ReturnType<typeof vi.fn>;
  objectStore: ReturnType<typeof vi.fn>;
  initDB: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
}

async function withRestoredService(deps: Partial<FakeDeps> = {}, dbOverrides: Record<string, any> = {}) {
  vi.resetModules();
  const put = vi.fn().mockResolvedValue(undefined);
  const clear = vi.fn().mockResolvedValue(undefined);
  const fakeStore = { clear, put };
  let currentStoreName = '';
  const objectStore = vi.fn((storeName: string) => {
    currentStoreName = storeName;
    return fakeStore;
  });
  const viewedReplaceAll = vi.fn().mockResolvedValue(0);
  const logsClear = vi.fn().mockResolvedValue(undefined);
  const logsBulkAdd = vi.fn().mockResolvedValue(undefined);
  const logsGetAll = vi.fn().mockResolvedValue([]);
  const magnetPushLogsBulkAdd = vi.fn().mockResolvedValue(undefined);
  const magnetPushLogsGetAll = vi.fn().mockResolvedValue([]);
  const viewedGetAll = vi.fn().mockResolvedValue([]);
  const initDB = vi.fn().mockResolvedValue({
    getAll: vi.fn(async (storeName: string) => {
      if (dbOverrides[storeName]) return dbOverrides[storeName];
      return [];
    }),
    transaction: vi.fn(() => ({
      objectStore,
      complete: Promise.resolve(),
    })),
    ...dbOverrides,
  } as any);

  vi.doMock('../../apps/extension/src/platform/storage/indexedDb', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../apps/extension/src/platform/storage/indexedDb')>();
    return {
      ...actual,
      initDB,
      viewedReplaceAll,
      viewedGetAll,
      logsClear,
      logsBulkAdd,
      logsGetAll,
      magnetPushLogsBulkAdd,
      magnetPushLogsGetAll,
    };
  });

  const { applyImportDataDirect } = await import('../../apps/extension/src/features/webdavSync/application/restoreService');
  return {
    applyImportDataDirect,
    deps: { viewedReplaceAll, logsClear, logsBulkAdd, logsGetAll, objectStore, initDB, put, clear, magnetPushLogsBulkAdd, magnetPushLogsGetAll, viewedGetAll },
  };
}

const ONLY: Record<string, boolean> = {
  settings: false,
  userProfile: false,
  importStats: false,
  viewed: false,
  actors: false,
  newWorks: false,
  lists: false,
  magnets: false,
  logs: false,
  magnetPushLogs: false,
};

describe('WebDAV 备份范围 × 恢复安全（存在性守卫）', () => {
  it('备份缺 viewed 键 + replace：不清空本地（viewedReplaceAll 零调用），标记 missing', async () => {
    const { applyImportDataDirect, deps } = await withRestoredService();
    const result = await applyImportDataDirect({}, {
      categories: { ...ONLY, viewed: true },
      categoryModes: { viewed: 'replace' },
    });

    expect(result.success).toBe(true);
    expect(deps.viewedReplaceAll).not.toHaveBeenCalled();
    expect(result.summary?.categories?.viewed).toMatchObject({ mode: 'replace', replaced: false, reason: 'missing' });
  });

  it('备份 idb.viewedRecords:[]（键存在空数组）+ replace：旧行为保留，照常走 viewedReplaceAll（清空语义不变）', async () => {
    const { applyImportDataDirect, deps } = await withRestoredService();
    const result = await applyImportDataDirect({ idb: { viewedRecords: [] } }, {
      categories: { ...ONLY, viewed: true },
      categoryModes: { viewed: 'replace' },
    });

    expect(result.success).toBe(true);
    expect(deps.viewedReplaceAll).toHaveBeenCalledTimes(1);
    expect(deps.viewedReplaceAll).toHaveBeenCalledWith([]);
    expect(result.summary?.categories?.viewed).toMatchObject({ mode: 'replace', cleared: true, written: 0 });
    expect(result.summary?.categories?.viewed?.reason).toBeUndefined();
  });

  it('备份缺 logs 键 + replace：idbLogsClear/idbLogsBulkAdd 零调用（本地日志保留），标记 missing', async () => {
    const { applyImportDataDirect, deps } = await withRestoredService();
    const result = await applyImportDataDirect({}, {
      categories: { ...ONLY, logs: true },
      categoryModes: { logs: 'replace' },
    });

    expect(result.success).toBe(true);
    expect(deps.logsClear).not.toHaveBeenCalled();
    expect(deps.logsBulkAdd).not.toHaveBeenCalled();
    expect(result.summary?.categories?.logs).toMatchObject({ mode: 'replace', replaced: false, reason: 'missing' });
  });

  it('备份缺 logs 键 + merge：同样跳过（merge/replace 一视同仁短路），不读不写本地', async () => {
    const { applyImportDataDirect, deps } = await withRestoredService();
    const result = await applyImportDataDirect({}, {
      categories: { ...ONLY, logs: true },
      categoryModes: { logs: 'merge' },
    });

    expect(result.success).toBe(true);
    expect(deps.logsGetAll).not.toHaveBeenCalled();
    expect(deps.logsBulkAdd).not.toHaveBeenCalled();
    expect(result.summary?.categories?.logs).toMatchObject({ mode: 'merge', replaced: false, reason: 'missing' });
  });

  it('备份缺 magnetPushLogs 键 + replace：不 clear 磁推日志 store，标记 missing', async () => {
    const { applyImportDataDirect, deps } = await withRestoredService();
    const result = await applyImportDataDirect({}, {
      categories: { ...ONLY, magnetPushLogs: true },
      categoryModes: { magnetPushLogs: 'replace' },
    });

    expect(result.success).toBe(true);
    expect(deps.objectStore).not.toHaveBeenCalledWith('magnetPushLogs');
    expect(deps.magnetPushLogsBulkAdd).not.toHaveBeenCalled();
    expect(result.summary?.categories?.magnetPushLogs).toMatchObject({ replaced: false, reason: 'missing' });
  });

  it('备份缺 actors/lists 键 + replace：对应 store 零事务，标记 missing', async () => {
    const { applyImportDataDirect, deps } = await withRestoredService();
    const result = await applyImportDataDirect({ idb: { magnets: [] } }, {
      categories: { ...ONLY, actors: true, lists: true, magnets: true },
      categoryModes: { actors: 'replace', lists: 'replace', magnets: 'replace' },
    });

    expect(result.success).toBe(true);
    expect(deps.objectStore).not.toHaveBeenCalledWith('actors');
    expect(deps.objectStore).not.toHaveBeenCalledWith('lists');
    // magnets 键存在（空数组）→ 照常走清空+写入（旧行为）
    expect(deps.objectStore).toHaveBeenCalledWith('magnets');
    expect(result.summary?.categories?.actors).toMatchObject({ replaced: false, reason: 'missing' });
    expect(result.summary?.categories?.lists).toMatchObject({ replaced: false, reason: 'missing' });
    expect(result.summary?.categories?.magnets?.reason).toBeUndefined();
  });

  it('全量备份（7 类别键齐全）+ 全 replace：无 missing 标记，各破坏性写入路径照常执行（旧行为不变）', async () => {
    const { applyImportDataDirect, deps } = await withRestoredService();
    const result = await applyImportDataDirect({
      data: { v1: { id: 'v1' } },
      userProfile: { uid: 'u1' },
      actorRecords: { a1: { id: 'a1' } },
      newWorks: { subscriptions: { s1: {} }, records: { r1: {} }, config: {} },
      logs: [{ id: 1, ts: 1 }],
      magnetPushLogs: [],
      importStats: { count: 1 },
      idb: {
        viewedRecords: [{ id: 'v1' }],
        actors: [{ id: 'a1' }],
        newWorks: [],
        magnets: [],
        lists: [{ id: 'local_1' }],
        logs: [{ id: 1, ts: 1 }],
        magnetPushLogs: [],
      },
    }, {
      categories: {
        settings: false,
        userProfile: false,
        importStats: false,
        viewed: true,
        actors: true,
        newWorks: true,
        lists: true,
        magnets: true,
        logs: true,
        magnetPushLogs: true,
      },
      categoryModes: {
        viewed: 'replace', actors: 'replace', newWorks: 'replace',
        lists: 'replace', magnets: 'replace', logs: 'replace', magnetPushLogs: 'replace',
      },
    });

    expect(result.success).toBe(true);
    for (const category of ['viewed', 'actors', 'newWorks', 'lists', 'magnets', 'logs', 'magnetPushLogs']) {
      expect(result.summary?.categories?.[category]?.reason, category).toBeUndefined();
    }
    expect(deps.viewedReplaceAll).toHaveBeenCalledTimes(1);
    expect(deps.logsClear).toHaveBeenCalledTimes(1);
    expect(deps.logsBulkAdd).toHaveBeenCalledTimes(1);
    expect(deps.objectStore).toHaveBeenCalledWith('actors');
    expect(deps.objectStore).toHaveBeenCalledWith('lists');
    expect(deps.objectStore).toHaveBeenCalledWith('magnets');
    expect(deps.objectStore).toHaveBeenCalledWith('magnetPushLogs');
  });
});
