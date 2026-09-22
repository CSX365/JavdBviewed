import { describe, expect, it } from 'vitest';
import { RequestScheduler } from './requestScheduler';

interface FakeTimer {
  atMs: number;
  fired: boolean;
  fire: () => void;
}

function createScheduler() {
  let nowMs = 1_000_000;
  const timers: FakeTimer[] = [];
  const fetchCalls: string[] = [];
  const fetchImpl = (async (input: any) => {
    const url = String(input);
    fetchCalls.push(url);
    return new Response('{}', { status: fetchCalls.length === 1 ? 429 : 200 });
  }) as unknown as typeof fetch;
  const setTimeoutImpl = ((fn: () => void, delay: number) => {
    const timer: FakeTimer = {
      atMs: nowMs + delay,
      fired: false,
      fire: () => {
        if (!timer.fired) {
          timer.fired = true;
          fn();
        }
      },
    };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const scheduler = new RequestScheduler({
    config: { globalMaxConcurrent: 4, perHostMaxConcurrent: 1, perHostRateLimitPerMin: 12 },
    fetchImpl,
    setTimeoutImpl,
    now: () => nowMs,
  });
  const advance = (ms: number) => {
    nowMs += ms;
    timers
      .filter((timer) => timer.atMs <= nowMs && !timer.fired)
      .sort((a, b) => a.atMs - b.atMs)
      .forEach((timer) => timer.fire());
  };
  return { scheduler, advance, timers, fetchCalls };
}

describe('RequestScheduler host backoff wake', () => {
  it('schedules a wake timer when a queued host enters cooldown instead of stalling', async () => {
    const { scheduler, advance, timers, fetchCalls } = createScheduler();

    const first = scheduler.enqueue('https://api.test/one');
    await first;
    expect(fetchCalls).toEqual(['https://api.test/one']);

    const second = scheduler.enqueue('https://api.test/two');
    // 429 触发 30s 退避，队列中的同 host 任务必须安排 wake，否则退避结束前无人唤醒
    expect(timers.length).toBeGreaterThanOrEqual(1);

    advance(5_000);
    expect(fetchCalls).toEqual(['https://api.test/one']);
    expect(timers.some((timer) => timer.atMs > 1_005_000)).toBe(true);

    advance(25_001);
    await second;
    expect(fetchCalls).toEqual(['https://api.test/one', 'https://api.test/two']);
    expect((await second).status).toBe(200);
  });

  it('keeps queued tasks waiting across wake fires until the cooldown truly expires', async () => {
    const { scheduler, advance, timers, fetchCalls } = createScheduler();

    const first = scheduler.enqueue('https://api.test/one');
    await first;
    const second = scheduler.enqueue('https://api.test/two');

    advance(29_999);
    expect(fetchCalls).toEqual(['https://api.test/one']);

    advance(1);
    await second;
    expect(fetchCalls).toEqual(['https://api.test/one', 'https://api.test/two']);
    expect(timers.length).toBeGreaterThanOrEqual(2);
  });
});

describe('RequestScheduler default timer receiver', () => {
  it('默认 setTimeoutImpl 必须以 globalThis 为接收者调用（SW realm receiver 检查）', async () => {
    // 回归：SW 中 this.setTimeoutImpl(...) 解引用裸全局 setTimeout 会抛
    // TypeError: Illegal invocation（receiver 检查）。此处用 spy 模拟该检查：
    // 接收者不是 globalThis 就抛同样的错。
    const original = globalThis.setTimeout;
    const calls: unknown[] = [];
    const spy = function (this: unknown) {
      calls.push(this);
      if (this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    } as unknown as typeof setTimeout;
    (globalThis as Record<string, unknown>).setTimeout = spy;
    try {
      const fetchImpl = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
      let nowMs = 2_000_000;
      const scheduler = new RequestScheduler({ fetchImpl, now: () => nowMs });
      const first = scheduler.enqueue('https://wake.test/one');
      await first; // 429 -> 30s 退避
      const second = scheduler.enqueue('https://wake.test/two');
      second.catch(() => undefined); // 等待唤醒，测试不推进真实时间
      expect(calls.length).toBeGreaterThanOrEqual(1);
      for (const received of calls) {
        expect(received).toBe(globalThis);
      }
    } finally {
      (globalThis as Record<string, unknown>).setTimeout = original;
    }
  });
});
