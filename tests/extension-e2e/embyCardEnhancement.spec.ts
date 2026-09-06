/**
 * @file embyCardEnhancement.spec.ts
 * @description Emby 卡片增强（番号识别 → JavDB 链接）真机专项 E2E（B1 配套，不碰真实 Emby）：
 *   mock 媒体服务器页经 page.route 拦截在不可路由的 TEST-NET 地址（192.0.2.1），
 *   与真实用户「任意 Emby/Jellyfin host」同链路：SW storage.onChanged → 注册动态 tab 监听
 *   → tab complete 且 URL 命中 matchUrls → chrome.scripting 注入主 content script
 *   → bootstrap deferred 阶段初始化 embyEnhancement（mock host 不在 manifest 静态匹配内，
 *     必须走动态注入才能加载主脚本，覆盖真实用户路径）。
 *   a) 识别开启 → 页面番号文本转为可点击 .emby-video-link（链接为搜索 URL），右侧悬浮快捷框出现；
 *   b) SPA 动态追加（页面脚本 1200ms 后 childList 追加）→ 新番号同样被链接（mutation 脏区扫描链路）；
 *   c) 识别总开关关闭 → 无链接、无悬浮快捷框。
 *
 * 基建与 listEnhancement-switches.spec.ts 一致：设置经 service worker 写 chrome.storage.local
 * （与 dashboard 改设置同链路，触发 SW 的 emby 动态脚本重注册）。
 *
 * @module tests/extension-e2e
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  extensionPageUrl,
  launchExtensionContext,
  readExtensionId,
  resolveExtensionHarnessOptions,
  seedExtensionStorage,
} from '../../scripts/extensionHarness';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ID = 'gnegjfjccmeafanpmbjboegcbchcghka';
const MOCK_FILE = path.resolve(__dirname, 'fixtures/embyMockPage.html');
// TEST-NET-1：不可路由地址，只能由 page.route 喂内容；同时不在 manifest 静态 content_scripts 匹配内
const MOCK_URL = 'http://192.0.2.1:8096/web/item.html';
const EMBY_MATCH_PATTERN = 'http://192.0.2.1:8096/*';

/** 完整 emby 块（getSettings 顶层浅合并，存储值整体替换默认 emby，必须自包含） */
function buildEmbySettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const emby: Record<string, unknown> = {
    enabled: true,
    recognitionEnabled: true,
    libraryEnabled: false,
    matchUrls: [EMBY_MATCH_PATTERN],
    videoCodePatterns: [
      '[A-Z]{2,6}-\\d{2,6}',
      'FC2-PPV-\\d+',
      '\\d{4,8}_\\d{1,3}',
      '\\d{6,12}',
      '[a-z0-9]+-\\d+_\\d+',
    ],
    linkBehavior: 'javdb-search',
    enableAutoDetection: true,
    highlightStyle: {
      backgroundColor: '#e3f2fd',
      color: '#1976d2',
      borderRadius: '4px',
      padding: '2px 4px',
    },
    showQuickSearchCode: true,
    showQuickSearchActor: true,
    mediaServers: [],
    syncIntervalMinutes: 60,
    libraryStatus: { enabled: false },
    ...overrides,
  };
  // 不写顶层 searchEngines：getSettings 的 mergeSearchEngineTemplates 对内置引擎只采纳
  // 用户 enabled 覆盖，模板以内置为准（dedupe 先到优先），内置 javdb 模板即
  // https://javdb.com/search?q={{ID}}&f=all —— 用例断言按此实际行为写。
  return {
    settings: {
      emby,
    },
  };
}

function launchContext(profile: string) {
  const opts = resolveExtensionHarnessOptions({
    ...process.env,
    JAVDB_EXTENSION_USE_CHROME_DATA: '0',
    JAVDB_EXTENSION_PROFILE: profile,
  }, process.cwd());
  return launchExtensionContext(opts, {
    headless: false,
    channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
  });
}

async function serveMockEmbyPage(context: BrowserContext, page: Page): Promise<void> {
  const html = await fs.readFile(MOCK_FILE, 'utf8');
  await page.route(MOCK_URL, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(MOCK_URL, { waitUntil: 'domcontentloaded' });
}

test.describe('Emby 卡片增强真机专项（B1）', () => {
  test('a) 识别开启：番号转链接 + 动态追加同样被链接 + 悬浮快捷框', async ({}, testInfo) => {
    const context = await launchContext(testInfo.outputPath('emby-on-profile'));
    try {
      const extensionId = await readExtensionId(context);
      expect(extensionId).toBe(EXTENSION_ID);

      await seedExtensionStorage(context, buildEmbySettings());

      const page = await context.newPage();
      await serveMockEmbyPage(context, page);

      // 初始 2 条 + SPA 动态追加 1 条（页面脚本 1200ms 后追加 + 脏区扫描 300ms 合并窗口）
      await expect(page.locator('.emby-video-link')).toHaveCount(3, { timeout: 30_000 });

      // 链接为内置 javdb 搜索模板（linkBehavior=javdb-search，模板含 &f=all）
      const first = page.locator('.emby-video-link').first();
      expect((await first.getAttribute('href')) || '').toBe('https://javdb.com/search?q=ABC-123&f=all');
      expect(await first.textContent()).toBe('ABC-123');

      // 动态追加的条目被链接
      const dynamicLink = page.locator('.item-dynamic .emby-video-link');
      await expect(dynamicLink).toHaveCount(1, { timeout: 15_000 });
      expect(await dynamicLink.textContent()).toBe('HDF-789');

      // 「普通影片无番号」不被链接
      expect(await page.locator('.item .name:has-text("普通影片无番号") .emby-video-link').count()).toBe(0);

      // 右侧悬浮快捷框出现（showQuickSearchCode 默认开）
      await expect(page.locator('.emby-quick-actions')).toHaveCount(1, { timeout: 10_000 });
    } finally {
      await context.close();
    }
  });

  test('c) 识别总开关关闭：无链接、无悬浮快捷框', async ({}, testInfo) => {
    const context = await launchContext(testInfo.outputPath('emby-off-profile'));
    try {
      const extensionId = await readExtensionId(context);
      expect(extensionId).toBe(EXTENSION_ID);

      await seedExtensionStorage(context, buildEmbySettings({
        enabled: false,
        recognitionEnabled: false,
      }));

      const page = await context.newPage();
      await serveMockEmbyPage(context, page);

      // 留足 deferred 初始化（1500ms）+ 动态追加（1200ms）之后的观察窗口
      await page.waitForTimeout(5000);

      expect(await page.locator('.emby-video-link').count()).toBe(0);
      expect(await page.locator('.emby-quick-actions').count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
