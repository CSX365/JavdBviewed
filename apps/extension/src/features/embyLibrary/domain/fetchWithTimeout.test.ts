/**
 * @file fetchWithTimeout.test.ts
 * @description 远端请求超时守卫：永不响应服务器（黑洞）必须落到超时，而不是无限悬挂
 * @module features/embyLibrary
 */
import { describe, expect, it, vi } from 'vitest';
import {
  EMBY_FETCH_TIMEOUT_MESSAGE,
  EMBY_LIBRARY_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
} from './fetchWithTimeout';

/** 永不 resolve 的 fetch；收到 abort 时像真实 fetch 一样 reject（AbortError） */
function hangingFetch(signal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

describe('fetchWithTimeout', () => {
  it('成功响应原样返回', async () => {
    const ok = new Response('{}', { status: 200 });
    const ret = await fetchWithTimeout(async () => ok, 'http://x/', undefined, 1000);
    expect(ret).toBe(ok);
  });

  it('超时后抛「连接超时」并 abort 在飞请求', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return hangingFetch(init?.signal);
    });
    const started = Date.now();
    await expect(fetchWithTimeout(fetchImpl as any, 'http://x/', { method: 'GET' }, 60))
      .rejects.toThrow(EMBY_FETCH_TIMEOUT_MESSAGE);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('快速网络错误原样抛出，不转成超时文案', async () => {
    const netErr = new TypeError('Failed to fetch');
    const fetchImpl = async () => {
      throw netErr;
    };
    await expect(fetchWithTimeout(fetchImpl as any, 'http://x/', undefined, 5000)).rejects.toBe(netErr);
  });

  it('请求完成后计时器清除，不迟到误伤', async () => {
    const ok = new Response('{}', { status: 200 });
    const ret = await fetchWithTimeout(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return ok;
    }, 'http://x/', undefined, 40);
    expect(ret.status).toBe(200);
    await new Promise((r) => setTimeout(r, 80));
  });

  it('超时口径为 45s（对齐媒体库既有请求口径）', () => {
    expect(EMBY_LIBRARY_REQUEST_TIMEOUT_MS).toBe(45000);
    expect(EMBY_FETCH_TIMEOUT_MESSAGE).toBe('连接超时');
  });
});
