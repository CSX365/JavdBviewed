/**
 * @file perfReplay.ts
 * @description cycle-10 受控复测基建：CDP 级页面响应缓存/回放（仅限性能测试使用）。
 *
 * 背景：本机直连源站 CDN 路由断，测量浏览器必须走代理 127.0.0.1:10808；cycle-9 曾因
 *   --no-proxy-server 硬编码导致全部测量窗封面图缺失（占位重排 + 无源布局风暴），
 *   sourceless 爆发与 control 臂漂移需受控复测重新归因。为把「反复打源站」降为
 *   「一次拉全、本地回放、最后真实验证」，本模块在浏览器内做响应缓存回放：
 *
 *   - record 模式（预热）：首轮 live 走通场景页，把 HTML/JS/JSON/封面/图片的响应
 *     落盘缓存（key=method+URL）；
 *   - replay 模式（正式矩阵/功能迭代）：命中缓存 → Fetch.fulfillRequest 直接回放
 *     （零源站压力、逐轮确定性）；未命中 → 放行 live 并计数（安全阀，可二次预热补全）。
 *
 * 机制（已实测验证，chromium-1243 + 本 build CDP 语义）：
 *   - 页面级 CDP 会话（context.newCDPSession(page)）上 Fetch.enable + Network.enable；
 *   - Fetch.requestPaused → 命中则 fulfillRequest（替换 body，页面拿到改后的内容）；
 *   - 记录走 Network.requestWillBeSent（requestId→原始请求映射）+ Network.responseReceived
 *     + Network.getResponseBody（Fetch.responseReceived 在此 build 的 flatten 会话不触发，勿用）；
 *   - SW target 的网络事件路由未验证 → SW 流量（115/Emby/cloud 同步）两臂一致 live 直通，
 *     不计入回放统计（共同因子，量小）。
 *
 * 缓存文件格式：<cacheDir>/<key前2位>/<key>.json
 *   { m: method, u: url, s: status, h: [[name,value],...], b: <body base64> }
 * 铁律：只服务 .test-profiles 下的测量浏览器；不影响功能代码与 dist。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BrowserContext, CDPSession, Page } from '@playwright/test';

export type ReplayMode = 'record' | 'replay';

export interface ReplayOptions {
  cacheDir: string;
  mode: ReplayMode;
  /** 单资源缓存上限（字节），超过不记录（大视频等直通 live） */
  maxRecordBytes?: number;
  log?: (msg: string) => void;
}

export interface ReplayStats {
  intercepted: number;
  hits: number;
  misses: number;
  recorded: number;
  /** record 模式：缓存已存在（first-write-wins 跳过写入）*/
  duplicates: number;
  recordFail: number;
  hitBytes: number;
  recordBytes: number;
  /** replay 模式下放行的 miss URL（去重，最多 50 条） */
  missedUrls: string[];
}

interface CachedEntry {
  m: string;
  u: string;
  s: number;
  h: [string, string][];
  b: string; // base64
  /** 新记录恒为 'b64'；历史缓存缺省（内容自判断） */
  enc?: 'b64';
}

/** 不参与回放的 scheme（扩展自身资源/浏览器内部） */
function isReplayable(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('http://') || url.startsWith('https://')) return true;
  return false;
}

function cacheKey(method: string, url: string): string {
  return crypto.createHash('sha1').update(`${method} ${url}`).digest('hex');
}

function cacheEntryPath(cacheDir: string, key: string): string {
  return path.join(cacheDir, key.slice(0, 2), `${key}.json`);
}

const SKIP_HEADERS = new Set([
  'set-cookie', 'set-cookie2', 'connection', 'keep-alive', 'transfer-encoding', 'content-length',
]);

/** 归一化缓存 body 为 base64（fulfillRequest.body 只收 base64，非 base64 会被 CDP schema 校验拒：
 *  "Protocol error (Fetch.fulfillRequest): Invalid parameters"）。
 *  历史缓存两种格式混存：record 路径存过解码后原文（文本响应），captureDocument 路径存 base64；
 *  knownB64=true 直接信任，否则按内容判断（真实文本几乎必含 base64 字母表外字符）。 */
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function toBase64Body(b: string, knownB64 = false): string {
  if (knownB64) return b;
  if (b.length % 4 === 0 && b.length > 0 && B64_RE.test(b)) return b;
  return Buffer.from(b, 'utf8').toString('base64');
}

/** CDP 不允许响应头值含控制字符（实测 Cloudflare 的 server-timing/vary 值带真实换行符），
 *  直接 fulfillRequest 会被 schema 校验拒（Invalid parameters，仅主文档中招）。存盘与回放前统一清洗。 */
