/**
 * @file perfS0VideoCensus.ts
 * @description cycle-11 S0-1 视频普查（独立检测脚本；不改 perfS0Profile.ts/perfReplay.ts，跑批禁区零触碰）。
 *
 * 背景：cycle-10 把「16 tab 稳态 1.5 核」归因为「15 路视频播放」，但代码侦察显示——
 *   扩展预览视频只在 hover（x-holding）时创建/播放；站点原生预览只在 fancybox 打开时播放；
 *   跑批脚本无任何鼠标模拟。归因未实锤。本普查用数据裁决：
 *   1) 每页 DOM 采样（2s 一次）：全部 <video> 的 src/paused/readyState/networkState/videoWidth/
 *      muted/volume/autoplay/loop/preload/id/class/父元素 —— 播放态是 world 无关的 ground truth；
 *   2) play/pause/load 猴子补丁（main world）：谁调用了 play，带调用栈；
 *      扩展（isolated world）的播放靠元素签名归类：class 含 x-preview-video=扩展预览，
 *      id=preview-video=站点原生，其余=未知；
 *   3) 每页媒体网络日志：fetch/XHR 命中 video|m3u8|mp4|preview|stream 的 URL（预载行为可见）；
 *   4) 浏览器级 CDP SystemInfo.getProcessInfo（2s 全进程 CPU 时间线）+ 每页 Performance.getMetrics
 *      （JsCpuTime/JSHeapUsedSize 差分）—— 核到底被哪个进程（renderer/GPU/browser/…）吃掉；
 *   5) 每页 longtask（main world PerformanceObserver 覆盖主线程全部长任务，含扩展 isolated world 执行）。
 *
 * 用法（两臂必须串行，两 Chrome 勿并行；DISPLAY=:12）：
 *   JAVDB_EXTENSION_PROFILE=.test-profiles/perf-s0 \
 *   pnpm tsx scripts/perfS0VideoCensus.ts --arm enhanced --tabs 16 --steady 150
 *   pnpm tsx scripts/perfS0VideoCensus.ts --arm control  --tabs 16 --steady 150
 *
 * 输出 <out>/census-<arm>/：
 *   video-census-<arm>.json     页面侧全量（samples/playCalls/net/longtasks…）
 *   -proc.jsonl                 浏览器级进程 CPU 时间线（2s 一帧）
 *   -tabmetrics.jsonl           每页 JsCpuTime/heap（2s 一帧）
 *   -procsample.json            SystemInfo.getProcessInfo 原始结构首帧（schema 存档）
 *   -summary.txt                人读汇总
 * 铁律：全程回放（replay 缓存），零源站压力；只读 .test-profiles；不 push。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page, Worker } from '@playwright/test';

import {
  readExtensionId,
  resolveExtensionHarnessOptions,
} from './extensionHarness';
import { attachReplay, type ReplayHandle } from './perfReplay';
import { extractVideoId } from '../apps/extension/src/shared/utils/videoId';
import { launchRealVisibilityContext } from './realVisibilityLaunch';

const CWD = path.resolve(import.meta.dirname, '..');
const SITE_LIST_URL = 'https://javdb570.com/search?q=test';
const REPLAY_DIR = process.env.JAVDB_E2E_REPLAY_DIR ?? '/tmp/c10s01/replay-cache';
const OUT_ROOT = '/tmp/c11s01';
/** 离线预览测试片（回放缓存内条目，页面同源）：外部预览源在测试环境不可达（javspyl 域名失效 / avpreview CF 质询），
 *  用 localStorage 预览缓存指向它，走扩展 loadVideoPreview 的缓存快捷路径，视频真实解码播放。 */
const PREVIEW_TEST_URL = 'https://javdb570.com/preview-test.mp4';

/** 与 perfS0Profile.ts ARM_SETTINGS 同口径（enhanced=用户真实增强开关，control=增强全关） */
const ARM_SETTINGS: Record<'enhanced' | 'control', Record<string, unknown>> = {
  enhanced: {
    userExperience: { enableActorEnhancement: true },
    videoEnhancement: { enabled: true, schedulingMode: 'smart' },
    listEnhancement: {
      enabled: true,
      enableVideoPreview: true,
      enableActorWatermark: true,
      hideBlacklistedActorsInList: true,
      showStatusBadge: true,
      enableStatusQuickAction: true,
      enableListFavoriteQuickAction: true,
    },
    libraryMatchStatus: { enabled: true, sources: { drive115: true, emby: true } },
    actorEnhancement: { enabled: true },
    emby: { recognitionEnabled: false, libraryEnabled: true },
  },
  control: {
    userExperience: { enableActorEnhancement: false },
    videoEnhancement: { enabled: false, schedulingMode: 'smart' },
    listEnhancement: {
      enabled: false,
      enableVideoPreview: false,
      enableActorWatermark: false,
      hideBlacklistedActorsInList: false,
      showStatusBadge: false,
      enableStatusQuickAction: false,
      enableListFavoriteQuickAction: false,
    },
    libraryMatchStatus: { enabled: false, sources: { drive115: false, emby: false } },
    actorEnhancement: { enabled: false },
    emby: { recognitionEnabled: false, libraryEnabled: false },
  },
};

