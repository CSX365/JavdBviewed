/**
 * @file globalTaskCenter.leaseGrantCoalesce.test.ts
 * @description S1-A (cycle-6)：租约授予合并窗口
 *  1) 窗口内并发授予合并为一次全量快照写（原 N 次授予 = N 次 immediate 全量写）
 *  2) sendResponse 只在 flush 完成后发出（不响应先行、写入继续堆积）
 *  3) 窗口外的授予新开窗口；waiter 全部 resolve（无 pending 泄漏）
 *  4) burst 窗口内的过期 pending 不写回（租约授予提交后，更旧 pending 被丢弃，防快照回滚）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalTaskCenter } from './globalTaskCenter';
import { TASK_CENTER_MESSAGE } from '../../shared/taskCenterProtocol';
import type { GlobalTaskDescriptor } from '../../shared/taskCenterTypes';

const T0 = 1_757_000_000_000;

interface ChromeStorageMock {
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

function installChromeMock(): ChromeStorageMock {
  const set = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockImplementation((_keys: unknown, cb: (result: Record<string, unknown>) => void) => {
    cb({});
  });
  const tabsQuery = vi.fn().mockResolvedValue([]);
  (globalThis as Record<string, unknown>).chrome = {
    storage: { local: { set, get } },
    tabs: { query: tabsQuery },
    runtime: { lastError: null },
  };
  return { set, get };
}

function descriptor(label: string, tabId: number): GlobalTaskDescriptor {
  return {
    taskId: `task-${label}`,
    label,
    tabId,
    pageUrl: `https://javdb.com/v/${label}`,
    pageType: 'detail',
    mainId: label,
    pageInstanceId: `page-${label}`,
    phase: 'high',
    priority: 5,
    cost: 'light',
    visibilityPolicy: 'foreground_first',
    timeoutMs: 10_000,
    retryLimit: 0,
    resumePolicy: 'restart',
    createdAt: Date.now(),
  };
}

function snapshotTasks(set: ChromeStorageMock['set'], callIndex: number): Array<{ taskId: string; status: string }> {
  const payload = set.mock.calls[callIndex][0] as Record<string, any>;
  return (payload['taskCenter:snapshot'].tasks as any[]).map((t) => ({
    taskId: t.descriptor.taskId,
    status: t.runtime.status,
  }));
}

describe('GlobalTaskCenter 租约授予合并窗口（S1-A）', () => {
  let handle: ChromeStorageMock;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    handle = installChromeMock();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  it('窗口内并发授予合并为一次写，快照包含全部已授予任务', async () => {
    const { set } = handle;
    const center = new GlobalTaskCenter();
    const ids: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const label = `ui:remove-unwanted:p${i}`;
      center.updateVisibility(i, true);
      ids.push(center.registerTask(descriptor(label, i)).taskId);
    }

    center.requestLease(ids[0]);
    vi.advanceTimersByTime(50);
    center.requestLease(ids[1]);
    vi.advanceTimersByTime(50);
    center.requestLease(ids[2]);
    // 150ms 合并窗口内不产生写
    expect(set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50); // 窗口结束 → 一次写
    expect(set).toHaveBeenCalledTimes(1);

    const tasks = snapshotTasks(set, 0);
    const byId = new Map(tasks.map((t) => [t.taskId, t.status]));
    for (const id of ids) expect(byId.get(id)).toBe('leased');
  });

  it('sendResponse 只在 flush 完成后发出（不响应先行）', async () => {
    const center = new GlobalTaskCenter();
    center.updateVisibility(7, true);
    const { taskId } = center.registerTask(descriptor('ui:remove-unwanted:resp', 7));

    const responses: unknown[] = [];
    center.handleMessage(
      { type: TASK_CENTER_MESSAGE.REQUEST_LEASE, payload: { taskId } },
      { tab: { id: 7 } } as chrome.runtime.MessageSender,
      (response: unknown) => { responses.push(response); },
    );
    // 授予瞬间响应尚未发出（等待 flush 完成）
    expect(responses).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(150);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({ granted: true });
  });

  it('窗口外的授予新开窗口，waiter 全部 resolve（无 pending 泄漏）', async () => {
    const { set } = handle;
    const center = new GlobalTaskCenter();
    const ids: string[] = [];
    for (let i = 1; i <= 2; i += 1) {
      center.updateVisibility(i, true);
      ids.push(center.registerTask(descriptor(`ui:remove-unwanted:w${i}`, i)).taskId);
    }

    center.requestLease(ids[0]);
    await vi.advanceTimersByTimeAsync(150);
    expect(set).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000); // 第一个窗口早已结束
    center.requestLease(ids[1]);
    expect(set).toHaveBeenCalledTimes(1); // 新窗口内仍未写

    await vi.advanceTimersByTimeAsync(150);
    expect(set).toHaveBeenCalledTimes(2);

    const tasks = snapshotTasks(set, 1);
    const byId = new Map(tasks.map((t) => [t.taskId, t.status]));
    expect(byId.get(ids[1])).toBe('leased');
  });

  it('burst 窗口内的过期 pending 不写回（租约授予提交后旧 pending 被丢弃）', async () => {
    const { set } = handle;
    const center = new GlobalTaskCenter();

    center.markTaskLabelCompleted('a');
    await vi.advanceTimersByTimeAsync(500); // 防抖 500ms → 首次写（锚定 burst 窗口至 t=3500ms）
    expect(set).toHaveBeenCalledTimes(1);

    center.markTaskLabelCompleted('b');
    vi.advanceTimersByTime(500); // t=1500ms 窗口内 → 合并为 pending，不写
    expect(set).toHaveBeenCalledTimes(1);

    center.updateVisibility(9, true);
    const { taskId } = center.registerTask(descriptor('ui:remove-unwanted:stale', 9));
    center.requestLease(taskId);
    await vi.advanceTimersByTimeAsync(150); // t=1650ms 租约窗结束 → 提交（比 pending 更新）
    expect(set).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000); // t=3650ms burst 窗结束 → 过期 pending 跳过
    expect(set).toHaveBeenCalledTimes(2);

    const payload = set.mock.calls[1][0] as Record<string, any>;
    const snap = payload['taskCenter:snapshot'];
    expect(snap.completedLabels).toEqual(expect.arrayContaining(['a', 'b']));
    const byId = new Map(snapshotTasks(set, 1).map((t) => [t.taskId, t.status]));
    expect(byId.get(taskId)).toBe('leased'); // 最新快照未被更旧 pending 回滚
  });
});
