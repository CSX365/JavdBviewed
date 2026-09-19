/**
 * @file perfSourcelessProbe.ts
 * @description cycle-10 S0-2：无源帧（无 invoker 的 LoAF）探测与归因 + 插桩污染冒烟。
 *
 * 背景：c8→c9 的 sourceless 爆发（无 invoker 长动画帧）无法用「某段 JS 任务」解释，
 *   怀疑与样式/CSSOM 变更触发的布局重算相关（增强注入样式表、封面占位重排等）。
 *   本脚本在页面侧装三类探针，把无源帧和「帧前 DOM/样式变更」关联起来：
 *
 *   1. 强制回流计数 + 调用栈：拦截 Element 布局属性 getter / getBoundingClientRect /
 *      getComputedStyle，样式脏状态下读到布局即记一次回流（含栈顶帧）；
 *   2. CSSOM/样式变更时间轴：MutationObserver 抓 STYLE/LINK 插入（含 id）、
 *      批量 DOM 变更、styleSheets 规则总数采样；
 *   3. LoAF：PerformanceObserver('long-animation-frame')，重点 invoker 为空的帧
 *      ——取帧前 500ms 内的样式/DOM 事件做归因直方图。
 *
 * 插桩污染冒烟（--smoke，默认开）：同一 arm 连跑两轮（每轮全新浏览器，与矩阵同口径），
 *   前轮不装探针（仅 CDP 指标）为基线，后轮装探针为测量轮；tInt / CPU 积分 / LoAF
 *   总量漂移 >10% 则标记 DEGRADED（插桩本身显著改变负载，数据只作定性参考）。
 *
 * 启动口径与 perfS0Profile.ts 保持一致：--real-visibility 手动 Chrome + CDP 代理
 * （focusEmulation 改写）、perf-s0 profile、代理 127.0.0.1:10808（可选）、
 * perfReplay 回放（可选，默认 /tmp/c10s01/replay-cache replay 模式）。
 *
 * 用法（矩阵跑批期间勿运行；跑前确认 ps -C chrome 为 0）：
 *   npx tsx scripts/perfSourcelessProbe.ts \
 *     --arm enhanced --pages detail --tabs 16 \
 *     --proxy http://127.0.0.1:10808 --replay /tmp/c10s01/replay-cache
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from '@playwright/test';

import {
  readExtensionId,
  resolveExtensionHarnessOptions,
  type ExtensionHarnessOptions,
  type LaunchExtensionContextOptions,
} from './extensionHarness';
import { attachReplay, type ReplayHandle } from './perfReplay';
import { launchRealVisibilityContext, type RealVisibilityLaunch } from './realVisibilityLaunch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CWD = path.resolve(__dirname, '..');
const PROFILE_DIR = path.resolve(CWD, '.test-profiles', 'perf-s0');
const SITE_LIST_URL = 'https://javdb570.com/search?q=test';
const REPLAY_DEFAULT_DIR = '/tmp/c10s01/replay-cache';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

interface Args {
  arm: 'enhanced' | 'control';
  pages: 'list' | 'detail';
  tabs: number;
  listPage: string;
  proxy?: string;
  replay?: string;
  replayRecord: boolean;
  smoke: boolean;
  steadyMs: number;
  quick: boolean;
  outDir: string;
}

interface HookReflow {
  t: number;
  top: string;
  frames: string[];
  kinds: string[];
}

interface HookStyleEvent {
  t: number;
  tag: string;
  id: string;
  href: string;
  ruleTotal: number;
}

interface HookDomEvent {
  t: number;
  added: number;
  removed: number;
  attrs: number;
  styles: number;
}

interface HookCssomSample {
  t: number;
  ruleTotal: number;
  sheetCount: number;
  trigger: string;
}

interface HookLoaf {
  t: number;
  dur: number;
  invoker: string;
  invokerType: string;
  blocking: number;
  pause: number;
}

interface HookData {
  installT: number;
  installRs: string;
  installHref: string;
  moInstalledT: number | null;
  reflows: HookReflow[];
  reflowTop: Record<string, number>;
  styleEvents: HookStyleEvent[];
  domEvents: HookDomEvent[];
  cssom: HookCssomSample[];
  loaf: HookLoaf[];
  marker: string | null;
  err: string | null;
}

/** 页面侧探针（纯字符串注入：避免 esbuild keepNames 的 __name 残留问题） */
const PROBE_HOOK_SRC = `(() => {
  const w = window;
  if (w.__s2p) return 'dup';
  const now = function () { return performance.now(); };
  const data = {
    installT: now(),
    installRs: document.readyState,
    installHref: location.href.slice(-60),
    moInstalledT: null,
    reflows: [],
    reflowTop: {},
    styleEvents: [],
    domEvents: [],
    cssom: [],
    loaf: [],
    marker: null,
    err: null,
  };
  w.__s2p = data;

  // --- 样式脏状态：DOM/样式变更后置脏，读到布局即强制回流，读完清脏 ---
  let dirty = false;
  let dirtyKinds = [];
  const markDirty = function (kind) {
    dirty = true;
    if (dirtyKinds.length < 6 && dirtyKinds.indexOf(kind) === -1) dirtyKinds.push(kind);
  };
  const recordReflow = function () {
    if (!dirty) return;
    let stack = [];
    try {
      const e = new Error();
      // 栈位：[0]Error 头 [1]recordReflow [2]探针 getter/包装 [3+] 真实调用方
      stack = (e.stack || '').split('\\n').slice(3, 8).map(function (s) { return s.trim(); }).filter(Boolean);
    } catch (_) { /* 忽略 */ }
    const top = stack[0] || 'unknown';
    if (data.reflows.length < 4000) data.reflows.push({ t: now(), top: top, frames: stack, kinds: dirtyKinds.slice() });
    data.reflowTop[top] = (data.reflowTop[top] || 0) + 1;
    dirty = false;
    dirtyKinds = [];
  };

  const ruleTotal = function () {
    try {
      let n = 0;
      const sheets = document.styleSheets;
      for (let i = 0; i < sheets.length; i += 1) {
        try { n += sheets[i].cssRules.length; } catch (_) { n += -1; } // 跨域 sheet 不可读
      }
      return n;
    } catch (_) { return 0; }
  };

  // --- 拦截 Element 布局读取 ---
  const elProto = Element.prototype;
  const LAYOUT_PROPS = ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'offsetRight', 'offsetBottom',
    'clientWidth', 'clientHeight', 'clientLeft', 'clientTop', 'scrollWidth', 'scrollHeight'];
  for (const p of LAYOUT_PROPS) {
    const d = Object.getOwnPropertyDescriptor(elProto, p);
    if (!d || !d.get) continue;
    Object.defineProperty(elProto, p, {
      configurable: true,
      enumerable: false,
      get: function () {
        recordReflow();
        return d.get.call(this);
      },
    });
  }
  for (const m of ['getBoundingClientRect', 'getClientRects']) {
    const orig = elProto[m];
    if (typeof orig !== 'function') continue;
    elProto[m] = function () {
      recordReflow();
      return orig.apply(this, arguments);
    };
  }
  if (w.getComputedStyle) {
    const origGcs = w.getComputedStyle.bind(w);
    w.getComputedStyle = function () {
      recordReflow();
      return origGcs.apply(w, arguments);
    };
  }

  // --- 规则总数定时采样（1s 一次，封顶 600 条） ---
  const ruleTimer = window.setInterval(function () {
    if (data.cssom.length < 600) {
      let sheetCount = 0;
      try { sheetCount = document.styleSheets.length; } catch (_) { /* 忽略 */ }
      data.cssom.push({ t: now(), ruleTotal: ruleTotal(), sheetCount: sheetCount, trigger: 'tick' });
    }
  }, 1000);
  window.setTimeout(function () { window.clearInterval(ruleTimer); }, 600000);

  // --- MutationObserver：DOM/样式变更时间轴（探针现在 document-start 安装，documentElement 可能还没解析出来） ---
  const mo = new MutationObserver(function (muts) {
    let added = 0, removed = 0, attrs = 0, styles = 0;
    let t = now();
    for (const m of muts) {
      if (m.type === 'attributes') {
        attrs += 1;
        if (m.attributeName === 'style' || m.attributeName === 'class') styles += 1;
      } else if (m.type === 'childList') {
        added += m.addedNodes.length;
        removed += m.removedNodes.length;
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const tag = String(n.tagName || '').toLowerCase();
          if (tag === 'style' || tag === 'link') {
            if (data.styleEvents.length < 500) {
              data.styleEvents.push({
                t: t,
                tag: tag,
                id: String(n.id || ''),
                href: String(n.getAttribute ? (n.getAttribute('href') || '') : ''),
                ruleTotal: ruleTotal(),
              });
            }
            markDirty('style');
          }
        }
      }
    }
    if (added || removed || attrs) {
      markDirty('dom');
      if (data.domEvents.length < 8000) data.domEvents.push({ t: t, added: added, removed: removed, attrs: attrs, styles: styles });
    }
  });
  const startMo = function () {
    if (data.moInstalledT != null) return;
    const root = document.documentElement;
    if (!root) return;
    try {
      // 只盯 class/style：全量 attributes 开销太大（插桩轮 CPU 漂移主嫌疑），且其它属性变更不会引发回流
      mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
      data.moInstalledT = now();
    } catch (e) {
      data.err = (data.err ? data.err + '; ' : '') + 'mo: ' + String(e);
    }
  };
  if (document.documentElement) {
    startMo();
  } else {
    document.addEventListener('DOMContentLoaded', startMo);
  }

  // --- LoAF 观察（阈值 50ms，封顶 4000 条） ---
  try {
    const po = new PerformanceObserver(function (list) {
      for (const e of list.getEntries()) {
        if (data.loaf.length >= 4000) return;
        data.loaf.push({
          t: Math.round(e.startTime),
          dur: Math.round(e.duration),
          invoker: e.invoker || '',
          invokerType: e.invokerType || '',
          blocking: Math.round(e.blockingDuration != null ? e.blockingDuration : 0),
          pause: Math.round(e.pauseDuration != null ? e.pauseDuration : 0),
        });
      }
    });
    po.observe({ type: 'long-animation-frame', buffered: true, durationThreshold: 50 });
  } catch (e) {
    data.err = 'loaf: ' + String(e);
  }
  return 'ok';
})()`;