interface Args {
  arm: 'enhanced' | 'control';
  tabs: number;
  steadySec: number;
  replayDir: string;
  outDir: string;
  staggerMs: number;
  proxy?: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (name: string, dflt: string): string => {
    const i = a.indexOf(`--${name}`);
    return i >= 0 && i + 1 < a.length ? a[i + 1] : dflt;
  };
  const arm = get('arm', 'enhanced');
  if (arm !== 'enhanced' && arm !== 'control') throw new Error(`--arm 只能 enhanced|control，收到 ${arm}`);
  return {
    arm,
    tabs: Number(get('tabs', '16')),
    steadySec: Number(get('steady', '150')),
    replayDir: get('replay', REPLAY_DIR),
    outDir: get('out', OUT_ROOT),
    staggerMs: Number(get('stagger', '250')),
    proxy: get('proxy', 'http://127.0.0.1:10808') || undefined,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (m: string): void => console.log(`[${new Date().toISOString()}] ${m}`);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

async function waitForExtensionServiceWorker(context: BrowserContext, timeoutMs: number): Promise<Worker> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const workers = context.serviceWorkers();
    const sw = workers.find((w) => w.url().startsWith('chrome-extension://')) ?? workers[0];
    if (sw) return sw;
    if (Date.now() >= deadline) throw new Error(`service worker 未在 ${timeoutMs}ms 内出现`);
    await sleep(300);
  }
}

