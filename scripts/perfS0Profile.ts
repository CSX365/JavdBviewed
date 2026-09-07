/**
 * @file perfS0Profile.ts
 * @description 性能 S0 profile runner：dashboard（剧本 A）/ 原站（剧本 B）双剧本，
 *              增强组 vs 对照组，每 (剧本×臂×重复) 一次全新浏览器、五阶段采样
 *              （cold/warmup/interaction/steady/cooldown）。
 *
 * 采集口径（PRD Methodology）：
 *   - CPU / RSS：进程树采样（ps，browser/renderer/gpu/utility 分类，复用 summarizeWslChromeProcessesByCategory）
 *   - JS heap / DOM nodes：页面 CDP Performance.getMetrics（2s 周期）
 *   - 长任务：页面 PerformanceObserver(longtask)，不支持时 rAF 帧间隔 >50ms 兜底（双轨记录，取主源）
 *   - runtime 消息：SW 侧 onMessage 计数 + 类型直方图（测量期插桩，不进业务代码）
 *   - storage 写：SW 侧包装 chrome.storage.local.set 计数/字节/key 组合直方图
 *   - 封面并发：resource observer 抓 jdbstatic.com//covers/ 区间，drain 时 sweep 求最大并发
 *
 * 铁律：
 *   - profile = .test-profiles/perf-s0（先跑 perfProfileSeed.ts 到真实规模，viewed≥15000 才允许测量）
 *   - 剧本 B 只读浏览真实站点（--no-proxy-server 直连、预置 over18 cookie、不登录不写）
 *   - 不碰真实 115/Emby/Cloud；报告经 redactDiagnosticPayload 脱敏后落 research/profiles/
 *   - 页面/SW 插桩字符串为纯 JS 常量（tsx 的 __name 注入坑：页面侧函数一律字符串 IIFE + JSON 内联参数）
 *
 * 用法：
 *   pnpm tsx scripts/perfS0Profile.ts --scenario A --arm enhanced --repeat 1 --quick   # 冒烟（缩短时长）
 *   pnpm tsx scripts/perfS0Profile.ts --scenario A --arm enhanced --repeat 1          # 单跑
 *   pnpm tsx scripts/perfS0Profile.ts --matrix                                        # 全矩阵 2 剧本×2 臂×3 重复（后台约 35-45 分钟）
 *   pnpm tsx scripts/perfS0Profile.ts --scenario B --list-page http://127.0.0.1:PORT/ # 本地 fixture 替代真站
 *   pnpm tsx scripts/perfS0Profile.ts --no-guard                                       # 跳过 seed 守卫（已知数据就绪时）
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type BrowserContext,
  type CDPSession,
  type Page,
  type Worker,
} from '@playwright/test';
import {
  extensionPageUrl,
  launchExtensionContext,
  readExtensionId,
  resolveExtensionHarnessOptions,
} from './extensionHarness';
import {
  redactDiagnosticPayload,
  summarizeDiagnosticSamples,
  type DiagnosticPhase,
  type DiagnosticSample,
} from './performanceDiagnostics';
import {
  summarizeWslChromeProcesses,
  summarizeWslChromeProcessesByCategory,
  type WslChromeProcess,
  type WslChromeProcessCategory,
  type WslChromeProcessSummary,
} from './wslCdpPerformanceProbe';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CWD = path.resolve(__dirname, '..');
const PROFILE_DIR = path.resolve(CWD, '.test-profiles', 'perf-s0');
const DEFAULT_OUT_DIR = path.resolve(
  CWD,
  '../.trellis/tasks/09-06-performance-cycle-2/research/profiles',
);
// 2026-09-07 口径变更：/tags?c10=1 对匿名会话是登录墙（302→/login），B 剧本两次失败均因此；
// /search?q=test 匿名开放且列表稳定（探针实测 40 个 a.box、真实封面与 /v/ 链接），改用此口径，详见 research/profiling.md。
const SITE_LIST_URL = 'https://javdb570.com/search?q=test';
const MIN_VIEWED_FOR_MEASUREMENT = 15_000;
const SAMPLE_INTERVAL_MS = 2_000;

/** dashboard 导航是「主 tab（组）+ 子 tab（组内项）」两级结构（navModel.ts 口径）。
 * 单项组（home/media/settings）不渲染子 tab 条，点主 tab 即激活；
 * 多 item 组（library/sync/analysis）先点主 tab 渲染子 tab 条，再点子 tab。
 * 旧平铺选择器 button.dashboard-sub-tab[data-tab=...] 对单项组永远不存在。 */
interface DashboardNavStep { tab: string; group: string; sub: boolean }
const DASHBOARD_NAV: readonly DashboardNavStep[] = [
  { tab: 'tab-home', group: 'home', sub: false },
  { tab: 'tab-records', group: 'library', sub: true },
  { tab: 'tab-actors', group: 'library', sub: true },
  { tab: 'tab-new-works', group: 'library', sub: true },
  { tab: 'tab-lists', group: 'library', sub: true },
  { tab: 'tab-recycle-bin', group: 'library', sub: true },
  { tab: 'tab-media', group: 'media', sub: false },
  { tab: 'tab-sync', group: 'sync', sub: true },
  { tab: 'tab-drive115-tasks', group: 'sync', sub: true },
  { tab: 'tab-backup', group: 'sync', sub: true },
  { tab: 'tab-insights', group: 'analysis', sub: true },
  { tab: 'tab-logs', group: 'analysis', sub: true },
  { tab: 'tab-settings', group: 'settings', sub: false },
] as const;

type Scenario = 'A' | 'B';
type Arm = 'enhanced' | 'control';

/** 增强组：与 perfProfileSeed.ts 同口径（用户真实 profile 的增强开关） */
/** 键排序后的 stringify：chrome.storage 对 key 按字母序持久化，直接 JSON.stringify 比较会因键序误判 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

const ARM_SETTINGS: Record<Arm, Record<string, unknown>> = {
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
  /** 对照组：增强全关（分离「站点本身 + 扩展基线」与「增强增量」） */
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

/** B6 业务点开关矩阵：功能点名 → enhanced 臂设置覆盖项（逐项关掉做差，回答「哪个业务点导致卡顿」）。
 * 只覆盖子键：getSettings() 读取时实时与 DEFAULT_SETTINGS 合并（无全局缓存），未覆盖项走默认。 */
const FEATURES_OFF_UNITS: Record<string, Record<string, unknown>> = {
  /** 视频增强（详情页 smart 调度：预览/去码/标题等重任务） */
  video: { videoEnhancement: { enabled: false, schedulingMode: 'smart' } },
  /** 列表增强整体（x-btn/状态徽标/快捷操作等全部列表侧注入） */
  list: { listEnhancement: { enabled: false } },
  /** 列表封面 hover 预览 */
  preview: { listEnhancement: { enableVideoPreview: false } },
  /** 封面演员角标水印 */
  watermark: { listEnhancement: { enableActorWatermark: false } },
  /** 状态徽标 + 已阅/想看/已看快捷操作 */
  status: { listEnhancement: { showStatusBadge: false, enableStatusQuickAction: false } },
  /** 收藏快捷操作 */
  favorite: { listEnhancement: { enableListFavoriteQuickAction: false } },
  /** 115/Emby 片库匹配状态角标 */
  match: { libraryMatchStatus: { enabled: false } },
  /** Emby 媒体库入库状态（列表卡片侧） */
  embylib: { emby: { libraryEnabled: false } },
  /** 演员增强（演员角标/黑名单等） */
  actor: { actorEnhancement: { enabled: false }, userExperience: { enableActorEnhancement: false } },
};

