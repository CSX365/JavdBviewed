/**
 * @file contentMainChain.spec.ts
 * @description S1.5 真机回归：内容脚本主链在性能优化后的端到端可用性。
 * 覆盖 S1.5 审计涉及的主链面：
 *   T1 详情页主链（干净 profile）：
 *      - 注入标记 documentElement.dataset.javdbExtensionInjected === '1'；
 *      - F2 语义固化：主开关 videoEnhancement.enabled 默认开启，
 *        「相关清单」点击拦截随默认值安装（见 research/p0-content.md F2）；
 *      - 热键默认关（userExperience.enableKeyboardShortcuts 默认 false）：
 *        页面无 .keyboard-shortcuts-help 帮助面板。
 *   T2 状态同步（seed 已看记录）：
 *      - 详情页标题出现 [已观看]（statusManager 主链 + F3 轮询稳定后停止）；
 *      - 列表页对应 item 出现 .custom-status-tag「已观看」徽章（listEnhancement）。
 *      记录经 dashboard 页直写同源 IndexedDB（javdb_v1 / viewedRecords），
 *      内容脚本经 SW 消息 DB:VIEWED_GET 读取，链路真实。
 *   T3 演员页增强（F1 统一门控开启后）：
 *      - seed userExperience.enableActorEnhancement=true 后，
 *        演员页控制台出现「演员页增强功能已启用」marker。
 *   T4 主开关显式关（seed videoEnhancement.enabled=false）：
 *      - 无「相关清单」点击拦截 log（负向断言，先等主链就绪信号再观察）；
 *      - 状态同步照常：seed 已看记录后详情页标题仍出现 [已观看]
 *        （数据行为不受主开关约束）。
 *   T5 子开关显式关（seed videoEnhancement.enableRelatedLists=false，主开）：
 *      - 无「相关清单」点击拦截 log（负向断言）。
 * @module tests/extension-e2e
 */
import { expect, test } from '@playwright/test';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import {
  extensionPageUrl,
  launchExtensionContext,
  readExtensionId,
  resolveExtensionHarnessOptions,
  seedExtensionStorage,
  siteFetchText,
} from '../../scripts/extensionHarness';

function resolveTestHarnessOptions(userDataDir: string): ReturnType<typeof resolveExtensionHarnessOptions> {
  return resolveExtensionHarnessOptions(
    {
      ...process.env,
      JAVDB_EXTENSION_USE_CHROME_DATA: '0',
      JAVDB_EXTENSION_PROFILE: path.resolve(userDataDir),
    },
    process.cwd(),
  );
}

const JAVDB_E2E_HOST = 'https://javdb570.com';
const FETCH_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const NAV_ACTOR_IDS = new Set(['censored', 'uncensored', 'western']);

interface PickedTarget {
  videoId: string;
  videoCode: string;
  videoUrl: string;
  actorUrl: string | null;
}

/** 从最新影片列表取一条（含番号）+ 一位真实演员（网络不可用返回 null）。
 * 顶部影片可能是素人作品（站点演员字段为 N/A，无 /actors/ 链接）——
 * 此时顺延取第 2、3 条直到找到有演员的影片，保证 T3（演员页增强）可被真机执行；
 * 三条都没有演员时退回第一条（T3 按设计 skip，站点数据依赖）。 */
