/**
 * @file dashboardPerfBaseline.ts
 * @description S0-4（cycle-8）：dashboard 各主页卡顿基线（定性反馈 → 定量）。
 * 纯测量工具链：在 chrome-extension:// dashboard 页注入
 *   - longtask observer（数量/总量/峰值/P95）
 *   - LoAF observer（blockingDuration + 最外层 function@script 归因 top-N）
 *   - 500ms 桶 DOM mutation 计数（re-render 的 DOM 输出代理；纯 state 无 DOM 变更不计，局限已在报告注明）
 * 逐 tab（总览/媒体库/设置/日志）：打开 → 内容渲染稳定窗 → 可选交互（滚动）→ 收尾采集。
 * 输出 JSON sidecar（每 tab 一份）+ 控制台摘要。不碰扩展源码，不落主报告体系。
 * @module scripts
 */
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  launchExtensionContext,
  readExtensionId,
  resolveExtensionHarnessOptions,
} from './extensionHarness';

const CWD = process.cwd();
const PROFILE_DIR = path.resolve(CWD, '.test-profiles', 'perf-s0');

interface Args {
  tabs: string[];
  settleMs: number;
  interactMs: number;
  outDir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { tabs: ['tab-home', 'tab-media', 'tab-settings', 'tab-logs'], settleMs: 8_000, interactMs: 6_000, outDir: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = (): string => { i += 1; const v = argv[i]; if (v === undefined) throw new Error(`参数 ${token} 缺少取值`); return v; };
    switch (token) {
      case '--tabs': args.tabs = next().split(',').map((t) => t.trim()).filter(Boolean); break;
      case '--settle': args.settleMs = Math.max(1_000, Number(next()) || 8_000); break;
      case '--interact': args.interactMs = Math.max(0, Number(next()) || 0); break;
      case '--out': args.outDir = next(); break;
      default: throw new Error(`未知参数 ${token}`);
    }
  }
  if (!args.outDir) throw new Error('缺少 --out');
  return args;
}

/** 页面侧钩子（main world，addInitScript 注入；纯 JS 字符串零 TS 残留）。
 * 字段命名避开脱敏 key 模式（url→src、function→fn）。 */
const DASH_HOOK_SRC = `(() => {
  if (window.__dashPerfHookInstalled) return;
  window.__dashPerfHookInstalled = true;
  const state = {
    ltCount: 0, ltTotalMs: 0, ltMaxMs: 0, ltDurations: [],
    loafCount: 0, loafCpuMs: 0, loafBySrc: [],
    mutBuckets: [], // { t, count }：500ms 桶（t=document 相对 ms）
    mutTotal: 0,
    rafStallCount: 0, rafStallMaxMs: 0, rafLast: 0,
  };
  try {
    const lt = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.ltCount += 1;
        state.ltTotalMs += entry.duration;
        if (entry.duration > state.ltMaxMs) state.ltMaxMs = entry.duration;
        if (state.ltDurations.length < 5000) state.ltDurations.push(entry.duration);
      }
    });
    lt.observe({ type: 'longtask', buffered: true });
  } catch (e) { /* 无 longtask 支持 */ }
  try {
    const loaf = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.loafCount += 1;
        const b = entry.blockingDuration ?? 0;
        state.loafCpuMs += b;
        let u = '', f = '';
        const scripts = entry.scripts || [];
        if (scripts.length > 0) {
          let best = scripts[0];
          for (let i = 1; i < scripts.length; i += 1) {
            if ((scripts[i].duration || 0) > (best.duration || 0)) best = scripts[i];
          }
          u = best.sourceURL || '';
          f = best.sourceFunctionName || '';
        }
        state.loafBySrc.push({ b, u, f });
        if (state.loafBySrc.length >= 3000) state.loafBySrc.length = 2000;
      }
    });
    loaf.observe({ type: 'long-animation-frame', buffered: true });
  } catch (e) { /* 无 LoAF 支持 */ }
  // rAF 帧停顿（兜底口径）
  let rafActive = false;
  const tick = (t) => {
    if (state.rafLast && t - state.rafLast > 60) {
      state.rafStallCount += 1;
      if (t - state.rafLast > state.rafStallMaxMs) state.rafStallMaxMs = t - state.rafLast;
    }
    state.rafLast = t;
    if (!rafActive) return;
    requestAnimationFrame(tick);
  };
  window.__dashPerfStartRaf = () => {
    if (rafActive) return;
    rafActive = true;
    state.rafLast = 0;
    requestAnimationFrame(tick);
  };
  window.__dashPerfStopRaf = () => { rafActive = false; };
  // DOM mutation 桶（观察整个 body，记录桶计数与涉及节点数；tab 内容区变化占主体）
  let bucketStart = performance.now();
  let bucketCount = 0;
  let mutObs = null;
  try {
    mutObs = new MutationObserver((muts) => {
      bucketCount += muts.length;
      state.mutTotal += muts.length;
    });
    mutObs.observe(document.body || document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
    });
    setInterval(() => {
      const now = performance.now();
      if (bucketCount > 0) state.mutBuckets.push({ t: Math.round((bucketStart + now) / 2), count: bucketCount });
      bucketStart = now;
      bucketCount = 0;
    }, 500);
  } catch (e) { /* 无 MutationObserver 则跳过 */ }
  window.__dashPerfRead = () => {
    if (mutObs) mutObs.disconnect();
    const durs = state.ltDurations.slice().sort((a, b) => a - b);
    const p95 = durs.length > 0 ? durs[Math.min(durs.length - 1, Math.floor(durs.length * 0.95))] : 0;
    const bySrc = new Map();
    for (const e of state.loafBySrc) {
      const key = e.f + '@' + e.u;
      const cur = bySrc.get(key) || { src: e.u, fn: e.f, count: 0, cpuMs: 0 };
      cur.count += 1;
      cur.cpuMs += e.b;
      bySrc.set(key, cur);
    }
    const top = [...bySrc.values()].sort((a, b) => b.cpuMs - a.cpuMs).slice(0, 12).map((e) => ({ ...e, cpuMs: Math.round(e.cpuMs) }));
    return {
      longTask: { count: state.ltCount, totalMs: Math.round(state.ltTotalMs), maxMs: Math.round(state.ltMaxMs), p95Ms: Math.round(p95) },
      loaf: { count: state.loafCount, cpuMs: Math.round(state.loafCpuMs), topSources: top },
      rafStall: { count: state.rafStallCount, maxMs: Math.round(state.rafStallMaxMs) },
      domMutations: { total: state.mutTotal, buckets: state.mutBuckets },
    };
  };
})()`;