function deepMergeSettings(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const prev = out[key];
    if (value && typeof value === 'object' && !Array.isArray(value)
      && prev && typeof prev === 'object' && !Array.isArray(prev)) {
      out[key] = deepMergeSettings(prev as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** enhanced 臂基线 × --disable-video × --features-off 叠加后的最终设置 */
function resolveEffectiveSettings(arm: Arm, disableVideo: boolean, featuresOff: string[] | undefined): Record<string, unknown> {
  if (featuresOff && featuresOff.length > 0) {
    if (arm !== 'enhanced') throw new Error('--features-off 只对 enhanced 臂有效（对照组本身就是全关）');
    for (const name of featuresOff) {
      if (!(name in FEATURES_OFF_UNITS)) {
        throw new Error(`未知业务点开关：${name}（可选：${Object.keys(FEATURES_OFF_UNITS).join(', ')}）`);
      }
    }
  }
  let settings: Record<string, unknown> = { ...ARM_SETTINGS[arm] };
  if (disableVideo) {
    settings = deepMergeSettings(settings, { videoEnhancement: { enabled: false, schedulingMode: 'smart' } });
  }
  for (const name of featuresOff ?? []) {
    settings = deepMergeSettings(settings, FEATURES_OFF_UNITS[name]);
  }
  return settings;
}



interface Durations {
  quick: boolean;
  coldSettleMs: number;
  coldWaitMs: number;
  warmupMs: number;
  tabRounds: number;
  tabSettleMs: number;
  steadyMsA: number;
  steadyMsB: number;
  cooldownMs: number;
  siteGotoMs: number;
  enhancedMarkerMs: number;
  controlColdMs: number;
  scrollRounds: number;
  scrollIntervalMs: number;
  detailDwellMs: number;
  detailScrollIntervalMs: number;
}

function resolveDurations(quick: boolean): Durations {
  return quick
    ? {
        quick,
        coldSettleMs: 2_000,
        coldWaitMs: 60_000,
        warmupMs: 3_000,
        tabRounds: 1,
        tabSettleMs: 700,
        steadyMsA: 10_000,
        steadyMsB: 8_000,
        cooldownMs: 3_000,
        siteGotoMs: 60_000,
        enhancedMarkerMs: 20_000,
        controlColdMs: 5_000,
        scrollRounds: 3,
        scrollIntervalMs: 400,
        detailDwellMs: 8_000,
        detailScrollIntervalMs: 2_000,
      }
    : {
        quick,
        coldSettleMs: 5_000,
        coldWaitMs: 60_000,
        warmupMs: 10_000,
        tabRounds: 2,
        tabSettleMs: 1_000,
        steadyMsA: 60_000,
        steadyMsB: 30_000,
        cooldownMs: 10_000,
        siteGotoMs: 90_000,
        enhancedMarkerMs: 30_000,
        controlColdMs: 10_000,
        scrollRounds: 10,
        scrollIntervalMs: 500,
        detailDwellMs: 20_000,
        detailScrollIntervalMs: 5_000,
      };
}

interface Args {
  scenario: Scenario;
  arm: Arm;
  repeat: number;
  quick: boolean;
  matrix: boolean;
  noGuard: boolean;
  outDir: string;
  listPage?: string;
  disableVideo?: boolean;
  /** B6 业务点开关矩阵：要关闭的功能点名（仅 enhanced 臂有效） */
  featuresOff?: string[];
}

interface Job {
  scenario: Scenario;
  arm: Arm;
  repeat: number;
}

interface GuardInfo {
  viewed: number;
  settingsBytes: number;
}

// ---------------------------------------------------------------------------
// 页面侧插桩（纯 JS 字符串：addInitScript / evaluate 注入，零 TS 残留）
// ---------------------------------------------------------------------------

const PAGE_HOOK_SRC = `(() => {
  if (window.__s0HookInstalled) return;
  window.__s0HookInstalled = true;
  const state = {
    longTaskCount: 0, longTaskTotalMs: 0, longTaskMaxMs: 0, longTaskSamples: [],
    // S1 归因用：不随 drain 重置的全量 longtask 记录（startTime document 相对），
    // 因 chrome-extension 页面 getEntriesByType('longtask') buffer 受限，改走 observer 侧记录
    longTaskAll: [],
    // S1 归因用：不随 drain 重置的 rAF 帧停顿记录（timestamp document 相对）
    // steady 期「长任务」实为 rAF 帧停顿（S0 source=raf），需时间戳做 5s 桶找周期性
    rafStallAll: [],
    rafCount: 0, rafTotalMs: 0, rafMaxMs: 0,
    // B6 函数级归因：long-animation-frame 记录（含调用栈最外层 function/url），不随 drain 重置
    loafAll: [],
    coverEvents: [],
  };
  try {
    if (typeof PerformanceObserver === 'function') {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            state.longTaskCount += 1;
            state.longTaskTotalMs += entry.duration;
            if (entry.duration > state.longTaskMaxMs) state.longTaskMaxMs = entry.duration;
            if (state.longTaskSamples.length < 2000) state.longTaskSamples.push({ at: entry.startTime, dur: entry.duration });
            if (state.longTaskAll.length < 5000) state.longTaskAll.push({ s: entry.startTime, d: entry.duration });
          }
        });
        observer.observe({ type: 'longtask', buffered: true });
      } catch (err) { /* 该上下文无 longtask，依赖 rAF 兜底 */ }
      try {
        // B6：LoAF 函数级归因。Chrome 149+ 已移除 entry.attributions/invoker，
        // 归因改由 entry.scripts（PerformanceScriptTiming[]）提供：
        // sourceURL/sourceFunctionName/invoker；取本帧内耗时最长的 script 为归因主体。
        // 旧版 Chrome 仍走 attributions 兜底（顶层=最外层，取末位）。
        const loafObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (state.loafAll.length >= 3000) continue;
            let u = '', f = '', inv = entry.invoker || '';
            const scripts = entry.scripts || [];
            if (scripts.length > 0) {
              let best = scripts[0];
              for (let i = 1; i < scripts.length; i++) {
                if ((scripts[i].duration || 0) > (best.duration || 0)) best = scripts[i];
              }
              u = best.sourceURL || '';
              f = best.sourceFunctionName || '';
              if (!inv && best.invoker) inv = best.invoker;
            } else {
              const stack = entry.attributions || [];
              const top = stack.length > 0 ? stack[stack.length - 1] : null;
              if (top) {
                u = top.scriptUrl || top.url || '';
                f = top.name || top.function || '';
              }
            }
            state.loafAll.push({ s: entry.startTime, d: entry.duration, inv: inv, u: u, f: f });
          }
        });
        loafObserver.observe({ type: 'long-animation-frame', buffered: true });
      } catch (err) { /* 浏览器不支持 LoAF，退化为 longtask/rAF 口径 */ }
      try {
        const resourceObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const url = entry.name || '';
            if (url.indexOf('jdbstatic.com') !== -1 || url.indexOf('/covers/') !== -1) {
              if (state.coverEvents.length < 5000) {
                state.coverEvents.push({ start: entry.startTime, end: entry.startTime + entry.duration });
              }
            }
          }
        });
        resourceObserver.observe({ type: 'resource', buffered: true });
      } catch (err) { /* 忽略 resource 观察失败 */ }
    }
  } catch (err) { /* 插桩绝不影响页面 */ }
  let lastFrame = 0;
  if (typeof requestAnimationFrame === 'function') {
    const tick = (timestamp) => {
      if (lastFrame > 0) {
        const delta = timestamp - lastFrame;
        if (delta > 50) {
          state.rafCount += 1;
          state.rafTotalMs += delta;
          if (delta > state.rafMaxMs) state.rafMaxMs = delta;
          if (state.rafStallAll.length < 3000) state.rafStallAll.push({ t: timestamp, d: delta });
        }
      }
      lastFrame = timestamp;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  window.__s0LongTaskAll = () => ({
    timeOrigin: performance.timeOrigin,
    entries: state.longTaskAll.slice(-3000),
    rafStalls: state.rafStallAll.slice(-2500),
    loaf: state.loafAll.slice(-2500),
  });
  window.__s0Drain = () => {
    const result = {
      longTaskCount: state.longTaskCount,
      longTaskTotalMs: state.longTaskTotalMs,
      longTaskMaxMs: state.longTaskMaxMs,
      longTaskDurations: state.longTaskSamples.slice(0, 100).map((sample) => sample.dur),
      rafCount: state.rafCount,
      rafTotalMs: state.rafTotalMs,
      rafMaxMs: state.rafMaxMs,
      coverEvents: state.coverEvents,
    };
    state.longTaskCount = 0; state.longTaskTotalMs = 0; state.longTaskMaxMs = 0;
    state.longTaskSamples = [];
    state.rafCount = 0; state.rafTotalMs = 0; state.rafMaxMs = 0;
    state.coverEvents = [];
    return result;
  };
})()`;

const PAGE_DRAIN_EXPR = `(() => {
  const drain = window.__s0Drain;
  if (typeof drain !== 'function') return null;
  const result = drain();
  if (!result) return null;
  return {
    longTaskCount: result.longTaskCount,
    longTaskTotalMs: result.longTaskTotalMs,
    longTaskMaxMs: result.longTaskMaxMs,
    longTaskDurations: result.longTaskDurations || [],
    rafCount: result.rafCount,
    rafTotalMs: result.rafTotalMs,
    rafMaxMs: result.rafMaxMs,
    coverEvents: result.coverEvents || [],
  };
})()`;

/** SW 侧插桩（经 CDP Runtime.evaluate 注入，幂等；SW 重启后重新注入并重建基线） */
const SW_HOOK_SRC = `(() => {
  if (self.__s0Hook) return { already: true, hook: self.__s0Hook };
  const hook = {
    installedAt: Date.now(),
    messages: 0,
    byType: {},
    storageSetCount: 0,
    storageSetBytes: 0,
    setKeyCombos: {},
    outMessages: 0,
    outByType: {},
    outBuckets: {},
  };
  self.__s0Hook = hook;
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      try {
        let type = 'unknown';
        if (msg && typeof msg === 'object') type = String(msg.type || msg.action || msg.command || 'unknown');
        else type = typeof msg;
        hook.messages += 1;
        hook.byType[type] = (hook.byType[type] || 0) + 1;
      } catch (err) {}
      return false;
    });
  } catch (err) {}
  try {
    const storageLocal = chrome.storage.local;
    const origSet = storageLocal.set.bind(storageLocal);
    storageLocal.set = function (items, callback) {
      try {
        hook.storageSetCount += 1;
        let text = '';
        try { text = JSON.stringify(items) || ''; } catch (err) { text = ''; }
        hook.storageSetBytes += text.length;
        let combo = 'unknown';
        try { combo = Object.keys(items || {}).sort().join('+') || 'empty'; } catch (err) {}
        hook.setKeyCombos[combo] = (hook.setKeyCombos[combo] || 0) + 1;
      } catch (err) {}
      return origSet(items, callback);
    };
  } catch (err) {}
  try {
    const recordOut = (message) => {
      try {
        hook.outMessages += 1;
        let type = 'raw';
        if (message && typeof message === 'object') type = String(message.type || message.action || message.command || 'raw');
        hook.outByType[type] = (hook.outByType[type] || 0) + 1;
        const bucket = Math.floor((Date.now() - hook.installedAt) / 5000);
        hook.outBuckets[bucket] = (hook.outBuckets[bucket] || 0) + 1;
      } catch (err) {}
    };
    const origRuntimeSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = function (message, options) {
      recordOut(message);
      return origRuntimeSend.call(chrome.runtime, message, options);
    };
    const origTabsSend = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = function (tabId, message, options) {
      recordOut(message);
      return origTabsSend.call(chrome.tabs, tabId, message, options);
    };
  } catch (err) {}
  return { already: false, hook };
})()`;

/** 长任务全量记录（PAGE_HOOK 的 observer 侧累积，不随 drain 重置）。
 * S1 归因：在 interaction/steady 边界读 startTime（document 相对）/duration，
 * 用 timeOrigin 换算 epoch 后归因到 tab 时间窗。
 * 注：chrome-extension 页面 performance.getEntriesByType('longtask') 返回空，不可用。 */
const LONGTASK_ALL_EXPR = `(() => {
  const fn = window.__s0LongTaskAll;
  if (typeof fn !== 'function') return null;
  return fn();
})()`;

/** B6：读取页面 LoAF 记录（函数级卡顿归因）。
 * 注意：字段名刻意避开脱敏 key 模式（url→src、function→fn），保证主报告 JSON 不被 redactDiagnosticPayload 误伤。 */
const LOAF_EXPR = `(() => {
  const fn = window.__s0LongTaskAll;
  if (typeof fn !== 'function') return null;
  const data = fn();
  return data && Array.isArray(data.loaf) ? data.loaf : [];
})()`;

interface LoafEntry { s: number; d: number; inv: string; u: string; f: string }
interface LoafTopEntry { src: string; fn: string; invoker: string; count: number; totalMs: number }

/** LoAF 按「调用栈最外层函数@脚本」聚合 → top-N 卡顿来源（回答「哪个业务模块的哪段代码导致长帧」） */
function summarizeLoafTop(entries: LoafEntry[] | null | undefined, topN = 12): LoafTopEntry[] {
  if (!entries || entries.length === 0) return [];
  const by = new Map<string, LoafTopEntry>();
  for (const entry of entries) {
    const key = `${entry.f}@${entry.u}`;
    const current = by.get(key) ?? { src: entry.u, fn: entry.f, invoker: entry.inv, count: 0, totalMs: 0 };
    current.count += 1;
    current.totalMs += entry.d;
    by.set(key, current);
  }
  return [...by.values()]
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, topN)
    .map((entry) => ({ ...entry, totalMs: Math.round(entry.totalMs) }));
}

async function captureLoafTop(page: Page): Promise<LoafTopEntry[]> {
  try {
    const entries = (await page.evaluate(LOAF_EXPR)) as LoafEntry[] | null;
    return summarizeLoafTop(entries);
  } catch {
    return [];
  }
}

function printLoafTop(label: string, loafTop: Record<string, LoafTopEntry[]> | null): void {
  if (!loafTop) return;
  for (const [pageName, entries] of Object.entries(loafTop)) {
    if (!entries || entries.length === 0) continue;
    const top = entries.slice(0, 5)
      .map((e) => `${e.fn || '(anon)'}@${(e.src || '').split('/').slice(-1)[0]} ${e.count}帧/${e.totalMs}ms`)
      .join(' | ');
    log(`[${label}] LoAF函数归因(${pageName}) top: ${top || '-'}`);
  }
}

/** SW 出站快照（归因 sidecar 专用：5s 桶 + 类型直方图 + installedAt，用于 steady 期推送相关性） */
const SW_OUT_EXPR = `(() => {
  const hook = self.__s0Hook;
  if (!hook) return null;
  return {
    installedAt: hook.installedAt,
    outMessages: hook.outMessages || 0,
    outByType: hook.outByType || {},
    outBuckets: hook.outBuckets || {},
  };
})()`;

/** seed 守卫：确认 profile 已 seed 到真实规模（viewed≥15000） */
const GUARD_EXPR = `(() => {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const request = indexedDB.open('javdb_v1', 14);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('viewedRecords')) {
          if (n < 30) { db.close(); window.setTimeout(() => attempt(n + 1), 1000); return; }
          db.close();
          reject(new Error('viewedRecords store 未就绪'));
          return;
        }
        const countReq = db.transaction('viewedRecords', 'readonly').objectStore('viewedRecords').count();
        countReq.onsuccess = () => {
          chrome.storage.local.get('settings', (items) => {
            const settings = items && items.settings;
            db.close();
            resolve({ viewed: countReq.result, settingsBytes: settings ? JSON.stringify(settings).length : 0 });
          });
        };
        countReq.onerror = () => reject(countReq.error || new Error('count viewedRecords failed'));
      };
      request.onerror = () => reject(request.error || new Error('open javdb_v1 failed'));
      request.onupgradeneeded = () => { if (request.transaction) request.transaction.abort(); };
    };
    attempt(0);
  });
})()`;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

interface PageDrain {
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  longTaskDurations: number[];
  rafCount: number;
  rafTotalMs: number;
  rafMaxMs: number;
  coverEvents: { start: number; end: number }[];
}

interface SwHookState {
  installedAt: number;
  messages: number;
  byType: Record<string, number>;
  storageSetCount: number;
  storageSetBytes: number;
  setKeyCombos: Record<string, number>;
  /** SW→扩展页出站消息（runtime/tabs.sendMessage）插桩：dashboard 空闲期长任务与 SW 推送的相关性归因 */
  outMessages: number;
  outByType: Record<string, number>;
  outBuckets: Record<string, number>;
}

interface SwAcc {
  messages: number;
  byType: Record<string, number>;
  setCount: number;
  setBytes: number;
  setKeyCombos: Record<string, number>;
  outMessages: number;
  outByType: Record<string, number>;
}

const newSwAcc = (): SwAcc => ({ messages: 0, byType: {}, setCount: 0, setBytes: 0, setKeyCombos: {}, outMessages: 0, outByType: {} });

type SwHistogramsLike = {
  byType?: Record<string, number> | Array<{ name: string; count: number }>;
  setKeyCombos?: Record<string, number> | Array<{ name: string; count: number }>;
  outByType?: Record<string, number> | Array<{ name: string; count: number }>;
};

const toNameCountPairs = (
  rec: Record<string, number> | Array<{ name: string; count: number }> | undefined,
): Array<{ name: string; count: number }> | undefined =>
  Array.isArray(rec) ? rec : rec ? Object.entries(rec).map(([name, count]) => ({ name, count })) : undefined;

/** 把报告里的 sw 直方图对象转成 {name,count} 对数组，避开按 key 名脱敏的误伤（见落盘处注释）。 */
const reshapeSwHistograms = (report: unknown): void => {
  const r = report as { byPhase?: Record<string, { sw?: SwHistogramsLike }>; totals?: { sw?: SwHistogramsLike } };
  for (const phase of Object.values(r.byPhase ?? {})) {
    if (phase?.sw) {
      phase.sw.byType = toNameCountPairs(phase.sw.byType);
      phase.sw.setKeyCombos = toNameCountPairs(phase.sw.setKeyCombos);
      phase.sw.outByType = toNameCountPairs(phase.sw.outByType);
    }
  }
  if (r.totals?.sw) {
    r.totals.sw.byType = toNameCountPairs(r.totals.sw.byType);
    r.totals.sw.setKeyCombos = toNameCountPairs(r.totals.sw.setKeyCombos);
    r.totals.sw.outByType = toNameCountPairs(r.totals.sw.outByType);
  }
};

const cloneSwHook = (hook: SwHookState): SwHookState => ({
  installedAt: hook.installedAt,
  messages: hook.messages,
  byType: { ...hook.byType },
  storageSetCount: hook.storageSetCount,
  storageSetBytes: hook.storageSetBytes,
  setKeyCombos: { ...hook.setKeyCombos },
  outMessages: hook.outMessages,
  outByType: { ...hook.outByType },
  outBuckets: { ...hook.outBuckets },
});

function addSwAcc(target: SwAcc, delta: SwAcc): void {
  target.messages += delta.messages;
  for (const [key, value] of Object.entries(delta.byType)) target.byType[key] = (target.byType[key] ?? 0) + value;
  target.setCount += delta.setCount;
  target.setBytes += delta.setBytes;
  for (const [key, value] of Object.entries(delta.setKeyCombos)) {
    target.setKeyCombos[key] = (target.setKeyCombos[key] ?? 0) + value;
  }
  target.outMessages += delta.outMessages;
  for (const [key, value] of Object.entries(delta.outByType)) {
    target.outByType[key] = (target.outByType[key] ?? 0) + value;
  }
}

function swDelta(base: SwHookState, next: SwHookState): SwAcc {
  const byType: Record<string, number> = {};
  for (const [key, value] of Object.entries(next.byType)) {
    const delta = value - (base.byType[key] ?? 0);
    if (delta > 0) byType[key] = delta;
  }
  const setKeyCombos: Record<string, number> = {};
  for (const [key, value] of Object.entries(next.setKeyCombos)) {
    const delta = value - (base.setKeyCombos[key] ?? 0);
    if (delta > 0) setKeyCombos[key] = delta;
  }
  const outByType: Record<string, number> = {};
  for (const [key, value] of Object.entries(next.outByType)) {
    const delta = value - (base.outByType[key] ?? 0);
    if (delta > 0) outByType[key] = delta;
  }
  return {
    messages: Math.max(0, next.messages - base.messages),
    byType,
    setCount: Math.max(0, next.storageSetCount - base.storageSetCount),
    setBytes: Math.max(0, next.storageSetBytes - base.storageSetBytes),
    setKeyCombos,
    outMessages: Math.max(0, next.outMessages - base.outMessages),
    outByType,
  };
}

interface PhaseProcPeak { cpuPeakPercent: number; rssPeakKb: number }

interface PhaseAcc {
  phase: DiagnosticPhase;
  startedAt: number;
  endedAt: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  rafCount: number;
  rafTotalMs: number;
  rafMaxMs: number;
  coverEvents: { start: number; end: number }[];
  sw: SwAcc;
  heapPeakBytes: number | null;
  nodesPeak: number;
  documentsPeak: number;
  procPeaks: Partial<Record<WslChromeProcessCategory, PhaseProcPeak>>;
  samples: DiagnosticSample[];
}

const newPhaseAcc = (phase: DiagnosticPhase): PhaseAcc => ({
  phase,
  startedAt: Date.now(),
  endedAt: 0,
  longTaskCount: 0,
  longTaskTotalMs: 0,
  longTaskMaxMs: 0,
  rafCount: 0,
  rafTotalMs: 0,
  rafMaxMs: 0,
  coverEvents: [],
  sw: newSwAcc(),
  heapPeakBytes: null,
  nodesPeak: 0,
  documentsPeak: 0,
  procPeaks: {},
  samples: [],
});

interface PhaseReport {
  phase: DiagnosticPhase;
  durationMs: number;
  diagnostic: ReturnType<typeof summarizeDiagnosticSamples>;
  longTask: {
    source: 'longtask' | 'raf' | 'none';
    primaryCount: number;
    primaryTotalMs: number;
    primaryMaxMs: number;
    longTaskCount: number;
    longTaskTotalMs: number;
    longTaskMaxMs: number;
    rafStallCount: number;
    rafStallTotalMs: number;
    rafStallMaxMs: number;
  };
  cover: { loadCount: number; maxConcurrency: number };
  sw: SwAcc;
  heap: { peakJsHeapUsedBytes: number | null; nodesPeak: number; documentsPeak: number };
  processPeaks: Partial<Record<WslChromeProcessCategory, PhaseProcPeak>>;
}

function maxCoverConcurrency(events: readonly { start: number; end: number }[]): number {
  if (events.length === 0) return 0;
  const deltas: Array<[number, number]> = [];
  for (const event of events) {
    deltas.push([event.start, 1]);
    deltas.push([event.end, -1]);
  }
  deltas.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let active = 0;
  let peak = 0;
  for (const [, delta] of deltas) {
    active += delta;
    if (active > peak) peak = active;
  }
  return peak;
}

function finalizePhase(acc: PhaseAcc): PhaseReport {
  const diagnostic = summarizeDiagnosticSamples(acc.samples);
  const source: 'longtask' | 'raf' | 'none' = acc.longTaskCount > 0 ? 'longtask' : acc.rafCount > 0 ? 'raf' : 'none';
  const primary = acc.longTaskCount > 0
    ? { count: acc.longTaskCount, totalMs: acc.longTaskTotalMs, maxMs: acc.longTaskMaxMs }
    : { count: acc.rafCount, totalMs: acc.rafTotalMs, maxMs: acc.rafMaxMs };
  return {
    phase: acc.phase,
    durationMs: acc.endedAt - acc.startedAt,
    diagnostic,
    longTask: {
      source,
      primaryCount: primary.count,
      primaryTotalMs: Math.round(primary.totalMs),
      primaryMaxMs: Math.round(primary.maxMs),
      longTaskCount: acc.longTaskCount,
      longTaskTotalMs: Math.round(acc.longTaskTotalMs),
      longTaskMaxMs: Math.round(acc.longTaskMaxMs),
      rafStallCount: acc.rafCount,
      rafStallTotalMs: Math.round(acc.rafTotalMs),
      rafStallMaxMs: Math.round(acc.rafMaxMs),
    },
    cover: { loadCount: acc.coverEvents.length, maxConcurrency: maxCoverConcurrency(acc.coverEvents) },
    sw: acc.sw,
    heap: {
      peakJsHeapUsedBytes: diagnostic.peakJsHeapUsedBytes,
      nodesPeak: acc.nodesPeak,
      documentsPeak: acc.documentsPeak,
    },
    processPeaks: acc.procPeaks,
  };
}

/** 通过 --user-data-dir 标记定位当前测试浏览器主进程 PID（不带 --type= 的根进程） */
function findBrowserRootPid(userDataDir: string): number {
  const result = spawnSync('ps', ['-eo', 'pid=,args='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) return 0;
  const marker = `--user-data-dir=${userDataDir}`;
  let best = 0;
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s(.*)$/);
    if (!match) continue;
    const args = match[2] ?? '';
    if (args.includes(marker) && !args.includes('--type=')) {
      const pid = Number(match[1]);
      if (pid > best) best = pid;
    }
  }
  return best;
}

/** 从 browser 主进程出发，收集整个 Chrome 进程树（ps 采样 + times 差值算 CPU%） */
class ChromeProcessTreeSampler {
  private previous = new Map<number, { times: number; at: number }>();
  private parentOf = new Map<number, number>();

  constructor(private readonly browserPid: number) {}

  sample(): WslChromeProcess[] {
    const result = spawnSync('ps', ['-eo', 'pid=,ppid=,times=,rss=,args='], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0 || !result.stdout) return [];
    const entries: Array<{ pid: number; ppid: number; times: number; rssKb: number; args: string }> = [];
    for (const line of result.stdout.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s(.*)$/);
      if (!match) continue;
      entries.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        times: Number(match[3]),
        rssKb: Number(match[4]),
        args: match[5] ?? '',
      });
    }
    if (entries.length === 0) return [];
    this.parentOf = new Map(entries.map((entry) => [entry.pid, entry.ppid]));
    const inTree = new Set<number>();
    for (const entry of entries) {
      const seen = new Set<number>();
      let current = entry.pid;
      let reachedRoot = false;
      while (!seen.has(current)) {
        seen.add(current);
        if (current === this.browserPid) { reachedRoot = true; break; }
        const parent = this.parentOf.get(current);
        if (parent === undefined) break;
        current = parent;
      }
      if (reachedRoot) inTree.add(entry.pid);
    }
    const now = Date.now();
    const processes: WslChromeProcess[] = [];
    for (const entry of entries) {
      if (!inTree.has(entry.pid)) continue;
      const prev = this.previous.get(entry.pid);
      let cpuPercent = 0;
      if (prev && entry.times >= prev.times) {
        const elapsedSeconds = (now - prev.at) / 1000;
        if (elapsedSeconds > 0) cpuPercent = (entry.times - prev.times) / elapsedSeconds * 100;
      }
      this.previous.set(entry.pid, { times: entry.times, at: now });
      processes.push({
        pid: entry.pid,
        cpuPercent,
        cpuJiffies: entry.times,
        rssKb: entry.rssKb,
        command: entry.args,
        args: entry.args,
      });
    }
    for (const pid of [...this.previous.keys()]) {
      if (!inTree.has(pid)) this.previous.delete(pid);
    }
    return processes;
  }
}