async function pickLatestVideoWithActor(): Promise<PickedTarget | null> {
  try {
    // 预检 fetch 偶发瞬时抖动，siteFetchText 内部已含重试；JAVDB_E2E_PROXY 设置时自动走代理
    const listHtml = await siteFetchText(`${JAVDB_E2E_HOST}/?vst=1`, { userAgent: FETCH_UA });
    if (!listHtml) return null;

    const blocks: { id: string; code: string }[] = [];
    let idx = listHtml.indexOf('<div class="item');
    for (let n = 0; n < 3 && idx !== -1; n++) {
      const next = listHtml.indexOf('<div class="item', idx + 1);
      const block = listHtml.slice(idx, next === -1 ? undefined : next);
      const idMatch = block.match(/href="\/v\/([A-Za-z0-9]+)"/);
      const codeMatch = block.match(/<div class="video-title[^"]*">[\s\S]*?<strong>([^<]+)<\/strong>/);
      if (!idMatch || !codeMatch) break;
      blocks.push({ id: idMatch[1], code: codeMatch[1].trim() });
      idx = next;
    }
    if (blocks.length === 0) return null;

    const first = blocks[0];
    const firstUrl = `${JAVDB_E2E_HOST}/v/${first.id}`;

    for (const item of blocks) {
      const videoUrl = `${JAVDB_E2E_HOST}/v/${item.id}`;
      const videoHtml = await siteFetchText(videoUrl, { userAgent: FETCH_UA });
      if (!videoHtml) continue;
      const actorLinks = Array.from(videoHtml.matchAll(/href="\/actors\/([A-Za-z0-9]+)"/g));
      for (const match of actorLinks) {
        const actorId = match[1];
        if (!NAV_ACTOR_IDS.has(actorId)) {
          return { videoId: item.id, videoCode: item.code, videoUrl, actorUrl: `${JAVDB_E2E_HOST}/actors/${actorId}` };
        }
      }
    }
    return { videoId: first.id, videoCode: first.code, videoUrl: firstUrl, actorUrl: null };
  } catch (error) {
    console.info('[E2E main-chain] pick target failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** 预置年龄验证 cookie（over18=1），干净 profile 直访即可跳过 18+ 确认页，
 * 避免门后重定向偶发卡顿导致的超时（实测一次 60s+ 未达 domcontentloaded） */
async function presetAgeGateCookie(context: BrowserContext): Promise<void> {
  await context.addCookies([
    { name: 'over18', value: '1', domain: 'javdb570.com', path: '/' },
  ]);
}

/** 全新测试 profile 首次访问影片页可能遇到 18+ 年龄确认页，自动点过（最多 3 轮，兜底） */
async function dismissAgeGateIfPresent(page: import('@playwright/test').Page): Promise<void> {
  for (let round = 0; round < 3; round++) {
    const yes = page.locator('a[href*="over18?respond=1"]').first();
    let visible = false;
    try {
      visible = (await yes.count()) > 0 && (await yes.isVisible());
    } catch {
      return;
    }
    if (!visible) return;
    await yes.click({ timeout: 10_000 });
    // 门后重定向偶发卡顿（真实站点抖动）：等待失败不视为致命，
    // 下一轮会重新探测门是否仍存在，避免 60s×3 轮吃满测试超时
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
    } catch {
      // ignore：继续探测
    }
  }
}

/** 本机环境代理不可达 javdb570，浏览器必须直连；node 侧 fetch 本来就不走代理 */
function stripProxyEnv(): void {
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete process.env[key];
  }
}

/** 经 dashboard 页（扩展同源）直写 IndexedDB：javdb_v1 / viewedRecords（keyPath=id） */
async function seedViewedRecord(context: BrowserContext, extensionId: string, videoCode: string): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto(extensionPageUrl(extensionId, 'dashboard/dashboard.html'), {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.evaluate((id: string) => {
      return new Promise<void>((resolve, reject) => {
        let attempts = 0;
        const attempt = () => {
          attempts += 1;
          const request = indexedDB.open('javdb_v1', 14);
          request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('viewedRecords')) {
              db.close();
              // 扩展存储层尚未建库，稍后重试
              if (attempts < 20) {
                window.setTimeout(attempt, 1_000);
              } else {
                reject(new Error('viewedRecords store 未就绪（20 次重试后）'));
              }
              return;
            }
            const tx = db.transaction('viewedRecords', 'readwrite');
            const now = Date.now();
            tx.objectStore('viewedRecords').put({
              id,
              title: id,
              status: 'viewed',
              createdAt: now,
              updatedAt: now,
            });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error ?? new Error('viewedRecords 写入事务失败'));
            };
          };
          request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'));
          request.onupgradeneeded = () => {
            // 极端情况：DB 首次以本连接创建，补建 store
            const db2 = request.result;
            if (!db2.objectStoreNames.contains('viewedRecords')) {
              db2.createObjectStore('viewedRecords', { keyPath: 'id' });
            }
          };
        };
        attempt();
      });
    }, videoCode);
  } finally {
    await page.close();
  }
}

/** 负向断言护栏：先等主链正信号（isolated world 注入标记），再固定观察窗口后断言
 * 目标 log 缺席。直接断言"无 log"会在内容脚本尚未跑完时竞态假过。 */
async function expectNoConsoleLog(page: Page, consoleLines: string[], needle: string, observeMs = 10_000): Promise<void> {
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.javdbExtensionInjected), {
      timeout: 45_000,
      message: 'documentElement 无 javdbExtensionInjected 标记（内容脚本未注入?）',
    })
    .toBe('1');
  await page.waitForTimeout(observeMs);
  expect(
    consoleLines.some((line) => line.includes(needle)),
    `控制台不应出现「${needle}」（主链已就绪但目标行为仍被安装?）`,
  ).toBe(false);
}

