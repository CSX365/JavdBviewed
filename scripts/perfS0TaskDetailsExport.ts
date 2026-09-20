/**
 * @file perfS0TaskDetailsExport.ts
 * @description cycle-11 S1-2b 真机证据导出：从 perf-s0 profile 的 SW 内用 chrome.storage.local.get
 *   读出 orchestratorTaskDetails（hot）+ orchestratorTaskDetailsArchive + orchestratorMetrics，
 *   落盘 JSON 供 waitReason 分布分析（S1-2b global-heavy-budget 真机证据）。
 *
 * 为什么走 CDP 浏览器内导出：外部解析 LevelDB 路线卡在 idb_cmp1（UTF-16 码元序）键编码，
 *   性价比过低；SW 内直接读 storage 零格式风险，且天然含 WAL 最新数据。
 *
 * 用法（DISPLAY=:12；代理 10808；跑批禁区零触碰，本脚本独立）：
 *   JAVDB_EXTENSION_PROFILE=.test-profiles/perf-s0 \
 *   pnpm tsx scripts/perfS0TaskDetailsExport.ts
 *
 * 输出：/tmp/c11s01/taskdetails-s8s9.json
 * 铁律：只读（只 get，不 set/remove）；只动 .test-profiles/perf-s0；不 push。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';

import {
  createChromiumExtensionArgs,
  readExtensionId,
  resolveExtensionHarnessOptions,
} from './extensionHarness';

const CWD = path.resolve(import.meta.dirname, '..');
const OUT_FILE = '/tmp/c11s01/taskdetails-s8s9.json';
const PROXY = 'http://127.0.0.1:10808';
/** 单次 evaluate 返回的条目上限（防超大 JSON 回传失败） */
const CHUNK = 100;

const HOT_KEY = 'orchestratorTaskDetails';
const ARCHIVE_KEY = 'orchestratorTaskDetailsArchive';
const METRICS_KEY = 'orchestratorMetrics';

const log = (m: string): void => console.log(`[taskdetails-export] ${m}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** SW 内读取：返回某键数组长度（storage 无该键为 null） */
const getCount = async (key: string): Promise<number | null> => {
  const items = await chrome.storage.local.get(key);
  const v = items[key];
  return Array.isArray(v) ? v.length : null;
};

/** SW 内读取：返回某键数组的 [start, start+len) 切片（纯读） */
const getSlice = async (params: { key: string; start: number; len: number }): Promise<unknown[]> => {
  const items = await chrome.storage.local.get(params.key);
  const v = items[params.key];
  if (!Array.isArray(v)) return [];
  return v.slice(params.start, params.start + params.len);
};

async function fetchKeySlices(sw: Worker, key: string): Promise<unknown[]> {
  const count = await sw.evaluate(getCount, key);
  if (!count || count <= 0) {
    log(`${key}: 空`);
    return [];
  }
  log(`${key}: ${count} 条，按 ${CHUNK}/片拉取`);
  const out: unknown[] = [];
  for (let start = 0; start < count; start += CHUNK) {
    const piece = await sw.evaluate(getSlice, { key, start, len: CHUNK });
    out.push(...piece);
  }
  if (out.length !== count) throw new Error(`${key} 分片拉取数量不符：期望 ${count}，实得 ${out.length}`);
  return out;
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

async function main(): Promise<void> {
  const options = resolveExtensionHarnessOptions(process.env, CWD);
  if (!options.userDataDir.includes('.test-profiles')) {
    throw new Error(`拒绝运行：profile 不在 .test-profiles 下（${options.userDataDir}）`);
  }
  log(`profile=${options.userDataDir} ext=${options.extensionDir}`);

  const context = await chromium.launchPersistentContext(options.userDataDir, {
    headless: false,
    channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
    args: [
      ...createChromiumExtensionArgs(options.extensionDir),
      `--proxy-server=${PROXY}`,
    ],
  });

  let dashboard: Page | null = null;
  try {
    const extensionId = await readExtensionId(context, 30_000);
    log(`扩展 ID=${extensionId}`);

    // 打开 dashboard 确保 SW 被唤醒并保活（读取期间 SW 可能因空闲被终止）
    dashboard = await context.newPage();
    await dashboard.goto(`chrome-extension://${extensionId}/dashboard/dashboard.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    log('dashboard 已打开（SW 唤醒）');

    // SW 可能尚未注册完成；evaluate 失败则轮询重试（SW 重启后取新实例）
    let sw: Worker | null = null;
    let hot: unknown[] | null = null;
    let archive: unknown[] | null = null;
    let metrics: unknown[] | null = null;
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (!sw) {
        try {
          sw = await waitForExtensionServiceWorker(context, 15_000);
        } catch {
          if (Date.now() >= deadline) throw new Error('SW 始终未出现');
          continue;
        }
      }
      try {
        hot = await fetchKeySlices(sw, HOT_KEY);
        archive = await fetchKeySlices(sw, ARCHIVE_KEY);
        metrics = await fetchKeySlices(sw, METRICS_KEY);
        break;
      } catch (error) {
        log(`evaluate 失败（SW 可能已重启）：${error instanceof Error ? error.message : String(error)}，重试`);
        sw = null;
        if (Date.now() >= deadline) throw error;
        await sleep(1_000);
      }
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      source: `chrome.storage.local @ ${options.userDataDir}（CDP SW eval，perf-s0）`,
      counts: { hot: hot.length, archive: archive.length, metrics: metrics.length },
      hot,
      archive,
      metrics,
    };
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`);
    log(`已写出 ${OUT_FILE}（hot=${hot.length} archive=${archive.length} metrics=${metrics.length}，` +
      `${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)}KB）`);
  } finally {
    await context.close().catch(() => {});
  }

  // 确认 Chrome 全部退出
  for (let i = 0; i < 20; i += 1) {
    const { execSync } = await import('node:child_process');
    const pids = execSync("pgrep -c chrome 2>/dev/null || true").toString().trim();
    if (pids === '0') { log('Chrome 进程已清零'); break; }
    await sleep(500);
    if (i === 19) log(`警告：仍有 ${pids} 个 chrome 进程`);
  }
}

main().catch((error) => {
  console.error(`[taskdetails-export] 失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
