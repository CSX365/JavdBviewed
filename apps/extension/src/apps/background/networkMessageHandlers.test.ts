import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleExternalDataFetch, RequestSchedulerLike } from './networkMessageHandlers';

/**
 * S1 B2 (cycle-14)：外部 fetch 收敛单测
 * - firstByteTimeoutMs 首字节快速失败（响应头到达前超时即 abort，到达后计时器清除）
 * - 失败响应附 cooldownMs（background 侧 host 剩余冷却），无冷却不回传
 * - 错误日志按 host 限速：5s 内仅首条带栈 console.error，后续抑制计数，30s 至多一条汇总
 */

interface EnqueueCall { url: string; init: RequestInit; }

type Behavior = (ctx: {
  url: string;
  signal: AbortSignal | undefined;
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
}) => void;

function makeScheduler(behavior: Behavior, cooldownMs = 0): RequestSchedulerLike & { calls: EnqueueCall[] } {
  const calls: EnqueueCall[] = [];
  return {
    calls,
    enqueue: (url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      calls.push({ url, init: init ?? {} });
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      behavior({ url, signal, resolve, reject });
    }),
    getRemainingCooldownMs: () => cooldownMs,
  };
}

function makeResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

describe('handleExternalDataFetch S1 B2 (cycle-14)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('firstByteTimeoutMs：3s 内无响应头即 abort（reason=no-first-byte），不再空挂全程超时', async () => {
    let abortReason: unknown = null;
    const scheduler = makeScheduler((ctx) => {
      // 模拟响应头 5s 才到达（超过 3s 首字节窗）
      ctx.signal?.addEventListener('abort', () => { abortReason = ctx.signal?.reason; });
      setTimeout(() => ctx.resolve(makeResponse('late')), 5000);
    });
    let response: any = null;
    const pending = handleExternalDataFetch(
      { url: 'https://slow.example.com/page', options: { firstByteTimeoutMs: 3000, timeout: 10000 } },
      (r) => { response = r; },
      scheduler,
    );
    await vi.advanceTimersByTimeAsync(2999);
    expect(abortReason).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(abortReason).toBe('no-first-byte');
    expect(response?.success).toBe(false);
    expect(String(response?.error)).toMatch(/abort/i);
  });

  it('firstByteTimeoutMs：响应头按时到达后清除首字节计时器（3s 后不再 abort）', async () => {
    let abortReason: unknown = null;
    const scheduler = makeScheduler((ctx) => {
      ctx.signal?.addEventListener('abort', () => { abortReason = ctx.signal?.reason; });
      setTimeout(() => ctx.resolve(makeResponse('ok')), 1000);
    });
    let response: any = null;
    const pending = handleExternalDataFetch(
      { url: 'https://fast.example.com/page', options: { firstByteTimeoutMs: 3000 } },
      (r) => { response = r; },
      scheduler,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(response?.success).toBe(true);
    expect(response?.data).toBe('ok');
    await vi.advanceTimersByTimeAsync(5000);
    expect(abortReason).toBeNull();
  });

  it('不传 firstByteTimeoutMs：全程超时语义不变（10s 才 abort）', async () => {
    let aborted = false;
    const scheduler = makeScheduler((ctx) => {
      ctx.signal?.addEventListener('abort', () => { aborted = true; });
      setTimeout(() => ctx.resolve(makeResponse('never')), 60000);
    });
    let response: any = null;
    const pending = handleExternalDataFetch(
      { url: 'https://slow.example.com/page', options: {} },
      (r) => { response = r; },
      scheduler,
    );
    await vi.advanceTimersByTimeAsync(9999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(aborted).toBe(true);
    expect(response?.success).toBe(false);
  });

  it('失败响应附 cooldownMs（供调用方对齐重试延迟）', async () => {
    const scheduler = makeScheduler((ctx) => {
      setTimeout(() => ctx.reject(new Error('fetch failed')), 10);
    }, 12345);
    let response: any = null;
    const pending = handleExternalDataFetch(
      { url: 'https://down.example.com/x', options: {} },
      (r) => { response = r; },
      scheduler,
    );
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    expect(response).toMatchObject({ success: false, error: 'fetch failed', cooldownMs: 12345 });
  });

  it('无冷却时不回传 cooldownMs 字段', async () => {
    const scheduler = makeScheduler((ctx) => {
      setTimeout(() => ctx.reject(new Error('fetch failed')), 10);
    }, 0);
    let response: any = null;
    const pending = handleExternalDataFetch(
      { url: 'https://down.example.com/x', options: {} },
      (r) => { response = r; },
      scheduler,
    );
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    expect(response?.success).toBe(false);
    expect(response).not.toHaveProperty('cooldownMs');
  });

  it('错误日志限速：同 host 5s 内仅首条带栈，抑制计数，30s 至多一条汇总', async () => {
    const scheduler = makeScheduler((ctx) => {
      ctx.reject(new Error('down'));
    }, 0);
    const send = () => new Promise<any>((resolve) => {
      handleExternalDataFetch({ url: 'https://flaky.example.com/x', options: {} }, resolve, scheduler);
    });

    // 阶段 A：t=0 首条带栈；t=1/2s 在 5s 窗内 → 抑制
    await send(); // t=0
    expect(errorSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await send(); // t=1s
    await vi.advanceTimersByTimeAsync(1000);
    await send(); // t=2s
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();

    // 阶段 B：t=7s 距上一条带栈(t=0)已 ≥5s → 窗口放行，再打一条带栈
    await vi.advanceTimersByTimeAsync(5000);
    await send(); // t=7s
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();

    // 阶段 C：连续不间断 burst（每 1s 一条，均距上一条带栈 <5s → 抑制），
    // 距 burst 起点 30s 时触发唯一一条汇总；汇总后计数重置，30s 内不再汇总
    errorSpy.mockClear();
    warnSpy.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    await send(); // t=12s：带栈（新 burst 起点，距上一条带栈 5s → 放行）
    expect(errorSpy).toHaveBeenCalledTimes(1);
    for (let i = 1; i <= 30; i += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      await send(); // t=8..37s：抑制；t=37s 距 burstStart 30s → 汇总
      if (i === 30) {
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0][0])).toContain('suppressed');
      }
    }
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await send(); // t=38s：抑制，距上次汇总 1s <30s → 不再汇总
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