test.describe('content main chain on JavDB real site (S1.5)', () => {
  test.setTimeout(240_000);

  test('T1: detail page injection + related-lists interception (main switch on by default) + shortcuts default off', async ({}, testInfo) => {
    const target = await pickLatestVideoWithActor();
    test.skip(!target, 'javdb570 网络不可用或页面结构变化，跳过真机检查');

    stripProxyEnv();
    const harnessOptions = resolveTestHarnessOptions(testInfo.outputPath('profile'));
    const context = await launchExtensionContext(harnessOptions, {
      headless: false,
      channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
      extraArgs: ['--no-proxy-server'],
    });

    try {
      await readExtensionId(context);
      await presetAgeGateCookie(context);
      const page = context.pages()[0] ?? (await context.newPage());
      const consoleLines: string[] = [];
      page.on('console', (msg) => consoleLines.push(msg.text()));

      await page.goto(target.videoUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await dismissAgeGateIfPresent(page);

      // 1) 内容脚本真实注入（isolated world 写入的 DOM 标记）
      await expect
        .poll(async () => page.evaluate(() => document.documentElement.dataset.javdbExtensionInjected), {
          timeout: 45_000,
          message: 'documentElement 无 javdbExtensionInjected 标记（内容脚本未注入?）',
        })
        .toBe('1');

      // 2) F2 语义固化：主开关默认开启，相关清单点击拦截随默认值安装
      await expect
        .poll(
          () => consoleLines.some((line) => line.includes('[RelatedLists] click interception installed')),
          { timeout: 60_000, message: '相关清单点击拦截未安装（内容脚本主链未跑通?）' },
        )
        .toBeTruthy();

      // 3) 热键默认关：无帮助面板
      const helpPanel = await page.$('.keyboard-shortcuts-help');
      expect(helpPanel, '热键默认应为关闭状态（无帮助面板）').toBeNull();

      console.info(`[E2E main-chain] T1 通过: ${target.videoUrl} code=${target.videoCode}`);
    } finally {
      await context.close();
    }
  });

  test('T2: seeded viewed record syncs to detail title and list status badge', async ({}, testInfo) => {
    const target = await pickLatestVideoWithActor();
    test.skip(!target, 'javdb570 网络不可用或页面结构变化，跳过真机检查');

    stripProxyEnv();
    const harnessOptions = resolveTestHarnessOptions(testInfo.outputPath('profile'));
    const context = await launchExtensionContext(harnessOptions, {
      headless: false,
      channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
      extraArgs: ['--no-proxy-server'],
    });

    try {
      const extensionId = await readExtensionId(context);
      await presetAgeGateCookie(context);

      // 0) seed 已看记录（经 dashboard 页直写 IndexedDB）
      await seedViewedRecord(context, extensionId, target.videoCode);

      const page = context.pages()[0] ?? (await context.newPage());

      // 1) 详情页标题出现 [已观看]
      await page.goto(target.videoUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await dismissAgeGateIfPresent(page);
      await expect
        .poll(async () => (await page.title()).includes('[已观看]'), {
          timeout: 60_000,
          message: `详情页标题未出现 [已观看]（videoCode=${target.videoCode}）`,
        })
        .toBeTruthy();

      // 2) 列表页对应 item 出现「已观看」状态徽章
      await page.goto(`${JAVDB_E2E_HOST}/?vst=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await dismissAgeGateIfPresent(page);
      await expect
        .poll(async () => page.evaluate((code: string) => {
          const items = Array.from(document.querySelectorAll<HTMLElement>('.movie-list .item'));
          const item = items.find((el) => el.querySelector('div.video-title > strong')?.textContent?.trim() === code);
          const tag = item?.querySelector<HTMLElement>('.custom-status-tag');
          return tag ? tag.textContent?.trim() : null;
        }, target.videoCode), {
          timeout: 60_000,
          message: `列表页未出现 ${target.videoCode} 的已观看状态徽章`,
        })
        .toBe('已观看');

      console.info(`[E2E main-chain] T2 通过: ${target.videoUrl} code=${target.videoCode}`);
    } finally {
      await context.close();
    }
  });

  test('T3: actor page enhancement enabled via unified gate (F1)', async ({}, testInfo) => {
    const target = await pickLatestVideoWithActor();
    test.skip(!target?.actorUrl, 'javdb570 网络不可用或未找到演员页，跳过真机检查');
    if (!target?.actorUrl) return;

    stripProxyEnv();
    const harnessOptions = resolveTestHarnessOptions(testInfo.outputPath('profile'));
    const context = await launchExtensionContext(harnessOptions, {
      headless: false,
      channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
      extraArgs: ['--no-proxy-server'],
    });

    try {
      const extensionId = await readExtensionId(context);
      await presetAgeGateCookie(context);

      // 0) 统一门控双字段显式开启（与设置表单双写一致）。
      // 注意：扩展设置整体存于 chrome.storage.local 的 `settings` 单键下，
      // getSettings 按节 merge 默认值，因此只写需要覆盖的节即可。
      await seedExtensionStorage(context, {
        settings: {
          userExperience: { enableActorEnhancement: true },
          actorEnhancement: { enabled: true },
        },
      });

      const page = context.pages()[0] ?? (await context.newPage());
      const consoleLines: string[] = [];
      page.on('console', (msg) => consoleLines.push(msg.text()));

      await page.goto(target.actorUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await dismissAgeGateIfPresent(page);

      await expect
        .poll(
          () => consoleLines.some((line) => line.includes('演员页增强功能已启用')),
          { timeout: 60_000, message: `演员页增强未启用（${target.actorUrl}，F1 门控?）` },
        )
        .toBeTruthy();

      console.info(`[E2E main-chain] T3 通过: ${target.actorUrl}`);
    } finally {
      await context.close();
    }
  });

  test('T4: main switch off disables interception but keeps status sync (F2)', async ({}, testInfo) => {
    const target = await pickLatestVideoWithActor();
    test.skip(!target, 'javdb570 网络不可用或页面结构变化，跳过真机检查');

    stripProxyEnv();
    const harnessOptions = resolveTestHarnessOptions(testInfo.outputPath('profile'));
    const context = await launchExtensionContext(harnessOptions, {
      headless: false,
      channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
      extraArgs: ['--no-proxy-server'],
    });

    try {
      const extensionId = await readExtensionId(context);
      await presetAgeGateCookie(context);

      // 0) 主开关显式关（settings 存于 chrome.storage.local 单键，getSettings 按节 merge 默认值，只写覆盖节）
      await seedExtensionStorage(context, {
        settings: { videoEnhancement: { enabled: false } },
      });
      // seed 已看记录：数据行为（状态同步）不受主开关约束，应照常工作
      await seedViewedRecord(context, extensionId, target.videoCode);

      const page = context.pages()[0] ?? (await context.newPage());
      const consoleLines: string[] = [];
      page.on('console', (msg) => consoleLines.push(msg.text()));

      await page.goto(target.videoUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await dismissAgeGateIfPresent(page);

      // 1) 状态同步照常：详情页标题出现 [已观看]（数据行为不被主开关误伤）
      await expect
        .poll(async () => (await page.title()).includes('[已观看]'), {
          timeout: 60_000,
          message: `详情页标题未出现 [已观看]（videoCode=${target.videoCode}，数据行为是否被主开关误伤?）`,
        })
        .toBeTruthy();

      // 2) 负向断言：无相关清单拦截安装 log
      await expectNoConsoleLog(page, consoleLines, '[RelatedLists] click interception installed');

      console.info(`[E2E main-chain] T4 通过: ${target.videoUrl} code=${target.videoCode}`);
    } finally {
      await context.close();
    }
  });

  test('T5: related-lists sub switch off disables interception only (F2)', async ({}, testInfo) => {
    const target = await pickLatestVideoWithActor();
    test.skip(!target, 'javdb570 网络不可用或页面结构变化，跳过真机检查');

    stripProxyEnv();
    const harnessOptions = resolveTestHarnessOptions(testInfo.outputPath('profile'));
    const context = await launchExtensionContext(harnessOptions, {
      headless: false,
      channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
      extraArgs: ['--no-proxy-server'],
    });

    try {
      await readExtensionId(context);
      await presetAgeGateCookie(context);

      // 0) 主开关保持默认开，仅子开关 enableRelatedLists 显式关
      await seedExtensionStorage(context, {
        settings: { videoEnhancement: { enableRelatedLists: false } },
      });

      const page = context.pages()[0] ?? (await context.newPage());
      const consoleLines: string[] = [];
      page.on('console', (msg) => consoleLines.push(msg.text()));

      await page.goto(target.videoUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await dismissAgeGateIfPresent(page);

      // 负向断言：无相关清单拦截安装 log（主链正信号 = 注入标记，观察窗口内无 log）
      await expectNoConsoleLog(page, consoleLines, '[RelatedLists] click interception installed');

      console.info(`[E2E main-chain] T5 通过: ${target.videoUrl} code=${target.videoCode}`);
    } finally {
      await context.close();
    }
  });
});
