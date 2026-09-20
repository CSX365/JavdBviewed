/**
 * @file perfS0WaitReasonProbe.ts
 * @description cycle-11 S1-2b 真机证据探针：16 列表页 enhanced 臂（与 s9 同口径）跑批期间，
 *   用原始 CDP Runtime.consoleAPICalled 捕获全部 execution context（含扩展 isolated world）
 *   的 console 输出，聚合任务排队/重试日志中的 waitReason 分布。
 *
 * 背景：task details 落盘不含 waitReason（它是 globalTaskCenter 内存态）；
 *   initOrchestrator 每次因租约不可用被弹回时打
 *   [Orchestrator] deferred retry scheduled { phase, label, waitReason, retryDelayMs, ... }
 *   （content isolated world console）。本探针只读 console，不改扩展代码，不碰跑批禁区脚本。
 *
 * 用法（DISPLAY=:12；代理 10808；零源站压力——全程回放）：
 *   JAVDB_EXTENSION_PROFILE=.test-profiles/perf-s0 \
 *   pnpm tsx scripts/perfS0WaitReasonProbe.ts --tabs 16 --steady 90
 *
 * 输出 /tmp/c11s01/waitreason-probe-r<ts>/：
 *   waitreason-summary.json   聚合（waitReason 计数、per-tab、样本）
 *   console-events.jsonl      命中行原始记录（含完整 args 预览）
 * 铁律：只读 profile perf-s0；跑批期间禁 rebuild；不 push。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createChromiumExtensionArgs,
  readExtensionId,
  resolveExtensionHarnessOptions,
} from './extensionHarness';
import { attachReplay, type ReplayHandle } from './perfReplay';
import { launchRealVisibilityContext } from './realVisibilityLaunch';

const CWD = path.resolve(import.meta.dirname, '..');
const PROFILE_DIR = path.resolve(CWD, '.test-profiles', 'perf-s0');
const PROXY = 'http://127.0.0.1:10808';
const REPLAY_DIR = '/tmp/c10s01/replay-cache';
const SITE_LIST_URL = 'https://javdb570.com/search?q=test';
const OUT_ROOT = '/tmp/c11s01';

/** 与 perfS0Profile/perfS0VideoCensus ARM_SETTINGS 同口径（enhanced=用户真实增强开关） */
const ARM_SETTINGS: Record<string, unknown> = {
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
};

