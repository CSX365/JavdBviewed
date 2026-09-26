/**
 * @file networkMessageHandlers.ts
 * @description 网络请求消息处理器 —— 外部数据抓取、JavBus AJAX、封面获取
 * @module apps/background
 */
import { fetchJavbusAjaxViaTab } from '../../platform/browser/javbusTabFetch';
import { readBodyPrefix } from '../../platform/network/bodyPrefix';
import { requestScheduler as defaultRequestScheduler } from '../../platform/network/requestScheduler';

type SendResponse = (response: any) => void;  // chrome.runtime 消息回调类型

export interface RequestSchedulerLike {
  enqueue: (url: string, init?: RequestInit) => Promise<Response>;  // 按调度策略排队发起请求
  /** S1 B2 (cycle-14)：可选，返回 host 剩余冷却 ms（供失败响应回传调用方对齐重试） */
  getRemainingCooldownMs?: (host: string) => number;
}

/** 取 URL 的 host（解析失败返回空串），用于 B2 的冷却查询与错误日志限速分组 */
function fetchHostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** S1 B2 (cycle-14)：外部 fetch 错误日志限速状态（按 host） */
interface FetchErrorLogEntry {
  lastErrorAt: number;    // 上一条错误（无论放行/抑制）的时刻
  burstStartAt: number;   // 当前抑制 burst 起点（最近一条带栈放行）
  suppressed: number;     // 自 burst 起点累计被抑制的错误数
}
const fetchErrorLogState = new Map<string, FetchErrorLogEntry>();
const FETCH_ERROR_LOG_WINDOW_MS = 5_000;   // 同 host 距上一条错误 <5s 时不放行带栈日志
const FETCH_ERROR_LOG_SUMMARY_MS = 30_000; // 抑制 burst 持续 30s 至多补一条汇总（重置后同理）

/** 限速后的错误日志：同 host 距上一条错误 <5s 的连续 burst 只放行首条 console.error（带栈），
 *  后续抑制计数，burst 持续满 30s 补一条 warn 汇总（重置计数，30s 内不重复）。
 *  只改日志频率，请求行为不变。 */
function logExternalFetchError(host: string, error: unknown): void {
  const now = Date.now();
  const entry = fetchErrorLogState.get(host);
  if (!entry || now - entry.lastErrorAt >= FETCH_ERROR_LOG_WINDOW_MS) {
    console.error('[Background] Failed to fetch external data:', error);
    fetchErrorLogState.set(host, { lastErrorAt: now, burstStartAt: now, suppressed: 0 });
    return;
  }
  entry.suppressed += 1;
  entry.lastErrorAt = now;
  if (now - entry.burstStartAt >= FETCH_ERROR_LOG_SUMMARY_MS) {
    console.warn(`[Background] Failed to fetch external data: suppressed ${entry.suppressed} recent errors in 30s (host=${host})`);
    entry.burstStartAt = now;
    entry.suppressed = 0;
  }
}

/**
 * 处理外部数据抓取消息 —— 通过请求调度器 fetch 任意 URL
 * 支持 text/json/blob 三种响应类型，自动 abort 超时
 * S1 B2 (cycle-14)：可选 firstByteTimeoutMs 首字节快速失败；失败响应附 cooldownMs 供调用方对齐重试；
 * 错误日志按 host 限速（5s 首条带栈 / 30s 至多一条汇总）
 */

