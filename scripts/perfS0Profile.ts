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
 *   pnpm tsx scripts/perfS0Profile.ts --scenario C --pages detail --tabs 16            # 16 个影片详情页（需 perf-s0 登录态）
 *   pnpm tsx scripts/perfS0Profile.ts --scenario C --pages mix                         # 8 详情+6 列表+2 演员（混合真实用法，需登录态）
 *   pnpm tsx scripts/perfS0Profile.ts --no-guard                                       # 跳过 seed 守卫（已知数据就绪时）
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  attributeLoafCpuToTasks,
  aggregateOrchCpuAttributions,
  type OrchTimelineEntry,
  type LoafCpuEntry,
} from './perfS0OrchCpuAttribution';

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

type Scenario = 'A' | 'B' | 'C';
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
  steadyMsC: number;
  cStaggerMs: number;
  cScrollRounds: number;
  cScrollIntervalMs: number;
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
        steadyMsC: 10_000,
        cStaggerMs: 200,
        cScrollRounds: 3,
        cScrollIntervalMs: 400,
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
        steadyMsC: 60_000,
        cStaggerMs: 250,
        cScrollRounds: 6,
        cScrollIntervalMs: 800,
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
  /** 剧本 C：并发打开的原站 tab 数（模拟用户 15+ 页并发） */
  tabs: number;
  /** 剧本 C：页面组成——list（全列表页，cycle-5 默认口径）/ detail（全影片详情页）/ mix（8 详情+6 列表+2 演员，混合真实用法） */
  pages: 'list' | 'detail' | 'mix';
  quick: boolean;
  matrix: boolean;
  noGuard: boolean;
  outDir: string;
  listPage?: string;
  disableVideo?: boolean;
  /** B6 业务点开关矩阵：要关闭的功能点名（仅 enhanced 臂有效） */
  featuresOff?: string[];
  /** 剧本 A 全程 CDP 跟踪（V8 CPU 采样 + 时间轴），落 zip 供 parseDashboardTrace 归因 */
  cdpTrace: boolean;
  /** 逐 tick 进程分类 CPU/RSS 时间轴 JSONL（浏览器级复合负载分析） */
  procTimeline: boolean;
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
            state.loafAll.push({ s: entry.startTime, d: entry.duration, b: entry.blockingDuration ?? 0, inv: inv, u: u, f: f });
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
    storageByKey: {},
    outMessages: 0,
    outByType: {},
    outBuckets: {},
    // S2-1 SW 主线程归因（sidecar 专用）：事件循环延迟 500ms 桶 / 入站类型 500ms 桶 / storage.get 直方图
    inTypeBuckets: {},
    stallBuckets: {},
    maxStallMs: 0,
    storageGetCount: 0,
    storageGetByKey: {},
    stallTimer: null,
    // S2-2 r3: 事件级时间戳 sidecar 缓冲（入站 request-lease / complete，出站 lease-prompt；定案尾部丢点）
    swEvents: [],
  };
  self.__s0Hook = hook;
  self.__s0Snapshots = [];
  try {
    chrome.runtime.onMessage.addListener((msg, sender) => {
      try {
        let type = 'unknown';
        if (msg && typeof msg === 'object') type = String(msg.type || msg.action || msg.command || 'unknown');
        else type = typeof msg;
        hook.messages += 1;
        hook.byType[type] = (hook.byType[type] || 0) + 1;
        try {
          const bucket = Math.floor((Date.now() - hook.installedAt) / 500);
          const arr = hook.inTypeBuckets[type] || (hook.inTypeBuckets[type] = []);
          arr[bucket] = (arr[bucket] || 0) + 1;
        } catch (err) {}
        // S2-2 r3: 租约关键消息记精确 ms（{e, at, tab, id}；at 相对 installedAt）
        if (type === 'task-center:request-lease' || type === 'task-center:complete') {
          try {
            if (hook.swEvents.length < 200000) {
              let tid = -1;
              try { tid = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : -1; } catch (err2) {}
              let taskId = '';
              try { taskId = String((msg.payload && (msg.payload.taskId || msg.payload.id)) || ''); } catch (err2) {}
              hook.swEvents.push({ e: type === 'task-center:request-lease' ? 'rl' : 'c', at: Date.now() - hook.installedAt, tab: tid, id: taskId });
            }
          } catch (err) {}
        }
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
        // per-key 字节归因（近似：逐 key 单独序列化，多 key set 的合计略小于整体长度，够用相对归因）
        try {
          for (const [k, v] of Object.entries(items || {})) {
            let kb = 0;
            try { kb = (JSON.stringify(v) || '').length; } catch (err) {}
            if (!hook.storageByKey[k]) hook.storageByKey[k] = { count: 0, bytes: 0 };
            hook.storageByKey[k].count += 1;
            hook.storageByKey[k].bytes += kb;
            // S0-2 field-level diff: capture full payload at taskCenter write points (separate buffer, not in the hook object, to avoid heavy per-tick serialization)
            if ((k === 'taskCenter:snapshot' || k === 'taskCenter:dedupeIndex') && self.__s0Snapshots) {
              try { self.__s0Snapshots.push({ k: k, at: Date.now() - hook.installedAt, c: combo, len: kb, t: JSON.stringify(v) || '' }); } catch (err) {}
            }
          }
        } catch (err) {}
      } catch (err) {}
      return origSet(items, callback);
    };
  } catch (err) {}
  try {
    const slForGet = chrome.storage.local;
    const origGet = slForGet.get.bind(slForGet);
    slForGet.get = function (keys, callback) {
      try {
        hook.storageGetCount += 1;
        let keyName = 'unknown';
        try {
          if (Array.isArray(keys)) keyName = keys.map(String).sort().join('+');
          else if (typeof keys === 'string') keyName = keys;
          else if (keys == null) keyName = 'all';
          else keyName = 'obj';
        } catch (err) {}
        hook.storageGetByKey[keyName] = (hook.storageGetByKey[keyName] || 0) + 1;
      } catch (err) {}
      return origGet.call(slForGet, keys, callback);
    };
  } catch (err) {}
  try {
    // S2-1 事件循环延迟探针：100ms tick，实际-期望漂移 >5ms 记入 500ms 桶（SW 主线程忙的直接证据）
    let nextTick = Date.now() + 100;
    hook.stallTimer = setInterval(() => {
      try {
        const now = Date.now();
        const drift = now - nextTick;
        nextTick += 100;
        if (drift > 5) {
          const bucket = Math.floor((now - hook.installedAt) / 500);
          hook.stallBuckets[bucket] = (hook.stallBuckets[bucket] || 0) + drift;
          if (drift > hook.maxStallMs) hook.maxStallMs = drift;
        }
        if (nextTick < now - 1000) nextTick = now + 100;
      } catch (err) {}
    }, 100);
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
      try {
        if (message && message.type === 'task-center:lease-prompt' && hook.swEvents.length < 200000) {
          hook.swEvents.push({ e: 'lp', at: Date.now() - hook.installedAt, tab: tabId, reason: String((message.payload && message.payload.reason) || '') });
        }
      } catch (err) {}
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

/** S0-1：读回 orchestrator 任务 timeline 的求值表达式（扩展经 window.__initOrchestrator__ 暴露，扩展侧零改动）。
 * 注意：__initOrchestrator__ 挂在 content script 的 ISOLATED world，Playwright page.evaluate（main world）
 * 不可见 → 必须经 CDP Runtime.evaluate + contextId 在 isolated world 内执行（见 readOrchTimelineViaCdp）。
 * ts 为 performance.now()（document 相对），与 LoAF startTime 同源，可直接做窗口归因。
 * detail 截断 200 字符（防错误文案撑大 sidecar）；读失败返回 null 不阻断收尾。 */
const ORCH_TIMELINE_EXPR = `(() => {
  const o = window.__initOrchestrator__;
  if (o && typeof o.getState === 'function') {
    try {
      const st = o.getState();
      if (st && Array.isArray(st.timeline)) {
        return st.timeline.map((e) => ({
          phase: e.phase,
          label: e.label,
          status: e.status,
          ts: e.ts,
          durationMs: e.durationMs ?? 0,
          detail: typeof e.detail === 'string' ? e.detail.slice(0, 200) : undefined,
        }));
      }
    } catch (err) { /* 读取失败按 null 处理 */ }
  }
  return null;
})()`;

/** S0-1：经 CDP 在 content script isolated world 内读回 orchestrator timeline。
 * 步骤：Page.getFrameTree 取主 frame id → Runtime.enable（补发既有 executionContextCreated）
 * → 等首个 auxData.isDefault=false 且 frameId 匹配主 frame 的 context（300ms 窗口，steady 末期 context 必已存在）
 * → Runtime.evaluate(ORCH_TIMELINE_EXPR, contextId) returnByValue。
 * 任何一步失败返回 null（不阻断收尾；sidecar 该 tab 记 timeline=null，归因计 unattributed）。 */
async function readOrchTimelineViaCdp(page: Page): Promise<OrchTimelineEntry[] | null> {
  let session: CDPSession | null = null;
  try {
    session = await page.context().newCDPSession(page);
    const frameTree = (await session.send('Page.getFrameTree')) as {
      frameTree?: { frame?: { id?: string } };
    };
    const rootFrameId = frameTree.frameTree?.frame?.id ?? null;
    const isolatedCtxId = await new Promise<number | null>((resolve) => {
      const nonDefault: number[] = [];
      let matchedRoot: number | null = null;
      const onEvent = (ev: { method: string; params?: { context?: { id: number; auxData?: { isDefault?: boolean; frameId?: string } } } }): void => {
        if (ev.method !== 'Runtime.executionContextCreated') return;
        const ctx = ev.params?.context;
        if (!ctx) return;
        const aux = ctx.auxData ?? {};
        if (aux.isDefault !== false) return;
        nonDefault.push(ctx.id);
        if (rootFrameId && aux.frameId === rootFrameId && matchedRoot === null) matchedRoot = ctx.id;
      };
      session!.on('event', onEvent as never);
      void session!.send('Runtime.enable').then(
        () => {
          // 优先主 frame 的 isolated world；拿不到 frameId 匹配时，若 isolated context 唯一则回退接受
          setTimeout(() => resolve(matchedRoot ?? (nonDefault.length === 1 ? nonDefault[0] : null)), 300);
        },
        () => resolve(null),
      );
    });
    if (isolatedCtxId === null) return null;
    const resp = (await session.send('Runtime.evaluate', {
      expression: ORCH_TIMELINE_EXPR,
      contextId: isolatedCtxId,
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (resp.exceptionDetails) return null;
    const value = resp.result?.value;
    return Array.isArray(value) ? (value as OrchTimelineEntry[]) : null;
  } catch {
    return null;
  } finally {
    await session?.detach().catch(() => {});
  }
}

interface LoafEntry { s: number; d: number; /** LoAF blockingDuration（CPU 时间，S0-1 任务归因用；字段名避开脱敏 key 模式） */ b: number; inv: string; u: string; f: string }
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

/** CDP Tracing 采集器（V8 CPU 采样 + devtools timeline + latency/laf）。
 * 本 Chromium build 的 CDP 语义（已实测）：
 *   - Tracing.start(categories, options) 启动 browser 级 tracing，Tracing 是 browser 全局的，
 *     发起 session 所在的 target 会收到全部进程的事件（浏览器进程 + 所有 renderer）；
 *   - 事件名是 Tracing.dataCollected（payload.value = TraceEvent[]），不是旧版的 dataReceived；
 *   - 数据在 Tracing.end 之后才成批送达，以 Tracing.tracingComplete 收尾（end 返回值不含数据）；
 *   - 因此 stop() 必须先 end、再等 complete，锚点页必须存活到 stop（页面关=session 断）。 */
async function startCdpTracing(context: BrowserContext): Promise<{ stop: () => Promise<TraceEvent[]> }> {
  const anchorPage = await context.newPage();
  const cdp = await context.newCDPSession(anchorPage);
  const rawEvents: TraceEvent[] = [];
  let completeResolve: () => void = () => {};
  const complete = new Promise<void>((resolve) => { completeResolve = resolve; });
  cdp.on('event', ({ method, params }) => {
    if (method === 'Tracing.dataCollected') {
      const value = (params as { value?: unknown } | undefined)?.value;
      if (Array.isArray(value)) rawEvents.push(...(value as TraceEvent[]));
    } else if (method === 'Tracing.tracingComplete') {
      completeResolve();
    }
  });
  await cdp.send('Tracing.start', {
    categories: 'disabled-by-default-v8.cpu_profiler,disabled-by-default-devtools.timeline,latency',
    options: 'sampling-frequency=100',
  });
  return {
    async stop(): Promise<TraceEvent[]> {
      try {
        await cdp.send('Tracing.end');
      } catch { /* 收尾失败保留已收事件 */ }
      await Promise.race([complete, sleep(15_000)]);
      // complete 之后留 300ms 缓冲，确保最后一批 dataCollected 入队
      await sleep(300);
      await cdp.detach().catch(() => {});
      await anchorPage.close().catch(() => {});
      return rawEvents;
    },
  };
}

interface TraceEvent {
  name: string;
  cat?: string;
  ph?: string;
  ts?: number;
  dur?: number;
  pid?: number;
  tid?: number;
  id?: string;
  args?: { data?: Record<string, unknown> };
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

/** S2-1 SW 主线程归因回读：事件循环延迟 500ms 桶 / 入站类型 500ms 桶 / storage.get 直方图（sidecar 专用，不进主报告） */
const SW_ATTR_EXPR = `(() => {
  const hook = self.__s0Hook;
  if (!hook) return null;
  return {
    installedAt: hook.installedAt,
    maxStallMs: hook.maxStallMs || 0,
    stallBuckets: hook.stallBuckets || {},
    inTypeBuckets: hook.inTypeBuckets || {},
    storageGetCount: hook.storageGetCount || 0,
    storageGetByKey: hook.storageGetByKey || {},
  };
})()`;

/** SW taskCenter write-point payload drain (S0-2 field-level diff dedicated; drain semantics: fetch and clear) */
const SW_SNAPSHOTS_DRAIN_EXPR = `(() => {
  const arr = self.__s0Snapshots || [];
  self.__s0Snapshots = [];
  return arr;
})();
`;
/** S2-2 r3: SW 事件级时间戳 drain（fetch-and-clear，与 snapshots 同款语义） */
const SW_EVENTS_DRAIN_EXPR = `(() => {
  const hook = self.__s0Hook;
  if (!hook || !hook.swEvents) return [];
  const arr = hook.swEvents;
  hook.swEvents = [];
  return arr;
})();
`;
/** S0-1 第二步：dashboard render 分段探针缓冲 drain（window.__s1Segs，由 untracked 探针 perfS1Probe.ts 写入；drain 语义：取走即清） */
const S1_SEGS_DRAIN_EXPR = `(() => {
  const b = window.__s1Segs;
  if (!Array.isArray(b) || b.length === 0) return null;
  return b.splice(0, b.length);
})()`;
interface S1SegRec {
  tab: string;
  seg: string;
  ms: number;
  t: number;
  extra?: Record<string, number>;
  err?: 1;
}
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
  /** per-key 字节归因（S3 轮探针）：key → {count, bytes}，近似值见 set 插桩处注释 */
  storageByKey: Record<string, { count: number; bytes: number }>;
  /** SW→扩展页出站消息（runtime/tabs.sendMessage）插桩：dashboard 空闲期长任务与 SW 推送的相关性归因 */
  outMessages: number;
  outByType: Record<string, number>;
  outBuckets: Record<string, number>;
}

interface SwSnapshotRec {
  k: string;
  /** relative to SW hook installation (ms) */
  at: number;
  /** key combo of that set */
  c: string;
  len: number;
  t: string;
}

/** S2-2 r3: SW 事件级时间戳记录（at 相对 SW hook installedAt 的 ms；e: rl=request-lease 入站, c=complete 入站, lp=lease-prompt 出站） */
interface SwEventRec {
  e: 'rl' | 'c' | 'lp';
  at: number;
  tab: number;
  id?: string;
  reason?: string;
}

interface SwAcc {
  messages: number;
  byType: Record<string, number>;
  setCount: number;
  setBytes: number;
  setKeyCombos: Record<string, number>;
  storageByKey: Record<string, { count: number; bytes: number }>;
  outMessages: number;
  outByType: Record<string, number>;
}

const newSwAcc = (): SwAcc => ({ messages: 0, byType: {}, setCount: 0, setBytes: 0, setKeyCombos: {}, storageByKey: {}, outMessages: 0, outByType: {} });

type SwHistogramsLike = {
  byType?: Record<string, number> | Array<{ name: string; count: number }>;
  setKeyCombos?: Record<string, number> | Array<{ name: string; count: number }>;
  storageByKey?: Record<string, { count: number; bytes: number }> | Array<{ name: string; count: number; bytes: number }>;
  outByType?: Record<string, number> | Array<{ name: string; count: number }>;
};

const toNameCountBytes = (
  rec: Record<string, { count: number; bytes: number }> | Array<{ name: string; count: number; bytes: number }> | undefined,
): Array<{ name: string; count: number; bytes: number }> | undefined =>
  Array.isArray(rec) ? rec : rec ? Object.entries(rec).map(([name, v]) => ({ name, count: v.count, bytes: v.bytes })) : undefined;

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
      phase.sw.storageByKey = toNameCountBytes(phase.sw.storageByKey);
      phase.sw.outByType = toNameCountPairs(phase.sw.outByType);
    }
  }
  if (r.totals?.sw) {
    r.totals.sw.byType = toNameCountPairs(r.totals.sw.byType);
    r.totals.sw.setKeyCombos = toNameCountPairs(r.totals.sw.setKeyCombos);
    r.totals.sw.storageByKey = toNameCountBytes(r.totals.sw.storageByKey);
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
  storageByKey: Object.fromEntries(
    Object.entries(hook.storageByKey).map(([k, v]) => [k, { ...v }]),
  ),
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
  for (const [key, value] of Object.entries(delta.storageByKey)) {
    const t = target.storageByKey[key] ?? (target.storageByKey[key] = { count: 0, bytes: 0 });
    t.count += value.count;
    t.bytes += value.bytes;
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
  const storageByKey: Record<string, { count: number; bytes: number }> = {};
  for (const [key, value] of Object.entries(next.storageByKey)) {
    const b = base.storageByKey[key];
    const dc = value.count - (b?.count ?? 0);
    const db = value.bytes - (b?.bytes ?? 0);
    if (dc > 0 || db > 0) storageByKey[key] = { count: Math.max(0, dc), bytes: Math.max(0, db) };
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
    storageByKey,
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
  /** S0-2: full capture of taskCenter write-point payloads (drained each tick from the SW side) */
  snapshots: SwSnapshotRec[] = [];
  /** S2-2 r3: SW 事件级时间戳（request-lease/complete 入站、lease-prompt 出站；drained each tick） */
  swEvents: SwEventRec[] = [];
  /** S0-1 第二步: dashboard render 分段计时记录（drained each tick from page side, 仅 scenario A 有值） */
  s1Segs: S1SegRec[] = [];
  private stopped = false;
  private readonly loopDone: Promise<void>;

  constructor(
    private readonly context: BrowserContext,
    private readonly proc: ChromeProcessTreeSampler,
    private readonly procTimelinePath?: string,
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

  finish(): { phases: PhaseReport[]; allSamples: DiagnosticSample[]; totals: SwAcc; s1Segs: S1SegRec[]; loopDone: Promise<void> } {
    this.stop();
    this.phaseAcc.endedAt = Date.now();
    this.completedPhases.push(this.phaseAcc);
    return {
      phases: this.completedPhases.map(finalizePhase),
      allSamples: this.allSamples,
      totals: this.totals,
      s1Segs: this.s1Segs,
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
      if (this.procTimelinePath) {
        const catLine: Record<string, { cpu: number; rssKb: number; n: number }> = {};
        for (const [category, summary] of Object.entries(byCategory) as Array<[WslChromeProcessCategory, WslChromeProcessSummary]>) {
          catLine[category] = {
            cpu: Math.round(summary.cpuPercent * 100) / 100,
            rssKb: summary.rssKb,
            n: summary.processCount,
          };
        }
        appendFileSync(this.procTimelinePath, `${JSON.stringify({
          at: Date.now(),
          phase: acc.phase,
          cpuPercent: Math.round(treeCpuPercent * 100) / 100,
          rssKb: Math.round(treeRssBytes / 1024),
          cat: catLine,
        })}\n`, 'utf8');
      }
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
      try {
        const segs = await page.evaluate<S1SegRec[] | null>(S1_SEGS_DRAIN_EXPR);
        if (segs && segs.length > 0) this.s1Segs.push(...segs);
      } catch {
        // 页面导航中，下一轮重试（该 tick 的分段记录会随页面导航丢失，可接受）
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

  /** Drain taskCenter payloads from the SW side (independent of the hook object, does not affect existing delta baselines) */
  /** S2-1：回读 SW 主线程归因数据（SW 停摆/未安装时返回 null） */
  async readSwAttribution(): Promise<Record<string, unknown> | null> {
    const sw = this.swWorker;
    if (!sw) return null;
    try {
      return (await sw.evaluate(SW_ATTR_EXPR)) as Record<string, unknown> | null;
    } catch {
      return null;
    }
  }

  private async drainSwSnapshots(sw: Worker): Promise<void> {
    try {
      const recs = (await sw.evaluate(SW_SNAPSHOTS_DRAIN_EXPR)) as SwSnapshotRec[] | null;
      if (recs && recs.length > 0) this.snapshots.push(...recs);
    } catch {
      // SW is temporarily stopped; retry on next round (payloads in the old SW instance are lost, acceptable, noted in docs)
    }
  }

  /** S2-2 r3: drain SW 事件级时间戳（每 tick；SW 重启后旧实例缓冲丢失，与 snapshots 同口径） */
  private async drainSwEvents(sw: Worker): Promise<void> {
    try {
      const recs = (await sw.evaluate(SW_EVENTS_DRAIN_EXPR)) as SwEventRec[] | null;
      if (recs && recs.length > 0) this.swEvents.push(...recs);
    } catch {
      // SW is temporarily stopped; retry on next round
    }
  }

  /** S2-2 r3: 最终 flush（run 结束侧落盘前取走残余缓冲） */
  async readSwEvents(): Promise<SwEventRec[] | null> {
    const sw = this.swWorker;
    if (!sw) return null;
    try {
      const recs = (await sw.evaluate(SW_EVENTS_DRAIN_EXPR)) as SwEventRec[] | null;
      if (recs && recs.length > 0) this.swEvents.push(...recs);
      return this.swEvents.length > 0 ? this.swEvents : null;
    } catch {
      return null;
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
    void this.drainSwSnapshots(sw);
    void this.drainSwEvents(sw);
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
  loaf?: LoafEntry[];
}

/** 剧本 C：detail 逐 tab 增强注入时延记录（S0-2 裁决数据：迟注入 vs waitForSelector 误判）。
 * t 为页面内 performance.now 相对该 tab DCL 的毫秒数；recorderLost=true 表示读回时页面内记录器已丢失
 * （文档被替换 / evaluate 失败）；navsAfterDcl = DCL 之后主框架导航次数（>0 即发生过文档替换）。 */
interface S0TimelineTick {
  t: number;
  cs: string | null;
  style: boolean;
  related: boolean;
  rs: string;
  hrefTail: string;
}
interface DetailTimelineRec {
  tab: number;
  url: string;
  /** goto 起点到 DCL 的耗时（goto 失败为 null） */
  dclAt: number | null;
  navsAfterDcl: number | null;
  recorderLost: boolean;
  csAt: number | null;
  styleAt: number | null;
  relatedAt: number | null;
  /** 诊断：记录器实际执行次数 / 最近一次异常 / 安装时的 readyState / href */
  snapCount: number;
  lastErr: string | null;
  installRs: string | null;
  installHref: string | null;
  ticks: S0TimelineTick[];
  /** 终态（steady 后）二次读回：整个 session 的 rs/href 轨迹 + 记录器累计 tick 数 */
  finalSnapCount: number;
  finalRs: string | null;
  finalHrefTail: string | null;
  finalTicks: S0TimelineTick[];
}

/** 剧本 C：逐 tab 归因记录（sidecar 落盘 + 主报告 perTab 字段） */
interface PerTabRec {
  tab: number;
  url: string;
  /** 就绪判定：marker（注入标记命中）/ settle（兜底稳定窗）/ marker-timeout / fail-login-wall / skipped（control 臂） */
  readyBy: string;
  closed: boolean;
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  rafStallCount: number;
  rafStallTotalMs: number;
  rafStallMaxMs: number;
  jsHeapUsedBytes: number | null;
  nodes: number | null;
  loafTop: LoafTopEntry[];
}

/** S0-1：orchestrator 任务 CPU 归因逐 tab 原始数据；runJob 归因后落 ${'$'}{label}-orch-cpu.json sidecar（不进主报告，防 JSON 膨胀）。 */
interface OrchTabCpuRaw {
  tab: number;
  url: string;
  timeline: OrchTimelineEntry[] | null;
  loaf: LoafCpuEntry[] | null;
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

/** 剧本 C：页面组成变体（--pages）与逐 tab 类型 */
type CPagesVariant = 'list' | 'detail' | 'mix';
type TabKind = 'list' | 'detail' | 'actor';

/** 从门卫列表页收集 /v/ 影片详情链接（去重、绝对 URL，上限 count） */
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

/** 运行时发现演员页 URL：探测 tab 打开首个详情页取第一个 a[href^="/act/"]。
 * 详情页对匿名会话是登录墙，只能在已登录 perf-s0 profile 内运行；失败返回 null，调用方把演员 tab 降级为列表页（记 failures）。 */
/** 演员页 URL 发现：在候选详情页中依次查找 a[href^="/actors/"]（排除筛选页）。
 * 单个详情页可能无演员（FC2/素人等），故按候选顺序最多尝试 4 个。 */
async function discoverActorUrl(
  context: BrowserContext,
  candidateUrls: string[],
  failures: string[],
): Promise<string | null> {
  const attempts = Math.min(4, candidateUrls.length);
  for (let i = 0; i < attempts; i += 1) {
    let page: Page | null = null;
    try {
      page = await context.newPage();
      await page.goto(candidateUrls[i], { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // 站点演员链接为 /actors/<slug>（注意：`a[href^="/act/"]` 不匹配 /actors，
      // 2026-09-12 排查 C-mix 发现超时根因之一）。排除 /actors/censored|uncensored|western 等筛选页。
      const href = await page
        .locator('a[href^="/actors/"]:not([href$="/censored"]):not([href$="/uncensored"]):not([href$="/western"])')
        .first()
        .getAttribute('href', { timeout: 8_000 });
      if (!href) continue;
      const url = new URL(href, 'https://javdb570.com').toString();
      console.log(`[C-mix] 演员页 URL 发现成功（候选 ${i + 1}/${attempts}）: ${url}`);
      return url;
    } catch {
      console.log(`[C-mix] 演员页候选 ${i + 1}（${candidateUrls[i]}）未发现演员链接，尝试下一个`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }
  failures.push('C-mix: 演员页 URL 发现失败（候选详情页均未见 a[href^="/actors/"]），演员 tab 降级为列表页');
  return null;
}

/** 剧本 C：构建逐 tab URL 与类型组成。
 * list=全列表页；detail=全详情页；mix=8 详情+6 列表+2 演员（非 16 tab 按比例缩放：actor=max(1,round(n/8))、list=round(n*6/16)、detail=其余）。
 * 详情链接收集为空则整体降级列表页并记 failures。 */
async function buildTabUrls(
  context: BrowserContext,
  gate: Page,
  listUrl: string,
  variant: CPagesVariant,
  tabCount: number,
  failures: string[],
): Promise<{ urls: string[]; kinds: TabKind[] }> {
  if (variant === 'list') {
    return {
      urls: Array.from({ length: tabCount }, () => listUrl),
      kinds: Array.from({ length: tabCount }, () => 'list' as TabKind),
    };
  }
  const actorCount = variant === 'mix' ? Math.max(1, Math.round(tabCount / 8)) : 0;
  const listCount = variant === 'mix' ? Math.round((tabCount * 6) / 16) : 0;
  const detailCount = Math.max(0, tabCount - listCount - actorCount);

  const detailUrls = await collectDetailUrls(gate, detailCount);
  if (detailUrls.length === 0) {
    failures.push(`C-${variant}: 门卫页未收集到 /v/ 详情链接（站点结构变化?），全部 tab 降级为列表页`);
    return {
      urls: Array.from({ length: tabCount }, () => listUrl),
      kinds: Array.from({ length: tabCount }, () => 'list' as TabKind),
    };
  }
  if (detailUrls.length < detailCount) {
    failures.push(`C-${variant}: 详情链接仅 ${detailUrls.length}/${detailCount}，不足 tab 以列表页补齐`);
  }

  let actorUrl: string | null = null;
  if (actorCount > 0) actorUrl = await discoverActorUrl(context, detailUrls, failures);

  const urls: string[] = [];
  const kinds: TabKind[] = [];
  for (let i = 0; i < detailCount; i += 1) {
    kinds.push('detail');
    urls.push(i < detailUrls.length ? detailUrls[i] : listUrl);
  }
  for (let i = 0; i < listCount; i += 1) {
    kinds.push('list');
    urls.push(listUrl);
  }
  for (let i = 0; i < actorCount; i += 1) {
    kinds.push(actorUrl ? 'actor' : 'list');
    urls.push(actorUrl ?? listUrl);
  }
  return { urls, kinds };
}

/** 剧本 C：并发打开 N 个增强原站 tab（默认 16，--tabs 可调）。
 * 复现用户反馈：同时打开 15+ 页面时浏览器与单个页面的 CPU/内存异常飙高、整体卡顿。
 * 口径说明：
 *   - RunSampler 逐 tick drain 全部被 track 页面，byPhase 聚合值 = 全部 tab 之和（浏览器级）；
 *   - perTab sidecar 用页面侧全量累计 buffer（longTaskAll/rafStallAll，不随 drain 重置）+ CDP 堆指标，
 *     给出逐 tab 的卡顿分布与 JS heap，回答「哪几个 tab 在吃资源」。
 *   - 逐 tab 长任务数为数组截断口径（longTaskAll≤5000 / rafStallAll≤2500），极端卡顿 tab 可能低估；
 *     权威总量以 byPhase 聚合（drain 口径）为准。
 */
async function runScenarioC(
  context: BrowserContext,
  listUrl: string,
  arm: Arm,
  tabCount: number,
  variant: CPagesVariant,
  sampler: RunSampler,
  durations: Durations,
  failures: string[],
): Promise<{ tInteractiveMs: number; perTab: PerTabRec[]; detailTimelines: DetailTimelineRec[]; variant: CPagesVariant; orchCpu: OrchTabCpuRaw[] }> {
  await context.addCookies([
    { name: 'over18', value: '1', domain: 'javdb570.com', path: '/' },
  ]).catch(() => {});

  // --- 门卫 tab：年龄门 + 登录墙检测（与剧本 B 同口径）---
  const gate = await context.newPage();
  sampler.trackPage(gate);
  let gateLoaded = false;
  let loginWall = false;
  try {
    await gate.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: durations.siteGotoMs });
    gateLoaded = true;
  } catch (error) {
    failures.push(`C: 门卫 tab 加载失败: ${errMsg(error)}`);
  }
  if (gateLoaded) {
    for (let round = 0; round < 2; round += 1) {
      const yes = gate.locator('a[href*="over18?respond=1"]').first();
      try {
        await yes.waitFor({ state: 'visible', timeout: 15_000 });
      } catch {
        break; // 无年龄门
      }
      try {
        await yes.click({ timeout: 10_000 });
        await gate.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
        await sleep(1_000);
      } catch (error) {
        failures.push(`C: 年龄门点击失败: ${errMsg(error)}`);
        break;
      }
    }
    const onLoginPage = await gate.evaluate(() => location.pathname.startsWith('/login')).catch(() => false);
    const over18Count = await gate.locator('a[href*="over18?respond=1"]').count().catch(() => 0);
    if (onLoginPage && over18Count === 0) {
      loginWall = true;
      failures.push('C: 站点登录墙（年龄验证后仍停留 /login，列表不渲染）——先运行 pnpm tsx scripts/loginPerfS0.ts 在 perf-s0 profile 建立登录态后重跑');
    }
  }
  if (!gateLoaded || loginWall) {
    sampler.setPhase('cooldown');
    await sleep(1_000);
    await gate.close().catch(() => {});
    return { tInteractiveMs: 0, perTab: [], detailTimelines: [], variant, orchCpu: [] };
  }

  const pages: Page[] = [gate];
  const startedAt = Date.now();

  // --- 逐 tab URL 组成（detail/mix 依赖 perf-s0 登录态：详情页对匿名是登录墙）---
  const { urls, kinds } = await buildTabUrls(context, gate, listUrl, variant, tabCount, failures);
  const kindCounts = kinds.reduce<Record<string, number>>((acc, k) => {
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  log(`[C] 页面组成 ${variant}: ` + Object.entries(kindCounts).map(([k, n]) => `${k}×${n}`).join(' '));

  // --- 门卫 tab 增强标记（同 B 口径）---
  if (arm === 'enhanced') {
    try {
      await gate.waitForSelector('.x-btn, .jdb-list-status-actions', { timeout: durations.enhancedMarkerMs });
    } catch {
      failures.push('C: 门卫 tab 增强标记（.x-btn/.jdb-list-status-actions）未出现——站点可能被拦截或增强未注入');
    }
  } else {
    await sleep(durations.controlColdMs);
  }

  // --- S0-2 裁决数据：detail 逐 tab 注入时延记录器（仅 enhanced 臂）---
  // DCL 时启动页面内 500ms 轮询，记 cs/style/related 首现时刻（t=相对 DCL）+ rs/href 轨迹；
  // 记录器随文档销毁 → 读回为空即说明 DCL 后文档被替换。不改变 readyBy 判定，只加时延数据。
  // 安装函数必须用字符串表达式（同 PAGE_HOOK_SRC 模式）：tsx/esbuild(keepNames) 会给 evaluate
  // 箭头函数内的命名内层函数注入 __name helper 引用，页面侧无 __name → ReferenceError，
  // 其后语句全部不执行（2026-09-12 n2 run 实证：w.__s0tl 已置位但 snapCount 恒 0）。
  interface DetailTlState {
    dclAt: number;
    dclNavBase: number;
    navs: { count: number };
  }
  const detailTlState = new Map<Page, DetailTlState>();
  const DETAIL_TL_INSTALL_SRC = `(() => {
    const w = window;
    if (w.__s0tl) return 'dup';
    const t0 = performance.now();
    const data = {
      csAt: null, styleAt: null, relatedAt: null,
      ticks: [],
      snapCount: 0,
      lastErr: null,
      installRs: document.readyState,
      installHref: location.href.slice(-48),
    };
    w.__s0tl = data;
    const snap = function () {
      try {
        const now = Math.round(performance.now() - t0);
        const el = document.documentElement;
        const cs = el ? (el.dataset.javdbExtensionInjected || null) : null;
        const style = !!document.getElementById('video-detail-preview-styles');
        const related = !!document.getElementById('jdb-related-lists-styles');
        if (data.csAt === null && cs === '1') data.csAt = now;
        if (data.styleAt === null && style) data.styleAt = now;
        if (data.relatedAt === null && related) data.relatedAt = now;
        if (data.ticks.length < 240) data.ticks.push({ t: now, cs: cs, style: style, related: related, rs: document.readyState, hrefTail: location.href.slice(-48) });
        data.snapCount += 1;
      } catch (e) {
        data.lastErr = String(e);
      }
    };
    snap();
    const timer = window.setInterval(snap, 500);
    w.__s0tlTimer = timer;
    window.setTimeout(function () { window.clearInterval(timer); }, 120000);
    return 'ok';
  })()`;
  const installTimelineRecorder = (page: Page): void => {
    void page.evaluate(DETAIL_TL_INSTALL_SRC).catch(() => {});
  };

  // --- 并发打开其余 N-1 个 tab（stagger 模拟用户连续打开）---
  for (let i = 1; i < tabCount; i += 1) {
    const page = await context.newPage();
    sampler.trackPage(page);
    if (arm === 'enhanced' && kinds[i - 1] === 'detail') {
      const gotoStart = Date.now();
      const state: DetailTlState = { dclAt: Number.NaN, dclNavBase: 0, navs: { count: 0 } };
      const onNav = (frame: import('@playwright/test').Frame): void => {
        if (frame === page.mainFrame()) state.navs.count += 1;
      };
      page.on('framenavigated', onNav);
      page.once('domcontentloaded', () => {
        state.dclAt = Date.now() - gotoStart;
        state.dclNavBase = state.navs.count;
        installTimelineRecorder(page);
      });
      detailTlState.set(page, state);
    }
    try {
      await page.goto(urls[i], { waitUntil: 'domcontentloaded', timeout: durations.siteGotoMs });
    } catch (error) {
      failures.push(`C: tab${i + 1} 加载失败: ${errMsg(error)}`);
    }
    pages.push(page);
    if (i < tabCount - 1) await sleep(durations.cStaggerMs);
  }

  // --- 其余 tab 等增强标记（并行，各自独立预算；就绪口径按页面类型区分）---
  // 详情页增强无全页统一 DOM 标记：注入样式 id 为主口径 + 2.5s 兜底稳定窗；演员页无专用标记：稳定窗；
  // 列表页保持 cycle-5 口径（.x-btn/.jdb-list-status-actions）。readyBy 写入 perTab 供诊断。
  const readyBy: string[] = new Array<string>(pages.length).fill('skipped');
  if (arm === 'enhanced') {
    await Promise.all(
      pages.map(async (page, idx) => {
        if (idx === 0) return;
        const kind = kinds[idx - 1] ?? 'list';
        try {
          if (kind === 'detail') {
            // 就绪口径：state:'attached'（DOM 存在即就绪）。主口径 #video-detail-preview-styles 是
            // <style> 标签——Playwright waitForSelector 默认 state:'visible' 对 style 标签永不满足
            // （无渲染盒），是 15/16「未命中」假阴性的真正根因（2026-09-12 探针+最小复现实证）。
            // 8s 为安全网：探针实测（无 instrument）16tab 标记 ≤DCL+1.7s，instrument 下也不应超 8s。
            await page.waitForSelector('#jdb-related-lists-styles, #video-detail-preview-styles, .enhanced-translation', { state: 'attached', timeout: 8_000 });
            readyBy[idx] = 'marker';
            return;
          }
          if (kind === 'actor') {
            await sleep(2_000);
            readyBy[idx] = 'settle';
            return;
          }
          await page.waitForSelector('.x-btn, .jdb-list-status-actions', { timeout: durations.enhancedMarkerMs });
          readyBy[idx] = 'marker';
          return;
        } catch {
          // 落入下方按类型的失败处理
        }
        if (kind === 'detail') {
          // 登录态失效时详情页会 302→/login（或再跳回列表/搜索）：final URL 不在 /v/ 下即判失败
          let finalPath = '';
          try {
            finalPath = new URL(page.url()).pathname;
          } catch {
            // ignore
          }
          if (!finalPath.startsWith('/v/')) {
            readyBy[idx] = 'fail-redirected';
            failures.push(`C: tab${idx + 1} 详情页未落在 /v/（final=${page.url().slice(0, 120)}）——登录态失效或站点结构变化；先运行 pnpm tsx scripts/loginPerfS0.ts 重建登录态后重跑`);
            return;
          }
          // 标记未命中时的注入状态诊断（区分「content script 没跑」vs「跑了但样式缺失」）
          let diag = 'diag-unavailable';
          try {
            const d = await page.evaluate(() => ({
              cs: document.documentElement?.dataset.javdbExtensionInjected ?? 'none',
              style: !!document.getElementById('video-detail-preview-styles'),
              related: !!document.getElementById('jdb-related-lists-styles'),
              rs: document.readyState,
              href: location.href.slice(0, 120),
            }));
            diag = `cs=${d.cs} style=${d.style} related=${d.related} rs=${d.rs} href=${d.href}`;
          } catch (error) {
            diag = `diag-err:${errMsg(error).slice(0, 80)}`;
          }
          readyBy[idx] = 'settle';
          failures.push(`C: tab${idx + 1} 详情页增强标记未命中（降级稳定窗，readyBy=settle; ${diag}）`);
          return;
        }
        if (kind === 'actor') {
          readyBy[idx] = 'settle';
          return;
        }
        readyBy[idx] = 'marker-timeout';
        failures.push(`C: tab${idx + 1} 增强标记未出现`);
      }),
    );
  }
  // --- S0-2：detail 逐 tab 注入时延读回（裁决数据；不改变 readyBy 判定）---
  // 读回 #1：readyBy 刚结束时记录器的 500ms tick 可能还没覆盖到 style 首现，
  // 轮询至 styleAt 出现或 2s 上限（200ms 粒度），保证首现时刻被 tick 捕获。
  const detailTimelines: DetailTimelineRec[] = [];
  if (arm === 'enhanced') {
    for (let i = 1; i < pages.length; i += 1) {
      if (kinds[i - 1] !== 'detail') continue;
      const state = detailTlState.get(pages[i]);
      interface S0TlData {
        csAt: number | null;
        styleAt: number | null;
        relatedAt: number | null;
        ticks: S0TimelineTick[];
        snapCount: number;
        lastErr: string | null;
        installRs: string;
        installHref: string;
      }
      let data: S0TlData | null = null;
      const readOnce = async (): Promise<S0TlData | null> => {
        try {
          return ((await pages[i].evaluate('window.__s0tl ?? null')) as S0TlData | null) ?? null;
        } catch {
          return null;
        }
      };
      data = await readOnce();
      if (data !== null && data.styleAt === null) {
        const pollDeadline = Date.now() + 2_000;
        while (data.styleAt === null && Date.now() < pollDeadline) {
          await sleep(200);
          const next = await readOnce();
          if (next === null) break; // 文档已替换（记录器丢失）
          data = next;
        }
      }
      let url = '';
      try {
        url = pages[i].url().slice(0, 120);
      } catch {
        url = '(closed)';
      }
      detailTimelines.push({
        tab: i + 1,
        url,
        dclAt: state && Number.isFinite(state.dclAt) ? state.dclAt : null,
        navsAfterDcl: state ? state.navs.count - state.dclNavBase : null,
        recorderLost: data === null,
        csAt: data?.csAt ?? null,
        styleAt: data?.styleAt ?? null,
        relatedAt: data?.relatedAt ?? null,
        snapCount: data?.snapCount ?? 0,
        lastErr: data?.lastErr ?? null,
        installRs: data?.installRs ?? null,
        installHref: data?.installHref ?? null,
        ticks: data?.ticks ?? [],
        finalSnapCount: 0,
        finalRs: null,
        finalHrefTail: null,
        finalTicks: [],
      });
    }
    const summary = detailTimelines
      .map((r) => `tab${r.tab}:${r.recorderLost ? 'recorder-lost' : r.styleAt === null ? `style-none(snap=${r.snapCount} err=${r.lastErr ?? '-'} rs=${r.installRs} href=${r.installHref})` : `style@${r.styleAt}ms cs@${r.csAt ?? '?'}ms navs+${r.navsAfterDcl ?? '?'}`}`)
      .join(' ');
    if (summary) log(`[C] detail 注入时延（t=相对各 tab DCL）: ${summary}`);
  }
  const tInteractiveMs = Date.now() - startedAt;
  log(`[C] ${pages.length} tab 就绪（增强注入/加载）=${tInteractiveMs}ms`);
  await sleep(durations.coldSettleMs);

  sampler.setPhase('warmup');
  log('[C] phase: warmup');
  await sleep(durations.warmupMs);

  sampler.setPhase('interaction');
  log(`[C] phase: interaction（${durations.cScrollRounds} 轮 × ${pages.length} tab 滚动）`);
  for (let r = 0; r < durations.cScrollRounds; r += 1) {
    for (const page of pages) {
      await page.evaluate(() => window.scrollBy(0, 1400)).catch(() => {});
    }
    await sleep(durations.cScrollIntervalMs);
  }
  for (const page of pages) {
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  }
  await sleep(500);

  sampler.setPhase('steady');
  log(`[C] phase: steady（${durations.steadyMsC}ms，${pages.length} tab 并发 smart 调度）`);
  await sleep(durations.steadyMsC);

  // --- 逐 tab 终态归因（全量累计 buffer + CDP 堆指标）---
  const perTab: PerTabRec[] = [];
  const orchCpu: OrchTabCpuRaw[] = []; // S0-1：orchestrator 任务 CPU 归因原始数据
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    const rec: PerTabRec = {
      tab: i + 1,
      url: '',
      readyBy: readyBy[i] ?? 'skipped',
      closed: false,
      longTaskCount: 0,
      longTaskTotalMs: 0,
      longTaskMaxMs: 0,
      rafStallCount: 0,
      rafStallTotalMs: 0,
      rafStallMaxMs: 0,
      jsHeapUsedBytes: null,
      nodes: null,
      loafTop: [],
    };
    try {
      rec.url = page.url();
    } catch {
      rec.closed = true;
    }
    // S0-2 读回 #2：终态（steady 后）二次读回注入时延记录器 → 整个 session 的 rs/href 稳定性
    if (!rec.closed && arm === 'enhanced' && i > 0 && kinds[i - 1] === 'detail') {
      const tlRec = detailTimelines.find((r) => r.tab === i + 1);
      if (tlRec && !tlRec.recorderLost) {
        try {
          const finalData = (await page.evaluate('window.__s0tl ?? null')) as {
            snapCount?: number;
            ticks?: S0TimelineTick[];
          } | null;
          if (finalData) {
            tlRec.finalSnapCount = finalData.snapCount ?? 0;
            tlRec.finalTicks = finalData.ticks ?? [];
            const last = (finalData.ticks ?? [])[finalData.ticks!.length - 1];
            tlRec.finalRs = last?.rs ?? null;
            tlRec.finalHrefTail = last?.hrefTail ?? null;
          }
        } catch {
          // 终态读回失败不阻断收尾
        }
      }
    }
    if (!rec.closed) {
      try {
        const data = await page.evaluate<LongTaskBuffer | null>(LONGTASK_ALL_EXPR).catch(() => null);
        if (data) {
          for (const entry of data.entries) {
            rec.longTaskCount += 1;
            rec.longTaskTotalMs += entry.d;
            if (entry.d > rec.longTaskMaxMs) rec.longTaskMaxMs = entry.d;
          }
          for (const entry of data.rafStalls ?? []) {
            rec.rafStallCount += 1;
            rec.rafStallTotalMs += entry.d;
            if (entry.d > rec.rafStallMaxMs) rec.rafStallMaxMs = entry.d;
          }
          rec.loafTop = summarizeLoafTop(data.loaf, 5);
          // S0-1：顺手读回 orchestrator timeline（读不到 null 不阻断；loaf 原文随 sidecar 归因用）
          const orchTimeline = await readOrchTimelineViaCdp(page);
          orchCpu.push({
            tab: i + 1,
            url: rec.url,
            timeline: orchTimeline,
            loaf: data.loaf && data.loaf.length > 0 ? data.loaf : null,
          });
        }
      } catch {
        rec.closed = true;
      }
    }
    if (!rec.closed) {
      try {
        const session = await page.context().newCDPSession(page);
        await session.send('Performance.enable');
        const response = (await session.send('Performance.getMetrics')) as {
          metrics?: Array<{ name: string; value: number }>;
        };
        for (const metric of response.metrics ?? []) {
          if (!Number.isFinite(metric.value)) continue;
          if (metric.name === 'JSHeapUsedSize' || metric.name === 'JSUsedHeapSize') {
            rec.jsHeapUsedBytes = Math.round(metric.value);
          } else if (metric.name === 'Nodes') {
            rec.nodes = Math.round(metric.value);
          }
        }
        await session.detach().catch(() => {});
      } catch {
        // CDP 取堆失败，保留 null（不阻断收尾）
      }
    }
    perTab.push(rec);
  }
  for (const rec of perTab) {
    const heapMb = rec.jsHeapUsedBytes === null ? '?' : `${(rec.jsHeapUsedBytes / 1048576).toFixed(1)}MB`;
    log(
      `[C] tab${rec.tab}: longTask ${rec.longTaskCount}个/${Math.round(rec.longTaskTotalMs)}ms(max ${Math.round(rec.longTaskMaxMs)}) ` +
        `rafStall ${rec.rafStallCount}个/${Math.round(rec.rafStallTotalMs)}ms(max ${Math.round(rec.rafStallMaxMs)}) heap=${heapMb} nodes=${rec.nodes ?? '?'}`,
    );
  }
  sampler.setPhase('cooldown');
  log(`[C] phase: cooldown（关闭 ${pages.length} tab）`);
  for (const page of pages) {
    await page.close().catch(() => {});
  }
  await sleep(durations.cooldownMs);
  return { tInteractiveMs, perTab, detailTimelines, variant, orchCpu };
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
    pagesVariant: CPagesVariant | null;
    featuresOff: string[];
    quick: boolean;
    seedGuard: GuardInfo | null;
    fatalError: string | null;
  };
  tInteractiveMs: number;
  /** B6 函数级卡顿归因：页面名 → top-N（LoAF attributions 聚合） */
  loafTop: Record<string, LoafTopEntry[]> | null;
  /** 剧本 C：逐 tab 卡顿/堆内存归因（全量测量窗口累计） */
  perTab?: PerTabRec[];
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
    `  [totals] longTaskP95=${totals.diagnostic.longTaskP95Ms ?? '-'}ms cpu积分=${totals.diagnostic.cpuIntegralCoreSec}core·s `
    + `swMsg=${totals.sw.messages} swOut=${totals.sw.outMessages} swSet=${totals.sw.setCount}次/${Math.round(totals.sw.setBytes / 1024)}KB `
    + 'sw类型=' + JSON.stringify(totals.sw.byType)
    + ' sw出站类型=' + JSON.stringify(totals.sw.outByType)
    + ' storage写=' + JSON.stringify(totals.sw.setKeyCombos)
    + ' perKeyTop3=' + JSON.stringify(
        Object.entries(totals.sw.storageByKey)
          .sort((a, b) => b[1].bytes - a[1].bytes)
          .slice(0, 3)
          .map(([k, v]) => `${k}:${Math.round(v.bytes / 1024)}KB×${v.count}`),
      ),
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
    const procTimelinePath = args.procTimeline ? path.join(args.outDir, `${label}-proc-timeline.jsonl`) : undefined;
    if (procTimelinePath) {
      mkdirSync(args.outDir, { recursive: true });
      writeFileSync(procTimelinePath, '', 'utf8');
      log(`[${label}] 进程时间轴：${path.relative(CWD, procTimelinePath)}`);
    }
    sampler = new RunSampler(context, new ChromeProcessTreeSampler(browserPid), procTimelinePath);
    let finished: ReturnType<RunSampler['finish']> | null = null;
    let tInteractiveMs = 0;
    let attribution: AAttribution | null = null;
    let perTab: PerTabRec[] | undefined;
    let swOut: SwOutSnapshot | null = null;
    let loafTop: Record<string, LoafTopEntry[]> | null = null;
    let traceInfo: { file: string; startEpochMs: number } | null = null;
    try {
      let cdpTrace: { stop: () => Promise<TraceEvent[]> } | null = null;
      if (job.scenario === 'A' && args.cdpTrace) {
        mkdirSync(args.outDir, { recursive: true });
        // 先开页面占位以便附着 CDP session（dashboard 页随后由 runScenarioA 复用同一 context 新开）
        cdpTrace = await startCdpTracing(context);
        traceInfo = {
          file: path.join(args.outDir, `${label}-trace.json`),
          startEpochMs: Date.now(),
        };
        log(`[${label}] CDP tracing 已启动（v8.cpu_profiler + devtools.timeline，锚点=${traceInfo.startEpochMs}）`);
      }
      if (job.scenario === 'A') {
        const result = await runScenarioA(context, extensionId, sampler, durations, failures);
        tInteractiveMs = result.tInteractiveMs;
        attribution = result.attribution;
        if (result.loafTop.length > 0) loafTop = { dashboard: result.loafTop };
        swOut = await captureSwOut(context);
        if (traceInfo && cdpTrace) {
          try {
            const traceEvents = await cdpTrace.stop();
            writeFileSync(traceInfo.file, `${JSON.stringify(traceEvents)}\n`, 'utf8');
            log(`[${label}] CDP trace 已落盘 ${path.relative(CWD, traceInfo.file)}（events=${traceEvents.length}）`);
          } catch (error) {
            traceInfo = null;
            log(`[${label}] CDP tracing stop 失败：${errMsg(error)}`);
          }
        }
        printAAttribution(label, attribution, swOut);
      } else if (job.scenario === 'B') {
        const result = await runScenarioB(context, args.listPage ?? SITE_LIST_URL, job.arm, sampler, durations, failures);
        tInteractiveMs = result.tInteractiveMs;
        if (Object.keys(result.loafTop).length > 0) loafTop = result.loafTop;
      } else {
        mkdirSync(args.outDir, { recursive: true });
        const result = await runScenarioC(
          context,
          args.listPage ?? SITE_LIST_URL,
          job.arm,
          args.tabs,
          args.pages,
          sampler,
          durations,
          failures,
        );
        tInteractiveMs = result.tInteractiveMs;
        if (result.perTab.length > 0) perTab = result.perTab;
        if (result.detailTimelines.length > 0) {
          writeFileSync(path.join(args.outDir, `${label}-detail-timeline.json`), `${JSON.stringify({
            scenario: 'C',
            variant: args.pages,
            arm: job.arm,
            tabCount: args.tabs,
            note: 't 为各 tab DCL 起点的页面内 performance.now 毫秒（500ms tick 粒度）；recorderLost=true 表示读回时页面内记录器丢失（文档替换/evaluate 失败）；navsAfterDcl 为 DCL 后主框架导航次数（>0 即文档被替换）；finalTicks/finalSnapCount 为 steady 后终态二次读回（整个 session 的 rs/href 稳定性）',
            detailTimelines: result.detailTimelines,
          }, null, 2)}\n`, 'utf8');
          log(`[${label}] detail 注入时延 sidecar 已落盘 ${path.relative(CWD, path.join(args.outDir, `${label}-detail-timeline.json`))}`);
        }
        writeFileSync(path.join(args.outDir, `${label}-per-tab.json`), `${JSON.stringify({
          scenario: 'C',
          variant: args.pages,
          arm: job.arm,
          tabCount: args.tabs,
          tInteractiveMs: result.tInteractiveMs,
          perTab: result.perTab,
        }, null, 2)}\n`, 'utf8');
        log(`[${label}] per-tab sidecar 已落盘 ${path.relative(CWD, path.join(args.outDir, `${label}-per-tab.json`))}`);
        if (result.orchCpu.length > 0) {
          const perTabAttr = result.orchCpu.map((t) => ({
            tab: t.tab,
            url: t.url,
            timeline: t.timeline,
            attribution: attributeLoafCpuToTasks(t.timeline, t.loaf),
          }));
          const aggregate = aggregateOrchCpuAttributions(perTabAttr.map((t) => t.attribution));
          const orchCpuPath = path.join(args.outDir, `${label}-orch-cpu.json`);
          writeFileSync(orchCpuPath, `${JSON.stringify({
            capturedAt: new Date().toISOString(),
            scenario: 'C',
            variant: args.pages,
            arm: job.arm,
            tabCount: args.tabs,
            note: 'timeline ts 与 LoAF s 均为页面内 performance.now()（document 相对，同源可比）；cpuMs=归因到任务窗口 [ts-durationMs, ts) 的 LoAF blockingDuration 之和；重叠窗口归属最早开始者；blockingDuration 缺失/≤0 的帧不计入 total（诚实口径）；unattributed=未落入任何任务窗口的帧；wallMs 为同 label 任务墙钟合计（并发窗口可重叠，仅参考）',
            aggregate,
            perTab: perTabAttr,
          }, null, 2)}\n`, 'utf8');
          log(`[${label}] orch 任务 CPU 归因 sidecar 已落盘 ${path.relative(CWD, orchCpuPath)}`);
          const top = aggregate.tasks.filter((t) => t.cpuMs > 0).slice(0, 5)
            .map((t) => `${t.phase}/${t.label}=${t.cpuMs}ms(wall=${t.wallMs}ms,${t.frames}帧)`)
            .join(' ');
          log(`[${label}] CPU 归因(orch任务) 跨${result.orchCpu.length}tab: total=${aggregate.totalCpuMs}ms unattributed=${aggregate.unattributed.cpuMs}ms top: ${top || '（无命中）'}`);
        }
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
        siteListUrl: job.scenario === 'B' || job.scenario === 'C' ? (args.listPage ?? SITE_LIST_URL) : null,
        pagesVariant: job.scenario === 'C' ? args.pages : null,
        featuresOff: args.featuresOff ?? [],
        quick: args.quick,
        seedGuard: guard,
        fatalError: runError,
      },
      tInteractiveMs,
      loafTop,
      perTab,
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
    if (sampler.snapshots.length > 0) {
      const snapPath = path.join(args.outDir, `${label}-sw-snapshots.json`);
      writeFileSync(snapPath, `${JSON.stringify({ capturedAt: new Date().toISOString(), count: sampler.snapshots.length, records: sampler.snapshots }, null, 2)}\n`, 'utf8');
      log(`[${label}] SW snapshot payload sidecar written to ${snapPath} (count=${sampler.snapshots.length})`);
    }
    if (sampler.s1Segs.length > 0) {
      const segsPath = path.join(args.outDir, `${label}-s1-segs.json`);
      writeFileSync(segsPath, `${JSON.stringify({ capturedAt: new Date().toISOString(), count: sampler.s1Segs.length, records: sampler.s1Segs }, null, 2)}\n`, 'utf8');
      log(`[${label}] S1 render-seg sidecar 已落盘 ${segsPath} (count=${sampler.s1Segs.length})`);
    }
    const swAttr = await sampler.readSwAttribution();
    if (swAttr) {
      const swAttrPath = path.join(args.outDir, `${label}-sw-attribution.json`);
      writeFileSync(swAttrPath, `${JSON.stringify({ capturedAt: new Date().toISOString(), ...swAttr }, null, 2)}\n`, 'utf8');
      log(`[${label}] SW 主线程归因 sidecar 已落盘 ${swAttrPath} (maxStall=${swAttr.maxStallMs}ms, storageGet=${swAttr.storageGetCount}次)`);
    }
    const swEvents = await sampler.readSwEvents();
    if (swEvents) {
      const swEventsPath = path.join(args.outDir, `${label}-sw-events.json`);
      writeFileSync(swEventsPath, `${JSON.stringify({ capturedAt: new Date().toISOString(), count: swEvents.length, events: swEvents }, null, 2)}\n`, 'utf8');
      log(`[${label}] SW 事件级时间戳 sidecar 已落盘 ${swEventsPath} (count=${swEvents.length})`);
    }
    printRunSummary(label, report);
    if (attribution) {
      // sidecar 只含性能元数据（tab 名/时间戳/消息类型名/计数），不走脱敏主报告通道
      const sidecarPath = path.join(args.outDir, `${label}-attribution.json`);
      writeFileSync(sidecarPath, `${JSON.stringify({ attribution, swOut, trace: traceInfo }, null, 2)}\n`, 'utf8');
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
    tabs: 16,
    pages: 'list',
    quick: false,
    matrix: false,
    noGuard: false,
    outDir: DEFAULT_OUT_DIR,
    featuresOff: undefined,
    cdpTrace: false,
    procTimeline: false,
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
        if (value !== 'A' && value !== 'B' && value !== 'C') throw new Error(`--scenario 只接受 A|B|C，收到 ${value}`);
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
      case '--tabs': {
        const n = Math.trunc(Number(next()) || 16);
        if (!(n >= 2 && n <= 40)) throw new Error(`--tabs 取值 2~40，收到 ${n}`);
        args.tabs = n;
        break;
      }
      case '--pages': {
        const value = next();
        if (value !== 'list' && value !== 'detail' && value !== 'mix') throw new Error(`--pages 只接受 list|detail|mix，收到 ${value}`);
        args.pages = value;
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
      case '--cdp-trace':
        args.cdpTrace = true;
        break;
      case '--proc-timeline':
        args.procTimeline = true;
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
    for (const scenario of ['A', 'B', 'C'] as const) {
      for (const arm of ['enhanced', 'control'] as const) {
        for (let repeat = 1; repeat <= 3; repeat += 1) jobs.push({ scenario, arm, repeat });
      }
    }
    return jobs;
  }
  if (args.quick) return [{ scenario: args.scenario, arm: args.arm, repeat: 1 }];
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
