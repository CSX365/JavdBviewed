/**
 * @file globalTaskCenter.terminalRetention.test.ts
 * @description S1-B：终态任务保留窗口（1h→5min）+ 终态 LRU 上限（≤50）
 * 背景：S0-2/S0-3 实测 taskCenter:snapshot 每轮净增 +39,620B（B×3：39,841→79,461→119,081B），
 * 增长全部来自 tasks 数组里的终态记录（保留 1h + 无上限），导致 SW 写放大与内存膨胀。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalTaskCenter } from './globalTaskCenter';
import type { GlobalTaskDescriptor } from '../../shared/taskCenterTypes';

const T0 = 1_757_000_000_000;

function makeDescriptor(index: number, now: number): GlobalTaskDescriptor {
  return {
    taskId: `t-${index}`,
    label: `label-${index % 5}`,
    tabId: 0,
    pageUrl: 'https://javdb.com/v/test',
    pageType: 'detail',
    mainId: 'test',
    pageInstanceId: `page-${index}`,
    phase: 'high',
    priority: 5,
    cost: 'light',
    visibilityPolicy: 'foreground_first',
    timeoutMs: 10_000,
    retryLimit: 0,
    dedupeKey: `dedupe-${index}`,
    resumePolicy: 'restart',
    createdAt: now,
  };
}

function visibleTaskIds(center: GlobalTaskCenter): string[] {
  return center.queryState().tasks.map((task) => task.taskId);
}

describe('GlobalTaskCenter 终态任务保留与 LRU 上限', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('终态任务超过 5min 保留期后被清理（原 1h 保留导致快照无界增长）', () => {
    const center = new GlobalTaskCenter();
    const { taskId } = center.registerTask(makeDescriptor(1, T0));
    center.completeTask(taskId); // endedAt = T0
    expect(visibleTaskIds(center)).toContain(taskId);

    vi.setSystemTime(T0 + 4 * 60_000);
    expect(visibleTaskIds(center)).toContain(taskId); // 4min：仍在保留窗口内

    vi.setSystemTime(T0 + 6 * 60_000);
    expect(visibleTaskIds(center)).not.toContain(taskId); // 6min：超出 5min 保留期 → 清理
  });

  it('终态任务超过 50 条时按 endedAt 升序淘汰最旧的，保留 ≤50 条', () => {
    const center = new GlobalTaskCenter();
    for (let i = 0; i < 60; i++) {
      const now = T0 + i * 1_000; // 完成时间分散在 1min 内，不触发保留期
      vi.setSystemTime(now);
      const { taskId } = center.registerTask(makeDescriptor(i, now));
      center.completeTask(taskId);
    }

    vi.setSystemTime(T0 + 60_000);
    const ids = visibleTaskIds(center);
    expect(ids).toHaveLength(50);
    for (let i = 0; i < 10; i++) {
      expect(ids).not.toContain(`t-${i}`); // 最旧的 10 条被淘汰
    }
    for (let i = 50; i < 60; i++) {
      expect(ids).toContain(`t-${i}`); // 最新的 10 条保留
    }
  });
});
