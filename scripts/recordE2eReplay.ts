/**
 * @file recordE2eReplay.ts
 * @description cycle-10 E2E 离线回放预热器：一次拉全、落盘回放缓存，功能测试后续零源站压力。
 *
 * 背景：本机直连源站 CDN 路由断，且用户要求「代码与功能测试全离线、最后才做源站真实验证」。
 * 本脚本按 E2E spec 的真实选取逻辑（contentMainChain / enhancementItemAudit-*）算出
 * 全部会访问的页面 URL，分两阶段预热 scripts/perfReplay.ts 同格式的缓存：
 *
 *   Stage A（node，走代理 10808）：列表 /?vst=1、/?vft=2 + 前 8 个影片详情页 +
 *     候选演员页（复现 audit-actor 的 primary/divider 选取，找到即停，上限 12 人），
 *     每页 1 次 GET，写入缓存（已存在跳过，first-write-wins）；
 *   Stage B（浏览器 record 模式，走代理）：仅对 Stage A 新录的页面导航一次，
 *     把封面/JS/CSS 等子资源补录进缓存（矩阵预热轮已录的资产无需重录）。
 *
 * 用法：
 *   npx tsx scripts/recordE2eReplay.ts --cache /tmp/c10s01/replay-cache
 *     [--base https://javdb570.com] [--proxy http://127.0.0.1:10808] [--max-actors 12]
 * 铁律：只写回放缓存目录；不碰真实 Chrome profile / Emby / 115。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { attachReplay } from './perfReplay';

const FETCH_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const NAV_ACTOR_IDS = new Set(['censored', 'uncensored', 'western']);
const SEGMENTATION_MONTHS = 6;
const OLD_WORK_BUFFER_DAYS = 7;

interface Args {
  cacheDir: string;
  base: string;
  proxy: string;
  maxActors: number;
  skipBrowser: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cacheDir: '/tmp/c10s01/replay-cache', base: 'https://javdb570.com', proxy: 'http://127.0.0.1:10808', maxActors: 12, skipBrowser: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cache') args.cacheDir = argv[++i];
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--proxy') args.proxy = argv[++i];
    else if (a === '--max-actors') args.maxActors = Number(argv[++i]);
    else if (a === '--skip-browser') args.skipBrowser = true;
  }
  return args;
}

function cacheKey(method: string, url: string): string {
  return crypto.createHash('sha1').update(`${method} ${url}`).digest('hex');
}

function entryPath(cacheDir: string, url: string): string {
  const key = cacheKey('GET', url);
  return path.join(cacheDir, key.slice(0, 2), `${key}.json`);
}

function readCached(cacheDir: string, url: string): string | null {
  try {
    const e = JSON.parse(fs.readFileSync(entryPath(cacheDir, url), 'utf8')) as { b: string };
    return Buffer.from(e.b, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function writeCached(cacheDir: string, url: string, body: string, status: number): void {
  const key = cacheKey('GET', url);
  const file = path.join(cacheDir, key.slice(0, 2), `${key}.json`);
  if (fs.existsSync(file)) return; // first-write-wins
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    m: 'GET', u: url, s: status,
    h: [['content-type', 'text/html; charset=utf-8']] as [string, string][],
    b: Buffer.from(body, 'utf8').toString('base64'),
  }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.cacheDir, { recursive: true });
  // Stage A 只需 GET HTML：走代理用 curl（避免 pnpm 严格模式下 undici 不可直引）
  function fetchViaProxy(url: string): string | null {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const body = execFileSync('curl', [
          '-s', '--proxy', args.proxy, '--max-time', '45',
          '-w', '\n__HTTP_STATUS__%{http_code}',
          '-A', FETCH_UA, url,
        ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) as string;
        const sep = body.lastIndexOf('\n__HTTP_STATUS__');
        const status = Number(body.slice(sep + '__HTTP_STATUS__'.length + 1));
        const html = body.slice(0, sep);
        if (status !== 200) {
          console.info(`[record] ${url} -> HTTP ${status}`);
          continue;
        }
        return html;
      } catch (e) {
        console.info(`[record] ${url} 尝试 ${attempt + 1} 失败: ${String(e).slice(0, 160)}`);
      }
    }
    return null;
  }

  const newDocs: string[] = []; // Stage A 新录的页面（Stage B 要导航补子资源）
  async function get(url: string): Promise<string | null> {
    const cached = readCached(args.cacheDir, url);
    if (cached !== null) return cached;
    const body = fetchViaProxy(url);
    if (body === null) return null;
    writeCached(args.cacheDir, url, body, 200);
    newDocs.push(url);
    console.info(`[record] 新录 ${url}`);
    return body;
  }

  // ---- 列表页 ----
  const listUrl = `${args.base}/?vst=1`;
  const tagListUrl = `${args.base}/?vft=2`;
  const listHtml = await get(listUrl);
  await get(tagListUrl);
  if (!listHtml) throw new Error(`列表页拉取失败: ${listUrl}`);

  // ---- 前 8 个影片（与 audit-actor 的 listIds 选取同口径）----
  const listIds: string[] = [];
  const seenIds = new Set<string>();
  for (const m of listHtml.matchAll(/href="\/v\/([A-Za-z0-9]+)"/g)) {
    if (!seenIds.has(m[1])) {
      seenIds.add(m[1]);
      listIds.push(m[1]);
    }
    if (listIds.length >= 8) break;
  }
  console.info(`[record] 列表前 8 个影片: ${listIds.join(', ')}`);

  // ---- 演员候选（与 audit-actor 的 pickActorsFromDetail 同口径）----
  const candidates: { id: string; name: string }[] = [];
  const seenActors = new Set<string>();
  for (const vid of listIds) {
    const detailUrl = `${args.base}/v/${vid}`;
    const detailHtml = await get(detailUrl);
    if (!detailHtml) continue;
    for (const m of detailHtml.matchAll(/href="\/actors\/([A-Za-z0-9]+)"[^>]*>([^<]{1,30})</g)) {
      const id = m[1];
      const name = m[2].trim();
      if (NAV_ACTOR_IDS.has(id) || seenActors.has(id) || !name) continue;
      seenActors.add(id);
      candidates.push({ id, name });
      if (candidates.length >= 12) break;
    }
    if (candidates.length >= 12) break;
  }
  console.info(`[record] 演员候选 ${candidates.length} 人: ${candidates.map((a) => `${a.name}(${a.id})`).join(', ')}`);

  // ---- 演员页（复现 primary/divider 选取，两者齐了就停）----
  const threshold = Date.now() - (SEGMENTATION_MONTHS * 30 + OLD_WORK_BUFFER_DAYS) * 24 * 60 * 60 * 1000;
  let primaryFound = false;
  let dividerFound = false;
  let actorPages = 0;
  for (const actor of candidates) {
    if (actorPages >= args.maxActors) break;
    const url = `${args.base}/actors/${actor.id}`;
    const html = await get(url);
    actorPages += 1;
    if (!html) continue;
    if (!primaryFound && (html.match(/<div class="item[" >]/g) ?? []).length > 0) primaryFound = true;
    const dates: number[] = [];
    for (const block of html.split(/<div class="item[" >]/).slice(1)) {
      const meta = block.match(/<div class="meta[^"]*">[\s\S]*?<\/div>/)?.[0] ?? '';
      const dm = meta.match(/(20\d{2}|19\d{2})[./-](\d{1,2})[./-](\d{1,2})/);
      if (!dm) continue;
      const t = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])).getTime();
      if (!Number.isNaN(t)) dates.push(t);
    }
    if (!dividerFound && dates.some((d) => d < threshold)) dividerFound = true;
    console.info(`[record] 演员页 ${actor.name}(${actor.id}): primary=${primaryFound} divider=${dividerFound}`);
    if (primaryFound && dividerFound) break;
  }
  console.info(`[record] primary=${primaryFound} divider=${dividerFound}（actor-audit A02/A03 数据依赖已满足与否）`);

  if (args.skipBrowser) {
    console.info(`[record] --skip-browser：跳过子资源补录。Stage A 完成，新录 ${newDocs.length} 页`);
    return;
  }

  // ---- Stage B：浏览器 record 模式补子资源（仅新录页面）----
  console.info(`[record] Stage B：浏览器补录 ${newDocs.length} 页的子资源`);
  const browser = await chromium.launch({
    headless: false,
    args: [`--proxy-server=${args.proxy}`, '--proxy-bypass-list=<-loopback>'],
  });
  const context = await browser.newContext({ userAgent: FETCH_UA });
  await context.addCookies([{ name: 'over18', value: '1', domain: new URL(args.base).hostname, path: '/' }]);
  const replay = await attachReplay(context, {
    cacheDir: args.cacheDir,
    mode: 'record',
    log: (msg) => console.info(msg),
  });
  const page = await context.newPage();
  for (const url of newDocs) {
    await replay.awaitReady(page);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await replay.captureDocument(page);
      await page.waitForTimeout(3000); // 等封面等子资源落盘
    } catch (e) {
      console.info(`[record] 补录导航失败 ${url}: ${String(e).slice(0, 120)}`);
    }
  }
  const { total } = replay.stats();
  console.info(`[record] Stage B 统计: 拦截 ${total.intercepted} / 新录 ${total.recorded} / 重复 ${total.duplicates} / 失败 ${total.recordFail}`);
  await browser.close();
  console.info('[record] 预热完成');
}

main().catch((e) => {
  console.error('[record] 失败:', e);
  process.exit(1);
});
