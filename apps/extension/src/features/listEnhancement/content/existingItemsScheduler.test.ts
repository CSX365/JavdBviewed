/**
 * @file existingItemsScheduler.test.ts
 * @description 列表冷启动已有卡片 enhance 分块调度单测（S1-1b）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EXISTING_ITEMS_CHUNK_SIZE,
  scheduleExistingItemsEnhancement,
} from './existingItemsScheduler';

function makeItems(n: number): HTMLElement[] {
  return Array.from({ length: n }, (_, i) => ({ __i: i }) as unknown as HTMLElement);
}

function manualIdle() {
  const queue: Array<() => void> = [];
  const scheduleIdle = vi.fn((cb: () => void) => {
    queue.push(cb);
  });
  const flushAll = (): number => {
    let n = 0;
    while (queue.length > 0) {
      queue.shift()!();
      n += 1;
    }
    return n;
  };
  return { scheduleIdle, queue, flushAll };
}

describe('scheduleExistingItemsEnhancement', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('items 为空时同步调用 onAllEnhanced', () => {
    const onAllEnhanced = vi.fn();
    const enhance = vi.fn();
    const { scheduleIdle } = manualIdle();

    scheduleExistingItemsEnhancement({ items: [], enhance, onAllEnhanced, scheduleIdle });

    expect(enhance).not.toHaveBeenCalled();
    expect(onAllEnhanced).toHaveBeenCalledTimes(1);
    expect(scheduleIdle).not.toHaveBeenCalled();
  });

  it('单 chunk 内同步完成：25 张按 12/12/1 分块，顺序不变，全部完成后才 onAllEnhanced', () => {
    const items = makeItems(25);
    const enhanced: number[] = [];
    const onAllEnhanced = vi.fn();
    const { scheduleIdle, flushAll } = manualIdle();

    scheduleExistingItemsEnhancement({
      items,
      enhance: item => enhanced.push((item as any).__i),
      onAllEnhanced,
      scheduleIdle,
    });

    // 首块同步
    expect(enhanced).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(onAllEnhanced).not.toHaveBeenCalled();

    flushAll();
    expect(enhanced).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(onAllEnhanced).toHaveBeenCalledTimes(1);
  });

  it('恰为整倍数时不多排一次空闲回调', () => {
    const items = makeItems(24);
    const onAllEnhanced = vi.fn();
    const { scheduleIdle, flushAll } = manualIdle();

    scheduleExistingItemsEnhancement({ items, enhance: vi.fn(), onAllEnhanced, scheduleIdle });
    expect(scheduleIdle).toHaveBeenCalledTimes(1);
    flushAll();
    expect(scheduleIdle).toHaveBeenCalledTimes(1);
    expect(onAllEnhanced).toHaveBeenCalledTimes(1);
  });

  it('chunkSize 小于 1 时按 1 处理（不崩、不死循环）', () => {
    const items = makeItems(3);
    const onAllEnhanced = vi.fn();
    const { scheduleIdle, flushAll } = manualIdle();

    scheduleExistingItemsEnhancement({ items, enhance: vi.fn(), onAllEnhanced, scheduleIdle, chunkSize: 0 });
    flushAll();
    expect(onAllEnhanced).toHaveBeenCalledTimes(1);
  });

  it('默认调度：有 requestIdleCallback 时走 rIC（带 500ms 超时）', () => {
    const ric = vi.fn((cb: () => void, opts?: { timeout?: number }) => {
      setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 16 } as IdleDeadline), 1);
      return 1;
    });
    vi.stubGlobal('requestIdleCallback', ric);
    const items = makeItems(DEFAULT_EXISTING_ITEMS_CHUNK_SIZE + 1);
    const onAllEnhanced = vi.fn();

    scheduleExistingItemsEnhancement({ items, enhance: vi.fn(), onAllEnhanced });
    expect(ric).toHaveBeenCalledTimes(1);
    expect(ric.mock.calls[0][1]).toEqual({ timeout: 500 });
    return new Promise<void>(resolve => setTimeout(resolve, 10)).then(() => {
      expect(onAllEnhanced).toHaveBeenCalledTimes(1);
    });
  });

  it('默认调度：无 requestIdleCallback 时回退 setTimeout(0)', async () => {
    vi.useFakeTimers();
    const items = makeItems(DEFAULT_EXISTING_ITEMS_CHUNK_SIZE + 1);
    const enhanced = vi.fn();
    const onAllEnhanced = vi.fn();

    scheduleExistingItemsEnhancement({ items, enhance: enhanced, onAllEnhanced });
    expect(enhanced).toHaveBeenCalledTimes(DEFAULT_EXISTING_ITEMS_CHUNK_SIZE);
    expect(onAllEnhanced).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(enhanced).toHaveBeenCalledTimes(items.length);
    expect(onAllEnhanced).toHaveBeenCalledTimes(1);
  });

  it('enhance 抛错时中断后续（与旧 forEach 行为一致），onAllEnhanced 不再调用', () => {
    const items = makeItems(3);
    const onAllEnhanced = vi.fn();
    const { scheduleIdle } = manualIdle();

    expect(() =>
      scheduleExistingItemsEnhancement({
        items,
        enhance: item => {
          if ((item as any).__i === 1) throw new Error('boom');
        },
        onAllEnhanced,
        scheduleIdle,
        chunkSize: 3,
      }),
    ).toThrow('boom');
    expect(onAllEnhanced).not.toHaveBeenCalled();
  });
});
