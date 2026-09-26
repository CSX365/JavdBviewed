import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient, NetworkError } from './httpClient';

/**
 * S1 B2 (cycle-14)：HttpClient 重试延迟对齐 background 回传的 host 冷却
 * - 旧行为：失败后按 1s/2s/4s 指数退避立即重发，SW 侧仍需等 host 冷却到期（墙钟相同，多消息往返）
 * - 新行为：delay = max(2^n×1s, cooldownMs)；重试次数与成功路径不变
 */

function makeChromeStub(sendMessageImpl: (msg: any, cb: (resp: any) => void) => void) {
  return {
    runtime: {
      lastError: null,
      sendMessage: vi.fn(sendMessageImpl),
    },
  };
}

/** 强制走 background 代理路径（node 环境无真实 window/chrome） */
function forceBackground() {
  vi.stubGlobal('window', { location: { origin: 'https://javdb.com' } });
}

describe('HttpClient S1 B2 (cycle-14)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    forceBackground();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('重试延迟对齐 background 回传的 cooldownMs（不再 1s/2s 提前重发）', async () => {
    const sendMessage = vi.fn((_msg: any, cb: (r: any) => void) => {
      cb({ success: false, error: 'fetch failed', cooldownMs: 4000 });
    });
    vi.stubGlobal('chrome', makeChromeStub(sendMessage));
    const client = new HttpClient();

    const pending = client.get('https://slow.example.com/data', { retries: 2, timeout: 1000 })
      .catch((e: unknown) => e);

    expect(sendMessage).toHaveBeenCalledTimes(1); // 首次立即发起
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendMessage).toHaveBeenCalledTimes(1); // 旧行为此处已重试
    await vi.advanceTimersByTimeAsync(3000); // t=4000 = max(1s, 4s)
    expect(sendMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(sendMessage).toHaveBeenCalledTimes(2); // max(2s, 4s)=4s，未到期
    await vi.advanceTimersByTimeAsync(1); // t=8000
    expect(sendMessage).toHaveBeenCalledTimes(3);

    const err = await pending;
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).message).toContain('fetch failed');
    expect(sendMessage).toHaveBeenCalledTimes(3); // retries=2 → 共 3 次，次数不变
  });

  it('background 未回传 cooldownMs：保持旧 1s/2s 指数退避', async () => {
    const sendMessage = vi.fn((_msg: any, cb: (r: any) => void) => {
      cb({ success: false, error: 'x' });
    });
    vi.stubGlobal('chrome', makeChromeStub(sendMessage));
    const client = new HttpClient();

    const pending = client.get('https://slow.example.com/data', { retries: 2, timeout: 1000 })
      .catch((e: unknown) => e);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // t=1000
    expect(sendMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000); // t=3000
    expect(sendMessage).toHaveBeenCalledTimes(3);
    const err = await pending;
    expect(err).toBeInstanceOf(NetworkError);
  });

  it('成功路径只发一次请求，数据原样返回（不重试）', async () => {
    const sendMessage = vi.fn((_msg: any, cb: (r: any) => void) => {
      cb({ success: true, data: { ok: 1 }, status: 200 });
    });
    vi.stubGlobal('chrome', makeChromeStub(sendMessage));
    const client = new HttpClient();

    const data = await client.get('https://ok.example.com/data', { timeout: 1000 });
    expect(data).toEqual({ ok: 1 });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('firstByteTimeoutMs 透传到 background 代理请求（maxBodyBytes 共存）', async () => {
    const sendMessage = vi.fn((_msg: any, cb: (r: any) => void) => {
      cb({ success: true, data: '<html></html>', status: 200 });
    });
    vi.stubGlobal('chrome', makeChromeStub(sendMessage));
    const client = new HttpClient();

    await client.get('https://probe.example.com/page', {
      timeout: 8000,
      retries: 0,
      responseType: 'text',
      maxBodyBytes: 32768,
      firstByteTimeoutMs: 3000,
    });
    const msg = sendMessage.mock.calls[0][0] as any;
    expect(msg.type).toBe('fetch-external-data');
    expect(msg.options.firstByteTimeoutMs).toBe(3000);
    expect(msg.options.maxBodyBytes).toBe(32768);
  });

  it('未设 firstByteTimeoutMs 时不透传该字段', async () => {
    const sendMessage = vi.fn((_msg: any, cb: (r: any) => void) => {
      cb({ success: true, data: '<html></html>', status: 200 });
    });
    vi.stubGlobal('chrome', makeChromeStub(sendMessage));
    const client = new HttpClient();

    await client.get('https://probe.example.com/page', { timeout: 8000, responseType: 'text' });
    const msg = sendMessage.mock.calls[0][0] as any;
    expect(msg.options).not.toHaveProperty('firstByteTimeoutMs');
  });
});