/** 单次运行的后台采样器：进程树 + 页面 drain/CDP + SW drain，2s 周期 */
class RunSampler {
  private readonly pages = new Set<Page>();
  private readonly pageCdp = new Map<Page, CDPSession | 'failed'>();
  private swWorker: Worker | null = null;
  private lastSw: SwHookState | null = null;
  private phaseAcc: PhaseAcc;
  private readonly completedPhases: PhaseAcc[] = [];
  private readonly allSamples: DiagnosticSample[] = [];
  private readonly totals: SwAcc = newSwAcc();
  private stopped = false;
  private readonly loopDone: Promise<void>;

  constructor(
    private readonly context: BrowserContext,
    private readonly proc: ChromeProcessTreeSampler,
  ) {
    this.phaseAcc = newPhaseAcc('cold');
    this.loopDone = this.loop();
  }

  trackPage(page: Page): void {
    this.pages.add(page);
  }

  setPhase(phase: DiagnosticPhase): void {
    this.phaseAcc.endedAt = Date.now();
    this.completedPhases.push(this.phaseAcc);
    this.phaseAcc = newPhaseAcc(phase);
  }

  stop(): void {
    this.stopped = true;
  }

  /** 兜底收尾：确保采样循环退出（失败路径也调），幂等 */
  async dispose(timeoutMs = 5_000): Promise<void> {
    this.stop();
    await Promise.race([this.loopDone, sleep(timeoutMs)]);
  }

