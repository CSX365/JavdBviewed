/**
 * @file runtimeMessaging.hiddenLeaseBackoff.test.ts
 * @description S1-2 (cycle-8)：hidden 页容量型租约拒绝改为退出内层等待循环（外层指数退避接管）
 *  1) hidden + 容量型拒绝：第一次请求后立即返回 waitReason，后续 LEASE_PROMPT 不再触发重请求
 *  2) visible + 容量型拒绝：保持 prompt 驱动即时重试（前台行为不变）
 *  3) hidden + tab-hidden：仍立即退出（回归保护）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

interface ChromeMockHandle {
  sendMessage: ReturnType<typeof vi.fn>;
  onMessageListeners: Array<(message: unknown) => void>;
}

function installChromeMock(behavior: (message: { type: string }) => unknown): ChromeMockHandle {
  const onMessageListeners: Array<(message: unknown) => void> = [];
  const sendMessage = vi.fn(async (message: { type: string }) => behavior(message));
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test-extension',
      lastError: undefined,
      sendMessage,
      onMessage: {
        addListener: (listener: (message: unknown) => void) => {
          onMessageListeners.push(listener);
        },
      },
    },
  });
  return { sendMessage, onMessageListeners };
}

function fireLeasePrompt(handle: ChromeMockHandle, reason = 'task-completed'): void {
  const message = { type: 'task-center:lease-prompt', payload: { reason } };
  for (const listener of handle.onMessageListeners) listener(message);
}

describe('waitForTaskLease hidden 页容量型拒绝退避（S1-2）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.useRealTimers();
  });

  it('hidden 页容量型拒绝：第一次请求后立即退出，prompt 不再触发重请求', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const handle = installChromeMock((message) => {
      if (message.type === 'task-center:request-lease') {
        attempts += 1;
        return { granted: false, waitReason: 'background-global-budget' };
      }
      return {};
    });
    vi.stubGlobal('document', { visibilityState: 'hidden' });

    const { waitForTaskLease } = await import('./runtimeMessaging');
    const resultPromise = waitForTaskLease('task-hidden-capacity', 30_000);
    await vi.advanceTimersByTimeAsync(50);

    const result = await resultPromise;
    expect(result).toEqual({ granted: false, waitReason: 'background-global-budget' });
    expect(attempts).toBe(1);

    // 外层退避期间即使收到 prompt 也不重请求（由 orchestrator 退避定时器接管）
    fireLeasePrompt(handle);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(1);
  });

  it('hidden 页各容量型拒绝原因均立即退出（source-page-heavy / page-budget / higher-priority-wait / bucket）', async () => {
    vi.useFakeTimers();
    const reasons = [
      'source-page-heavy-budget',
      'background-page-budget',
      'higher-priority-wait',
      'bucket:video-light',
      'smart-background-global-budget',
    ];
    for (const waitReason of reasons) {
      let attempts = 0;
      installChromeMock((message) => {
        if (message.type === 'task-center:request-lease') {
          attempts += 1;
          return { granted: false, waitReason };
        }
        return {};
      });
      vi.stubGlobal('document', { visibilityState: 'hidden' });
      vi.resetModules();
      const { waitForTaskLease } = await import('./runtimeMessaging');
      const resultPromise = waitForTaskLease(`task-${waitReason}`, 30_000);
      await vi.advanceTimersByTimeAsync(50);
      const result = await resultPromise;
      expect(result, waitReason).toEqual({ granted: false, waitReason });
      expect(attempts, waitReason).toBe(1);
      vi.useRealTimers();
      vi.useFakeTimers();
    }
  });

  it('前台页容量型拒绝：保持 prompt 驱动即时重试（前台行为不变）', async () => {
    let attempts = 0;
    const handle = installChromeMock((message) => {
      if (message.type === 'task-center:request-lease') {
        attempts += 1;
        return attempts < 2
          ? { granted: false, waitReason: 'background-page-budget' }
          : { granted: true };
      }
      return {};
    });
    vi.stubGlobal('document', { visibilityState: 'visible' });

    const { waitForTaskLease } = await import('./runtimeMessaging');
    const startedAt = Date.now();
    const resultPromise = waitForTaskLease('task-visible-capacity', 30_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(1);

    fireLeasePrompt(handle);

    const result = await resultPromise;
    const elapsedMs = Date.now() - startedAt;
    expect(result).toEqual({ granted: true });
    expect(attempts).toBe(2);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('hidden 页 tab-hidden 拒绝：仍立即退出（回归保护）', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    installChromeMock((message) => {
      if (message.type === 'task-center:request-lease') {
        attempts += 1;
        return { granted: false, waitReason: 'tab-hidden' };
      }
      return {};
    });
    vi.stubGlobal('document', { visibilityState: 'hidden' });

    const { waitForTaskLease } = await import('./runtimeMessaging');
    const resultPromise = waitForTaskLease('task-tab-hidden', 30_000);
    await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;
    expect(result).toEqual({ granted: false, waitReason: 'tab-hidden' });
    expect(attempts).toBe(1);
  });
});