function cleanHeaderPair(name: string, value: string): [string, string] {
  return [name, value.replace(/[\x00-\x1f\x7f]/g, ' ')];
}

export class ReplaySession {
  private readonly opts: ReplayOptions;
  private readonly stats: ReplayStats = {
    intercepted: 0, hits: 0, misses: 0, recorded: 0, duplicates: 0, recordFail: 0,
    hitBytes: 0, recordBytes: 0, missedUrls: [],
  };
  private readonly mem = new Map<string, CachedEntry | null>(); // null=已查过磁盘且无
  private readonly reqInfo = new Map<string, { key: string; method: string; url: string }>();
  private closed = false;
  /** record 模式并发写保护：同 key 只写一次 */
  private readonly writing = new Set<string>();
  private readonly lastStatus = new Map<string, number>();
  private readonly lastHeaders = new Map<string, [string, string][]>();

  constructor(
    private readonly cdp: CDPSession,
    opts: ReplayOptions,
    private readonly label: string,
    private readonly page: Page,
  ) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    await this.cdp.send('Network.enable');
    await this.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }], handleAuthRequests: false });
    this.cdp.on('Fetch.requestPaused', this.onRequestPaused);
    this.cdp.on('Network.requestWillBeSent', this.onRequestWillBeSent);
    this.cdp.on('Network.responseReceived', this.onResponseReceived);
    this.cdp.on('Network.loadingFinished', this.onLoadingFinished);
    // Fetch.responseReceived 不在本 Playwright 版 CDPSession 的类型事件表里，走通用 event 通道过滤
    this.cdp.on('event', (data: { method: string; params?: Object }) => {
      if (data.method === 'Fetch.responseReceived' && data.params) {
        const params = data.params as Record<string, unknown>;
        this.onFetchResponseReceived(params as {
          requestId: string;
          response: { status: number; headers: Record<string, string>; url: string };
        });
      }
    });
  }

  getStats(): ReplayStats {
    return { ...this.stats, missedUrls: [...this.stats.missedUrls] };
  }

  sessionLabel(): string {
    return this.label;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.cdp.detach();
    } catch { /* 页面已关 */ }
  }

  private async readCache(key: string): Promise<CachedEntry | null> {
    const hit = this.mem.get(key);
    if (hit !== undefined) return hit;
    let entry: CachedEntry | null = null;
    try {
      const raw = fs.readFileSync(cacheEntryPath(this.opts.cacheDir, key), 'utf8');
      entry = JSON.parse(raw) as CachedEntry;
    } catch { entry = null; }
    this.mem.set(key, entry);
    return entry;
  }

  private writeCache(key: string, entry: CachedEntry): void {
    if (this.writing.has(key)) return;
    this.writing.add(key);
    try {
      const file = cacheEntryPath(this.opts.cacheDir, key);
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(entry));
        this.stats.recorded += 1;
        this.stats.recordBytes += Buffer.byteLength(entry.b, 'base64');
      } else {
        this.stats.duplicates += 1;
      }
      this.mem.set(key, entry);
    } catch (e) {
      this.stats.recordFail += 1;
      this.opts.log?.(`[replay:${this.label}] 缓存写入失败 ${key.slice(0, 12)}: ${String(e).slice(0, 80)}`);
    }
  }

  private readonly onRequestWillBeSent = (p: { requestId: string; request: { url: string; method: string } }): void => {
    if (!isReplayable(p.request.url)) return;
    this.reqInfo.set(p.requestId, {
      key: cacheKey(p.request.method, p.request.url),
      method: p.request.method,
      url: p.request.url,
    });
  };

  private readonly onRequestPaused = (p: { requestId: string; request: { url: string; method: string } }): void => {
    const { requestId, request } = p;
    if (!isReplayable(request.url)) {
      void this.cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    this.stats.intercepted += 1;
    const key = cacheKey(request.method, request.url);
    // 主文档映射兜底：主文档导航的 requestWillBeSent 可能因 Network.enable 竞态漏收
    // （实测预热轮 17 个页面 HTML 全部漏录、子资源正常），paused 事件自带完整请求信息，可补映射
    if (!this.reqInfo.has(requestId)) {
      this.reqInfo.set(requestId, { key, method: request.method, url: request.url });
    }
    void this.readCache(key).then(async (entry) => {
      if (this.opts.mode === 'replay' && entry) {
        this.stats.hits += 1;
        const bodyB64 = toBase64Body(entry.b, entry.enc === 'b64');
        this.stats.hitBytes += Buffer.byteLength(bodyB64, 'base64');
        const headers = (entry.h ?? [])
          .filter(([n]) => !SKIP_HEADERS.has(n.toLowerCase()))
          .map(([name, value]) => {
            const [cn, cv] = cleanHeaderPair(name, value);
            return { name: cn, value: cv };
          });
        try {
          await this.cdp.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: entry.s || 200,
            responseHeaders: headers,
            body: bodyB64,
          });
          return;
        } catch (e) {
          // fulfill 失败（页面已取消等）→ 放行 live 兜底
          this.stats.misses += 1;
          void this.cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
          this.opts.log?.(`[replay:${this.label}] fulfill 失败改放行: ${request.url.slice(0, 80)} ${String(e).slice(0, 60)}`);
          return;
        }
      }
      // miss（或 record 模式）→ 放行 live
      this.stats.misses += 1;
      if (this.opts.mode === 'replay' && this.stats.missedUrls.length < 50 && !this.stats.missedUrls.includes(request.url)) {
        this.stats.missedUrls.push(request.url);
      }
      void this.cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
    });
  };

  /** body 落盘（loadingFinished / responseReceived 两路共用，first-write-wins 去重） */
  private captureBody(requestId: string): void {
    if (this.opts.mode !== 'record') return;
    const info = this.reqInfo.get(requestId);
    if (!info || !isReplayable(info.url)) return;
    void this.cdp.send('Network.getResponseBody', { requestId }).then((r: { body: string; base64Encoded: boolean }) => {
      const maxBytes = this.opts.maxRecordBytes ?? 30 * 1024 * 1024;
      const bytes = r.base64Encoded ? Buffer.byteLength(r.body, 'base64') : Buffer.byteLength(r.body, 'utf8');
      if (bytes > maxBytes) return; // 大资源不缓存
      // headers 来自最近一次 responseReceived 的缓存（见 onResponseReceived 里存的 docHeaders）
      const headers = (this.lastHeaders.get(requestId) ?? []) as [string, string][];
      const status = this.lastStatus.get(requestId) ?? 200;
      this.writeCache(info.key, { m: info.method, u: info.url, s: status, h: headers, b: toBase64Body(r.body, r.base64Encoded), enc: 'b64' });
    }).catch((e: unknown) => {
      this.stats.recordFail += 1;
      this.opts.log?.(`[replay:${this.label}] Network.getResponseBody 失败 ${info.url.slice(0, 90)}: ${String(e).slice(0, 120)}`);
    });
  }

  /** record 模式兜底：主文档导航的 body 在网络服务侧可能取不到（commit 后销毁），
   *  用页面内同 URL fetch 拿原始 HTML（同会话 cookie，响应与导航请求一致）。调用时机：goto 完成后。 */
  async captureDocument(): Promise<void> {
    if (this.opts.mode !== 'record') return;
    const url = this.page.url();
    if (!isReplayable(url)) return;
    const key = cacheKey('GET', url);
    try {
      if (this.mem.get(key) === null || fs.existsSync(cacheEntryPath(this.opts.cacheDir, key))) return; // 已有
    } catch { /* 继续兜底 */ }
    try {
      const res = await this.page.evaluate(async (u: string) => {
        const r = await fetch(u, { credentials: 'include' });
        const text = await r.text();
        const h: [string, string][] = [];
        r.headers.forEach((v, k) => h.push([k, v]));
        return { status: r.status, headers: h, text };
      }, url);
      if (res.status < 200 || res.status >= 300 || !res.text) {
        this.opts.log?.(`[replay:${this.label}] 兜底 fetch 非 2xx：${url.slice(0, 80)} status=${res.status}`);
        return;
      }
      const entry: CachedEntry = { m: 'GET', u: url, s: res.status, h: res.headers.map(([n, v]) => cleanHeaderPair(n, String(v))), b: Buffer.from(res.text, 'utf8').toString('base64'), enc: 'b64' };
      this.writeCache(key, entry);
    } catch (e) {
      this.opts.log?.(`[replay:${this.label}] 兜底 fetch 失败 ${url.slice(0, 80)}: ${String(e).slice(0, 120)}`);
    }
  }

  private readonly onFetchResponseReceived = (p: {
    requestId: string;
    response: { status: number; headers: Record<string, string>; url: string };
  }): void => {
    if (this.opts.mode !== 'record') return;
    const info = this.reqInfo.get(p.requestId);
    if (!info || !isReplayable(p.response.url)) return;
    const maxBytes = this.opts.maxRecordBytes ?? 30 * 1024 * 1024;
    void this.cdp.send('Fetch.getResponseBody', { requestId: p.requestId }).then((r: { body: string; base64Encoded: boolean }) => {
      const bytes = r.base64Encoded ? Buffer.byteLength(r.body, 'base64') : r.body.length;
      if (bytes > maxBytes) return; // 大资源不缓存
      const headers: [string, string][] = Object.entries(p.response.headers ?? {}).map(([n, v]) => cleanHeaderPair(n, String(v)));
      this.writeCache(info.key, { m: info.method, u: info.url, s: p.response.status, h: headers, b: r.body });
    }).catch((e: unknown) => {
      this.stats.recordFail += 1;
      this.opts.log?.(`[replay:${this.label}] Fetch.getResponseBody 失败 ${info.url.slice(0, 90)}: ${String(e).slice(0, 120)}`);
    });
  };

  private readonly onResponseReceived = (p: {
    requestId: string;
    response: { status: number; headers: Record<string, string>; url: string };
  }): void => {
    if (this.opts.mode !== 'record') return;
    const info = this.reqInfo.get(p.requestId);
    if (!info || !isReplayable(p.response.url)) return;
    this.lastStatus.set(p.requestId, p.response.status);
    this.lastHeaders.set(p.requestId, Object.entries(p.response.headers ?? {}).map(([n, v]) => cleanHeaderPair(n, String(v))));
    // 小资源常在 responseReceived 时 body 已就绪；主文档大资源此时通常未就绪，
    // loadingFinished 路径会再取一次（first-write-wins 去重）
    this.captureBody(p.requestId);
  };

  private readonly onLoadingFinished = (p: { requestId: string }): void => {
    this.captureBody(p.requestId);
  };
}