  finish(): { phases: PhaseReport[]; allSamples: DiagnosticSample[]; totals: SwAcc; loopDone: Promise<void> } {
    this.stop();
    this.phaseAcc.endedAt = Date.now();
    this.completedPhases.push(this.phaseAcc);
    return {
      phases: this.completedPhases.map(finalizePhase),
      allSamples: this.allSamples,
      totals: this.totals,
      loopDone: this.loopDone,
    };
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const tickStartedAt = Date.now();
      try {
        await this.tick();
      } catch {
        // 单轮采样失败不中断运行（页面导航/CDP 抖动）
      }
      await sleep(Math.max(0, SAMPLE_INTERVAL_MS - (Date.now() - tickStartedAt)));
    }
  }

  private async tick(): Promise<void> {
    const acc = this.phaseAcc;

    const processes = this.proc.sample();
    let treeRssBytes = 0;
    let treeCpuPercent = 0;
    if (processes.length > 0) {
      const byCategory = summarizeWslChromeProcessesByCategory(processes);
      for (const [category, summary] of Object.entries(byCategory) as Array<[WslChromeProcessCategory, WslChromeProcessSummary]>) {
        const current = acc.procPeaks[category] ?? { cpuPeakPercent: 0, rssPeakKb: 0 };
        acc.procPeaks[category] = {
          cpuPeakPercent: Math.max(current.cpuPeakPercent, summary.cpuPercent),
          rssPeakKb: Math.max(current.rssPeakKb, summary.rssKb),
        };
      }
      const total = summarizeWslChromeProcesses(processes);
      treeRssBytes = total.rssKb * 1024;
      treeCpuPercent = total.cpuPercent;
    }

    let tickHeapPeakBytes: number | null = null;
    const tickLongTaskDurations: number[] = [];
    for (const page of [...this.pages]) {
      if (page.isClosed()) {
        this.pages.delete(page);
        this.pageCdp.delete(page);
        continue;
      }
      let session = this.pageCdp.get(page);
      if (session === undefined) {
        try {
          const created = await page.context().newCDPSession(page);
          await created.send('Performance.enable');
          session = created;
        } catch {
          session = 'failed';
        }
        this.pageCdp.set(page, session);
      }
      if (session !== undefined && session !== 'failed') {
        try {
          const response = await session.send('Performance.getMetrics') as {
            metrics?: Array<{ name: string; value: number }>;
          };
          for (const metric of response.metrics ?? []) {
            if (!Number.isFinite(metric.value)) continue;
            if (metric.name === 'JSHeapUsedSize' || metric.name === 'JSUsedHeapSize') {
              tickHeapPeakBytes = Math.max(tickHeapPeakBytes ?? 0, metric.value);
            } else if (metric.name === 'Nodes') {
              acc.nodesPeak = Math.max(acc.nodesPeak, metric.value);
            } else if (metric.name === 'Documents') {
              acc.documentsPeak = Math.max(acc.documentsPeak, metric.value);
            }
          }
        } catch {
          this.pageCdp.set(page, 'failed');
        }
      }
      try {
        const drain = await page.evaluate<PageDrain | null>(PAGE_DRAIN_EXPR);
        if (drain) {
          acc.longTaskCount += drain.longTaskCount;
          acc.longTaskTotalMs += drain.longTaskTotalMs;
          acc.longTaskMaxMs = Math.max(acc.longTaskMaxMs, drain.longTaskMaxMs);
          for (const duration of drain.longTaskDurations) tickLongTaskDurations.push(duration);
          acc.rafCount += drain.rafCount;
          acc.rafTotalMs += drain.rafTotalMs;
          acc.rafMaxMs = Math.max(acc.rafMaxMs, drain.rafMaxMs);
          if (drain.coverEvents.length > 0) acc.coverEvents.push(...drain.coverEvents.slice(0, 2000));
        }
      } catch {
        // 页面导航中，下一轮重试
      }
    }
    if (tickHeapPeakBytes !== null) {
      acc.heapPeakBytes = Math.max(acc.heapPeakBytes ?? 0, tickHeapPeakBytes);
    }

    await this.tickSw();

    if (treeRssBytes > 0 || (acc.heapPeakBytes ?? 0) > 0) {
      const sample: DiagnosticSample = {
        phase: acc.phase,
        module: 's0-profile',
        at: Date.now(),
        rssBytes: treeRssBytes,
        cpuPercent: treeCpuPercent,
        jsHeapUsedBytes: acc.heapPeakBytes,
        longTaskDurationsMs: tickLongTaskDurations.slice(-200),
      };
      this.allSamples.push(sample);
      // 同步进当前相，修「每相诊断恒空、只有 totals 有值」
      acc.samples.push(sample);
    }
  }

  private swTickCount = 0;

  private async tickSw(): Promise<void> {
    const workers = this.context.serviceWorkers();
    const sw = workers.find((worker) => worker.url().startsWith('chrome-extension://')) ?? workers[0] ?? null;
    if (!sw) return;
    if (this.swWorker !== sw) {
      this.swWorker = sw;
      this.lastSw = null;
      log(`[sw-hook] 发现 SW worker：${sw.url()}`);
    }
    let value: { already?: boolean; hook?: SwHookState } | undefined;
    try {
      value = (await sw.evaluate(SW_HOOK_SRC)) as { already?: boolean; hook?: SwHookState };
    } catch (error) {
      // SW 被浏览器停摆时 evaluate 会失败；停摆期无消息/storage 活动，下一轮再试
      this.swTickCount += 1;
      if (this.swTickCount === 1 || this.swTickCount % 15 === 0) {
        log(`[sw-hook] evaluate 失败（第${this.swTickCount}轮，SW 可能停摆）：${errMsg(error).split('\n')[0]}`);
      }
      return;
    }
    const hook = value?.hook;
    if (!hook) {
      this.swTickCount += 1;
      if (this.swTickCount === 1 || this.swTickCount % 15 === 0) {
        log(`[sw-hook] evaluate 无 hook（第${this.swTickCount}轮）：value=${JSON.stringify(value ?? null).slice(0, 200)}`);
      }
      return;
    }
    if (!this.lastSw || this.lastSw.installedAt !== hook.installedAt) {
      // 首次看到该 SW 实例：计数器从安装点起算，直接取基线
      this.lastSw = cloneSwHook(hook);
      log(`[sw-hook] hook 基线已取（installedAt=${hook.installedAt}，SW 重启会重新取基线）`);
      return;
    }
    const delta = swDelta(this.lastSw, hook);
    addSwAcc(this.phaseAcc.sw, delta);
    addSwAcc(this.totals, delta);
    this.lastSw = cloneSwHook(hook);
    this.swTickCount += 1;
    if (this.swTickCount % 15 === 0) {
      log(
        `[sw-hook] 周期快照：累计 msg=${this.totals.messages} set=${this.totals.setCount}次/${Math.round(this.totals.setBytes / 1024)}KB`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripProxyEnv(): void {
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete process.env[key];
  }
}

async function waitForExtensionServiceWorker(context: BrowserContext, timeoutMs: number): Promise<Worker> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const workers = context.serviceWorkers();
    const sw = workers.find((worker) => worker.url().startsWith('chrome-extension://')) ?? workers[0];
    if (sw) return sw;
    if (Date.now() >= deadline) {
      throw new Error(`service worker 未在 ${timeoutMs}ms 内出现`);
    }
    await sleep(300);
  }
}