interface DashTabResult {
  tab: string;
  url: string;
  settleMs: number;
  interactMs: number;
  rendered: boolean;
  longTask: { count: number; totalMs: number; maxMs: number; p95Ms: number };
  loaf: { count: number; cpuMs: number; topSources: Array<{ src: string; fn: string; count: number; cpuMs: number }> };
  rafStall: { count: number; maxMs: number };
  domMutations: { total: number; buckets: Array<{ t: number; count: number }> };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.env.JAVDB_EXTENSION_PROFILE = PROFILE_DIR;
  process.env.JAVDB_EXTENSION_USE_CHROME_DATA = '0';
  const options = resolveExtensionHarnessOptions(process.env, CWD);
  const context = await launchExtensionContext(options, {
    headless: false,
    channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
    extraArgs: ['--no-proxy-server'],
  });
  const results: DashTabResult[] = [];
  try {
    const extensionId = await readExtensionId(context, 30_000);
    await context.addInitScript(DASH_HOOK_SRC);
    for (const tab of args.tabs) {
      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`chrome-extension://${extensionId}/dashboard/dashboard.html#${tab}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      }).catch(() => {});
      await page.waitForTimeout(1_500); // 外壳挂载 + 首个 partial init
      await page.evaluate('window.__dashPerfStartRaf?.()').catch(() => {});
      // 稳定窗：等 tab 内容渲染（容器有子节点）或超时
      let rendered = false;
      try {
        await page.waitForFunction((t: string) => {
          const el = document.querySelector(`#${t}`) || document.querySelector(`.tab-section[data-tab-id="${t}"]`);
          return !!el && el.childElementCount > 0;
        }, tab, { timeout: args.settleMs });
        rendered = true;
      } catch { /* 内容未渲染仍继续（基线数据标注 rendered=false） */ }
      const settleStart = Date.now();
      await page.waitForTimeout(Math.max(0, args.settleMs - (Date.now() - settleStart)));
      // 交互：内容区滚动（媒体库/日志为长列表）
      if (args.interactMs > 0) {
        await page.evaluate((t: string) => {
          const el = document.querySelector(`#${t}`) || document.querySelector(`.tab-section[data-tab-id="${t}"]`);
          const scroller = (el && (el.querySelector('.list, .media-grid, .container, [class*="scroll"]') as HTMLElement | null)) ?? el;
          if (scroller && scroller.scrollHeight > scroller.clientHeight) scroller.scrollTop = scroller.scrollHeight / 2;
          window.scrollTo(0, document.body.scrollHeight / 3);
        }, tab).catch(() => {});
        await page.waitForTimeout(args.interactMs);
      }
      await page.evaluate('window.__dashPerfStopRaf?.()').catch(() => {});
      const data = await page.evaluate('window.__dashPerfRead?.() ?? null').catch(() => null) as DashTabResult | null;
      if (data) {
        results.push({
          tab,
          url: page.url(),
          settleMs: args.settleMs,
          interactMs: args.interactMs,
          rendered,
          longTask: data.longTask,
          loaf: data.loaf,
          rafStall: data.rafStall,
          domMutations: data.domMutations,
        });
      }
      await page.close().catch(() => {});
    }
  } finally {
    await context.close();
  }
  mkdirSync(args.outDir, { recursive: true });
  const outPath = path.join(args.outDir, `dashboard-baseline-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outPath, `${JSON.stringify({ capturedAt: new Date().toISOString(), profile: 'perf-s0', results }, null, 2)}\n`, 'utf8');
  for (const r of results) {
    const top = r.loaf.topSources.slice(0, 3).map((t) => `${t.fn || t.src.split('/').pop()}=${t.cpuMs}ms`).join(' ');
    console.log(`[dash] ${r.tab} rendered=${r.rendered} longTask=${r.longTask.count}个/${r.longTask.totalMs}ms(max ${r.longTask.maxMs}ms, p95 ${r.longTask.p95Ms}ms) loafCpu=${r.loaf.cpuMs}ms domMut=${r.domMutations.total} top: ${top || '（无）'}`);
  }
  console.log(`[dash] 基线已落盘 ${outPath}`);
}

main().catch((e) => { console.error('dashboardPerfBaseline failed:', String(e)); process.exit(1); });
