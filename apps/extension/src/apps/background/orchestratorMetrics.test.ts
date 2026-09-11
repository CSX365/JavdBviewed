import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * S1-1：orchestratorTaskDetails 写路径治理（分层 + 合并写）单测
 *
 * 存储布局：
 * - orchestratorTaskDetails          = hot（最新 HOT_CAP=300 条）
 * - orchestratorTaskDetailsArchive   = archive（更旧，hot+archive 全局 cap=2000）
 *
 * 写语义：
 * - saveTaskDetail 只入内存 buffer，resolve 于「已缓冲」而非「已落盘」
 * - 1.5s 防抖合并写（burst 只落盘 1 次）+ onSuspend flush
 * - archive 达到 100 条（或全局 cap 强制裁剪）才持久化
 * - 读方合并 hot+archive，读语义与旧的单数组一致
 */

vi.mock('../../platform/tasks/globalTaskCenter', () => ({
  globalTaskCenter: {
    clearAll: vi.fn(() => ({ cleared: 0, clearedActive: 0, clearedTerminal: 0 })),
  },
}));

const HOT_KEY = 'orchestratorTaskDetails';
const ARCHIVE_KEY = 'orchestratorTaskDetailsArchive';
const HOT_CAP = 300;
const GLOBAL_CAP = 2000;
const ARCHIVE_CHUNK = 100;

function makeEntry(id: number, tsBase = 1_000_000): Record<string, unknown> {
  return {
    taskId: `task-${id}`,
    label: `label-${id}`,
    status: 'done',
    durationMs: 10,
    timestamp: tsBase + id,
    tabId: 1,
    savedAt: tsBase + id,
  };
}

