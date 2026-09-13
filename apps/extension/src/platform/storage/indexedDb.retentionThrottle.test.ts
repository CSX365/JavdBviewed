/**
 * @file indexedDb.retentionThrottle.test.ts
 * @description S2-2 (cycle-7)：日志保留清理节流
 *  原实现每批日志写入后都执行「getSettings 读 + logs 全索引扫描」（S2-1 归因实测：
 *  16 详情页一轮 441 次 LOGS_BULK → settings 读 443 次 + 全扫 441 次，browser 进程冷相位 CPU 净增 +35% 主因）。
 *  本测试验证：
 *   1) 同一 60s 窗口内多批日志写入只触发一次 count 全扫与一次 settings 读；
 *   2) 窗口过后（≥60s）下一次写入恢复执行；
 *   3) 首次调用必然执行（初始戳 0）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const T0 = 1_757_000_000_000;

const initDB = vi.fn();
const resetDBConnection = vi.fn();
const getSettingsMock = vi.fn();

vi.mock('./indexedDbConnection', () => ({
  initDB,
  resetDBConnection,
}));

vi.mock('../../utils/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/storage')>();
  return { ...actual, getSettings: getSettingsMock };
});

vi.mock('../../features/cloudSync/enqueueLocalChange', () => ({
  enqueueVideoChange: vi.fn(),
  scheduleEnqueue: vi.fn(),
}));

function makeFakeDb(count: () => Promise<number>) {
  let nextId = 1;
  const transaction = vi.fn(() => ({
    store: {
      add: async (value: unknown) => nextId++,
      put: async (value: unknown) => nextId++,
    },
    index: (name: string) => {
      // 保留清理走到 cursor 阶段时返回 null（无可删），验证目标在 count 全扫次数
      expect(name).toBe('by_timestamp');
      return { openCursor: async () => null };
    },
    done: Promise.resolve(),
  }));
  return {
    add: async (_store: string, _value: unknown) => nextId++,
    transaction,
    count: vi.fn(count),
  };
}

describe('logs 保留清理节流（S2-2）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.resetModules();
    initDB.mockReset();
    getSettingsMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('60s 窗口内多批写入只执行一次全扫与一次 settings 读，窗外恢复', async () => {
    const count = vi.fn(async () => 5001);
    const db = makeFakeDb(count);
    initDB.mockResolvedValue(db as unknown as Awaited<ReturnType<typeof initDB>>);
    getSettingsMock.mockResolvedValue({ logging: { maxLogEntries: 2 } });

    const { logsBulkAdd } = await import('./indexedDb');

    await logsBulkAdd([{ message: 'batch-1' } as any]);
    expect(count).toHaveBeenCalledTimes(1);
    expect(getSettingsMock).toHaveBeenCalledTimes(1);

    await logsBulkAdd([{ message: 'batch-2' } as any]);
    await logsBulkAdd([{ message: 'batch-3' } as any]);
    expect(count).toHaveBeenCalledTimes(1);
    expect(getSettingsMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    await logsBulkAdd([{ message: 'batch-4' } as any]);
    expect(count).toHaveBeenCalledTimes(2);
    expect(getSettingsMock).toHaveBeenCalledTimes(2);
  });

  it('单条 logsAdd 与批量 logsBulkAdd 共享同一节流窗口', async () => {
    const count = vi.fn(async () => 5001);
    const db = makeFakeDb(count);
    initDB.mockResolvedValue(db as unknown as Awaited<ReturnType<typeof initDB>>);
    getSettingsMock.mockResolvedValue({ logging: { maxLogEntries: 2 } });

    const { logsAdd, logsBulkAdd } = await import('./indexedDb');

    await logsAdd({ message: 'single-1' } as any);
    expect(count).toHaveBeenCalledTimes(1);
    await logsBulkAdd([{ message: 'bulk-1' } as any]);
    expect(count).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(59_999);
    await logsBulkAdd([{ message: 'bulk-2' } as any]);
    expect(count).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await logsBulkAdd([{ message: 'bulk-3' } as any]);
    expect(count).toHaveBeenCalledTimes(2);
  });
});
