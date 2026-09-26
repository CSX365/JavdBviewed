import { describe, expect, it } from 'vitest';
import { RequestScheduler } from './requestScheduler';

/**
 * S1 B2 (cycle-14)：getRemainingCooldownMs —— 供调用方把重试延迟对齐 host 冷却到期，
 * 免「快重试入队后空等冷却」的消息往返。
 */

function makeScheduler(getNow: () => number, status: number) {
  const timers: Array<{ at: number; fn: () => void; fired: boolean }> = [];
  const fetchCalls: string[] = [];
  const fetchImpl = (async (input: any) => {
    fetchCalls.push(String(input));
    return new Response('x', { status });
  }) as unknown as typeof fetch;
  const setTimeoutImpl = ((fn: () => void, delay: number) => {
    const timer = { at: getNow() + delay, fn, fired: false };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const scheduler = new RequestScheduler({ fetchImpl, setTimeoutImpl, now: getNow });
  return { scheduler, timers, fetchCalls };
}

describe('RequestScheduler.getRemainingCooldownMs (S1 B2 cycle-14)', () => {
  it('无失败时返回 0', () => {
    const { scheduler } = makeScheduler(() => 1_000_000, 200);
    expect(scheduler.getRemainingCooldownMs('api.test')).toBe(0);
  });

  it('429 后剩余冷却 = 退避时长并随时间衰减，到期归 0', async () => {
    let nowMs = 1_000_000;
    const { scheduler, timers } = makeScheduler(() => nowMs, 429);

    const res = await scheduler.enqueue('https://api.test/one');
    expect(res.status).toBe(429);
    // 非 light 退避 base=30s：首次 429 后剩余冷却 ≈30s
    expect(scheduler.getRemainingCooldownMs('api.test')).toBeGreaterThan(29_000);
    expect(scheduler.getRemainingCooldownMs('api.test')).toBeLessThanOrEqual(30_000);

    nowMs += 10_000;
    timers.forEach((t) => { if (!t.fired && t.at <= nowMs) { t.fired = true; t.fn(); } });
    expect(scheduler.getRemainingCooldownMs('api.test')).toBe(20_000);

    nowMs += 25_000;
    timers.forEach((t) => { if (!t.fired && t.at <= nowMs) { t.fired = true; t.fn(); } });
    expect(scheduler.getRemainingCooldownMs('api.test')).toBe(0);
  });

  it('异常（网络错误）触发 light 退避（base 10s），同样可查询', async () => {
    let nowMs = 1_000_000;
    const timers: Array<{ at: number; fn: () => void; fired: boolean }> = [];
    const fetchImpl = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const setTimeoutImpl = ((fn: () => void, delay: number) => {
      const timer = { at: nowMs + delay, fn, fired: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const scheduler = new RequestScheduler({ fetchImpl, setTimeoutImpl, now: () => nowMs });

    await expect(scheduler.enqueue('https://down.test/x')).rejects.toThrow('network down');
    expect(scheduler.getRemainingCooldownMs('down.test')).toBeGreaterThan(9_000);
    expect(scheduler.getRemainingCooldownMs('down.test')).toBeLessThanOrEqual(10_000);

    nowMs += 11_000;
    timers.forEach((t) => { if (!t.fired && t.at <= nowMs) { t.fired = true; t.fn(); } });
    expect(scheduler.getRemainingCooldownMs('down.test')).toBe(0);
  });
});