// 注意：读回必须用函数形式（或 IIFE 字符串）。Playwright 的 evaluate 传"字符串形式的函数表达式"
// 时不会调用它，而是把函数对象当求值结果——函数不可序列化，返回值就是 undefined（2026-09-19 实测钉死）。

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string): void {
  console.log(`[s2probe] ${message}`);
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripProxyEnv(): void {
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete process.env[key];
  }
}

function purgeServiceWorkerCache(userDataDir: string): void {
  const rel = path.relative(CWD, userDataDir);
  if (!rel || rel.startsWith('..') || !rel.startsWith('.test-profiles')) {
    throw new Error(`拒绝清除 SW 缓存：${userDataDir} 不在 .test-profiles 下（安全边界）`);
  }
  for (const sub of ['Default/Service Worker/ScriptCache', 'Default/Service Worker/Database']) {
    const dir = path.join(userDataDir, sub);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`已清除 SW 缓存（防旧 SW 复用）：${path.relative(CWD, dir)}`);
    }
  }
}

/** arm 设置与 perfS0Profile.ARM_SETTINGS 同口径 */
const ARM_SETTINGS: Record<Args['arm'], Record<string, unknown>> = {
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

async function waitForExtensionServiceWorker(context: BrowserContext, timeoutMs: number): Promise<import('@playwright/test').Worker> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const workers = context.serviceWorkers();
    const sw = workers.find((worker) => worker.url().startsWith('chrome-extension://')) ?? workers[0];
    if (sw) return sw;
    if (Date.now() >= deadline) throw new Error(`service worker 未在 ${timeoutMs}ms 内出现`);
    await sleep(300);
  }
}