function gitShortSha(): string {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: CWD, encoding: 'utf8' });
  return result.status === 0 && result.stdout ? result.stdout.trim() : 'unknown';
}

function extensionVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(CWD, 'dist/manifest.json'), 'utf8')) as { version?: string };
    return manifest.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// seed 守卫
// ---------------------------------------------------------------------------

async function verifySeededProfile(): Promise<GuardInfo> {
  const options = resolveExtensionHarnessOptions(process.env, CWD);
  const context = await launchExtensionContext(options, {
    headless: false,
    channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
    extraArgs: ['--no-proxy-server'],
  });
  try {
    const extensionId = await readExtensionId(context, 30_000);
    const page = await context.newPage();
    await page.goto(extensionPageUrl(extensionId, 'dashboard/dashboard.html'), {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    const result = await page.evaluate<GuardInfo>(GUARD_EXPR);
    if (result.viewed < MIN_VIEWED_FOR_MEASUREMENT) {
      throw new Error(
        `viewed 记录 ${result.viewed} < ${MIN_VIEWED_FOR_MEASUREMENT}：先跑 pnpm tsx scripts/perfProfileSeed.ts`,
      );
    }
    if (result.settingsBytes === 0) {
      throw new Error('storage.settings 缺失：先跑 pnpm tsx scripts/perfProfileSeed.ts');
    }
    log(`[guard] profile 就绪：viewed=${result.viewed} settings=${result.settingsBytes}B`);
    return result;
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// 剧本执行
// ---------------------------------------------------------------------------

/** 打开 dashboard 页；扩展刚 reload 时 Chrome 可能短暂拒绝加载扩展页（ERR_BLOCKED_BY_CLIENT），退避重试 */
async function gotoDashboard(
  page: Page,
  url: string,
  label: string,
  attempts = 6,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      return;
    } catch (error) {
      lastError = error;
      const message = String(error);
      const retryable = message.includes('ERR_BLOCKED_BY_CLIENT') || message.includes('ERR_') || message.includes('net::');
      if (!retryable || attempt === attempts) break;
      log(`[${label}] dashboard 加载失败（第${attempt}次）：${message.split('\n')[0]}，退避后重试`);
      await sleep(2_500);
    }
  }
  throw lastError;
}

/** 新版扩展首次加载 dashboard 会弹版本公告（aria-modal 拦截全部点击），测量前关掉 */
async function dismissReleaseAnnouncement(page: Page, failures: string[]): Promise<void> {
  try {
    const modal = page.locator('#jdb-release-announcement-modal');
    if ((await modal.count()) === 0) return;
    await modal.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {});
    if ((await modal.count()) === 0) return;
    await page
      .locator('#jdb-release-announcement-modal [data-action="release-announcement-close"]')
      .click({ timeout: 5_000 });
    await modal.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    log('[A] 版本公告弹窗已关闭');
  } catch (error) {
    failures.push(`A: 关闭版本公告弹窗失败: ${errMsg(error).split('\n')[0]}`);
  }
}

interface AAttributionWindow { name: string; start: number; end: number }

interface AAttribution {
  capturedAt: string;
  timeOrigin: number | null;
  windows: AAttributionWindow[];
  perTab: { name: string; count: number; totalMs: number; maxMs: number; p95Ms: number }[];
  perTabEntries: { name: string; s: number; d: number }[];
  unattributed: { count: number; totalMs: number; maxMs: number };
  steady: {
    start: number;
    end: number;
    bucketMs: number;
    buckets: number[];
    count: number;
    totalMs: number;
    maxMs: number;
    entries: { s: number; d: number }[];
    /** steady 期 rAF 帧停顿（>50ms）5s 桶：S0 证明 steady 期工作形态是帧停顿而非 longtask */
    rafBuckets: number[];
    rafCount: number;
    rafTotalMs: number;
    rafMaxMs: number;
    rafStallEntries: { s: number; d: number }[];
  };
}

interface SwOutSnapshot {
  installedAt: number;
  outMessages: number;
  outByType: Record<string, number>;
  outBuckets: Record<string, number>;
}

interface LongTaskBuffer {
  timeOrigin: number;
  entries: { s: number; d: number }[];
  rafStalls?: { t: number; d: number }[];
}

/** 长任务按 startTime（document 相对，经 timeOrigin 换算 epoch）归因到 tab 时间窗。
 * 窗口顺序且互不重叠；不属于任何窗口（冷/热启动期）的条目归 unattributed。 */
function attributeLongTasks(
  buffer: LongTaskBuffer | null,
  windows: AAttributionWindow[],
): { perTab: AAttribution['perTab']; perTabEntries: AAttribution['perTabEntries']; unattributed: AAttribution['unattributed'] } {
  const per = new Map<string, { count: number; totalMs: number; maxMs: number; durs: number[] }>();
  const unattributed = { count: 0, totalMs: 0, maxMs: 0 };
  const perTabEntries: AAttribution['perTabEntries'] = [];
  if (!buffer) return { perTab: [], perTabEntries, unattributed };
  for (const entry of buffer.entries) {
    const epoch = buffer.timeOrigin + entry.s;
    const window = windows.find((w) => epoch >= w.start && epoch < w.end);
    if (!window) {
      unattributed.count += 1;
      unattributed.totalMs += entry.d;
      if (entry.d > unattributed.maxMs) unattributed.maxMs = entry.d;
      continue;
    }
    const acc = per.get(window.name) ?? { count: 0, totalMs: 0, maxMs: 0, durs: [] };
    acc.count += 1;
    acc.totalMs += entry.d;
    if (entry.d > acc.maxMs) acc.maxMs = entry.d;
    if (acc.durs.length < 200) acc.durs.push(entry.d);
    if (perTabEntries.length < 800) perTabEntries.push({ name: window.name, s: entry.s, d: entry.d });
    per.set(window.name, acc);
  }
  const perTab = [...per.entries()]
    .map(([name, acc]) => {
      const durs = [...acc.durs].sort((a, b) => a - b);
      const p95Ms = durs.length > 0 ? durs[Math.min(durs.length - 1, Math.floor(0.95 * durs.length))] : 0;
      return { name, count: acc.count, totalMs: Math.round(acc.totalMs), maxMs: Math.round(acc.maxMs), p95Ms: Math.round(p95Ms) };
    })
    .sort((a, b) => b.totalMs - a.totalMs);
  return { perTab, perTabEntries, unattributed: { count: unattributed.count, totalMs: Math.round(unattributed.totalMs), maxMs: Math.round(unattributed.maxMs) } };
}

function buildAAttribution(
  capInteraction: LongTaskBuffer | null,
  capSteady: LongTaskBuffer | null,
  windows: AAttributionWindow[],
  steadyStart: number,
  steadyEnd: number,
): AAttribution {
  const { perTab, perTabEntries, unattributed } = attributeLongTasks(capInteraction, windows);
  const steady: AAttribution['steady'] = {
    start: steadyStart,
    end: steadyEnd,
    bucketMs: 5_000,
    buckets: [],
    count: 0,
    totalMs: 0,
    maxMs: 0,
    entries: [],
    rafBuckets: [],
    rafCount: 0,
    rafTotalMs: 0,
    rafMaxMs: 0,
    rafStallEntries: [],
  };
  if (capSteady) {
    const bucketCount = Math.max(1, Math.ceil((steadyEnd - steadyStart) / 5_000));
    steady.buckets = new Array<number>(bucketCount).fill(0);
    steady.rafBuckets = new Array<number>(bucketCount).fill(0);
    for (const entry of capSteady.entries) {
      const epoch = capSteady.timeOrigin + entry.s;
      if (epoch < steadyStart || epoch >= steadyEnd) continue;
      const idx = Math.min(bucketCount - 1, Math.floor((epoch - steadyStart) / 5_000));
      steady.buckets[idx] += 1;
      steady.count += 1;
      steady.totalMs += entry.d;
      if (entry.d > steady.maxMs) steady.maxMs = entry.d;
      if (steady.entries.length < 200) steady.entries.push({ s: Math.round(epoch - steadyStart), d: Math.round(entry.d) });
    }
    for (const stall of capSteady.rafStalls ?? []) {
      const epoch = capSteady.timeOrigin + stall.t;
      if (epoch < steadyStart || epoch >= steadyEnd) continue;
      const idx = Math.min(bucketCount - 1, Math.floor((epoch - steadyStart) / 5_000));
      steady.rafBuckets[idx] += 1;
      steady.rafCount += 1;
      steady.rafTotalMs += stall.d;
      if (stall.d > steady.rafMaxMs) steady.rafMaxMs = stall.d;
      if (steady.rafStallEntries.length < 200) steady.rafStallEntries.push({ s: Math.round(epoch - steadyStart), d: Math.round(stall.d) });
    }
  }
  steady.totalMs = Math.round(steady.totalMs);
  steady.maxMs = Math.round(steady.maxMs);
  steady.rafTotalMs = Math.round(steady.rafTotalMs);
  steady.rafMaxMs = Math.round(steady.rafMaxMs);
  return {
    capturedAt: new Date().toISOString(),
    timeOrigin: capInteraction?.timeOrigin ?? capSteady?.timeOrigin ?? null,
    windows,
    perTab,
    perTabEntries,
    unattributed,
    steady,
  };
}

/** 剧本 A：dashboard 控制面板（13 tab 两轮连切 + 媒体库搜索 + 空闲）。
 * S1 归因：记录每次 tab 点击的 epoch 时间窗；interaction/steady 边界读长任务原始缓冲，
 * 归因「哪个 tab 切换最慢」与「空闲期周期性工作」。 */
async function runScenarioA(
  context: BrowserContext,
  extensionId: string,
  sampler: RunSampler,
  durations: Durations,
  failures: string[],
): Promise<{ tInteractiveMs: number; attribution: AAttribution | null; loafTop: LoafTopEntry[] }> {
  const page = await context.newPage();
  sampler.trackPage(page);
  const startedAt = Date.now();
  await gotoDashboard(page, extensionPageUrl(extensionId, 'dashboard/dashboard.html'), 'A');
  let tInteractiveMs = Date.now() - startedAt;
  try {
    await page.waitForSelector('button.dashboard-main-tab', { timeout: durations.coldWaitMs });
    tInteractiveMs = Date.now() - startedAt;
  } catch {
    failures.push('A: 导航 tab 未在冷启动窗口内出现');
  }
  await dismissReleaseAnnouncement(page, failures);
  log(`[A] 可交互=${tInteractiveMs}ms，进入冷启动 settle`);
  await sleep(durations.coldSettleMs);

  sampler.setPhase('warmup');
  log('[A] phase: warmup');
  await sleep(durations.warmupMs);

  sampler.setPhase('interaction');
  log(`[A] phase: interaction（${durations.tabRounds} 轮 × ${DASHBOARD_NAV.length} tab，两级导航）`);
  const windows: AAttributionWindow[] = [];
  for (let round = 0; round < durations.tabRounds; round += 1) {
    for (const nav of DASHBOARD_NAV) {
      const tabWindowStart = Date.now();
      try {
        await page.click(`button.dashboard-main-tab[data-nav-group-id="${nav.group}"]`, { timeout: 10_000 });
        if (nav.sub) {
          await page.click(`button.dashboard-sub-tab[data-tab="${nav.tab}"]`, { timeout: 10_000 });
        }
      } catch (error) {
        failures.push(`A: tab 点击失败 ${nav.tab}: ${errMsg(error)}`);
      }
      await sleep(durations.tabSettleMs);
      windows.push({ name: `r${round + 1}:${nav.tab}`, start: tabWindowStart, end: Date.now() });
    }
  }
  const searchWindowStart = Date.now();
  try {
    await page.click('button.dashboard-main-tab[data-nav-group-id="media"]', { timeout: 10_000 });
    await sleep(500);
    // 媒体库 tab 由 React（MediaLibraryPage.tsx）接管，静态 partial 的 #mediaLibrarySearch 已被替换
    const search = page.locator('.ml-view-search input[type="search"]');
    await search.click({ timeout: 10_000 });
    await search.pressSequentially('PERF-0', { delay: 30 });
    await sleep(800);
    await search.pressSequentially('1', { delay: 30 });
    await sleep(800);
    await search.fill('');
    await sleep(400);
    await search.pressSequentially('LUXU', { delay: 30 });
    await sleep(800);
    await search.fill('');
    await sleep(400);
  } catch (error) {
    failures.push(`A: 媒体库搜索交互失败: ${errMsg(error)}`);
  }
  windows.push({ name: 'media-search', start: searchWindowStart, end: Date.now() });
  const capInteraction = await page.evaluate<LongTaskBuffer | null>(LONGTASK_ALL_EXPR).catch(() => null);

  sampler.setPhase('steady');
  log(`[A] phase: steady（${durations.steadyMsA}ms）`);
  const steadyStart = Date.now();
  await sleep(durations.steadyMsA);
  const steadyEnd = Date.now();
  const capSteady = await page.evaluate<LongTaskBuffer | null>(LONGTASK_ALL_EXPR).catch(() => null);
  const attribution = buildAAttribution(capInteraction, capSteady, windows, steadyStart, steadyEnd);

  sampler.setPhase('cooldown');
  log('[A] phase: cooldown');
  await sleep(durations.cooldownMs);

  const loafTop = await captureLoafTop(page);
  await page.close().catch(() => {});
  return { tInteractiveMs, attribution, loafTop };
}

/** 剧本 B：原站列表页（增强全开）→ 详情页（smart 调度）→ 停留滚动 → 关闭 */
async function runScenarioB(
  context: BrowserContext,
  listUrl: string,
  arm: Arm,
  sampler: RunSampler,
  durations: Durations,
  failures: string[],
): Promise<{ tInteractiveMs: number; loafTop: Record<string, LoafTopEntry[]> }> {
  await context.addCookies([
    { name: 'over18', value: '1', domain: 'javdb570.com', path: '/' },
  ]).catch(() => {});
  const page = await context.newPage();
  sampler.trackPage(page);
  const startedAt = Date.now();
  let siteLoaded = false;
  try {
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: durations.siteGotoMs });
    siteLoaded = true;
  } catch (error) {
    failures.push(`B: 列表页加载失败: ${errMsg(error)}`);
  }
  if (!siteLoaded) {
    sampler.setPhase('cooldown');
    await sleep(1_000);
    await page.close().catch(() => {});
    return { tInteractiveMs: 0, loafTop: {} };
  }

  // 18+ 门兜底：等按钮可见再点击（DCL 时弹窗可能尚未渲染，一次性检查会漏；探针实测 56ms 后可见，给 15s 余量）
  for (let round = 0; round < 2; round += 1) {
    const yes = page.locator('a[href*="over18?respond=1"]').first();
    try {
      await yes.waitFor({ state: 'visible', timeout: 15_000 });
    } catch {
      break; // 无年龄门（已验证或不在门页）
    }
    try {
      await yes.click({ timeout: 10_000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
      await sleep(1_000);
    } catch (error) {
      failures.push(`B: 年龄门点击失败: ${errMsg(error)}`);
      break;
    }
  }
  // 登录墙检测：年龄门之后仍停在 /login 且无门按钮 = 匿名会话看不了列表（2026-09 站点策略），快速失败并给出修复路径
  const onLoginPage = await page.evaluate(() => location.pathname.startsWith('/login')).catch(() => false);
  const over18Count = await page.locator('a[href*="over18?respond=1"]').count().catch(() => 0);
  if (onLoginPage && over18Count === 0) {
    failures.push('B: 站点登录墙（年龄验证后仍停留 /login，列表不渲染）——先运行 pnpm tsx scripts/loginPerfS0.ts 在 perf-s0 profile 建立登录态后重跑');
    sampler.setPhase('cooldown');
    await sleep(1_000);
    await page.close().catch(() => {});
    return { tInteractiveMs: 0, loafTop: {} };
  }

  let tInteractiveMs = Date.now() - startedAt;
  if (arm === 'enhanced') {
    try {
      await page.waitForSelector('.x-btn, .jdb-list-status-actions', { timeout: durations.enhancedMarkerMs });
      tInteractiveMs = Date.now() - startedAt;
    } catch {
      tInteractiveMs = Date.now() - startedAt;
      failures.push('B: 增强标记（.x-btn/.jdb-list-status-actions）未出现——站点可能被拦截或增强未注入');
    }
  } else {
    await sleep(durations.controlColdMs);
    tInteractiveMs = Date.now() - startedAt;
  }
  log(`[B] 列表可交互/增强注入=${tInteractiveMs}ms`);
  await sleep(durations.coldSettleMs);

  sampler.setPhase('warmup');
  log('[B] phase: warmup');
  await sleep(durations.warmupMs);

  sampler.setPhase('interaction');
  log(`[B] phase: interaction（${durations.scrollRounds}×scroll + 详情停留 ${durations.detailDwellMs}ms）`);
  for (let i = 0; i < durations.scrollRounds; i += 1) {
    await page.evaluate(() => window.scrollBy(0, 1400)).catch(() => {});
    await sleep(durations.scrollIntervalMs);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await sleep(500);
  const loafList = await captureLoafTop(page);
  let detailOpened = false;
  try {
    await page.click('a.box[href^="/v/"]', { timeout: 15_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });
    detailOpened = true;
    log('[B] 详情页已打开');
  } catch (error) {
    failures.push(`B: 详情页打开失败: ${errMsg(error)}`);
  }
  if (detailOpened) {
    const scrolls = Math.max(1, Math.round(durations.detailDwellMs / durations.detailScrollIntervalMs));
    for (let i = 0; i < scrolls; i += 1) {
      await sleep(durations.detailScrollIntervalMs);
      await page.evaluate(() => window.scrollBy(0, 1600)).catch(() => {});
    }
  } else {
    await sleep(durations.detailDwellMs);
  }

  sampler.setPhase('steady');
  log(`[B] phase: steady（${durations.steadyMsB}ms，详情页前台 smart 调度）`);
  await sleep(durations.steadyMsB);

  const loafDetail = detailOpened ? await captureLoafTop(page) : [];
  sampler.setPhase('cooldown');
  log('[B] phase: cooldown（goBack）');
  try {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (error) {
    failures.push(`B: goBack 失败: ${errMsg(error)}`);
  }
  await sleep(durations.cooldownMs);
  await page.close().catch(() => {});
  const loafTop: Record<string, LoafTopEntry[]> = {};
  if (loafList.length > 0) loafTop.list = loafList;
  if (loafDetail.length > 0) loafTop.detail = loafDetail;
  return { tInteractiveMs, loafTop };
}

// ---------------------------------------------------------------------------
// 单跑编排 + 报告
// ---------------------------------------------------------------------------

interface RunReport {
  meta: {
    tool: string;
    scenario: Scenario;
    arm: Arm;
    repeat: number;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    extensionId: string;
    extensionVersion: string;
    gitSha: string;
    profileDir: string;
    siteListUrl: string | null;
    featuresOff: string[];
    quick: boolean;
    seedGuard: GuardInfo | null;
    fatalError: string | null;
  };
  tInteractiveMs: number;
  /** B6 函数级卡顿归因：页面名 → top-N（LoAF attributions 聚合） */
  loafTop: Record<string, LoafTopEntry[]> | null;
  byPhase: Record<string, PhaseReport>;
  totals: {
    diagnostic: ReturnType<typeof summarizeDiagnosticSamples>;
    sw: SwAcc;
    processPeaks: Partial<Record<WslChromeProcessCategory, PhaseProcPeak>>;
  };
  failures: string[];
}

function summarizeProcPeaks(phases: readonly PhaseReport[]): Partial<Record<WslChromeProcessCategory, PhaseProcPeak>> {
  const merged: Partial<Record<WslChromeProcessCategory, PhaseProcPeak>> = {};
  for (const phase of phases) {
    for (const [category, peak] of Object.entries(phase.processPeaks) as Array<[WslChromeProcessCategory, PhaseProcPeak]>) {
      const current = merged[category] ?? { cpuPeakPercent: 0, rssPeakKb: 0 };
      merged[category] = {
        cpuPeakPercent: Math.max(current.cpuPeakPercent, peak.cpuPeakPercent),
        rssPeakKb: Math.max(current.rssPeakKb, peak.rssPeakKb),
      };
    }
  }
  return merged;
}

/** 进程树峰值汇总行（diag.peakRssBytes 恒 0，真实进程数据在 processPeaks 里） */
function processPeaksLine(peaks: Partial<Record<WslChromeProcessCategory, PhaseProcPeak>>): string {
  let rssKb = 0;
  let cpuPercent = 0;
  for (const peak of Object.values(peaks)) {
    rssKb += peak.rssPeakKb ?? 0;
    cpuPercent = Math.max(cpuPercent, peak.cpuPeakPercent ?? 0);
  }
  if (rssKb === 0) return 'rss峰值=- cpu峰值=-';
  return `rss峰值=${Math.round(rssKb / 1024)}MB cpu峰值=${cpuPercent.toFixed(1)}%`;
}

function printRunSummary(label: string, report: RunReport): void {
  log(
    `[summary ${label}] 时长=${Math.round(report.meta.durationMs / 1000)}s 可交互=${report.tInteractiveMs}ms 失败=${report.failures.length}`
    + (report.meta.fatalError ? ` 致命=${report.meta.fatalError.split('\n')[0]}` : ''),
  );
  for (const phase of Object.values(report.byPhase)) {
    const lt = phase.longTask;
    const diag = phase.diagnostic;
    log(
      `  [${phase.phase}] ${Math.round(phase.durationMs / 1000)}s `
      + `longTask(${lt.source})=${lt.primaryCount}个/${lt.primaryTotalMs}ms `
      + processPeaksLine(phase.processPeaks) + ' '
      + `heap峰值=${diag.peakJsHeapUsedBytes === null ? '-' : Math.round(diag.peakJsHeapUsedBytes / 1024 / 1024)}MB `
      + `swMsg=${phase.sw.messages} swOut=${phase.sw.outMessages} `
      + `swSet=${phase.sw.setCount}次/${Math.round(phase.sw.setBytes / 1024)}KB `
      + `cover并发=${phase.cover.maxConcurrency}`,
    );
  }
  const totals = report.totals;
  log(
    `  [totals] longTaskP95=${totals.diagnostic.longTaskP95Ms ?? '-'}ms `
    + `swMsg=${totals.sw.messages} swOut=${totals.sw.outMessages} swSet=${totals.sw.setCount}次/${Math.round(totals.sw.setBytes / 1024)}KB `
    + 'sw类型=' + JSON.stringify(totals.sw.byType)
    + ' sw出站类型=' + JSON.stringify(totals.sw.outByType)
    + ' storage写=' + JSON.stringify(totals.sw.setKeyCombos),
  );
  if (warnIfStaleSwSignature(totals.sw.setKeyCombos)) {
    log(
      '  [warn] 检测到 taskCenter:snapshot 与 taskCenter:dedupeIndex 独立双写（B5-4 前特征）'
      + '——当前 SW 可能不是 dist 最新代码（SW 缓存未刷新），本 run 的 SW 侧指标不可信！',
    );
  }
}

/**
 * SW 新鲜度守卫（2026-09-07 事故教训）：
 * Chrome 对 manifest version 未变化的 unpacked 扩展不保证刷新已注册的 service worker，
 * profile 的 Default/Service Worker/ScriptCache 里的旧 SW 脚本会被跨次启动复用
 * （实证：build-119 落盘后 14:53/15:35/16:18 的所有「after」跑仍执行旧 SW，
 * storage 写呈现 B5-4 之前的双写模式，导致 S2 复测结论失真）。
 * 因此每次 profile 启动前强制清除 SW 脚本缓存与注册库。
 * 安全边界：只允许操作 .test-profiles 下的可丢弃测试 profile，拒绝一切真实 Chrome profile。
 */
function purgeServiceWorkerCache(userDataDir: string): void {
  const rel = path.relative(CWD, userDataDir);
  if (!rel || rel.startsWith('..') || !rel.startsWith('.test-profiles')) {
    throw new Error(`拒绝清除 SW 缓存：${userDataDir} 不在 .test-profiles 下（安全边界）`);
  }
  for (const sub of ['Default/Service Worker/ScriptCache', 'Default/Service Worker/Database']) {
    const dir = path.join(userDataDir, sub);
    if (!existsSync(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    log(`[guard] 已清除 SW 缓存（防旧 SW 复用）：${path.relative(CWD, dir)}`);
  }
}

/**
 * 旧 SW 双写特征检测（belt & suspenders）：B5-4 之后 taskCenter 快照与 dedupeIndex
 * 只会以合并 combo（两 key 同次 set）落盘；若 totals 中同时出现两个独立单 key 写，
 * 说明正在执行的 SW 不是当前 dist 代码（缓存/注册未刷新）。
 */
function warnIfStaleSwSignature(setKeyCombos: Record<string, number>): boolean {
  const names = Object.keys(setKeyCombos);
  return names.includes('taskCenter:snapshot') && names.includes('taskCenter:dedupeIndex');
}

async function runProfile(job: Job, args: Args, guard: GuardInfo | null): Promise<void> {
  const label = `s0-${job.scenario}-${job.arm}-r${job.repeat}`;
  const durations = resolveDurations(args.quick);
  const startedAt = Date.now();
  const failures: string[] = [];
  log(`[${label}] 开始（quick=${args.quick}）`);

  // fail-fast：参数/业务点开关校验在启动浏览器前完成
  const effectiveSettings = resolveEffectiveSettings(job.arm, args.disableVideo === true, args.featuresOff);
  const options = resolveExtensionHarnessOptions(process.env, CWD);
  purgeServiceWorkerCache(options.userDataDir);
  const launchOptions = {
    headless: false,
    channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
    extraArgs: ['--no-proxy-server'],
  };

  // --- 测量浏览器（每 run 全新启动） ---
  // 注意：不用 chrome.runtime.reload()（--load-extension 场景下 reload 后 SW 不再复活、
  // 扩展页持续 ERR_BLOCKED_BY_CLIENT，probe 已证实）；也不用跨浏览器持久化设置
  // （chrome.storage.local 快速关闭时不保证落盘）。getSettings() 全程实时读存储并
  // 与 DEFAULT_SETTINGS 合并（无全局缓存），所以直接在测量浏览器内写 arm 设置即生效。
  const context = await launchExtensionContext(options, launchOptions);
  let sampler: RunSampler | null = null;
  let runError: string | null = null;
  try {
    const extensionId = await readExtensionId(context, 30_000);
    const sw = await waitForExtensionServiceWorker(context, 30_000);
    await sw.evaluate((data: Record<string, unknown>) => chrome.storage.local.set(data), {
      settings: effectiveSettings,
    });
    const readBack = await sw.evaluate(() => chrome.storage.local.get('settings')) as {
      settings?: unknown;
    };
    if (stableStringify(readBack?.settings) !== stableStringify(effectiveSettings)) {
      throw new Error(`${job.arm} 臂设置读回不一致，对照组无效${args.disableVideo ? '（disableVideo）' : ''}`);
    }
    context.addInitScript(PAGE_HOOK_SRC);
    if (args.featuresOff && args.featuresOff.length > 0) {
      log(`[${label}] B6 业务点关闭：${args.featuresOff.join('+')}`);
    }
    log(`[${label}] ${job.arm} 臂设置已写入并校验`);
    log(`[${label}] ${job.arm} 臂就绪，开始测量`);

    // --- 测量起点 ---
    const browserPid = findBrowserRootPid(options.userDataDir);
    if (browserPid === 0) {
      log(`[${label}] 警告：未能通过 user-data-dir 定位浏览器主进程 PID，进程树指标将为空`);
    }
    sampler = new RunSampler(context, new ChromeProcessTreeSampler(browserPid));
    let finished: ReturnType<RunSampler['finish']> | null = null;
    let tInteractiveMs = 0;
    let attribution: AAttribution | null = null;
    let swOut: SwOutSnapshot | null = null;
    let loafTop: Record<string, LoafTopEntry[]> | null = null;
    try {
      if (job.scenario === 'A') {
        const result = await runScenarioA(context, extensionId, sampler, durations, failures);
        tInteractiveMs = result.tInteractiveMs;
        attribution = result.attribution;
        if (result.loafTop.length > 0) loafTop = { dashboard: result.loafTop };
        swOut = await captureSwOut(context);
        printAAttribution(label, attribution, swOut);
      } else {
        const result = await runScenarioB(context, args.listPage ?? SITE_LIST_URL, job.arm, sampler, durations, failures);
        tInteractiveMs = result.tInteractiveMs;
        if (Object.keys(result.loafTop).length > 0) loafTop = result.loafTop;
      }
      if (loafTop) printLoafTop(label, loafTop);
      finished = sampler.finish();
      await Promise.race([finished.loopDone, sleep(5_000)]);
    } catch (error) {
      runError = errMsg(error);
      failures.push(`致命错误：${runError}`);
      log(`[${label}] 测量阶段异常：${runError.split('\n')[0]}`);
      if (!finished) {
        finished = sampler.finish();
        await Promise.race([finished.loopDone, sleep(5_000)]);
      }
    }
    const { phases, allSamples, totals } = finished;

    const byPhase: Record<string, PhaseReport> = {};
    for (const phase of phases) byPhase[phase.phase] = phase;
    const report: RunReport = {
      meta: {
        tool: 'perfS0Profile',
        scenario: job.scenario,
        arm: job.arm,
        repeat: job.repeat,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        extensionId,
        extensionVersion: extensionVersion(),
        gitSha: gitShortSha(),
        profileDir: path.relative(CWD, PROFILE_DIR),
        siteListUrl: job.scenario === 'B' ? (args.listPage ?? SITE_LIST_URL) : null,
        featuresOff: args.featuresOff ?? [],
        quick: args.quick,
        seedGuard: guard,
        fatalError: runError,
      },
      tInteractiveMs,
      loafTop,
      byPhase,
      totals: {
        diagnostic: summarizeDiagnosticSamples(allSamples),
        sw: totals,
        processPeaks: summarizeProcPeaks(phases),
      },
      failures,
    };
    // redactDiagnosticPayload 按 key 名脱敏（SENSITIVE_KEY_PATTERN 含 'query'），直方图 key 如
    // "DB:ACTORS_QUERY" 的值会被误脱敏为 "[REDACTED]"，造成消息类型直方图静默丢桶。
    // 落盘前先把 sw 直方图对象转成 {name,count} 对数组：类型名转为非敏感 key 下的 *值* 得以完整保留
    // （报告 JSON 形态说明见 research/profiling.md 口径节）。只改克隆体，report 原样供 printRunSummary 用。
    const reshaped = JSON.parse(JSON.stringify(report)) as unknown;
    reshapeSwHistograms(reshaped);
    const redacted = redactDiagnosticPayload(reshaped);
    mkdirSync(args.outDir, { recursive: true });
    const outPath = path.join(args.outDir, `${label}.json`);
    writeFileSync(outPath, `${JSON.stringify(redacted, null, 2)}\n`, 'utf8');
    log(`[${label}] 报告已落盘 ${outPath}`);
    printRunSummary(label, report);
    if (attribution) {
      // sidecar 只含性能元数据（tab 名/时间戳/消息类型名/计数），不走脱敏主报告通道
      const sidecarPath = path.join(args.outDir, `${label}-attribution.json`);
      writeFileSync(sidecarPath, `${JSON.stringify({ attribution, swOut }, null, 2)}\n`, 'utf8');
      log(`[${label}] 归因 sidecar 已落盘 ${sidecarPath}`);
    }
  } finally {
    // 兜底：无论成功/异常都确保采样循环退出（避免僵尸 node 进程），再关浏览器
    if (sampler) await sampler.dispose(5_000);
    await context.close();
  }
}

/** SW 出站快照（归因 sidecar 专用；主报告仍用采样器逐相 delta，口径不变） */
async function captureSwOut(context: BrowserContext): Promise<SwOutSnapshot | null> {
  const sw = context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'))
    ?? context.serviceWorkers()[0]
    ?? null;
  if (!sw) return null;
  try {
    return (await sw.evaluate(SW_OUT_EXPR)) as SwOutSnapshot | null;
  } catch {
    return null;
  }
}

/** 归因紧凑摘要：慢 tab 排行 + steady 5s 桶 + SW 出站；完整数据在 sidecar JSON */
function printAAttribution(label: string, attribution: AAttribution | null, swOut: SwOutSnapshot | null): void {
  if (!attribution) {
    log(`[${label}] 归因数据不可用`);
    return;
  }
  const top = attribution.perTab.slice(0, 8)
    .map((tab) => `${tab.name} ${tab.count}个/${tab.totalMs}ms(max ${tab.maxMs})`)
    .join(' | ');
  log(`[${label}] tab归因(按totalMs): ${top || '-'}`);
  log(`[${label}] 未归因(冷/热启动) = ${attribution.unattributed.count}个/${attribution.unattributed.totalMs}ms(max ${attribution.unattributed.maxMs})`);
  const buckets = attribution.steady.buckets
    .map((count, idx) => (count > 0 ? `${idx * 5}s:${count}` : ''))
    .filter(Boolean)
    .join(' ');
  log(`[${label}] steady长任务5s桶: ${buckets || '(无)'} 共=${attribution.steady.count}个/${attribution.steady.totalMs}ms(max ${attribution.steady.maxMs})`);
  const rafBuckets = attribution.steady.rafBuckets
    .map((count, idx) => (count > 0 ? `${idx * 5}s:${count}` : ''))
    .filter(Boolean)
    .join(' ');
  log(`[${label}] steady rAF帧停顿5s桶: ${rafBuckets || '(无)'} 共=${attribution.steady.rafCount}个/${attribution.steady.rafTotalMs}ms(max ${attribution.steady.rafMaxMs})`);
  if (swOut) {
    const outBuckets = Object.entries(swOut.outBuckets)
      .map(([bucket, count]) => `${Number(bucket) * 5}s:${count}`)
      .join(' ');
    log(`[${label}] SW出站 共=${swOut.outMessages} 5s桶: ${outBuckets || '(无)'} 类型=${JSON.stringify(swOut.outByType)}`);
  } else {
    log(`[${label}] SW出站快照不可用`);
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  const args: Args = {
    scenario: 'A',
    arm: 'enhanced',
    repeat: 1,
    quick: false,
    matrix: false,
    noGuard: false,
    outDir: DEFAULT_OUT_DIR,
    featuresOff: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = (): string => {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`参数 ${token} 缺少取值`);
      return value;
    };
    switch (token) {
      case '--scenario': {
        const value = next().toUpperCase();
        if (value !== 'A' && value !== 'B') throw new Error(`--scenario 只接受 A|B，收到 ${value}`);
        args.scenario = value;
        break;
      }
      case '--arm': {
        const value = next();
        if (value !== 'enhanced' && value !== 'control') throw new Error(`--arm 只接受 enhanced|control，收到 ${value}`);
        args.arm = value;
        break;
      }
      case '--repeat': {
        args.repeat = Math.max(1, Math.trunc(Number(next()) || 1));
        break;
      }
      case '--quick':
        args.quick = true;
        break;
      case '--matrix':
        args.matrix = true;
        break;
      case '--no-guard':
        args.noGuard = true;
        break;
      case '--disable-video':
        args.disableVideo = true;
        break;
      case '--features-off': {
        args.featuresOff = next().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      }
      case '--out':
        args.outDir = path.resolve(next());
        break;
      case '--list-page':
        args.listPage = next();
        break;
      default:
        throw new Error(`未知参数：${token}`);
    }
  }
  return args;
}

function buildJobs(args: Args): Job[] {
  if (args.matrix) {
    const jobs: Job[] = [];
    for (const scenario of ['A', 'B'] as const) {
      for (const arm of ['enhanced', 'control'] as const) {
        for (let repeat = 1; repeat <= 3; repeat += 1) jobs.push({ scenario, arm, repeat });
      }
    }
    return jobs;
  }
  if (args.quick) return [{ scenario: 'A', arm: 'enhanced', repeat: 1 }];
  const jobs: Job[] = [];
  for (let repeat = 1; repeat <= args.repeat; repeat += 1) {
    jobs.push({ scenario: args.scenario, arm: args.arm, repeat });
  }
  return jobs;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  stripProxyEnv();
  process.env.JAVDB_EXTENSION_PROFILE = PROFILE_DIR;
  process.env.JAVDB_EXTENSION_USE_CHROME_DATA = '0';

  const jobs = buildJobs(args);
  log(`[perfS0Profile] 任务数=${jobs.length} quick=${args.quick} 输出=${args.outDir}`);

  let guard: GuardInfo | null = null;
  if (!args.noGuard) {
    guard = await verifySeededProfile();
  } else {
    log('[guard] 已跳过（--no-guard）');
  }

  let failedRuns = 0;
  for (const job of jobs) {
    try {
      await runProfile(job, args, guard);
    } catch (error) {
      failedRuns += 1;
      log(`[perfS0Profile] 运行失败 s0-${job.scenario}-${job.arm}-r${job.repeat}: ${errMsg(error)}`);
    }
    // 等 leveldb 锁释放后再启下一个全新浏览器
    await sleep(1_500);
  }
  log(`[perfS0Profile] 完成：成功=${jobs.length - failedRuns} 失败=${failedRuns}`);
  if (failedRuns > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[perfS0Profile] 失败：', error);
  process.exitCode = 1;
});
