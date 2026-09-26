/**
 * @file fetchWithTimeout.ts
 * @description Emby/JF 远端请求超时守卫：媒体库请求超时口径的单一事实源 + 单请求超时包装。
 * 背景：远端媒体库不可达（黑洞）时，裸 fetch 会挂到 TCP 层，UI 侧遮罩/按钮永久等待。
 * @module features/embyLibrary
 */

/** 媒体库远端请求超时（毫秒）。对齐既有同步路径口径：大库/穿透代理 15s 偏紧。 */
export const EMBY_LIBRARY_REQUEST_TIMEOUT_MS = 45_000;

/** 超时统一文案（对齐既有同步路径「连接超时」，UI 侧可据此识别连接类失败）。 */
export const EMBY_FETCH_TIMEOUT_MESSAGE = '连接超时';

/**
 * 单请求超时包装：到点 abort 并抛出 Error(连接超时)。
 * 即使注入的 fetchImpl 忽略 signal，计时器也会兜底 reject，调用方不会无限悬挂。
 */
export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number = EMBY_LIBRARY_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = controller?.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(EMBY_FETCH_TIMEOUT_MESSAGE));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(url, { ...init, ...(signal ? { signal } : {}) }),
      deadline,
    ]);
  } catch (e: any) {
    if (signal?.aborted) {
      controller?.abort();
      throw new Error(EMBY_FETCH_TIMEOUT_MESSAGE);
    }
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
