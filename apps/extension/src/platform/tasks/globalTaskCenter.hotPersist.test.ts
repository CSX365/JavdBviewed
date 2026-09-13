/**
 * @file globalTaskCenter.hotPersist.test.ts
 * @description S1-C：持久化热/冷分层 + dedupe 变化检测
 *  S1 首测实测：16-tab detail 场景 185 次快照写 ≈11MB，其中 ~53% 是终态任务（展示用历史），
 *  dedupe 每次随快照全量重写 1.7MB；browser 进程 CPU 较 control +50% 的主残留。
 *  1) 租约授予/防抖写走 hot 快照：只含非终态任务 + dedupe-by-action 终态结果
 *  2) 30s 周期兜底走 full 快照：终态历史随周期落盘
 *  3) dedupe 仅自身变化时随写（内容未变不再伴随 dedupe 重写）
 *  4) 同一 label 重复完成不再驱动写
 *  5) restore 用恢复出的 dedupe 初始化基线，不触发冗余重写
 *  6) hot/full 基线独立：hot 写后 full 写不被误跳过
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalTaskCenter } from './globalTaskCenter';
import type { GlobalTaskDescriptor } from '../../shared/taskCenterTypes';

const T0 = 1_757_000_000_000;

interface ChromeStorageMock {
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function installChromeMock(
  seed: Record<string, unknown> = {},
): ChromeStorageMock {
  const set = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockImplementation((_keys: unknown, cb: (result: Record<string, unknown>) => void) => {
    cb(seed);
  });
  const remove = vi.fn().mockResolvedValue(undefined);
  const tabsQuery = vi.fn().mockResolvedValue([]);
  (globalThis as Record<string, unknown>).chrome = {
    storage: { local: { set, get, remove } },
    tabs: { query: tabsQuery },
    runtime: { lastError: null },
  };
  return { set, get, remove };
}

function descriptor(
  label: string,
  tabId: number,
  overrides: Partial<GlobalTaskDescriptor> = {},
): GlobalTaskDescriptor {
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
    ...overrides,
  };
}

function payloadOf(set: ChromeStorageMock['set'], callIndex: number): Record<string, any> {
  return set.mock.calls[callIndex][0] as Record<string, any>;
}

function snapshotTasks(set: ChromeStorageMock['set'], callIndex: number): Array<{ taskId: string; status: string }> {
  const snap = payloadOf(set, callIndex)['taskCenter:snapshot'];
  return (snap.tasks as any[]).map((t) => ({
    taskId: t.descriptor.taskId,
    status: t.runtime.status,
  }));
}

describe('GlobalTaskCenter 持久化热/冷分层（S1-C）', () => {
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

  it('租约授予 flush 写 hot 快照：排除普通终态任务、保留 leased 任务', async () => {
    const { set } = handle;
    const center = new GlobalTaskCenter();
    const doneId = center.registerTask(descriptor('ui:a:done', 1)).taskId;
    const leasedId = center.registerTask(descriptor('ui:b:leased', 2)).taskId;
    center.updateVisibility(1, true);
    center.updateVisibility(2, true);
    center.completeTask(doneId); // 终态（普通 label）

    center.requestLease(leasedId);
    await vi.advanceTimersByTimeAsync(150); // 授予窗 flush
    expect(set).toHaveBeenCalledTimes(1);

    const byId = new Map(snapshotTasks(set, 0).map((t) => [t.taskId, t.status]));
    expect(byId.get(leasedId)).toBe('leased');
    expect(byId.has(doneId)).toBe(false); // 终态不入 hot 快照
  });

  it('dedupe-by-action 终态结果保留在 hot 快照（跨重启去重复用）', async () => {
    const { set } = handle;
    const center = new GlobalTaskCenter();
    const sharedId = center.registerTask(descriptor(
      'shared:push',
      1,
      { shareScope: 'dedupe-by-action' },
    )).taskId;
    center.updateVisibility(1, true);
    const otherId = center.registerTask(descriptor('ui:c:other', 2)).taskId;
    center.updateVisibility(2, true);
    center.completeTask(sharedId);
    center.completeTask(otherId);

    center.requestLease(sharedId); // task-done → 不授予、不写
    expect(set).not.toHaveBeenCalled();
    // 用另一个新任务的授予触发 hot 写
    const grantId = center.registerTask(descriptor('ui:d:grant', 3)).taskId;
    center.updateVisibility(3, true);
    center.requestLease(grantId);
    await vi.advanceTimersByTimeAsync(150);
    expect(set).toHaveBeenCalledTimes(1);

    const byId = new Map(snapshotTasks(set, 0).map((t) => [t.taskId, t.status]));
    expect(byId.get(sharedId)).toBe('done'); // 共享动作终态保留
    expect(byId.has(otherId)).toBe(false); // 普通终态剔除
  });

  it('30s 周期兜底写 full 快照：含终态历史', async () => {
    const { set } = handle;
    const center = new GlobalTaskCenter();
    await center.restoreFromStorage();
    const doneId = center.registerTask(descriptor('ui:e:hist', 1)).taskId;
    center.completeTask(doneId);
    // 触发一次 hot 写建立基线
    const grantId = center.registerTask(descriptor('ui:f:grant', 2)).taskId;
    center.updateVisibility(2, true);
    center.requestLease(grantId);
    await vi.advanceTimersByTimeAsync(150);
    expect(set).toHaveBeenCalledTimes(1);
    expect(snapshotTasks(set, 0).some((t) => t.taskId === doneId)).toBe(false);

    vi.advanceTimersByTime(30_000); // 周期 full 写
    expect(set).toHaveBeenCalledTimes(2);
    const byId = new Map(snapshotTasks(set, 1).map((t) => [t.taskId, t.status]));
    expect(byId.get(doneId)).toBe('done'); // 终态历史随周期落盘
  });

  it('dedupe 未变化时不随写；变化时合写', async () => {
    const { set } = handle;
    const center = new GlobalTaskCenter();
    const a = center.registerTask(descriptor('ui:g:a', 1)).taskId;
    center.updateVisibility(1, true);
    center.requestLease(a);
    await vi.advanceTimersByTimeAsync(150);
    expect(set).toHaveBeenCalledTimes(1);
    expect(payloadOf(set, 0)['taskCenter:dedupeIndex']).toBeTruthy(); // 首次带 dedupe

    // 完成任务触发 hot 写（内容变化）：dedupe 条目未变 → 不带 dedupe 键
    center.completeTask(a);
    await vi.advanceTimersByTimeAsync(500);
    expect(set).toHaveBeenCalledTimes(2);
    expect(payloadOf(set, 1)['taskCenter:dedupeIndex']).toBeUndefined();

    // 新任务注册 → dedupe 新增条目 → 下次写带上
    const c = center.registerTask(descriptor('ui:i:c', 2)).taskId;
    center.updateVisibility(2, true);
    center.requestLease(c);
    await vi.advanceTimersByTimeAsync(150);
    expect(set).toHaveBeenCalledTimes(3);
    const dedupe = payloadOf(set, 2)['taskCenter:dedupeIndex'] as Record<string, string>;
    expect(Object.values(dedupe)).toContain(c);
  });

  it('同一 label 重复完成只触发一次写', async () => {
    const { set } = handle;
    const center = new GlobalTaskCenter();
    center.updateVisibility(1, true);
    const a = center.registerTask(descriptor('ui:j:same', 1, { taskId: 'task-j-a' })).taskId;
    const b = center.registerTask(descriptor('ui:j:same', 1, { taskId: 'task-j-b', pageUrl: 'https://javdb.com/v/j-b' })).taskId;
    center.completeTask(a);
    await vi.advanceTimersByTimeAsync(500); // 首次完成 label → 防抖写
    expect(set).toHaveBeenCalledTimes(1);

    center.completeTask(b); // 同 label 重复完成 → 不再调度
    await vi.advanceTimersByTimeAsync(1_000);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('restore 用恢复出的 dedupe 初始化基线：周期写不冗余重发 dedupe', async () => {
    const seed = {
      'taskCenter:snapshot': {
        tasks: [],
        completedLabels: ['x'],
        savedAt: T0 - 1000,
      },
      'taskCenter:dedupeIndex': { 'ui:k:seed:https://javdb.com/v/x': 'task-seed' },
    };
    handle = installChromeMock(seed);
    const center = new GlobalTaskCenter();
    await center.restoreFromStorage();

    vi.advanceTimersByTime(30_000); // 周期 full 写（建立基线）
    expect(handle.set).toHaveBeenCalledTimes(1);
    const snap = payloadOf(handle.set, 0)['taskCenter:snapshot'];
    expect(snap.completedLabels).toEqual(['x']);
    // dedupe 与存储一致 → 不重发
    expect(payloadOf(handle.set, 0)['taskCenter:dedupeIndex']).toBeUndefined();
  });

  it('hot/full 基线独立：hot 写后 full 周期写不被误跳过，label 非新则跳过', async () => {
    const { set } = handle;
    const center = new GlobalTaskCenter();
    await center.restoreFromStorage();
    const a = center.registerTask(descriptor('ui:l:same', 1, { taskId: 'task-l-a' })).taskId;
    const b = center.registerTask(descriptor('ui:l:same', 1, { taskId: 'task-l-b', pageUrl: 'https://javdb.com/v/l-b' })).taskId;
    center.updateVisibility(1, true);
    center.requestLease(a);
    await vi.advanceTimersByTimeAsync(150); // hot 写 #1
    expect(set).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000); // full 写 #2（full 基线未建立）
    expect(set).toHaveBeenCalledTimes(2);

    // b 完成：label 首次完成 → 防抖 hot 写 #3（label 集合变化）
    // 周期 full 写锚定了 3s burst 合并窗，防抖写落在窗内 → 合并到窗口结束 flush
    center.completeTask(b);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(set).toHaveBeenCalledTimes(3);
    const byIdAfter = new Map(snapshotTasks(set, 2).map((t) => [t.taskId, t.status]));
    expect(byIdAfter.get(a)).toBe('leased'); // hot 写只含非终态：b(done) 不入快照
    expect(byIdAfter.has(b)).toBe(false);

    center.completeTask(a); // label 非新 → 不再调度，hot 写保持 3 次
    await vi.advanceTimersByTimeAsync(1_000);
    expect(set).toHaveBeenCalledTimes(3);
  });
});