async function collectDetailUrls(page: Page, count: number): Promise<string[]> {
  if (count <= 0) return [];
  return page
    .evaluate((n: number) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const a of Array.from(document.querySelectorAll('a[href^="/v/"]'))) {
        const href = a.getAttribute('href');
        if (!href) continue;
        let abs = '';
        try {
          abs = new URL(href, location.origin).toString();
        } catch {
          continue;
        }
        if (!seen.has(abs)) {
          seen.add(abs);
          out.push(abs);
        }
        if (out.length >= n) break;
      }
      return out;
    }, count)
    .catch(() => [] as string[]);
}

// ---------------------------------------------------------------------------
// 浏览器级 CPU/RSS 采样（CDP Performance.getBrowserMetrics + /proc 兜底）
// ---------------------------------------------------------------------------

interface CpuSample {
  wallMs: number;
  cpuCoreSec: number;
  jsCpuCoreSec: number;
  rssBytes: number;
  pids: number;
}

function readProcRss(pids: number[]): number {
  let total = 0;
  for (const pid of pids) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const line = status.split('\n').find((l) => l.startsWith('VmRSS:'));
      if (line) total += Number(line.replace(/[^0-9]/g, '')) * 1024;
    } catch { /* 进程已退出 */ }
  }
  return total;
}

/** 浏览器级 CPU 采样：SystemInfo.getProcessInfo（Chromium 1243 口径；
 * Performance.getBrowserMetrics 已废弃）。cpuTime=进程累计 CPU 秒，轮询差分得窗口 CPU 积分。 */