export interface ReplayHandle {
  stats: () => { total: ReplayStats; perPage: { label: string; stats: ReplayStats }[] };
  /** 等指定页面的回放会话挂载完成（Fetch/Network enable 已生效）——goto 前 await，堵住主文档竞态 */
  awaitReady: (page: Page) => Promise<void>;
  /** record 模式：goto 完成后兜底补录主文档 HTML（导航 body 网络服务侧取不到时） */
  captureDocument: (page: Page) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * 给 context 内所有页面（含后续新开）挂回放会话。
 * 调用时机：context 就绪后、开任何场景页之前。
 */
export async function attachReplay(context: BrowserContext, opts: ReplayOptions): Promise<ReplayHandle> {
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  const sessions = new Map<Page, ReplaySession>();
  const readyMap = new Map<Page, Promise<void>>();
  // 统计聚合专用：页面关闭后 session 仍保留（旧实现从 map 删除 → 场景结束后 stats() 全零，
  // 预热轮已实证：393 个文件落盘但汇总 recorded=0）
  const allSessions: ReplaySession[] = [];

  const attachToPage = (page: Page, idx: number): void => {
    if (readyMap.has(page)) return;
    let settled = false;
    const ready = (async () => {
      try {
        const cdp = await context.newCDPSession(page);
        const session = new ReplaySession(cdp, opts, `p${idx}`, page);
        await session.start();
        sessions.set(page, session);
        allSessions.push(session);
      } catch (e) {
        opts.log?.(`[replay] 页面会话附着失败（忽略）: ${String(e).slice(0, 100)}`);
      } finally {
        settled = true;
      }
    })();
    readyMap.set(page, ready);
    page.once('close', () => {
      // 会话创建中则不追踪；已创建则关闭（allSessions 保留供统计）
      if (!settled) return;
      const s = sessions.get(page);
      if (s) { void s.close(); sessions.delete(page); }
    });
  };

  const pages = context.pages();
  pages.forEach((p, i) => attachToPage(p, i + 1));
  let nextIdx = pages.length;
  context.on('page', (p) => {
    nextIdx += 1;
    attachToPage(p, nextIdx);
  });

  return {
    stats: () => {
      const perPage = allSessions.map((s) => ({
        label: s.sessionLabel(),
        stats: s.getStats(),
      }));
      const total: ReplayStats = {
        intercepted: 0, hits: 0, misses: 0, recorded: 0, duplicates: 0, recordFail: 0,
        hitBytes: 0, recordBytes: 0, missedUrls: [],
      };
      for (const s of allSessions) {
        const st = s.getStats();
        total.intercepted += st.intercepted;
        total.hits += st.hits;
        total.misses += st.misses;
        total.recorded += st.recorded;
        total.duplicates += st.duplicates;
        total.recordFail += st.recordFail;
        total.hitBytes += st.hitBytes;
        total.recordBytes += st.recordBytes;
        for (const u of st.missedUrls) if (total.missedUrls.length < 50 && !total.missedUrls.includes(u)) total.missedUrls.push(u);
      }
      return { total, perPage };
    },
    awaitReady: (page: Page) => readyMap.get(page) ?? Promise.resolve(),
    captureDocument: async (page: Page) => {
      const s = sessions.get(page);
      if (s) await s.captureDocument();
    },
    close: async () => {
      for (const s of sessions.values()) await s.close().catch(() => {});
      sessions.clear();
    },
  };
}
