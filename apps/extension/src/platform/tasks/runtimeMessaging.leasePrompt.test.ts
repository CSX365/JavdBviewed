/**
 * @file runtimeMessaging.leasePrompt.test.ts
 * @description S2-2 (cycle-7)：waitForTaskLease 的事件驱动唤醒
 *  1) LEASE_PROMPT 到达后立即重试租约（无需等 2s 兜底间隔）
 *  2) 无事件时兜底轮询仍按间隔重试，超时返回最后一次 waitReason
 *  3) 终态等待原因仍立即退出（回归保护）
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

describe('waitForTaskLease 事件驱动唤醒（S2-2）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.useRealTimers();
  });

  it('LEASE_PROMPT 到达后立即重试租约，三次尝试在 1s 内完成（兜底间隔为 2s）', async () => {
    let attempts = 0;
    const handle = installChromeMock((message) => {
      if (message.type === 'task-center:request-lease') {
        attempts += 1;
        return attempts < 3
          ? { granted: false, waitReason: 'bucket:translate' }
          : { granted: true };
      }
      return {};
    });

    const { waitForTaskLease } = await import('./runtimeMessaging');
    const startedAt = Date.now();
    const resultPromise = waitForTaskLease('task-waiting', 30_000);

    // 第一次尝试进入等待窗
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(1);

    fireLeasePrompt(handle);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(2);
    fireLeasePrompt(handle);

    const result = await resultPromise;
    const elapsedMs = Date.now() - startedAt;
    expect(result).toEqual({ granted: true });
    expect(attempts).toBe(3);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('无事件时按兜底间隔继续轮询，超时后返回最后一次 waitReason', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    installChromeMock((message) => {
      if (message.type === 'task-center:request-lease') {
        attempts += 1;
        return { granted: false, waitReason: 'task-not-found' };
      }
      return {};
    });

    const { waitForTaskLease } = await import('./runtimeMessaging');
    const resultPromise = waitForTaskLease('task-starved', 2_500);
    // t0 第 1 次；t2000 第 2 次；t4000 等待窗结束 → 超出 2500ms 超时退出
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await resultPromise;
    expect(result).toEqual({ granted: false, waitReason: 'task-not-found' });
    expect(attempts).toBe(2);
  });

  it('D: 请求在途期间到达的 prompt 不丢失（无需等 2s 兜底间隔即重试）', async () => {
    let attempts = 0;
    const handle = installChromeMock((message) => {
      if (message.type === 'task-center:request-lease') {
        attempts += 1;
        if (attempts === 1) {
          // 第一次请求在途 50ms；期间 SW 释放槽位并在 ~10ms 发出 prompt
          setTimeout(() => fireLeasePrompt(handle), 10);
          return new Promise<{ granted: boolean; waitReason?: string }>((resolve) => {
            setTimeout(() => resolve({ granted: false, waitReason: 'source-page-heavy-budget' }), 50);
          });
        }
        return { granted: true };
      }
      return {};
    });

    const { waitForTaskLease } = await import('./runtimeMessaging');
    const startedAt = Date.now();
    const result = await waitForTaskLease('task-d', 30_000);
    const elapsedMs = Date.now() - startedAt;
    expect(result).toEqual({ granted: true });
    expect(attempts).toBe(2);
    // 修复前：prompt 到达时 waiter 尚未注册 → 丢失 → 第二次尝试要等 ~2s 兜底间隔；
    // 修复后：请求返回后由已触发的 wake 立即驱动第二次尝试，总耗时远小于兜底间隔
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('终态等待原因立即退出（回归保护：不依赖轮询间隔）', async () => {
    const handle = installChromeMock((message) => {
      if (message.type === 'task-center:request-lease') {
        return { granted: false, waitReason: 'task-canceled' };
      }
      return {};
    });

    const { waitForTaskLease } = await import('./runtimeMessaging');
    const startedAt = Date.now();
    const result = await waitForTaskLease('task-gone', 30_000);
    expect(result).toEqual({ granted: false, waitReason: 'task-canceled' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(handle.onMessageListeners.length).toBeGreaterThan(0);
  });
});