export async function handleExternalDataFetch(
  message: any,
  sendResponse: SendResponse,
  requestScheduler: RequestSchedulerLike = defaultRequestScheduler,
): Promise<void> {
  // url 提升到 try 外：catch 里的日志限速分组与冷却查询也要用它
  const url = message?.url;
  try {
    const options = (message?.options || {}) as any;
    if (!url) {
      sendResponse({ success: false, error: 'No URL provided' });
      return;
    }
    const responseType = options.responseType || 'text';

    const controller = new AbortController();
    const timeoutMs = typeof options.timeout === 'number' ? options.timeout : 10000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // S1 B2 (cycle-14): 首字节快速失败——响应头到达前超时即 abort，不再空挂全程超时（轻量探测判败提速）
    const firstByteTimeoutMs = typeof options.firstByteTimeoutMs === 'number' ? options.firstByteTimeoutMs : 0;
    let firstByteTimer: ReturnType<typeof setTimeout> | null = null;
    if (firstByteTimeoutMs > 0) {
      firstByteTimer = setTimeout(() => controller.abort('no-first-byte'), firstByteTimeoutMs);
    }

    const reqInit: RequestInit = {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      signal: controller.signal,
      ...(typeof options.referrer === 'string' ? { referrer: options.referrer } : {}),
    };

    const response = await requestScheduler.enqueue(url, reqInit);
    if (firstByteTimer) {
      clearTimeout(firstByteTimer);
      firstByteTimer = null;
    }
    const maxBodyBytes = typeof options.maxBodyBytes === 'number' ? Math.floor(options.maxBodyBytes) : 0;
    let data: any;
    if (responseType === 'json') data = await response.json().catch(() => null);
    else if (responseType === 'blob') data = await response.blob();
    else if (maxBodyBytes > 0) data = await readBodyPrefix(response, maxBodyBytes);
    else data = await response.text();
    const headersObj: Record<string, string> = {};
    try { response.headers.forEach((v, k) => { headersObj[k] = v; }); } catch {}
    clearTimeout(timer);
    sendResponse({ success: true, data, status: response.status, headers: headersObj });
  } catch (error: any) {
    // S1 B2 (cycle-14): 日志限速（同 host 5s 仅首条带栈，30s 至多一条汇总）
    logExternalFetchError(fetchHostOf(url), error);
    // 回传该 host 剩余冷却，调用方据此对齐重试延迟（不削弱重试次数与成功路径）
    let cooldownMs = 0;
    try {
      cooldownMs = requestScheduler.getRemainingCooldownMs?.(fetchHostOf(url)) ?? 0;
    } catch {
      cooldownMs = 0;
    }
    sendResponse({
      success: false,
      error: error.message,
      ...(cooldownMs > 0 ? { cooldownMs } : {}),
    });
  }
}

/**
 * 通过注入 content script 到 JavBus 页面抓取 AJAX 数据（规避 CORS）
 */
export async function handleFetchJavbusAjaxViaTab(message: any, sendResponse: SendResponse): Promise<void> {
  try {
    const pageUrl = String(message?.pageUrl || '');
    const timeoutMs = typeof message?.timeoutMs === 'number' ? message.timeoutMs : 15000;
    if (!/^https:\/\/(?:www\.)?javbus\.com\/[^/?#]+/i.test(pageUrl)) {
      sendResponse({ success: false, error: 'Invalid JAVBUS page URL' });
      return;
    }

    const result = await fetchJavbusAjaxViaTab(pageUrl, timeoutMs);
    sendResponse({ success: result.success, data: result, error: result.error });
  } catch (error: any) {
    console.error('[Background] JAVBUS tab ajax fetch failed:', error);
    sendResponse({ success: false, error: error?.message || String(error) });
  }
}

/**
 * 从 BlogJav 网站抓取番号封面图
 * 搜索匹配番号后返回第一张封面图片 URL
 */
export async function handleFetchExternalCover(
  message: any,
  sendResponse: SendResponse,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    const { code } = message || {};
    if (!code) {
      sendResponse({ success: false, error: 'No code provided' });
      return;
    }

    const searchUrl = `https://blogjav.net/search?q=${encodeURIComponent(code)}`;
    const res = await fetchImpl(searchUrl);

    if (!res.ok) {
      sendResponse({ success: false, error: `Failed to fetch BlogJav: ${res.status}` });
      return;
    }

    const html = await res.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const resultItems = doc.querySelectorAll('.post-item, .search-result-item, .video-item');

    for (const item of resultItems) {
      const titleElement = item.querySelector('.title, .post-title, h2, h3');
      const title = titleElement?.textContent?.trim().toUpperCase() || '';

      if (title.includes(code.toUpperCase().replace(/[-\s]/g, ''))) {
        const img = item.querySelector('img');
        const imgSrc = img?.getAttribute('src') || img?.getAttribute('data-src');

        if (imgSrc) {
          let imageUrl = imgSrc;
          if (imgSrc.startsWith('//')) {
            imageUrl = 'https:' + imgSrc;
          } else if (imgSrc.startsWith('/')) {
            imageUrl = 'https://blogjav.net' + imgSrc;
          }

          sendResponse({ success: true, imageUrl });
          return;
        }
      }
    }

    sendResponse({ success: false, error: 'Cover image not found' });
  } catch (error: any) {
    console.error('[Background] Failed to fetch external cover:', error);
    sendResponse({ success: false, error: error.message });
  }
}
