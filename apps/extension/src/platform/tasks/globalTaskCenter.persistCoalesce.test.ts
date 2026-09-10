/**
 * @file globalTaskCenter.persistCoalesce.test.ts
 * @description S1-B（I-4a）：persistToStorage 写合并
 *  1) 快照内容未变化时跳过写（含 30s 周期兜底写），杜绝无变化的全量重写
 *  2) 冷启动 0~3s 写风暴（S0 实测 7~8 次全量重写）合并为 ≤2 次
 *  3) 窗口外的稳态写保持立即写，不被延迟
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalTaskCenter } from './globalTaskCenter';

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

describe('GlobalTaskCenter persist 写合并（I-4a）', () => {
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

  it('30s 周期快照在内容未变化时跳过写', async () => {
    const { set } = handle;
    const center = new GlobalTaskCenter();
    await center.restoreFromStorage();
    expect(set).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(set).toHaveBeenCalledTimes(1); // 首次周期：尚无写基线 → 落一次基线

    vi.advanceTimersByTime(30_000);
    expect(set).toHaveBeenCalledTimes(1); // 内容未变 → 跳过
  });

  it('冷启动 3s 窗口内的写合并为 ≤2 次（原实现逐次全量重写）', () => {
    const { set } = handle;
    const center = new GlobalTaskCenter();

    center.markTaskLabelCompleted('a');
    vi.advanceTimersByTime(500); // 写 #1（t=500ms），锚定窗口至 t=3500ms
    expect(set).toHaveBeenCalledTimes(1);

    center.markTaskLabelCompleted('b');
    vi.advanceTimersByTime(500); // 防抖到点（t=1000ms）→ 窗口内 → 合并，不写
    expect(set).toHaveBeenCalledTimes(1);

    center.markTaskLabelCompleted('c');
    vi.advanceTimersByTime(500); // 防抖到点（t=1500ms）→ 窗口内 → 合并，不写
    expect(set).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000); // t=3500ms 窗口结束 → 写 #2（含 a/b/c）
    expect(set).toHaveBeenCalledTimes(2);

    const lastPayload = set.mock.calls[set.mock.calls.length - 1][0] as Record<string, any>;
    expect(lastPayload['taskCenter:snapshot'].completedLabels).toEqual(
      expect.arrayContaining(['a', 'b', 'c']),
    );
  });

  it('合并窗口外的稳态写保持立即写（不被延迟到窗口结束）', () => {
    const { set } = handle;
    const center = new GlobalTaskCenter();

    center.markTaskLabelCompleted('a');
    vi.advanceTimersByTime(500); // 写 #1（t=500ms，窗口至 3500ms）
    expect(set).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(4_000); // t=4500ms，窗口已结束
    center.markTaskLabelCompleted('b');
    vi.advanceTimersByTime(500); // 防抖到点（t=5000ms）→ 立即写
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('内容未变化时不产生重复写（含窗口结束时的合并写）', () => {
    const { set } = handle;
    const center = new GlobalTaskCenter();

    center.markTaskLabelCompleted('a');
    vi.advanceTimersByTime(500); // 写 #1
    expect(set).toHaveBeenCalledTimes(1);

    center.markTaskLabelCompleted('a'); // 同一 label → 内容未变
    vi.advanceTimersByTime(500); // 防抖到点（t=1000ms）→ 内容未变 → 跳过
    expect(set).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000); // 其后无新变化
    expect(set).toHaveBeenCalledTimes(1);
  });
});