function purgeServiceWorkerCache(userDataDir: string): void {
  const rel = path.relative(CWD, userDataDir);
  if (!rel || rel.startsWith('..') || !rel.startsWith('.test-profiles')) {
    throw new Error(`拒绝清除 SW 缓存：${userDataDir} 不在 .test-profiles 下（安全边界）`);
  }
  for (const sub of ['Default/Service Worker/ScriptCache', 'Default/Service Worker/Database']) {
    const dir = path.join(userDataDir, sub);
    if (!fs.existsSync(dir)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    log(`[guard] 已清除 SW 缓存：${path.relative(CWD, dir)}`);
  }
}

/** 回放缓存命中检查：key=sha1("GET "+url)，<key[:2]>/<key>.json */
function isCached(cacheDir: string, url: string): boolean {
  const key = crypto.createHash('sha1').update(`GET ${url}`).digest('hex');
  return fs.existsSync(path.join(cacheDir, key.slice(0, 2), `${key}.json`));
}

/**
 * 页面侧普查钩子（main world，字符串字面量注入——tsx/esbuild keepNames 会给
 * 打包函数注入 __name helper 引用，页面侧没有 → ReferenceError，必须纯字符串）。
 */
const CENSUS_HOOK_SRC = `(() => {
  if (window.__vc) return;
  const w = window;
  const t0 = performance.now();
  const d = {
    url: location.href,
    samples: [],
    playCalls: [],
    pauseCalls: [],
    loadCalls: [],
    net: [],
    hiddenLog: [],
    longTasks: [],
    ltTotal: 0,
    ltCount: 0,
    errors: [],
  };
  w.__vc = d;
  const cap = function (arr, n) { if (arr.length > n) arr.splice(0, arr.length - n); };
  const tail = function (s, n) { return String(s == null ? '' : s).slice(-n); };
  const stack = function () {
    try { return new Error().stack.split('\\n').slice(1, 9).map(function (s) { return s.trim(); }).join(' | '); }
    catch (e) { return ''; }
  };
  try {
    const V = HTMLVideoElement.prototype;
    const origPlay = V.play, origPause = V.pause, origLoad = V.load;
    V.play = function () {
      try {
        d.playCalls.push({ t: Math.round(performance.now() - t0), src: tail(this.currentSrc || this.src, 90), stack: stack() });
        cap(d.playCalls, 400);
      } catch (e) {}
      return origPlay.apply(this, arguments);
    };
    V.pause = function () {
      try {
        d.pauseCalls.push({ t: Math.round(performance.now() - t0), src: tail(this.currentSrc || this.src, 90) });
        cap(d.pauseCalls, 400);
      } catch (e) {}
      return origPause.apply(this, arguments);
    };
    V.load = function () {
      try {
        d.loadCalls.push({ t: Math.round(performance.now() - t0), src: tail(this.currentSrc || this.src, 90) });
        cap(d.loadCalls, 400);
      } catch (e) {}
      return origLoad.apply(this, arguments);
    };
  } catch (e) { d.errors.push('vpatch:' + e); }

  const isMedia = function (u) { return /m3u8|\\.mp4|\\.webm|video|preview|stream/i.test(u || ''); };
  try {
    const of = w.fetch;
    w.fetch = function (input, init) {
      try {
        const u = typeof input === 'string' ? input : (input && input.url) || '';
        if (isMedia(u)) { d.net.push({ k: 'fetch', t: Math.round(performance.now() - t0), u: tail(u, 140) }); cap(d.net, 400); }
      } catch (e) {}
      return of.apply(this, arguments);
    };
  } catch (e) { d.errors.push('fpatch:' + e); }
  try {
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      try { if (isMedia(u)) { d.net.push({ k: 'xhr', t: Math.round(performance.now() - t0), u: tail(u, 140) }); cap(d.net, 400); } } catch (e) {}
      return oo.apply(this, arguments);
    };
  } catch (e) { d.errors.push('xpatch:' + e); }

  const snap = function () {
    try {
      const vids = Array.from(document.querySelectorAll('video'));
      const row = {
        t: Math.round(performance.now() - t0),
        hidden: document.hidden,
        rs: document.readyState,
        n: vids.length,
        v: vids.map(function (el) {
          const pc = el.parentElement ? (el.parentElement.tagName + '.' + String(el.parentElement.className || '').slice(0, 40)) : '';
          return {
            s: tail(el.currentSrc || el.src || '', 90),
            p: el.paused ? 0 : 1,
            rs: el.readyState,
            ns: el.networkState,
            vw: el.videoWidth,
            m: el.muted ? 1 : 0,
            vol: Math.round(el.volume * 100),
            al: el.autoplay ? 1 : 0,
            lp: el.loop ? 1 : 0,
            pl: el.preload,
            id: el.id || '',
            c: String(el.className || '').slice(0, 60),
            par: pc,
          };
        }),
      };
      d.samples.push(row);
      cap(d.samples, 300);
    } catch (e) { d.errors.push('snap:' + e); }
  };
  snap();
  w.__vcTimer = window.setInterval(snap, 2000);
  w.addEventListener('visibilitychange', function () {
    try { d.hiddenLog.push({ t: Math.round(performance.now() - t0), hidden: document.hidden }); cap(d.hiddenLog, 100); } catch (e) {}
  });
  try {
    const po = new PerformanceObserver(function (list) {
      try {
        for (const en of list.getEntries()) {
          d.longTasks.push({ t: Math.round(en.startTime), dur: Math.round(en.duration) });
          d.ltTotal += en.duration;
          d.ltCount += 1;
        }
        cap(d.longTasks, 500);
      } catch (e) {}
    });
    po.observe({ type: 'longtask', buffered: true });
  } catch (e) { d.errors.push('lo:' + e); }
})();`;

interface VideoRow {
  s: string; p: number; rs: number; ns: number; vw: number; m: number;
  vol: number; al: number; lp: number; pl: string; id: string; c: string; par: string;
}
interface SampleRow { t: number; hidden: boolean; rs: string; n: number; v: VideoRow[]; }
interface PageDump {
  missing?: boolean;
  error?: string;
  url?: string;
  title?: string;
  hiddenNow?: boolean;
  readyState?: string;
  samples?: SampleRow[];
  playCalls?: { t: number; src: string; stack: string }[];
  pauseCalls?: { t: number; src: string }[];
  loadCalls?: { t: number; src: string }[];
  net?: { k: string; t: number; u: string }[];
  hiddenLog?: { t: number; hidden: boolean }[];
  longTasks?: { t: number; dur: number }[];
  ltTotal?: number;
  ltCount?: number;
  errors?: string[];
}

function classifyVideo(v: VideoRow): 'ext-preview' | 'site-native' | 'site-fancybox' | 'other' {
  if (typeof v.c === 'string' && v.c.includes('x-preview-video')) return 'ext-preview';
  if (v.id === 'preview-video') return 'site-native';
  if (typeof v.c === 'string' && v.c.includes('fancybox')) return 'site-fancybox';
  return 'other';
}

interface TabSummary {
  tab: number;
  url: string;
  missing?: boolean;
  error?: string | null;
  hiddenNow?: boolean | null;
  sampleCount?: number;
  finalVideoCount?: number;
  finalVideos?: { src: string; playing: boolean; rs: number; ns: number; vw: number; cls: string }[];
  playingSamples?: number;
  maxConcurrentPlaying?: number;
  playingSamplesByClass?: Record<string, number>;
  distinctSrcs?: { extPreview: string[]; site: string[]; other: string[] };
  playCallCount?: number;
  pauseCallCount?: number;
  loadCallCount?: number;
  playCallTopStacks?: { n: number; stack: string }[];
  mediaNetCount?: number;
  mediaNetDistinct?: number;
  mediaNetTop?: { n: number; u: string }[];
  longTaskCount?: number;
  longTaskTotalMs?: number;
  longTaskTop?: { t: number; dur: number }[];
  hiddenTransitions?: number;
  hookErrors?: string[];
}

function summarizeTab(idx: number, url: string, dump: PageDump): TabSummary {
  if (dump.missing) return { tab: idx, url, missing: true, error: dump.error ?? null };
  const samples = dump.samples ?? [];
  let maxConcurrent = 0;
  let playingSamples = 0;
  const playingByClass: Record<string, number> = {};
  for (const row of samples) {
    let playing = 0;
    for (const v of row.v) {
      if (v.p === 1 && v.rs >= 2) {
        playing += 1;
        const cls = classifyVideo(v);
        playingByClass[cls] = (playingByClass[cls] ?? 0) + 1;
      }
    }
    if (playing > 0) playingSamples += 1;
    if (playing > maxConcurrent) maxConcurrent = playing;
  }
  const playCalls = dump.playCalls ?? [];
  const extSrcs = new Set<string>();
  const siteSrcs = new Set<string>();
  const otherSrcs = new Set<string>();
  for (const row of samples) {
    for (const v of row.v) {
      const cls = classifyVideo(v);
      if (cls === 'ext-preview') extSrcs.add(v.s);
      else if (cls === 'site-native' || cls === 'site-fancybox') siteSrcs.add(v.s);
      else if (v.s) otherSrcs.add(v.s);
    }
  }
  const topStacks = new Map<string, number>();
  for (const c of playCalls) {
    if (!c.stack) continue;
    const key = c.stack.split(' | ').slice(0, 3).join(' | ');
    topStacks.set(key, (topStacks.get(key) ?? 0) + 1);
  }
  const last = samples[samples.length - 1];
  return {
    tab: idx,
    url,
    hiddenNow: dump.hiddenNow ?? null,
    sampleCount: samples.length,
    finalVideoCount: last?.n ?? 0,
    finalVideos: (last?.v ?? []).map((v) => ({ src: v.s, playing: v.p === 1 && v.rs >= 2, rs: v.rs, ns: v.ns, vw: v.vw, cls: classifyVideo(v) })),
    playingSamples,
    maxConcurrentPlaying: maxConcurrent,
    playingSamplesByClass: playingByClass,
    distinctSrcs: { extPreview: [...extSrcs], site: [...siteSrcs], other: [...otherSrcs] },
    playCallCount: playCalls.length,
    pauseCallCount: (dump.pauseCalls ?? []).length,
    loadCallCount: (dump.loadCalls ?? []).length,
    playCallTopStacks: [...topStacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => ({ n, stack: k })),
    mediaNetCount: (dump.net ?? []).length,
    mediaNetDistinct: new Set((dump.net ?? []).map((x) => x.u)).size,
    mediaNetTop: (() => {
      const m = new Map<string, number>();
      for (const x of dump.net ?? []) m.set(x.u, (m.get(x.u) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([u, n]) => ({ n, u }));
    })(),
    longTaskCount: dump.ltCount ?? 0,
    longTaskTotalMs: Math.round(dump.ltTotal ?? 0),
    longTaskTop: (dump.longTasks ?? []).slice().sort((a, b) => b.dur - a.dur).slice(0, 5),
    hiddenTransitions: (dump.hiddenLog ?? []).length,
    hookErrors: dump.errors ?? [],
  };
}

/** SystemInfo.cpuTime 单位=秒（protocol.d.ts: cumulative CPU usage in seconds） */
function coresFromSeconds(deltaSec: number, wallMs: number): number {
  const wallSec = wallMs / 1000;
  return wallSec > 0 ? deltaSec / wallSec : 0;
}

/** Performance.getMetrics 的 CPU 时间单位自适应：
 *  Chrome 149 起 JsCpuTime 被 ThreadTime 取代且单位为「秒」（旧 JsCpuTime 为 µs）。
 *  量级判定：原始差值 < 1e5 只可能是秒（1 核·秒 = 1e6 µs，µs 口径的最小有意义量级）；
 *  µs 口径若算出 >1024 核则按 ms 兜底。 */
function coresFromJsCpu(deltaRaw: number, wallMs: number): number {
  const wallSec = wallMs / 1000;
  if (wallSec <= 0) return 0;
  if (deltaRaw < 1e5) return deltaRaw / wallSec;
  const asUs = deltaRaw / 1e6 / wallSec;
  if (asUs <= 1024) return asUs;
  return deltaRaw / 1000 / wallSec;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const label = `census-${args.arm}`;
  const outDir = path.join(args.outDir, label);
  fs.mkdirSync(outDir, { recursive: true });
  log(`[${label}] 开始 tabs=${args.tabs} steady=${args.steadySec}s replay=${args.replayDir}`);

  const options = resolveExtensionHarnessOptions(process.env, CWD);
  purgeServiceWorkerCache(options.userDataDir);

  const { context, browser, cleanup } = await launchRealVisibilityContext(options, {
    headless: false,
    channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
    extraArgs: args.proxy ? [`--proxy-server=${args.proxy}`] : ['--no-proxy-server'],
  });
  if (args.proxy) log(`[${label}] 测量浏览器走代理：${args.proxy}`);
  log(`[${label}] real-visibility 模式就绪（手动 Chrome + CDP 代理）`);

  let finished = false;
  try {
    const extensionId = await readExtensionId(context, 30_000);
    const sw = await waitForExtensionServiceWorker(context, 30_000);
    const settings = ARM_SETTINGS[args.arm];
    // SW 启动路径（routeManagement 等）会一次性合并回写 settings，与我们的 set 存在竞态；
    // 重试至读回一致（初始化合并收敛后，我们的 set 成为终态）。
    let verified = false;
    for (let attempt = 1; attempt <= 6 && !verified; attempt += 1) {
      await sw.evaluate((data: Record<string, unknown>) => chrome.storage.local.set(data), { settings });
      await sleep(attempt * 400);
      const readBack = await sw.evaluate(() => chrome.storage.local.get('settings')) as { settings?: unknown };
      if (stableStringify(readBack?.settings) === stableStringify(settings)) {
        verified = true;
        if (attempt > 1) log(`[${label}] 设置第 ${attempt} 次写入后校验通过（前 ${attempt - 1} 次被 SW 初始化回写覆盖）`);
        break;
      }
    }
    if (!verified) throw new Error(`${args.arm} 臂设置读回不一致（重试 6 次仍失败），普查无效`);
    log(`[${label}] 设置已写入并校验（arm=${args.arm}）`);

    context.addInitScript(CENSUS_HOOK_SRC);

    const replay: ReplayHandle = await attachReplay(context, {
      cacheDir: args.replayDir,
      mode: 'replay',
      log: (m) => log(`[${label}] replay: ${m}`),
    });
    log(`[${label}] 回放已挂载（replay 模式）`);

    // --- 浏览器级 CDP：进程 CPU 时间线 ---
    let browserCdp: CDPSession | null = null;
    let procOk = true;
    const procTimelinePath = path.join(outDir, `census-${args.arm}-proc.jsonl`);
    const procFile = fs.openSync(procTimelinePath, 'a');
    try {
      browserCdp = await browser.newBrowserCDPSession();
      const probe = await browserCdp.send('SystemInfo.getProcessInfo', {});
      fs.writeFileSync(path.join(outDir, `census-${args.arm}-procsample.json`), `${JSON.stringify(probe, null, 2)}\n`);
      log(`[${label}] SystemInfo.getProcessInfo 可用，schema 已存档`);
    } catch (e) {
      procOk = false;
      log(`[${label}] SystemInfo.getProcessInfo 不可用，进程级采样降级：${errMsg(e)}`);
    }
    const closeProcFile = (): void => { try { fs.closeSync(procFile); } catch { /* 已关 */ } };

    const procFrame = async (): Promise<Record<string, number> | null> => {
      if (!browserCdp || !procOk) return null;
      try {
        const r = await browserCdp.send('SystemInfo.getProcessInfo', {});
        const byType: Record<string, number> = {};
        let total = 0;
        for (const p of r.processInfo ?? []) {
          const type = p.type || 'unknown';
          const cpu = typeof p.cpuTime === 'number' ? p.cpuTime : 0;
          byType[type] = (byType[type] ?? 0) + cpu;
          total += cpu;
        }
        const frame = { t: Date.now(), total, ...byType };
        fs.writeSync(procFile, `${JSON.stringify(frame)}\n`);
        return frame;
      } catch {
        return null;
      }
    };

    // --- 门卫页：收集详情链接（优先缓存命中的 URL，保证零 miss） ---
    const gate = await context.newPage();
    await replay.awaitReady(gate);
    let gateOk = false;
    try {
      await gate.goto(SITE_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      gateOk = true;
    } catch (e) {
      log(`[${label}] 门卫页加载失败：${errMsg(e)}`);
    }
    let detailUrls: string[] = [];
    if (gateOk) {
      const hrefs = await gate.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/v/"]')).map((a) => a.href),
      ).catch(() => [] as string[]);
      const seen = new Set<string>();
      const cached: string[] = [];
      for (const u of hrefs) {
        if (seen.has(u)) continue;
        seen.add(u);
        if (isCached(args.replayDir, u)) cached.push(u);
      }
      detailUrls = cached;
      // 门卫页 DOM 上只有 15 个缓存详情链接；--tabs 16 时活动（最后打开）tab 会落到列表页兜底，
      // 无封面/番号 → hover 预览无法触发。用回放缓存全量详情页 URL 补齐，保证活动 tab 是详情页。
      if (detailUrls.length < args.tabs) {
        const poolSeen = new Set(detailUrls);
        for (const shardDir of fs.readdirSync(args.replayDir)) {
          const shardPath = path.join(args.replayDir, shardDir);
          if (!fs.statSync(shardPath).isDirectory()) continue;
          for (const f of fs.readdirSync(shardPath)) {
            if (!f.endsWith('.json')) continue;
            try {
              const entry = JSON.parse(fs.readFileSync(path.join(shardPath, f), 'utf8')) as { u?: string };
              const u = entry.u;
              if (u && /\/v\//.test(u) && !poolSeen.has(u)) {
                poolSeen.add(u);
                detailUrls.push(u);
              }
            } catch { /* 坏条目跳过 */ }
          }
        }
        log(`[${label}] 缓存详情链接 ${cached.length} < ${args.tabs}，回放缓存全量池补齐至 ${detailUrls.length}`);
      }
      if (detailUrls.length < args.tabs) {
        log(`[${label}] 警告：可用详情 URL ${detailUrls.length} < ${args.tabs}，缺口仍用列表页兜底`);
      }
    }

    // --- 开 tab ---
    const pages: Page[] = [];
    const tabUrls: string[] = [];
    const tabCdp: CDPSession[] = [];
    const tabMetricsPath = path.join(outDir, `census-${args.arm}-tabmetrics.jsonl`);
    const tabMetricsFile = fs.openSync(tabMetricsPath, 'a');
    const closeTabMetrics = (): void => { try { fs.closeSync(tabMetricsFile); } catch { /* 已关 */ } };

    const openTab = async (url: string, isDetail: boolean): Promise<Page | null> => {
      const page = await context.newPage();
      const cs = await context.newCDPSession(page);
      await cs.send('Performance.enable').catch(() => {});
      tabCdp.push(cs);
      await replay.awaitReady(page);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch (e) {
        log(`[${label}] tab 加载失败 ${url}: ${errMsg(e)}`);
      }
      tabUrls.push(url);
      pages.push(page);
      if (isDetail && args.arm === 'enhanced') {
        await page.waitForSelector('#video-detail-preview-styles', { state: 'attached', timeout: 8_000 })
          .catch(() => log(`[${label}] 注意：${url.slice(-24)} 增强样式标记 8s 未出现`));
      }
      return page;
    };

    if (gateOk) await openTab(SITE_LIST_URL, false); // gate 本身留作列表参照 tab
    let opened = 0;
    for (let i = 0; i < args.tabs; i += 1) {
      const url = i < detailUrls.length ? detailUrls[i] : SITE_LIST_URL;
      await openTab(url, i < detailUrls.length);
      opened += 1;
      if (i < args.tabs - 1) await sleep(args.staggerMs);
    }
    log(`[${label}] ${opened + (gateOk ? 1 : 0)} tab 就绪（gate=列表参照）`);

    // --- 悬浮预览：详情页预览视频由 mouseenter 触发（previewDelay 默认 1s），
    //     自动化环境不动鼠标就是全静默 tab，测不出真实使用场景的 CPU。
    //     对当前可见（最后打开）tab 的封面做真实 hover，等预览视频真正 play。 ---
    if (args.arm === 'enhanced' && pages.length > 0) {
      const active = pages[pages.length - 1];
      try {
        // 扩展在编排器 idle/deferred 阶段才给封面挂 mouseenter（实测比 domcontentloaded 晚 ~1s，
        // 见 "Native cover preview enhanced" 日志）。过早 hover 会错过事件（mouseenter 不重发）。
        // x-preview 类在挂 listener 前一刻同步加上，可作挂接完成的标志。
        await active
          .waitForSelector('.column-video-cover.x-preview, .enhanced-cover-container', { timeout: 20_000 })
          .catch(() => log(`[${label}] 警告：预览挂接标记 20s 未出现，仍尝试 hover`));
        // 注入 localStorage 预览缓存（与扩展 extractVideoIdFromPage 同选择器/同提取器），
        // 让预览视频走缓存快捷路径真起播（外部预览源在测试环境不可达）。
        const rawCode = await active.evaluate(() => {
          const t =
            document.querySelector<HTMLElement>('h2.title.is-4 strong:first-child') ??
            document.querySelector<HTMLElement>('.panel-block.first-block .title.is-4');
          return t?.textContent?.trim() ?? '';
        }).catch(() => '');
        const videoCode = extractVideoId(rawCode);
        if (videoCode) {
          const payload: [string, string] = [videoCode, PREVIEW_TEST_URL];
          await active.evaluate(([code, url]: [string, string]) => {
            localStorage.setItem(`video_preview_${code}`, JSON.stringify({
              url, type: 'video/mp4', source: 'test', verifiedAt: Date.now(), failures: 0,
            }));
          }, payload);
          log(`[${label}] 预览缓存已注入 ${videoCode} -> ${PREVIEW_TEST_URL}`);
        } else {
          log(`[${label}] 警告：活动 tab 未提取到番号，预览缓存未注入`);
        }
        const cover = await active.$('.column-video-cover.x-preview, .enhanced-cover-container');
        if (cover) {
          await cover.hover({ timeout: 10_000 });
          log(`[${label}] 已悬浮活动 tab 封面，等预览视频起播（≤45s）…`);
          const started = await active
            .waitForFunction(
              () => {
                const v = document.querySelector('.column-video-cover video, .enhanced-cover-container video') as HTMLVideoElement | null;
                return v ? !v.paused : false;
              },
              undefined,
              { timeout: 45_000, polling: 500 },
            )
            .then(() => true)
            .catch(() => false);
          log(`[${label}] 预览视频${started ? '已起播，播放采样生效' : ' 45s 未起播，普查降级为静默 tab 基线（排查：预览源经代理是否可达）'}`);
        } else {
          log(`[${label}] 警告：活动 tab 未找到封面元素，预览无法触发`);
        }
      } catch (e) {
        log(`[${label}] hover 失败（普查降级为静默 tab 基线）：${errMsg(e)}`);
      }
    }

    // --- 稳态采样循环（2s 一帧：进程 CPU + 每页 ThreadTime/heap） ---
    const steadyStart = Date.now();
    const ticks = Math.round((args.steadySec * 1000) / 2000);
    let firstProc: Record<string, number> | null = null;
    let lastProc: Record<string, number> | null = null;
    for (let i = 0; i <= ticks; i += 1) {
      const frame = await procFrame();
      if (frame) {
        if (!firstProc) firstProc = frame;
        lastProc = frame;
      }
      const metricsRow: Record<string, number | string> = { t: Date.now() };
      for (let pi = 0; pi < pages.length; pi += 1) {
        try {
          const r = (await tabCdp[pi].send('Performance.getMetrics')) as {
            metrics: Array<{ name: string; value: number }>;
          };
          for (const m of r.metrics ?? []) {
            // Chrome 149 起 getMetrics 不再返回 JsCpuTime，改用 ThreadTime（渲染进程线程 CPU 总量，µs）
            if (m.name === 'JsCpuTime' || m.name === 'ThreadTime' || m.name === 'JSHeapUsedSize') metricsRow[`t${pi + 1}_${m.name}`] = m.value;
          }
        } catch { /* 页已关 */ }
      }
      fs.writeSync(tabMetricsFile, `${JSON.stringify(metricsRow)}\n`);
      if (i < ticks) await sleep(2000);
    }
    const steadyWallMs = Date.now() - steadyStart;

    // --- 页面侧全量 dump ---
    const dumps: PageDump[] = [];
    for (let i = 0; i < pages.length; i += 1) {
      const dump = await pages[i].evaluate(() => {
        const d = (window as unknown as { __vc?: unknown }).__vc;
        if (!d) return { missing: true } as PageDump;
        const out = { ...(d as Record<string, unknown>) } as PageDump;
        out.url = location.href;
        out.title = document.title.slice(0, 80);
        out.hiddenNow = document.hidden;
        out.readyState = document.readyState;
        return out;
      }).catch((e) => ({ missing: true, error: errMsg(e) }) as PageDump);
      dumps.push(dump);
    }

    const replayStats = replay.stats();
    const summary: TabSummary[] = dumps.map((d, i) => summarizeTab(i + 1, tabUrls[i], d));

    // --- 进程级汇总 ---
    const procSummary: Record<string, unknown> = { procOk };
    if (firstProc && lastProc && steadyWallMs > 0) {
      const deltaTotal = (lastProc.total ?? 0) - (firstProc.total ?? 0);
      const types = new Set([...Object.keys(firstProc), ...Object.keys(lastProc)]);
      const byTypeCores: Record<string, number> = {};
      for (const t of types) {
        if (t === 'total' || t === 't') continue; // t 为帧时间戳键，不是进程类型
        byTypeCores[t] = coresFromSeconds((lastProc[t] ?? 0) - (firstProc[t] ?? 0), steadyWallMs);
      }
      procSummary.steadyWallMs = steadyWallMs;
      procSummary.coresTotal = coresFromSeconds(deltaTotal, steadyWallMs);
      procSummary.coresByType = byTypeCores;
      procSummary.firstFrame = firstProc;
      procSummary.lastFrame = lastProc;
    }

    // --- tabmetrics 汇总（JsCpuTime 首末差） ---
    const tabCpuSummary: Record<string, unknown>[] = [];
    {
      const lines = fs.readFileSync(tabMetricsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, number | string>);
      for (let pi = 0; pi < pages.length; pi += 1) {
        const keyThread = `t${pi + 1}_ThreadTime`;
        const keyJs = `t${pi + 1}_JsCpuTime`;
        const keyHeap = `t${pi + 1}_JSHeapUsedSize`;
        const has = (l: Record<string, number | string>): boolean => typeof l[keyThread] === 'number' || typeof l[keyJs] === 'number';
        const first = lines.find(has);
        const last = [...lines].reverse().find(has);
        if (first && last) {
          const useThread = typeof first[keyThread] === 'number';
          const fKey = useThread ? keyThread : keyJs;
          const delta = (last[fKey] as number) - (first[fKey] as number);
          tabCpuSummary.push({
            tab: pi + 1,
            cpuMetric: useThread ? 'ThreadTime' : 'JsCpuTime',
            jsCpuDeltaRaw: delta,
            jsCpuCores: coresFromJsCpu(delta, steadyWallMs),
            jsHeapFirst: first[keyHeap] ?? null,
            jsHeapLast: last[keyHeap] ?? null,
          });
        }
      }
    }

    const payload = {
      meta: {
        label,
        arm: args.arm,
        gitSha: '137ac2524',
        tabs: args.tabs,
        steadySec: args.steadySec,
        steadyWallMs,
        replay: args.replayDir,
        capturedAt: new Date().toISOString(),
        note: 't 为页面内 performance.now()（各 tab 相对自身文档）；proc/tabmetrics 的 t 为 epoch ms。per-tab CPU 用 ThreadTime 差分（Chrome 149 已移除 JsCpuTime，ThreadTime=渲染进程线程 CPU 总量 µs，口径比原 JsCpuTime 略宽含 IO 线程）；差分相对值有效。',
      },
      replayStats: {
        total: replayStats.total,
        missedUrls: replayStats.total.missedUrls.slice(0, 20),
      },
      tabs: summary,
      tabCpu: tabCpuSummary,
      proc: procSummary,
      dumps,
    };
    fs.writeFileSync(path.join(outDir, `video-census-${args.arm}.json`), `${JSON.stringify(payload, null, 2)}\n`);

    // --- 人读汇总 ---
    const lines: string[] = [];
    lines.push(`== ${label} 稳态 ${Math.round(steadyWallMs / 1000)}s 汇总 ==`);
    lines.push(`浏览器总核（全部进程 CPU 时间差分）：${procSummary.coresTotal !== undefined ? Number(procSummary.coresTotal).toFixed(3) : 'n/a'} 核`);
    for (const [t, c] of Object.entries(procSummary.coresByType ?? {})) lines.push(`  ${t}: ${Number(c).toFixed(3)} 核`);
    lines.push('');
    lines.push('per-tab：');
    for (const s of summary) {
      if (s.missing) { lines.push(`  tab${s.tab} [${s.url}] dump 缺失: ${s.error}`); continue; }
      const cpu = tabCpuSummary[s.tab - 1];
      lines.push(
        `  tab${s.tab} [hidden=${s.hiddenNow}] ${String(s.url).slice(-28)} `
        + `| playingSamples=${s.playingSamples}/${s.sampleCount} maxConc=${s.maxConcurrentPlaying} `
        + `play()=${s.playCallCount} load()=${s.loadCallCount} mediaNet=${s.mediaNetCount} `
        + `lt=${s.longTaskCount}/${s.longTaskTotalMs}ms `
        + `jsCpu=${cpu ? Number(cpu.jsCpuCores).toFixed(3) + '核' : 'n/a'}`,
      );
      if (s.finalVideoCount) {
        for (const v of s.finalVideos ?? []) {
          lines.push(`      video ${v.playing ? 'PLAYING' : 'paused '} [${v.cls}] rs=${v.rs} ns=${v.ns} vw=${v.vw} src=${v.src}`);
        }
      }
      if (s.distinctSrcs && (s.distinctSrcs.extPreview.length || s.distinctSrcs.site.length || s.distinctSrcs.other.length)) {
        lines.push(`      srcs: ext=${s.distinctSrcs.extPreview.length} site=${s.distinctSrcs.site.length} other=${s.distinctSrcs.other.length}`);
      }
    }
    const summaryText = `${lines.join('\n')}\n`;
    fs.writeFileSync(path.join(outDir, `census-${args.arm}-summary.txt`), summaryText);
    console.log('\n' + summaryText);
    log(`[${label}] 产物已落盘 ${outDir}`);

    await replay.close().catch(() => {});
    closeProcFile();
    closeTabMetrics();
  } finally {
    if (!finished) {
      finished = true;
      await cleanup().catch((e) => log(`[${label}] cleanup 异常：${errMsg(e)}`));
    }
    void browser;
  }
}

main().catch((e) => {
  console.error(`[census] 致命错误：${errMsg(e)}`);
  process.exit(1);
});