async function sampleBrowserMetrics(cdp: CDPSession, wallMs: number): Promise<CpuSample> {
  const empty: CpuSample = { wallMs, cpuCoreSec: 0, jsCpuCoreSec: 0, rssBytes: 0, pids: 0 };
  try {
    const res = await cdp.send('SystemInfo.getProcessInfo') as {
      processInfo: { type: string; id: number; cpuTime: number }[];
    };
    const pids = new Set<number>();
    let cpu = 0;
    for (const m of res.processInfo) {
      if (m.id > 0) pids.add(m.id);
      cpu += m.cpuTime;
    }
    return { wallMs, cpuCoreSec: cpu, jsCpuCoreSec: 0, rssBytes: readProcRss([...pids]), pids: pids.size };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// 单轮执行
// ---------------------------------------------------------------------------

interface RoundMetrics {
  tInteractiveMs: number;
  cpuCoreSec: number;
  jsCpuCoreSec: number;
  rssPeakMB: number;
  loafCount: number;
  loafBlockingMs: number;
  sourcelessCount: number;
  sourcelessBlockingMs: number;
  reflowTotal: number;
  styleEventTotal: number;
  failures: string[];
}

interface RoundResult extends RoundMetrics {
  label: string;
  instrumented: boolean;
  perPage: { tab: number; url: string; kind: string; data: HookData | null; navs: number | null }[];
  cpuSamples: CpuSample[];
}

async function runRound(
  options: ExtensionHarnessOptions,
  args: Args,
  instrumented: boolean,
  roundIdx: number,
): Promise<RoundResult> {
  const label = `s2-${args.arm}-${instrumented ? 'inst' : 'bare'}-r${roundIdx}`;
  const failures: string[] = [];
  const launchOptions: LaunchExtensionContextOptions = {
    headless: false,
    channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
    extraArgs: args.proxy ? [`--proxy-server=${args.proxy}`] : ['--no-proxy-server'],
  };
  log(`${label} 启动（instrument=${instrumented} proxy=${args.proxy ?? '直连'}）`);
  purgeServiceWorkerCache(options.userDataDir);
  const realVis: RealVisibilityLaunch = await launchRealVisibilityContext(options, launchOptions);
  const context = realVis.context;
  const browser = realVis.browser;
  let replay: ReplayHandle | null = null;
  const pages: Page[] = [];
  const perPage: RoundResult['perPage'] = [];
  const cpuSamples: CpuSample[] = [];
  let browserCdp: CDPSession | null = null;

  try {
    const extensionId = await readExtensionId(context, 30_000);
    const sw = await waitForExtensionServiceWorker(context, 30_000);
    await sw.evaluate((data: Record<string, unknown>) => chrome.storage.local.set(data), {
      settings: ARM_SETTINGS[args.arm],
    });
    log(`${label} ${args.arm} 臂设置已写入`);

    if (args.replay) {
      const mode = args.replayRecord ? 'record' : 'replay';
      replay = await attachReplay(context, { cacheDir: args.replay, mode, log: (m) => log(`[${label}] ${m}`) });
      log(`${label} 回放已挂载 mode=${args.replayRecord ? 'record' : 'replay'} dir=${args.replay}`);
    }

    // --- 门卫 tab：年龄门 + 登录墙（与 perfS0Profile 剧本 C 同口径） ---
    await context.addCookies([{ name: 'over18', value: '1', domain: 'javdb570.com', path: '/' }]).catch(() => {});
    const gate = await context.newPage();
    pages.push(gate);
    const replayH = replay;
    const replayReady = replayH ? (p: Page) => replayH.awaitReady(p) : null;
    let gateLoaded = false;
    try {
      if (replayReady) await replayReady(gate);
      await gate.goto(args.listPage, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      gateLoaded = true;
    } catch (error) {
      failures.push(`门卫 tab 加载失败: ${errMsg(error)}`);
    }
    if (gateLoaded) {
      for (let round = 0; round < 2; round += 1) {
        const yes = gate.locator('a[href*="over18?respond=1"]').first();
        try {
          await yes.waitFor({ state: 'visible', timeout: 15_000 });
        } catch {
          break;
        }
        try {
          await yes.click({ timeout: 10_000 });
          await gate.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
          await sleep(1_000);
        } catch (error) {
          failures.push(`年龄门点击失败: ${errMsg(error)}`);
          break;
        }
      }
      const onLoginPage = await gate.evaluate(() => location.pathname.startsWith('/login')).catch(() => false);
      if (onLoginPage) {
        failures.push('站点登录墙：perf-s0 profile 登录态失效，先跑 loginPerfS0.ts');
      }
    }
    if (!gateLoaded) throw new Error('门卫 tab 未加载，轮次中止');
    if (replay && args.replayRecord) {
      await replay.captureDocument(gate).catch(() => {});
    }

    // --- tab URL 组成 ---
    const kinds: string[] = ['list'];
    const urls: string[] = [args.listPage];
    if (args.pages === 'detail') {
      const detailUrls = await collectDetailUrls(gate, args.tabs - 1);
      if (detailUrls.length < args.tabs - 1) {
        failures.push(`详情链接不足（${detailUrls.length}/${args.tabs - 1}），尾部补列表页`);
      }
      for (let i = 0; i < args.tabs - 1; i += 1) {
        urls.push(detailUrls[i] ?? args.listPage);
        kinds.push(detailUrls[i] ? 'detail' : 'list');
      }
    } else {
      for (let i = 0; i < args.tabs - 1; i += 1) {
        urls.push(args.listPage);
        kinds.push('list');
      }
    }

    // --- 并发开 tab（stagger 250ms；探针在 DCL 时安装） ---
    const staggerMs = args.quick ? 100 : 250;
    const markerMs = args.quick ? 15_000 : 30_000;
    const batchStart = Date.now();
    const readyAt: number[] = new Array(urls.length).fill(0);
    readyAt[0] = 0; // 门卫 tab 不算
    for (let i = 1; i < urls.length; i += 1) {
      const page = await context.newPage();
      pages.push(page);
      if (instrumented) {
        // addInitScript：文档一诞生就装（LoAF buffered 从 0 开始采，无安装前盲区；MO 等 documentElement 就绪）。
        // 每次整页导航（CF challenge/SPA 重载）自动重装，探针自带 dup 守卫。
        page.addInitScript(PROBE_HOOK_SRC).catch((e) => {
          failures.push(`tab${i + 1} 探针挂载失败: ${errMsg(e)}`);
        });
      }
      if (replayReady) await replayReady(page);
      try {
        await page.goto(urls[i], { waitUntil: 'domcontentloaded', timeout: 90_000 });
      } catch (error) {
        failures.push(`tab${i + 1} 加载失败: ${errMsg(error)}`);
      }
      if (replay && args.replayRecord) {
        await replay.captureDocument(page).catch(() => {});
      }
      // 就绪判定：enhanced 等增强标记；control 等固定冷窗
      const kind = kinds[i];
      let ready = 0;
      if (args.arm === 'enhanced') {
        try {
          if (kind === 'detail') {
            await page.waitForSelector('#video-detail-preview-styles', { state: 'attached', timeout: markerMs });
          } else {
            await page.waitForSelector('.x-btn, .jdb-list-status-actions', { timeout: markerMs });
          }
        } catch {
          failures.push(`tab${i + 1}(${kind}) 增强标记未出现（${markerMs}ms 预算）`);
        }
        ready = Date.now() - batchStart;
      } else {
        await sleep(args.quick ? 5_000 : 10_000);
        ready = Date.now() - batchStart;
      }
      readyAt[i] = ready;
      if (i < urls.length - 1) await sleep(staggerMs);
    }
    const tInteractiveMs = Math.max(...readyAt.slice(1), 0);
    log(`${label} tInt=${tInteractiveMs}ms（${urls.length - 1} tab 全部就绪/超时）`);

    // --- steady 窗：浏览器级 CPU/RSS 采样 ---
    try {
      browserCdp = await browser.newBrowserCDPSession();
    } catch (error) {
      failures.push(`浏览器级 CDP 会话失败（CPU 采样将为空）: ${errMsg(error)}`);
    }
    let lastCpu: CpuSample | null = null;
    const steadyEnd = Date.now() + args.steadyMs;
    while (Date.now() < steadyEnd) {
      if (browserCdp) {
        const sample = await sampleBrowserMetrics(browserCdp, Date.now() - batchStart);
        cpuSamples.push(sample);
        lastCpu = sample;
      }
      await sleep(2_000);
    }
    if (lastCpu) cpuSamples.push(await (browserCdp ? sampleBrowserMetrics(browserCdp, Date.now() - batchStart) : Promise.resolve(lastCpu)));

    // --- 读回页面侧数据 + 一次性 JS heap ---
    for (let i = 0; i < pages.length; i += 1) {
      const page = pages[i];
      let data: HookData | null = null;
      let navs: number | null = null;
      if (instrumented) {
        try {
          // 函数形式读回（字符串函数表达式不会被调用，见 READ_HOOK_EXPR 处注释）
          const rb = (await page.evaluate(() => {
            const w = window as any;
            let n = 0;
            try { n = performance.getEntriesByType('navigation').length; } catch (_) { /* 忽略 */ }
            return { data: w.__s2p || null, navs: n };
          })) as { data: HookData | null; navs: number };
          data = rb.data;
          navs = rb.navs;
          if (navs > 1) failures.push(`tab${i + 1} 本轮发生过 ${navs - 1} 次整页重载（探针数据只覆盖重载后窗口）`);
          if (data) {
            try {
              const markerSel = kinds[i] === 'detail' ? '#video-detail-preview-styles' : '.x-btn';
              data.marker = (await page.locator(markerSel).count()) > 0 ? markerSel : null;
            } catch { /* 忽略 */ }
          }
        } catch { /* 页面已关 */ }
      }
      perPage.push({ tab: i, url: page.url() || urls[i], kind: kinds[i], data, navs });
    }

    // --- 汇总指标 ---
    let loafCount = 0, loafBlockingMs = 0, sourcelessCount = 0, sourcelessBlockingMs = 0;
    let reflowTotal = 0, styleEventTotal = 0;
    for (const p of perPage) {
      const d = p.data;
      if (!d) continue;
      reflowTotal += d.reflows.length;
      styleEventTotal += d.styleEvents.length;
      for (const f of d.loaf) {
        loafCount += 1;
        loafBlockingMs += f.blocking;
        if (!f.invoker) {
          sourcelessCount += 1;
          sourcelessBlockingMs += f.blocking;
        }
      }
    }
    // CPU 积分：相邻样本 cpuTime 差之和（getProcessInfo 的 cpuTime 是进程累计 CPU 秒）
    let cpuCoreSec = 0;
    let rssPeak = 0;
    for (let i = 1; i < cpuSamples.length; i += 1) {
      cpuCoreSec += Math.max(0, cpuSamples[i].cpuCoreSec - cpuSamples[i - 1].cpuCoreSec);
      rssPeak = Math.max(rssPeak, cpuSamples[i].rssBytes);
    }
    const jsCpuCoreSec = 0; // SystemInfo 无 JS 分项，留字段占位（口径说明见报告）
    log(`${label} 汇总: loaf=${loafCount}(sourceless=${sourcelessCount}) reflow=${reflowTotal} cpu=${cpuCoreSec.toFixed(1)}core·s rssPeak=${(rssPeak / 1024 / 1024).toFixed(0)}MB`);

    return {
      label,
      instrumented,
      tInteractiveMs,
      cpuCoreSec,
      jsCpuCoreSec,
      rssPeakMB: rssPeak / 1024 / 1024,
      loafCount,
      loafBlockingMs,
      sourcelessCount,
      sourcelessBlockingMs,
      reflowTotal,
      styleEventTotal,
      failures,
      perPage,
      cpuSamples,
    };
  } finally {
    try {
      if (replay) await replay.close().catch(() => {});
    } catch { /* 忽略 */ }
    try { await realVis.cleanup(); } catch { /* 忽略 */ }
  }
}

// ---------------------------------------------------------------------------
// 无源帧归因
// ---------------------------------------------------------------------------

interface FrameAttribution {
  tab: number;
  url: string;
  frame: { t: number; dur: number; blocking: number };
  /** 帧前 500ms 窗口内的归因分类（取最近事件） */
  primary: 'style-insert' | 'dom-mutation' | 'attr-mutation' | 'none';
  styleInserts: number;
  domEvents: number;
  /** 命中的样式元素 id（最近一次 STYLE/LINK 插入） */
  lastStyleId: string;
  /** 安装前帧（归因窗口无数据，仅作参考） */
  preInstall: boolean;
}

function attributePage(page: { tab: number; url: string }, data: HookData, windowMs = 500): FrameAttribution[] {
  const out: FrameAttribution[] = [];
  const styles = data.styleEvents;
  const doms = data.domEvents;
  for (const f of data.loaf) {
    if (f.invoker) continue; // 只归因无源帧
    const preInstall = f.t < data.installT; // 安装前帧：时间轴无数据，归因不可信
    const from = f.t - windowMs;
    let styleInserts = 0;
    let domCount = 0;
    let lastStyleId = '';
    let lastStyleT = -1;
    let lastDomT = -1;
    let lastDomAdded = 0;
    let lastDomAttrs = 0;
    for (const s of styles) {
      if (s.t < from || s.t > f.t + 2) continue;
      styleInserts += 1;
      if (s.t > lastStyleT) {
        lastStyleT = s.t;
        lastStyleId = s.id || `.${s.href.slice(0, 24)}`;
      }
    }
    for (const d of doms) {
      if (d.t < from || d.t > f.t + 2) continue;
      domCount += 1;
      if (d.t > lastDomT) {
        lastDomT = d.t;
        lastDomAdded = d.added;
        lastDomAttrs = d.attrs;
      }
    }
    let primary: FrameAttribution['primary'] = 'none';
    if (lastStyleT >= 0 && lastStyleT >= lastDomT) primary = 'style-insert';
    else if (lastDomAdded > 0 || styleInserts > 0) primary = 'dom-mutation';
    else if (lastDomAttrs > 0) primary = 'attr-mutation';
    out.push({
      tab: page.tab,
      url: page.url,
      frame: { t: f.t, dur: f.dur, blocking: f.blocking },
      primary,
      styleInserts,
      domEvents: domCount,
      lastStyleId,
      preInstall,
    });
  }
  return out;
}

function histogram(frames: FrameAttribution[]): Record<string, { count: number; blockingMs: number; styleIds: Record<string, number> }> {
  const out: Record<string, { count: number; blockingMs: number; styleIds: Record<string, number> }> = {};
  for (const f of frames) {
    const bucket = out[f.primary] ??= { count: 0, blockingMs: 0, styleIds: {} };
    bucket.count += 1;
    bucket.blockingMs += f.frame.blocking;
    if (f.primary === 'style-insert' && f.lastStyleId) {
      bucket.styleIds[f.lastStyleId] = (bucket.styleIds[f.lastStyleId] ?? 0) + 1;
    }
  }
  return out;
}

function topReflowSites(perPage: RoundResult['perPage'], topN = 15): { site: string; count: number; tabs: number }[] {
  const agg = new Map<string, { count: number; tabs: Set<number> }>();
  for (const p of perPage) {
    const d = p.data;
    if (!d) continue;
    for (const [site, count] of Object.entries(d.reflowTop)) {
      const entry = agg.get(site) ?? { count: 0, tabs: new Set<number>() };
      entry.count += count;
      entry.tabs.add(p.tab);
      agg.set(site, entry);
    }
  }
  return [...agg.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, topN)
    .map(([site, e]) => ({ site, count: e.count, tabs: e.tabs.size }));
}

// ---------------------------------------------------------------------------
// 冒烟对比
// ---------------------------------------------------------------------------

interface SmokeMetric {
  name: string;
  base: number;
  inst: number;
  driftPct: number | null;
}

interface SmokeReport {
  metrics: SmokeMetric[];
  verdict: 'ok' | 'degraded';
  note: string;
}

function compareSmoke(base: RoundMetrics, inst: RoundMetrics): SmokeReport {
  const rows: [string, number, number][] = [
    ['tInt(ms)', base.tInteractiveMs, inst.tInteractiveMs],
    ['cpuCoreSec(steady)', base.cpuCoreSec, inst.cpuCoreSec],
    ['loafBlocking(ms)', base.loafBlockingMs, inst.loafBlockingMs],
    ['sourcelessBlocking(ms)', base.sourcelessBlockingMs, inst.sourcelessBlockingMs],
  ];
  const metrics: SmokeMetric[] = rows.map(([name, b, i]) => ({
    name,
    base: b,
    inst: i,
    driftPct: b > 0 ? ((i - b) / b) * 100 : null,
  }));
  const primary = metrics.filter((m) => m.name === 'tInt(ms)' || m.name === 'cpuCoreSec(steady)');
  const degraded = primary.some((m) => m.driftPct !== null && Math.abs(m.driftPct) > 10);
  return {
    metrics,
    verdict: degraded ? 'degraded' : 'ok',
    note: degraded
      ? '插桩使 tInt/CPU 漂移 >10%：插桩数据只作定性参考，量化结论以无插桩基线为准'
      : '插桩开销在 10% 以内，插桩轮数据可作量化参考',
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  const args: Args = {
    arm: 'enhanced',
    pages: 'detail',
    tabs: 16,
    listPage: SITE_LIST_URL,
    replay: undefined,
    replayRecord: false,
    smoke: true,
    steadyMs: 60_000,
    quick: false,
    outDir: path.resolve(CWD, '.test-profiles', `perf-s0-s2probe-${Date.now()}`),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`缺少 ${token} 的值`);
      i += 1;
      return v;
    };
    switch (token) {
      case '--arm': {
        const v = next();
        if (v !== 'enhanced' && v !== 'control') throw new Error(`--arm 只接受 enhanced|control，收到 ${v}`);
        args.arm = v;
        break;
      }
      case '--pages': {
        const v = next();
        if (v !== 'list' && v !== 'detail') throw new Error(`--pages 只接受 list|detail，收到 ${v}`);
        args.pages = v;
        break;
      }
      case '--tabs': {
        const n = Number(next());
        if (!(n >= 2 && n <= 40)) throw new Error(`--tabs 取值 2~40，收到 ${n}`);
        args.tabs = n;
        break;
      }
      case '--list-page':
        args.listPage = next();
        break;
      case '--proxy':
        args.proxy = next();
        break;
      case '--replay':
        args.replay = path.resolve(next());
        break;
      case '--replay-record':
        args.replayRecord = true;
        break;
      case '--no-smoke':
        args.smoke = false;
        break;
      case '--steady':
        args.steadyMs = Number(next()) * 1000;
        break;
      case '--quick':
        args.quick = true;
        args.steadyMs = Math.min(args.steadyMs, 15_000);
        break;
      case '--out':
        args.outDir = path.resolve(next());
        break;
      default:
        throw new Error(`未知参数：${token}`);
    }
  }
  if (args.quick) args.steadyMs = Math.min(args.steadyMs, 15_000);
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  stripProxyEnv();
  process.env.JAVDB_EXTENSION_PROFILE = PROFILE_DIR;
  process.env.JAVDB_EXTENSION_USE_CHROME_DATA = '0';
  if (!args.proxy) log('警告：未设置 --proxy（本机直连 CDN 路由断，封面会缺失——sourceless 归因会被放大，请确认意图）');
  fs.mkdirSync(args.outDir, { recursive: true });
  log(`出=${args.outDir} arm=${args.arm} pages=${args.pages} tabs=${args.tabs} steady=${args.steadyMs}ms smoke=${args.smoke}`);

  const options = resolveExtensionHarnessOptions(process.env, CWD);
  if (!fs.existsSync(path.join(PROFILE_DIR, 'Default'))) {
    throw new Error(`perf-s0 profile 不存在：${PROFILE_DIR}`);
  }

  const rounds: RoundResult[] = [];
  if (args.smoke) {
    rounds.push(await runRound(options, args, false, 1)); // 基线：不装探针
  }
  rounds.push(await runRound(options, args, args.smoke ? true : false, args.smoke ? 2 : 1));
  await sleep(1_500);

  // --- 归因（只用插桩轮） ---
  const instRound = rounds.find((r) => r.instrumented) ?? rounds[rounds.length - 1];
  const attributed = instRound.perPage
    .filter((p) => p.data)
    .flatMap((p) => attributePage(p, p.data as HookData));
  const preInstallFrames = attributed.filter((f) => f.preInstall);
  const attributedPost = attributed.filter((f) => !f.preInstall);
  const hist = histogram(attributedPost);
  const reflowTops = topReflowSites(instRound.perPage);

  const report = {
    generatedAt: new Date().toISOString(),
    arm: args.arm,
    pages: args.pages,
    tabs: args.tabs,
    listPage: args.listPage,
    replay: args.replay ?? null,
    steadyMs: args.steadyMs,
    rounds: rounds.map((r) => ({
      label: r.label,
      instrumented: r.instrumented,
      tInteractiveMs: r.tInteractiveMs,
      cpuCoreSec: r.cpuCoreSec,
      jsCpuCoreSec: r.jsCpuCoreSec,
      rssPeakMB: Math.round(r.rssPeakMB),
      loafCount: r.loafCount,
      loafBlockingMs: r.loafBlockingMs,
      sourcelessCount: r.sourcelessCount,
      sourcelessBlockingMs: r.sourcelessBlockingMs,
      reflowTotal: r.reflowTotal,
      styleEventTotal: r.styleEventTotal,
      failures: r.failures,
    })),
    smoke: args.smoke ? compareSmoke(rounds[0], rounds[1]) : null,
    attribution: {
      windowMs: 500,
      sourcelessFrames: attributed.length,
      sourcelessPostInstallFrames: attributedPost.length,
      sourcelessPreInstall: {
        count: preInstallFrames.length,
        blockingMs: preInstallFrames.reduce((n, f) => n + f.frame.blocking, 0),
      },
      byCategory: hist,
      reflowTopSites: reflowTops,
      perPageStyleEvents: instRound.perPage
        .filter((p) => p.data)
        .map((p) => ({
          tab: p.tab,
          kind: p.kind,
          styleEvents: (p.data as HookData).styleEvents.map((s) => ({ t: Math.round(s.t), tag: s.tag, id: s.id, href: s.href, ruleTotal: s.ruleTotal })),
        })),
    },
  };

  const reportPath = path.join(args.outDir, 's2probe-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  for (const r of rounds) {
    const perPagePath = path.join(args.outDir, `${r.label}-pages.json`);
    fs.writeFileSync(perPagePath, `${JSON.stringify(r.perPage, null, 2)}\n`, 'utf8');
  }
  log(`报告已落盘 ${reportPath}`);

  // --- 中文摘要 ---
  const fmt = (m: SmokeMetric) => `${m.name}: 基线=${m.base.toFixed ? m.base.toFixed(1) : m.base} 插桩=${m.inst.toFixed ? m.inst.toFixed(1) : m.inst} 漂移=${m.driftPct === null ? 'N/A' : `${m.driftPct.toFixed(1)}%`}`;
  console.log('\n========== S0-2 无源帧探测摘要 ==========');
  for (const r of rounds) {
    console.log(`[${r.label}] tInt=${r.tInteractiveMs}ms loaf=${r.loafCount}(sourceless=${r.sourcelessCount}, blocking=${r.loafBlockingMs}ms/sourceless=${r.sourcelessBlockingMs}ms) reflow=${r.reflowTotal} styleEv=${r.styleEventTotal} cpu=${r.cpuCoreSec.toFixed(1)}core·s rssPeak=${Math.round(r.rssPeakMB)}MB`);
    if (r.failures.length > 0) for (const f of r.failures.slice(0, 5)) console.log(`  失败: ${f}`);
  }
  if (report.smoke) {
    console.log(`[smoke] ${report.smoke.verdict === 'ok' ? 'OK' : 'DEGRADED'}：${report.smoke.note}`);
    for (const m of report.smoke.metrics) console.log(`  ${fmt(m)}`);
  }
  const preMs = preInstallFrames.reduce((n, f) => n + f.frame.blocking, 0);
  console.log(`[归因] 无源帧 ${attributed.length} 个（安装前 ${preInstallFrames.length} 帧/${preMs}ms 不参与归因；以下按帧前 500ms 窗口）:`);
  for (const [cat, v] of Object.entries(hist)) {
    const ids = Object.entries(v.styleIds).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => `${id}×${n}`).join(' ');
    console.log(`  ${cat}: ${v.count} 帧 / ${v.blockingMs}ms${ids ? ` [样式id: ${ids}]` : ''}`);
  }
  if (reflowTops.length > 0) {
    console.log('[归因] 强制回流 top 调用栈:');
    for (const s of reflowTops.slice(0, 8)) console.log(`  ${s.count}× (${s.tabs}tab) ${s.site.slice(0, 110)}`);
  }
  console.log('==========================================\n');
}

main().catch((error) => {
  console.error('[s2probe] 失败：', error);
  process.exitCode = 1;
});