const log = (m: string): void => console.log(`[waitreason-probe] ${m}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

let captureAll = false;
let detail = false;
let tabs = 16;
let steadyMs = 90_000;
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a === '--tabs') tabs = Number(process.argv[++i] ?? 16);
  else if (a === '--steady') steadyMs = Number(process.argv[++i] ?? 90) * 1000;
  else if (a === '--all') captureAll = true;
  else if (a === '--detail') detail = true;
}

interface CdpRemoteObject {
  type: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  preview?: { properties?: { name: string; type: string; value?: unknown; valuePreview?: string; unserializableValue?: string }[] };
}

/** 从 consoleAPICalled args 提取可读文本（浅层，够抽 waitReason） */
function argTexts(args: CdpRemoteObject[]): string[] {
  return args.map((a) => {
    if (a.type === 'string') return String(a.value ?? '');
    if (a.type === 'number' || a.type === 'boolean' || a.type === 'undefined' || a.type === 'null') return String(a.value ?? a.type);
    if (a.type === 'object' || a.type === 'object') {
      // 浅重建：取 preview.properties 的 value/valuePreview
      const p = a.preview;
      if (p?.properties?.length) {
        const parts = p.properties.map((pr) => {
          if (pr.valuePreview) return `${pr.name}:${pr.valuePreview}`;
          if (pr.unserializableValue) return `${pr.name}:${pr.unserializableValue}`;
          if (pr.value !== undefined) return `${pr.name}:${JSON.stringify(pr.value)}`;
          return `${pr.name}:<${pr.type}>`;
        });
        return `{${parts.join(', ')}}`;
      }
      return a.description ?? '<object>';
    }
    return a.description ?? a.type;
  });
}

const WAIT_RE = /deferred retry scheduled|waiting for|lease retry|stall: forcing|hidden-leak|foreground task resumed|background lease retry resumed/;

async function main(): Promise<void> {
  const outDir = path.join(OUT_ROOT, `waitreason-probe-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const rawLog = fs.openSync(path.join(outDir, 'console-events.jsonl'), 'a');
  const writeRaw = (o: unknown): void => { fs.writeSync(rawLog, `${JSON.stringify(o)}\n`); };

  if (!fs.existsSync(PROFILE_DIR)) throw new Error(`perf-s0 profile 不存在：${PROFILE_DIR}`);
  const options = resolveExtensionHarnessOptions({ ...process.env, JAVDB_EXTENSION_PROFILE: '.test-profiles/perf-s0' }, CWD);
  log(`profile=${options.userDataDir} ext=${options.extensionDir} tabs=${tabs} steady=${steadyMs / 1000}s`);

  const realVis = await launchRealVisibilityContext(options, {
    headless: false,
    channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
    extraArgs: [`--proxy-server=${PROXY}`],
  });
  const { context, browser } = realVis;

  type WaitHit = { t: number; tab: number; kind: string; msg: string; waitReason?: string };
  const hits: WaitHit[] = [];

  try {
    const extensionId = await readExtensionId(context, 30_000);
    log(`扩展 ID=${extensionId}`);
    const sw = await (async () => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const ws = context.serviceWorkers();
        const w = ws.find((x) => x.url().startsWith('chrome-extension://')) ?? ws[0];
        if (w) return w;
        if (Date.now() >= deadline) throw new Error('SW 未出现');
        await sleep(300);
      }
    })();
    await sw.evaluate((data: Record<string, unknown>) => chrome.storage.local.set(data), ARM_SETTINGS);
    log('enhanced 臂设置已写入');

    const replay: ReplayHandle = await attachReplay(context, {
      cacheDir: REPLAY_DIR,
      mode: 'replay',
      log: (m) => log(`[replay] ${m}`),
    });
    log('回放已挂载');

    // 门卫 tab：年龄门 + 登录检查（与 s9 同口径）
    await context.addCookies([{ name: 'over18', value: '1', domain: 'javdb570.com', path: '/' }]).catch(() => {});
    const gate = await context.newPage();
    let gateLoaded = false;
    try {
      await replay.awaitReady(gate);
      await gate.goto(SITE_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      gateLoaded = true;
    } catch (error) { log(`门卫 tab 加载失败: ${errMsg(error)}`); }
    if (!gateLoaded) throw new Error('门卫 tab 未加载，中止');
    try {
      const yes = gate.locator('a[href*="over18?respond=1"]').first();
      await yes.waitFor({ state: 'visible', timeout: 15_000 });
      await yes.click({ timeout: 10_000 });
      await sleep(1_000);
    } catch { /* 无年龄门（已验证过），忽略 */ }
    const onLoginPage = await gate.evaluate(() => location.pathname.startsWith('/login')).catch(() => false);
    if (onLoginPage) throw new Error('登录墙：perf-s0 登录态失效，先跑 loginPerfS0.ts');

    // detail 模式：从门卫列表页收集 /v/ 详情页 URL（同 perfSourcelessProbe.collectDetailUrls 口径）
    let detailUrls: string[] = [];
    if (detail) {
      detailUrls = await gate
        .evaluate((n: number) => {
          const seen = new Set<string>();
          const out: string[] = [];
          for (const a of Array.from(document.querySelectorAll('a[href^="/v/"]'))) {
            const href = a.getAttribute('href');
            if (!href) continue;
            let abs = '';
            try { abs = new URL(href, location.origin).toString(); } catch { continue; }
            if (!seen.has(abs)) { seen.add(abs); out.push(abs); }
            if (out.length >= n) break;
          }
          return out;
        }, tabs + 4)
        .catch(() => [] as string[]);
      if (detailUrls.length < tabs) {
        // 不够就循环复用
        while (detailUrls.length < tabs) detailUrls.push(detailUrls[detailUrls.length % Math.max(detailUrls.length, 1)]);
        log(`detail URL 不足，循环复用：${detailUrls.length}`);
      } else {
        log(`detail 模式：收集到 ${detailUrls.length} 个详情页 URL`);
      }
    }

    const pages: { tab: number; page: import('@playwright/test').Page }[] = [];
    for (let i = 0; i < tabs; i += 1) {
      const page = await context.newPage();
      pages.push({ tab: i + 1, page });
      // 原始 CDP：全部 execution context 的 console（含扩展 isolated world）
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Runtime.enable').catch((e) => log(`tab${i + 1} Runtime.enable 失败: ${errMsg(e)}`));
      cdp.on('Runtime.consoleAPICalled', (event: any) => {
        const texts = argTexts((event.args ?? []) as CdpRemoteObject[]);
        const joined = texts.join(' ');
        if (!captureAll && !WAIT_RE.test(joined)) return;
        if (captureAll && hits.length >= 3000) return;
        const waitReason = joined.match(/waitReason:([^,\s}]+)/)?.[1];
        const hit: WaitHit = { t: Date.now(), tab: i + 1, kind: detail ? 'detail' : 'list', msg: joined.slice(0, 400), ...(waitReason ? { waitReason } : {}) };
        hits.push(hit);
        writeRaw({ ...hit, ctx: event.executionContextId });
      });
      const targetUrl = detail ? (detailUrls[i] ?? SITE_LIST_URL) : SITE_LIST_URL;
      try {
        await replay.awaitReady(page);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      } catch (error) { log(`tab${i + 1} 加载失败: ${errMsg(error)}`); }
      try {
        const sel = detail ? 'h1.title, .video-title, .cover' : '.x-btn, .jdb-list-status-actions';
        await page.waitForSelector(sel, { timeout: 30_000 });
      } catch { log(`tab${i + 1} 增强标记未出现（30s 预算）`); }
      if (i < tabs - 1) await sleep(250);
    }
    log(`tInt 完成：${tabs} tab 全部就绪/超时，开始 steady ${steadyMs / 1000}s`);

    const steadyEnd = Date.now() + steadyMs;
    while (Date.now() < steadyEnd) await sleep(2_000);

    // --- 汇总 ---
    const wrCount = new Map<string, number>();
    const msgCount = new Map<string, number>();
    const perTab = new Map<number, number>();
    for (const h of hits) {
      if (h.waitReason) wrCount.set(h.waitReason, (wrCount.get(h.waitReason) ?? 0) + 1);
      const head = h.msg.slice(0, h.msg.indexOf('{') > 0 ? h.msg.indexOf('{') : 120).trim();
      msgCount.set(head, (msgCount.get(head) ?? 0) + 1);
      perTab.set(h.tab, (perTab.get(h.tab) ?? 0) + 1);
    }
    const summary = {
      exportedAt: new Date().toISOString(),
      arm: 'enhanced',
      tabs,
      steadyMs,
      replay: REPLAY_DIR,
      totalHits: hits.length,
      waitReasonCounts: Object.fromEntries([...wrCount.entries()].sort((a, b) => b[1] - a[1])),
      messageCounts: Object.fromEntries([...msgCount.entries()].sort((a, b) => b[1] - a[1])),
      perTabHits: Object.fromEntries([...perTab.entries()].sort((a, b) => a[0] - b[0])),
      sampleGlobalHeavyBudget: hits.filter((h) => h.waitReason === 'global-heavy-budget').slice(0, 10),
      sampleHits: hits.slice(0, 20),
    };
    fs.writeFileSync(path.join(outDir, 'waitreason-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    log(`汇总已写出 ${outDir}/waitreason-summary.json（总命中 ${hits.length}）`);
    log(`waitReason 分布: ${JSON.stringify(summary.waitReasonCounts)}`);
  } finally {
    fs.closeSync(rawLog);
    await realVis.cleanup().catch(() => {});
  }
  for (let i = 0; i < 20; i += 1) {
    const { execSync } = await import('node:child_process');
    const pids = execSync('pgrep -c chrome 2>/dev/null || true').toString().trim();
    if (pids === '0') { log('Chrome 进程已清零'); break; }
    await sleep(500);
  }
}

main().catch((error) => {
  console.error(`[waitreason-probe] 失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
