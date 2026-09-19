/**
 * @vitest-environment jsdom
 * @file settingsPersist.test.ts
 * @description React 设置页公共持久化 Hook 回归测试
 * @module apps/dashboard/pages/settings/shared
 */
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitPendingSettingsPersist, useDebouncedSettingsSave } from './settingsPersist';

type SaveHarnessProps = {
  value: string;
  persist: (value: string) => Promise<void>;
};

function SaveHarness({ value, persist }: SaveHarnessProps) {
  const { scheduleSave } = useDebouncedSettingsSave({
    delayMs: 1000,
    persist,
  });

  useEffect(() => {
    scheduleSave(value);
  }, [scheduleSave, value]);

  return null;
}

describe('useDebouncedSettingsSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('页面在防抖期内卸载时仍会写入最后一次设置', async () => {
    const persist = vi.fn(async () => undefined);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(createElement(SaveHarness, { value: 'latest', persist }));
    });
    expect(persist).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('latest');
  });

  it('连续修改时只保存防抖窗口内的最新值', async () => {
    const persist = vi.fn(async () => undefined);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(createElement(SaveHarness, { value: 'first', persist }));
    });
    await act(async () => {
      root.render(createElement(SaveHarness, { value: 'latest', persist }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('latest');

    await act(async () => {
      root.unmount();
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('前一次异步写入未完成时会串行保存新值', async () => {
    let resolveFirst: (() => void) | undefined;
    const persist = vi.fn((value: string): Promise<void> => {
      if (value !== 'first') return Promise.resolve();
      return new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(createElement(SaveHarness, { value: 'first', persist }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(persist).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(createElement(SaveHarness, { value: 'latest', persist }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(persist).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst?.();
      await Promise.resolve();
    });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith('latest');

    await act(async () => {
      root.unmount();
    });
  });
});


describe('awaitPendingSettingsPersist（设置子页切换竞态）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('无待写时立即 resolve（不依赖计时器）', async () => {
    // 链状态在模块级：先推进时间清掉前一个用例可能残留的在飞计时器
    await vi.advanceTimersByTimeAsync(5000);
    await expect(awaitPendingSettingsPersist(1500)).resolves.toBeUndefined();
  });

  it('有在飞写入时挂起，写入 settle 后才 resolve', async () => {
    let resolvePersist: (() => void) | undefined;
    const persist = vi.fn(
      (value: string): Promise<void> =>
        new Promise<void>((resolve) => {
          resolvePersist = resolve;
        }),
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(createElement(SaveHarness, { value: 'latest', persist }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(persist).toHaveBeenCalledTimes(1);

    let settled = false;
    const wait = awaitPendingSettingsPersist(1500).then(() => {
      settled = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(settled).toBe(false);

    await act(async () => {
      resolvePersist?.();
      await Promise.resolve();
    });
    await wait;
    expect(settled).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });

  it('超时 fail-open：等待返回并重置链，后续写入不被卡死', async () => {
    const persist = vi.fn((value: string): Promise<void> => {
      if (value === 'hang') {
        return new Promise<void>(() => {
          /* 永不 settle */
        });
      }
      return Promise.resolve();
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    // 第一页：入队后永不 settle 的写入
    await act(async () => {
      root.render(createElement(SaveHarness, { value: 'hang', persist }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenLastCalledWith('hang');

    // 挂载流等待：100ms 超时 fail-open
    const wait = awaitPendingSettingsPersist(100);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await wait;

    // 链已重置：新页面写入不再被旧的 hang 阻塞
    const host2 = document.createElement('div');
    document.body.append(host2);
    const root2 = createRoot(host2);
    await act(async () => {
      root2.render(createElement(SaveHarness, { value: 'fresh', persist }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith('fresh');
    await expect(awaitPendingSettingsPersist(100)).resolves.toBeUndefined();

    await act(async () => {
      root2.unmount();
    });
  });

  it('跨组件串行：前页卸载 flush 未 settle 时，后页写入排队等待', async () => {
    let resolveA: (() => void) | undefined;
    const persistA = vi.fn(
      (value: string): Promise<void> =>
        new Promise<void>((resolve) => {
          resolveA = resolve;
        }),
    );
    const persistB = vi.fn(async (value: string) => {
      /* 立即 settle */
    });
    const hostA = document.createElement('div');
    document.body.append(hostA);
    const rootA = createRoot(hostA);

    // 前页：挂载后防抖到期 → 卸载 flush 入队（在飞）
    await act(async () => {
      rootA.render(createElement(SaveHarness, { value: 'a', persist: persistA }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(persistA).toHaveBeenCalledTimes(1);

    const hostB = document.createElement('div');
    document.body.append(hostB);
    const rootB = createRoot(hostB);
    await act(async () => {
      rootB.render(createElement(SaveHarness, { value: 'b', persist: persistB }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // 后页写入必须等前页 flush settle
    expect(persistB).not.toHaveBeenCalled();

    await act(async () => {
      resolveA?.();
      await Promise.resolve();
    });
    expect(persistB).toHaveBeenCalledTimes(1);
    expect(persistB).toHaveBeenCalledWith('b');

    await act(async () => {
      rootB.unmount();
    });
  });
});