describe('orchestratorMetrics S1-1 写路径治理', () => {
  let stored: Record<string, unknown>;
  let setLog: Array<{ key: string; value: unknown }>;
  let suspendListener: ((...args: unknown[]) => void) | null;
  let storageGet: ReturnType<typeof vi.fn>;
  let storageSet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    stored = {};
    setLog = [];
    suspendListener = null;
    storageGet = vi.fn((keys: string | string[] | null, callback: (items: Record<string, unknown>) => void) => {
      queueMicrotask(() => {
        if (keys === null) {
          callback(structuredClone(stored));
          return;
        }
        const list = Array.isArray(keys) ? keys : [keys];
        const out: Record<string, unknown> = {};
        for (const k of list) {
          if (stored[k] !== undefined) out[k] = structuredClone(stored[k]);
        }
        callback(out);
      });
    });
    storageSet = vi.fn((items: Record<string, unknown>, callback: () => void) => {
      queueMicrotask(() => {
        for (const [k, v] of Object.entries(items)) {
          stored[k] = structuredClone(v);
          setLog.push({ key: k, value: structuredClone(v) });
        }
        callback();
      });
    });
    vi.stubGlobal('chrome', {
      storage: { local: { get: storageGet, set: storageSet } },
      runtime: {
        id: 'test-extension-id',
        lastError: null,
        onSuspend: {
          addListener: vi.fn((cb: (...args: unknown[]) => void) => {
            suspendListener = cb;
          }),
        },
      },
      tabs: {
        query: vi.fn(() => Promise.resolve([])),
        sendMessage: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function loadModule() {
    return import('./orchestratorMetrics');
  }

  async function settle(ms = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  function hotWrites(): Array<unknown> {
    return setLog.filter((w) => w.key === HOT_KEY).map((w) => w.value);
  }

  function archiveWrites(): Array<unknown> {
    return setLog.filter((w) => w.key === ARCHIVE_KEY).map((w) => w.value);
  }

  it('burst 保存只落盘一次（防抖合并写），且 read 方拿到全量有序数据', async () => {
    const mod = await loadModule();
    for (let i = 1; i <= 6; i++) {
      await mod.handleSaveTaskDetail(makeEntry(i));
    }
    // 防抖窗口内不落盘
    expect(hotWrites()).toHaveLength(0);
    expect(archiveWrites()).toHaveLength(0);

    await settle(1500);

    expect(hotWrites()).toHaveLength(1);
    const hot = hotWrites()[0] as Array<Record<string, unknown>>;
    expect(hot).toHaveLength(6);
    expect(hot.map((d) => d.taskId)).toEqual(['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6']);

    // 读方语义：与旧单数组一致
    const page = await mod.handleGetTaskDetails({ page: 1, pageSize: 50 });
    expect(page.total).toBe(6);
    expect(page.details.map((d: any) => d.taskId)).toEqual(
      ['task-6', 'task-5', 'task-4', 'task-3', 'task-2', 'task-1'],
    );
    // 既有语义：orchestratorMetrics 为空时聚合提前返回全零（treeMetrics 被丢弃），本周期不改
    const agg = await mod.handleGetAggregatedMetrics();
    expect(agg.recordCount).toBe(0);
    expect(agg.totalTasks).toBe(0);
  });

  it('hot 超过 300 条时溢出到 archive buffer（不足 chunk 不落盘 archive）', async () => {
    stored[HOT_KEY] = Array.from({ length: HOT_CAP }, (_, i) => makeEntry(i + 1));
    const mod = await loadModule();
    for (let i = HOT_CAP + 1; i <= HOT_CAP + 5; i++) {
      await mod.handleSaveTaskDetail(makeEntry(i));
    }
    await settle(1500);

    const hot = hotWrites()[0] as Array<Record<string, unknown>>;
    expect(hot).toHaveLength(HOT_CAP);
    expect(hot[0].taskId).toBe(`task-${6}`);
    expect(hot[hot.length - 1].taskId).toBe(`task-${HOT_CAP + 5}`);
    // 5 条溢出 < ARCHIVE_CHUNK → archive 不落盘
    expect(archiveWrites()).toHaveLength(0);

    // 读方仍能拿到 hot 内的 300 条（archive 部分仍在内存 buffer，未持久化）
    const page = await mod.handleGetTaskDetails({ page: 1, pageSize: 50 });
    expect(page.total).toBe(HOT_CAP);
  });

  it('archive 累积达到 chunk（100 条）才持久化，且读方合并 hot+archive 与单数组语义一致', async () => {
    stored[HOT_KEY] = Array.from({ length: HOT_CAP }, (_, i) => makeEntry(i + 1));
    const mod = await loadModule();
    // 一次 burst 推入 105 条 → 溢出 105 ≥ 100 → archive 落盘
    for (let i = HOT_CAP + 1; i <= HOT_CAP + 105; i++) {
      await mod.handleSaveTaskDetail(makeEntry(i));
    }
    await settle(1500);

    const hot = hotWrites()[0] as Array<Record<string, unknown>>;
    expect(hot).toHaveLength(HOT_CAP);
    expect(hot[0].taskId).toBe(`task-${106}`);
    const archive = archiveWrites()[0] as Array<Record<string, unknown>>;
    expect(archive).toHaveLength(105);
    expect(archive[0].taskId).toBe('task-1');
    expect(archive[archive.length - 1].taskId).toBe(`task-${105}`);

    // 读方合并：405 条全量、去重、时间升序拼接后再按 timestamp 降序分页
    const page = await mod.handleGetTaskDetails({ page: 1, pageSize: 500 });
    expect(page.total).toBe(HOT_CAP + 105);
    const ids = page.details.map((d: any) => d.taskId);
    expect(new Set(ids).size).toBe(HOT_CAP + 105);
    expect(ids[0]).toBe(`task-${HOT_CAP + 105}`);
    expect(ids[ids.length - 1]).toBe('task-1');
  });

  it('全局 cap 2000：超出时裁剪最旧 archive，archive 强制落盘', async () => {
    // archive 1990 + hot 300（=2290 > 2000 由 pending 触发 flush 时裁剪）
    stored[ARCHIVE_KEY] = Array.from({ length: 1990 }, (_, i) => makeEntry(i + 1));
    stored[HOT_KEY] = Array.from({ length: HOT_CAP }, (_, i) => makeEntry(1991 + i));
    const mod = await loadModule();
    for (let i = 2291; i <= 2300; i++) {
      await mod.handleSaveTaskDetail(makeEntry(i));
    }
    await settle(1500);

    const hot = hotWrites()[0] as Array<Record<string, unknown>>;
    expect(hot).toHaveLength(HOT_CAP);
    const archive = archiveWrites()[0] as Array<Record<string, unknown>>;
    expect(hot.length + archive.length).toBeLessThanOrEqual(GLOBAL_CAP);
    expect(hot.length + archive.length).toBe(GLOBAL_CAP);
    // 最旧被裁掉：archive 头不再是 task-1
    expect(archive[0].taskId).not.toBe('task-1');
    // 最新保留
    expect(hot[hot.length - 1].taskId).toBe('task-2300');
  });

  it('onSuspend 触发 flush（SW 急停前落盘未持久化数据）', async () => {
    const mod = await loadModule();
    expect(suspendListener).toBeTypeOf('function');
    for (let i = 1; i <= 3; i++) {
      await mod.handleSaveTaskDetail(makeEntry(i));
    }
    expect(hotWrites()).toHaveLength(0);
    (suspendListener as () => void)();
    await settle(0);
    expect(hotWrites()).toHaveLength(1);
    expect((hotWrites()[0] as unknown[]).length).toBe(3);
  });

  it('clear 后不复活旧数据（内存 buffer 同步清空）', async () => {
    stored[HOT_KEY] = Array.from({ length: 10 }, (_, i) => makeEntry(i + 1));
    stored[ARCHIVE_KEY] = Array.from({ length: 5 }, (_, i) => makeEntry(i + 101));
    const mod = await loadModule();
    const result = await mod.handleClearTaskDetails();
    expect(result.success).toBe(true);
    expect(stored[HOT_KEY]).toEqual([]);
    expect(stored[ARCHIVE_KEY]).toEqual([]);
    // clear 自身会对两个键各写一次空数组，断言只针对 clear 之后的 flush 写
    const logIndexAfterClear = setLog.length;

    for (let i = 201; i <= 202; i++) {
      await mod.handleSaveTaskDetail(makeEntry(i));
    }
    await settle(1500);
    const hotWritesAfterClear = setLog
      .slice(logIndexAfterClear)
      .filter((w) => w.key === HOT_KEY)
      .map((w) => w.value);
    expect(hotWritesAfterClear).toHaveLength(1);
    const hot = hotWritesAfterClear[0] as Array<Record<string, unknown>>;
    expect(hot).toHaveLength(2);
    expect(hot.map((d) => d.taskId)).toEqual(['task-201', 'task-202']);
  });

  it('遗留单数组（≤2000）升级兼容：首刷拆分 hot/archive，读方不丢数据', async () => {
    // 模拟升级前：单 key 354 条（cycle-4 seed profile 实测 ~354 条）
    const legacy = Array.from({ length: 354 }, (_, i) => makeEntry(i + 1));
    stored[HOT_KEY] = legacy;
    const mod = await loadModule();
    await mod.handleSaveTaskDetail(makeEntry(355));
    await settle(1500);

    const hot = hotWrites()[0] as Array<Record<string, unknown>>;
    expect(hot).toHaveLength(HOT_CAP);
    expect(hot[0].taskId).toBe('task-56');
    // 55 条溢出 < chunk：archive 未落盘，但读方只能看到已持久化的 300 条（内存中 55 条待 flush）
    const page = await mod.handleGetTaskDetails({ page: 1, pageSize: 500 });
    expect(page.total).toBe(HOT_CAP);

    // 再推 50 条 → 溢出累计 105 ≥ chunk → archive 落盘，全量 405 条可读
    for (let i = 356; i <= 405; i++) {
      await mod.handleSaveTaskDetail(makeEntry(i));
    }
    await settle(1500);
    expect(archiveWrites()).toHaveLength(1);
    const page2 = await mod.handleGetTaskDetails({ page: 1, pageSize: 500 });
    expect(page2.total).toBe(405);
  });

  describe('S1-B (cycle-6)：orchestratorMetrics 合并写', () => {
    function metricsWrites(): Array<unknown> {
      return setLog.filter((w) => w.key === 'orchestratorMetrics').map((w) => w.value);
    }

    function makeMetric(id: number): Record<string, unknown> {
      return {
        totalTasks: 1,
        completedTasks: 1,
        failedTasks: 0,
        timeoutTasks: 0,
        totalDuration: 100,
        maxDuration: 50,
        minDuration: 10,
        maxDurationTask: `m${id}`,
      };
    }

    it('burst saveMetrics 合并为一次落盘，读方在 flush 前即可见 buffer', async () => {
      const mod = await loadModule();
      for (let i = 1; i <= 5; i += 1) {
        await mod.handleSaveOrchestratorMetrics(makeMetric(i));
      }
      // 防抖窗口内不落盘（原实现每次保存即全量读+写）
      expect(metricsWrites()).toHaveLength(0);

      // 读方合并 stored + buffer（buffer 恒新于 stored）
      const agg1 = await mod.handleGetAggregatedMetrics();
      expect(agg1.recordCount).toBe(5);
      expect(agg1.totalTasks).toBe(5);

      await settle(1500);
      expect(metricsWrites()).toHaveLength(1);
      expect(metricsWrites()[0] as unknown[]).toHaveLength(5);

      const agg2 = await mod.handleGetAggregatedMetrics();
      expect(agg2.recordCount).toBe(5);
      expect(agg2.totalTasks).toBe(5);
    });

    it('磁盘 cap 保持 100 条（stored 与 buffer 合并后截断最新 100）', async () => {
      const mod = await loadModule();
      stored['orchestratorMetrics'] = Array.from({ length: 80 }, (_, i) => ({
        totalTasks: 1,
        completedTasks: 1,
        savedAt: i,
      }));
      for (let i = 1; i <= 50; i += 1) {
        await mod.handleSaveOrchestratorMetrics(makeMetric(i));
      }
      await settle(1500);

      const writes = metricsWrites() as Array<Record<string, unknown>[]>;
      expect(writes).toHaveLength(1);
      expect(writes[0]).toHaveLength(100);
      expect(writes[0][writes[0].length - 1].maxDurationTask).toBe('m50');
    });

    it('onSuspend 冲刷 metrics buffer（SW 急停前落盘）', async () => {
      const mod = await loadModule();
      await mod.handleSaveOrchestratorMetrics(makeMetric(1));
      expect(metricsWrites()).toHaveLength(0);

      expect(suspendListener).not.toBeNull();
      suspendListener!();
      await settle(0);

      const writes = metricsWrites() as Array<Record<string, unknown>[]>;
      expect(writes).toHaveLength(1);
      expect(writes[0]).toHaveLength(1);
    });

    it('clearTaskDetails 清 metrics buffer，在途 flush 之后写空数组不复活', async () => {
      const mod = await loadModule();
      await mod.handleSaveOrchestratorMetrics(makeMetric(1));
      await mod.handleClearTaskDetails();
      await settle(1500);

      const writes = metricsWrites() as Array<unknown>;
      expect(writes[writes.length - 1]).toEqual([]);
      const agg = await mod.handleGetAggregatedMetrics();
      expect(agg.recordCount).toBe(0);
    });
  });
});
