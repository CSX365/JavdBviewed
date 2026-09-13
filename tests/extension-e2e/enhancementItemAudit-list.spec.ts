/**
 * @file enhancementItemAudit-list.spec.ts
 * @description 性能优化后列表增强功能真机逐项审计（feature-matrix.md L 节，L03–L17）。
 *
 * 测试面口径 = 用户真实 profile（列表增强块全开 + 默认开项）：
 *   node 预检取真站 /?vst=1 前 6 项，逐项抓详情页第 1 位演员，
 *   分配三种角色（fav 普通收藏 / sub 订阅 / black 黑名单）+ ≥1 个未 seed 项；
 *   seed fav 项已看记录；seed fav/sub 的 115/Emby 本地片库索引。
 *
 * 逐项断言（每项独立 test，serial 共享同一真站列表页；卡片处理分批、
 * 水印/隐藏依赖 SW 演员索引与标题匹配，断言一律 expect.poll 30–90s）：
 *   L01 x-btn 注入（data-code）；L02 封面 x-preview；L04 已观看角标；
 *   L05 状态快捷按钮；L06 收藏按钮 aria-pressed 切换；
 *   L07 三色演员水印（badge title 含演员名+状态，抗交叉匹配）；
 *   L08 黑名单项隐藏（ACTOR_BLACKLIST）；L11 展示控制（style+cols override+日志）；
 *   L12 标题优化类；L13 右键后台 tab（新 tab+日志）；L15 双片库角标（115 已有/Emby已入库）。
 *   Phase 2 L09：开 hideNonFavorited+hideUnrecognized + reload → 未 seed 项隐藏；
 *   Phase 3 L14：开 enableScrollPaging + reload → 触底自动追加下一页；
 *   Phase 4 L16：开 resourceTags + 导航 /?vft=2（含字幕过滤列表）→ 中字资源标签；
 *   Phase 5 L17：开 sorting.enabled + reload → 排序工具条；
 *   Phase 6 L03：主开关关 + reload → 无 x-btn/状态/水印注入。
 *
 * Phase 2–5 的设置切换 = SW 里改 chrome.storage 的 settings 字段后 reload
 * （与 dashboard 改设置同一持久化链路，reload 保证确定性）。
 *
 * @module tests/extension-e2e
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import {
  extensionPageUrl,
  launchExtensionContext,
  readExtensionId,
  resolveExtensionHarnessOptions,
  seedExtensionStorage,
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
const LIST_URL = `${JAVDB_E2E_HOST}/?vst=1`;
const RESOURCE_TAG_LIST_URL = `${JAVDB_E2E_HOST}/?vft=2`;
const FETCH_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const NAV_ACTOR_IDS = new Set(['censored', 'uncensored', 'western']);

interface AuditListItem {
  id: string;
  code: string;
  title: string;
  tail3: string;
  actor: { id: string; name: string } | null;
}

interface ListAuditTarget {
  items: AuditListItem[];
  fav: AuditListItem;
  sub: AuditListItem;
  black: AuditListItem;
  unseeded: AuditListItem | null;
}

async function fetchText(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { 'user-agent': FETCH_UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) continue;
      return await resp.text();
    } catch {
      // 瞬时抖动重试一次
    }
  }
  return null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** 与扩展 normalizeActorMatchText 同口径（标题匹配链依赖该归一化） */
function normalizeMatchText(value: string): string {
  return (value || '').replace(/[\t\n\r]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function parseListItems(listHtml: string, maxItems: number): AuditListItem[] {
  const items: AuditListItem[] = [];
  let cursor = 0;
  while (items.length < maxItems) {
    const start = listHtml.indexOf('<div class="item', cursor);
    if (start === -1) break;
    const end = listHtml.indexOf('<div class="item', start + 1);
    const block = listHtml.slice(start, end === -1 ? undefined : end);
    cursor = end === -1 ? listHtml.length : end;

    const idMatch = block.match(/href="\/v\/([A-Za-z0-9]+)"/);
    const codeMatch = block.match(/<div class="video-title[^"]*">[\s\S]*?<strong>([^<]+)<\/strong>/);
    const titleAttrMatch = block.match(/<a href="\/v\/[^"]+"[^>]*title="([^"]*)"/);
    if (!idMatch || !codeMatch) continue;

    const rawTitle = titleAttrMatch ? decodeHtmlEntities(titleAttrMatch[1]) : '';
    const title = normalizeMatchText(rawTitle);
    if (!title) continue;
    const tokens = title.split(' ');
    const tail3 = tokens.slice(-3).join(' ');
    items.push({ id: idMatch[1], code: codeMatch[1].trim(), title, tail3, actor: null });
  }
  return items;
}

async function pickFirstActor(detailHtml: string): Promise<{ id: string; name: string } | null> {
  for (const m of detailHtml.matchAll(/href="\/actors\/([A-Za-z0-9]+)"[^>]*>([^<]{1,30})</g)) {
    const id = m[1];
    const name = normalizeMatchText(decodeHtmlEntities(m[2]));
    if (NAV_ACTOR_IDS.has(id) || !name) continue;
    return { id, name };
  }
  return null;
}

/** 角色分配：fav/sub/black 三位演员互不相同；未 seed 项标题不得含任何已 seed 演员名 */
function assignRoles(items: AuditListItem[]): Pick<ListAuditTarget, 'fav' | 'sub' | 'black' | 'unseeded'> | null {
  const candidates = items.filter((it) => it.actor);
  const fav = candidates.find((it) => it.actor && it.title.toLowerCase().includes(it.actor.name.toLowerCase()))
    ?? candidates[0];
  if (!fav) return null;
  const sub = candidates.find((it) => it !== fav && it.actor && it.actor.id !== fav.actor!.id) ?? null;
  const black = candidates.find(
    (it) => it !== fav && it !== sub && it.actor
      && it.actor.id !== fav.actor!.id
      && (sub ? it.actor.id !== sub.actor!.id : true),
  ) ?? null;
  if (!sub || !black) return null;

  const seededNames = [fav.actor!.name, sub.actor!.name, black.actor!.name].map((n) => n.toLowerCase());
  const unseeded = items.find(
    (it) => it !== fav && it !== sub && it !== black
      && !seededNames.some((n) => n && it.title.toLowerCase().includes(n)),
  ) ?? null;
  return { fav, sub, black, unseeded };
}

/** 从最新影片列表取 6 项 + 各项第 1 位演员（node 预检；网络不可用返回 null） */
async function pickListAuditTarget(): Promise<ListAuditTarget | null> {
  try {
    const listHtml = await fetchText(LIST_URL);
    if (!listHtml) return null;
    const items = parseListItems(listHtml, 6);
    if (items.length < 4) return null;

    for (const item of items) {
      const detailHtml = await fetchText(`${JAVDB_E2E_HOST}/v/${item.id}`);
      if (!detailHtml) continue;
      item.actor = await pickFirstActor(detailHtml);
    }

    const roles = assignRoles(items);
    if (!roles) {
      console.info('[E2E list-audit] role assignment failed（演员不足或重复）');
      return null;
    }
    return { items, ...roles };
  } catch (error) {
    console.info('[E2E list-audit] pick target failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** 用户真实 profile 口径的完整 settings（顶层浅合并：每个块必须自包含） */
function buildListAuditSettings(): Record<string, unknown> {
  return {
    userExperience: {
      enableContentFilter: false,
      enableKeyboardShortcuts: false,
      enableMagnetSearch: false,
      enableAnchorOptimization: false,
      enableListEnhancement: true,
      enableActorEnhancement: true,
      enableSuperRanking: true,
      showEnhancedTooltips: false,
      enablePasswordHelper: false,
    },
    videoEnhancement: {
      enabled: true,
      schedulingMode: 'smart',
      enableCoverImage: true,
      showLoadingIndicator: true,
      enableReviewBreaker: false,
      enableFC2Breaker: false,
      enableWantSync: true,
      autoMarkWatchedAfter115: true,
      autoMarkWatchedStars: 4,
      enableActorRemarks: false,
      enableActorNameMarks: true,
      enableActorQuickActions: false,
      enableVideoFavoriteRating: false,
      enableRelatedLists: false,
      enableLocalListInSourceModal: false,
      enableExternalEntryPanel: false,
      enableExternalSearch: false,
      enableOnlineAvailability: false,
      enableSubtitleSearch: false,
    },
    listEnhancement: {
      enabled: true,
      enableClickEnhancement: true,
      enableClickEnhancementList: true,
      enableClickEnhancementDetail: true,
      enableVideoPreview: true,
      enableScrollPaging: false,
      enableListOptimization: true,
      previewDelay: 1000,
      previewVolume: 0.2,
      enableRightClickBackground: true,
      enableActorWatermark: true,
      actorWatermarkPosition: 'top-right',
      actorWatermarkOpacity: 0.4,
      hideBlacklistedActorsInList: true,
      hideNonFavoritedActorsInList: false,
      hideUnrecognizedActorsInList: false,
      treatSubscribedAsFavorited: true,
      listDisplayControl: {
        enabled: true,
        columnCount: 4,
        containerWidth: 100,
        enableContainerExpansion: false,
      },
      showStatusBadge: true,
      enableStatusQuickAction: true,
      enableListFavoriteQuickAction: true,
      resourceTags: false,
      sorting: {
        enabled: false,
        appendStrategy: 'prompt',
        autoResortPosition: 'preserve',
      },
    },
    actorEnhancement: {
      enabled: true,
      autoApplyTags: false,
      defaultTags: [],
      defaultSortType: 0,
      enableTimeSegmentationDivider: false,
      timeSegmentationMonths: 6,
    },
    emby: {
      enabled: true,
      recognitionEnabled: false,
      libraryEnabled: true,
      matchUrls: [],
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
      // dummy 服务器：仅用于片库角标链路（serverKey 与 emby_library_state 条目一致）；
      // 地址为本地回环且 syncIntervalMinutes 拉到 7 天，避免任何真实同步副作用
      mediaServers: [
        {
          id: 'e2e-emby-dummy',
          type: 'emby',
          name: 'Emby-E2E',
          url: 'http://127.0.0.1:8096',
          apiKey: 'e2e-dummy-key',
          enabled: true,
        },
      ],
      syncIntervalMinutes: 10080,
      libraryStatus: {
        enabled: true,
        showOnList: true,
        showOnDetail: true,
      },
      realtimeCheck: {
        enabled: false,
        concurrency: 1,
        batchSize: 20,
        cacheTtlMinutes: 10,
      },
    },
    libraryMatchStatus: { enabled: true, sources: { drive115: true, emby: true } },
    dataEnhancement: {
      enableMultiSource: false,
      enableVideoPreview: true,
      enableTranslation: false,
    },
  };
}

async function presetAgeGateCookie(context: BrowserContext): Promise<void> {
  await context.addCookies([
    { name: 'over18', value: '1', domain: 'javdb570.com', path: '/' },
  ]);
}

async function dismissAgeGateIfPresent(page: Page): Promise<void> {
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
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
    } catch {
      // ignore
    }
  }
}

function makeActorRecord(actor: { id: string; name: string }, tail3: string, blacklisted = false): Record<string, unknown> {
  const now = Date.now();
  return {
    id: actor.id,
    name: actor.name,
    // 别名兜底：站端列表标题名与详情页名不一致时，用列表标题末 3 token 短语命中
    // （matchActorsFromTitle 尾部 offset 循环从 3-token 短语开始匹配）
    aliases: [actor.name, tail3].filter(Boolean),
    gender: 'unknown',
    category: 'unknown',
    profileUrl: `${JAVDB_E2E_HOST}/actors/${actor.id}`,
    createdAt: now,
    updatedAt: now,
    blacklisted,
  };
}

/** 经 extension page 发 DB:ACTORS_BULK_PUT 写真实演员库（与 dashboard 同链路） */
async function seedActors(context: BrowserContext, extensionId: string, records: Record<string, unknown>[]): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto(extensionPageUrl(extensionId, 'dashboard/dashboard.html'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const result = await page.evaluate(async (recs) => {
      const send = (msg: any): Promise<any> =>
        new Promise((resolve) => {
          let settled = false;
          const done = (v: any) => { if (!settled) { settled = true; resolve(v); } };
          chrome.runtime.sendMessage(msg, (resp) => {
            done(resp || (chrome.runtime.lastError ? { error: String(chrome.runtime.lastError.message) } : null));
          });
          setTimeout(() => done(null), 4000);
        });
      const maxAttempts = 8;
      let attempt = 0;
      let lastErr: any = null;
      while (attempt < maxAttempts) {
        const pong = await send({ type: 'DB:VIEWED_COUNT', payload: {} });
        if (pong && typeof pong === 'object' && !pong.error) {
          const put = await send({ type: 'DB:ACTORS_BULK_PUT', payload: { records: recs } });
          if (!put || put.success !== true) return { ok: false, reason: (put as any)?.error || 'bulkPut-not-success' };
          return { ok: true };
        }
        lastErr = pong?.error || 'no-response';
        attempt++;
        await new Promise((r) => setTimeout(r, [200, 400, 800, 1500, 2500, 3500, 4500][attempt - 1] || 4500));
      }
      return { ok: false, reason: lastErr };
    }, records);
    if (!result?.ok) throw new Error(`seed actors failed: ${result?.reason || 'unknown'}`);
  } finally {
    await page.close();
  }
}

/** 经 extension page 直写 IndexedDB：javdb_v1 / viewedRecords */
async function seedViewedRecord(context: BrowserContext, extensionId: string, videoCode: string): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto(extensionPageUrl(extensionId, 'dashboard/dashboard.html'), { waitUntil: 'domcontentloaded', timeout: 60_000 });
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
              if (attempts < 20) window.setTimeout(attempt, 1_000);
              else reject(new Error('viewedRecords store 未就绪（20 次重试后）'));
              return;
            }
            const tx = db.transaction('viewedRecords', 'readwrite');
            const now = Date.now();
            tx.objectStore('viewedRecords').put({ id, title: id, status: 'viewed', createdAt: now, updatedAt: now });
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error ?? new Error('viewedRecords 写入事务失败')); };
          };
          request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'));
          request.onupgradeneeded = () => {
            const db2 = request.result;
            if (!db2.objectStoreNames.contains('viewedRecords')) db2.createObjectStore('viewedRecords', { keyPath: 'id' });
          };
        };
        attempt();
      });
    }, videoCode);
  } finally {
    await page.close();
  }
}

/** SW 内按点路径改 chrome.storage 的 settings 字段（与 dashboard 改设置同持久化链路） */
async function patchSettings(context: BrowserContext, fields: Record<string, unknown>): Promise<void> {
  const worker =
    context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  await worker.evaluate(async (fieldMap) => {
    const res = await chrome.storage.local.get('settings');
    const settings = { ...(res.settings || {}) };
    for (const [dotPath, value] of Object.entries(fieldMap)) {
      const parts = dotPath.split('.');
      let node: any = settings;
      for (let i = 0; i < parts.length - 1; i++) {
        if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = value;
    }
    await chrome.storage.local.set({ settings });
  }, fields);
}

interface AuditState {
  context: BrowserContext;
  page: Page;
  target: ListAuditTarget;
  extensionId: string;
  consoleMessages: string[];
  pageErrors: string[];
}

let audit: AuditState | null = null;

function consoleHas(pattern: RegExp): boolean {
  return (audit?.consoleMessages ?? []).some((line) => pattern.test(line));
}

function testInfoContext(): { outputPath: (name: string) => string } {
  return { outputPath: (name: string) => path.join(process.cwd(), 'test-results', 'extension-e2e', name) };
}

test.describe('列表页增强逐项审计（真机）', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(async () => {
    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      delete process.env[key];
    }
    const target = await pickListAuditTarget();
    if (!target) return;

    const harnessOptions = resolveTestHarnessOptions(
      testInfoContext().outputPath('list-audit-profile'),
    );
    const context = await launchExtensionContext(harnessOptions, {
      headless: false,
      channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
    });
    const extensionId = await readExtensionId(context);
    await presetAgeGateCookie(context);

    // 1) chrome.storage：settings + 订阅 + 115/Emby 本地片库索引
    const now = Date.now();
    const { fav, sub, black } = target;
    await seedExtensionStorage(context, {
      settings: buildListAuditSettings(),
      new_works_subscriptions: {
        [sub.actor!.id]: {
          actorId: sub.actor!.id,
          actorName: sub.actor!.name,
          subscribedAt: now,
          enabled: true,
        },
      },
      drive115_library_state: {
        version: 1,
        updatedAt: now,
        entries: [
          {
            key: `c0:1`,
            code: fav.code,
            title: fav.code,
            folderCid: 'c0',
            folderName: fav.code,
            rootCid: 'r0',
            videoFileId: '1',
            pickCode: 'pc0',
            fileName: `${fav.code}.mp4`,
            fileSize: 1024,
            updatedAt: now,
          },
        ],
        stats: { roots: 0, foldersSeen: 1, indexed: 1, skipped: 0, unrecognized: 0, apiCalls: 0 },
      },
      emby_library_state: {
        entries: {
          [sub.code]: [
            {
              serverType: 'emby',
              serverName: 'Emby-E2E',
              serverUrl: 'http://127.0.0.1:8096',
              itemId: 'e2e-item-1',
              itemName: `${sub.code}.mp4`,
              path: '/media/av/e2e.mp4',
              updatedAt: now,
            },
          ],
        },
        updatedAt: now,
      },
    });

    // 2) IndexedDB：演员库（收藏/订阅/黑名单）+ 已看记录
    await seedActors(context, extensionId, [
      makeActorRecord(fav.actor!, fav.tail3, false),
      makeActorRecord(sub.actor!, sub.tail3, false),
      makeActorRecord(black.actor!, black.tail3, true),
    ]);
    await seedViewedRecord(context, extensionId, fav.code);

    // 3) 打开真站列表页
    const page = await context.newPage();
    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      consoleMessages.push(`${msg.type()}: ${msg.text()}`);
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    audit = { context, page, target, extensionId, consoleMessages, pageErrors };
  }, { timeout: 240_000 });

  test.afterAll(async () => {
    if (audit) {
      await audit.page.close().catch(() => {});
      await audit.context.close().catch(() => {});
      audit = null;
    }
  });

  const itemOf = (code: string) => audit!.page.locator(`.movie-list .item:has(.x-btn[data-code="${code}"])`).first();

  test('L01 x-btn 注入且 data-code 正确', async () => {
    if (!audit) return test.skip(true, 'javdb570 网络不可用或列表结构变化，跳过真机检查');
    const { page, target } = audit;
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await dismissAgeGateIfPresent(page);

    await expect
      .poll(() => itemOf(target.fav.code).locator('.x-btn').count(), {
        timeout: 90_000,
        intervals: [2_000],
      })
      .toBeGreaterThanOrEqual(1);
    const dataCode = await itemOf(target.fav.code).locator('.x-btn').first().getAttribute('data-code');
    expect(dataCode, 'x-btn data-code 应与卡片番号一致').toBe(target.fav.code);
    expect(pageErrorsSafe(), '列表页增强注入出现 JS 报错').toEqual([]);
    console.info(`[E2E list-audit] L01 ok: ${target.fav.code}`);
  });

  test('L02 封面 x-preview 挂载', async () => {
    if (!audit) return test.skip(true, 'L01 未执行');
    const { target } = audit;
    await expect
      .poll(async () => {
        const cover = itemOf(target.fav.code).locator('.cover.x-preview img').first();
        return (await cover.count()) > 0 && (await cover.isVisible().catch(() => false));
      }, { timeout: 60_000, intervals: [3_000] })
      .toBe(true);
  });

  test('L04 已观看角标（seed viewed）', async () => {
    if (!audit) return test.skip(true, 'L01 未执行');
    const { target } = audit;
    await expect
      .poll(() => itemOf(target.fav.code).locator('.custom-status-tag', { hasText: '已观看' }).count(), {
        timeout: 90_000,
        intervals: [3_000],
      })
      .toBeGreaterThanOrEqual(1);
  });

  test('L05 状态快捷按钮（已阅/想看/已看）', async () => {
    if (!audit) return test.skip(true, 'L01 未执行');
    const { target } = audit;
    await expect
      .poll(async () => ({
        group: await itemOf(target.fav.code).locator('.jdb-list-status-actions').count(),
        browsed: await itemOf(target.fav.code).locator('.jdb-list-status-action.status-browsed').count(),
        want: await itemOf(target.fav.code).locator('.jdb-list-status-action.status-want').count(),
        viewed: await itemOf(target.fav.code).locator('.jdb-list-status-action.status-viewed').count(),
      }), { timeout: 60_000, intervals: [3_000] })
      .toEqual(
        expect.objectContaining({ group: 1, browsed: 1, want: 1, viewed: 1 }),
      );
  });

  test('L06 收藏快捷按钮点击切换 aria-pressed', async () => {
    if (!audit) return test.skip(true, 'L01 未执行');
    const { target } = audit;
    const favBtn = itemOf(target.fav.code).locator('.jdb-list-favorite-action').first();
    await expect
      .poll(() => favBtn.count(), { timeout: 60_000, intervals: [3_000] })
      .toBeGreaterThanOrEqual(1);
    await expect(favBtn).toHaveAttribute('aria-pressed', 'false');

    await favBtn.click({ timeout: 10_000 });
    await expect(favBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(favBtn).toHaveText('♥');

    // 还原：避免污染后续用例与本地库
    await favBtn.click({ timeout: 10_000 });
    await expect(favBtn).toHaveAttribute('aria-pressed', 'false');
  });

  test('L07 演员水印三色：收藏/订阅/黑名单', async () => {
    if (!audit) return test.skip(true, 'L01 未执行');
    const { target } = audit;
    const cases: { item: AuditListItem; marker: string; badgeClass: string }[] = [
      { item: target.fav, marker: '【收藏】', badgeClass: 'badge-amber' },
      { item: target.sub, marker: '【订阅】', badgeClass: 'badge-green' },
      { item: target.black, marker: '【黑名单】', badgeClass: 'badge-red' },
    ];
    for (const c of cases) {
      const actorName = c.item.actor!.name;
      const badge = itemOf(c.item.code).locator('.x-actor-wm .x-actor-badge');
      const found = await expect
        .poll(async () => {
          const matches = await badge.evaluateAll(
            (els, [name, marker, wantClass]) =>
              els.filter((e) => {
                const t = e.getAttribute('title') || '';
                return t.includes(name) && t.includes(marker) && e.className.includes(wantClass);
              }).length,
            [actorName, c.marker, c.badgeClass],
          );
          return matches;
        }, { timeout: 90_000, intervals: [3_000] })
        .toBeGreaterThanOrEqual(1)
        .then(() => true, () => false);
      expect(found, `${c.item.code} 未出现 ${c.marker} 水印（演员 ${actorName}）`).toBe(true);
    }
  });

  test('L08 黑名单演员项隐藏（ACTOR_BLACKLIST）', async () => {
    if (!audit) return test.skip(true, 'L01 未执行');
    const { target } = audit;
    const blackItem = itemOf(target.black.code);
    await expect
      .poll(async () => ({
        hidden: (await blackItem.getAttribute('data-hidden-by-actor').catch(() => null)) === 'true',
        reason: await blackItem.getAttribute('data-hide-reason-actor').catch(() => null),
        visible: await blackItem.isVisible().catch(() => false),
      }), { timeout: 90_000, intervals: [3_000] })
      .toEqual(
        expect.objectContaining({ hidden: true, reason: 'ACTOR_BLACKLIST', visible: false }),
      );
  });

  test('L11 展示控制：style 注入 + 列数 override + 成功日志', async () => {
    if (!audit) return test.skip(true, 'L01 未执行');
    const { page } = audit;
    await expect
      .poll(async () => ({
        style: (await page.locator('style#x-list-display-control').count()) > 0,
        override: (await page.locator('.movie-list.h[data-x-cols-override="true"]').count()) > 0,
        log: consoleHas(/\[LIST DISPLAY\] ✓ List display styles applied successfully/),
      }), { timeout: 60_000, intervals: [3_000] })
      .toEqual({ style: true, override: true, log: true });
  });

  test('L12 列表优化：标题挂载 x-title/x-ellipsis 类', async () => {
    if (!audit) return test.skip(true, 'L01 未执行');
    const { target } = audit;
    await expect
      .poll(async () => {
        const title = itemOf(target.fav.code).locator('div.video-title').first();
        const cls = (await title.getAttribute('class').catch(() => '')) ?? '';
        return cls.includes('x-title') && cls.includes('x-ellipsis');
      }, { timeout: 60_000, intervals: [3_000] })
      .toBe(true);
  });

  test('L13 右键打开后台 tab（新 tab + 日志）', async () => {
    if (!audit) return test.skip(true, 'L01 未执行');
    const { page, context, target } = audit;
    const link = itemOf(target.fav.code).locator('a[href*="/v/"]').first();
    // 确保卡片已处理（委托状态已注册）
    await expect
      .poll(() => itemOf(target.fav.code).getAttribute('data-processed'), {
        timeout: 60_000,
        intervals: [2_000],
      })
      .toBe('true');

    const pagesBefore = (await context.pages()).length;
    await link.evaluate((el) => {
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    });

    let candidate: Page | null = null;
    await expect
      .poll(async () => {
        const pages = await context.pages();
        candidate = null;
        if (pages.length > pagesBefore) {
          candidate = pages.find((p) => p.url().includes(`/v/${target.fav.id}`)) ?? null;
        }
        return candidate !== null;
      }, { timeout: 45_000, intervals: [2_000] })
      .toBe(true);
    expect(consoleHas(/\[ListEnhancement\] Background tab opened in \d+ms/), '后台打开日志缺失').toBe(true);
    if (candidate) {
      await candidate.close().catch(() => {});
    }
  });

  test('L15 片库状态角标：115 已有 + Emby已入库', async () => {
    if (!audit) return test.skip(true, 'L01 未执行');
    const { target } = audit;
    await expect
      .poll(
        () => itemOf(target.fav.code).locator('.drive115-library-status-tag', { hasText: '115 已有' }).count(),
        { timeout: 60_000, intervals: [3_000] },
      )
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(
        () => itemOf(target.sub.code).locator('.emby-library-status-tag', { hasText: 'Emby已入库' }).count(),
        { timeout: 60_000, intervals: [3_000] },
      )
      .toBeGreaterThanOrEqual(1);
  });

  test('Phase2 L09 未收藏/未识别隐藏：开开关 + reload', async () => {
    if (!audit) return test.skip(true, 'L01 未执行');
    const { page, context, target } = audit;
    if (!target.unseeded) {
      console.info('[E2E list-audit] L09 skip: 无可用未 seed 项');
      return test.skip(true, '无可用未 seed 项');
    }
    await patchSettings(context, {
      'listEnhancement.hideNonFavoritedActorsInList': true,
      'listEnhancement.hideUnrecognizedActorsInList': true,
    });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
    await dismissAgeGateIfPresent(page);

    const unseeded = itemOf(target.unseeded.code);
    await expect
      .poll(async () => ({
        hidden: (await unseeded.getAttribute('data-hidden-by-actor').catch(() => null)) === 'true',
        reason: await unseeded.getAttribute('data-hide-reason-actor').catch(() => null),
        visible: await unseeded.isVisible().catch(() => false),
      }), { timeout: 90_000, intervals: [3_000] })
      .toEqual(
        expect.objectContaining({
          hidden: true,
          visible: false,
          reason: expect.stringMatching(/ACTOR_(NOT_FAVORITED|UNRECOGNIZED)/),
        }),
      );
    // 收藏/订阅项不受影响
    for (const item of [target.fav, target.sub]) {
      const el = itemOf(item.code);
      const hidden = await el.getAttribute('data-hidden-by-actor').catch(() => null);
      expect(hidden, `${item.code}（收藏/订阅）不应被隐藏`).not.toBe('true');
    }
    // 还原开关
    await patchSettings(context, {
      'listEnhancement.hideNonFavoritedActorsInList': false,
      'listEnhancement.hideUnrecognizedActorsInList': false,
    });
  });

  test('Phase3 L14 滚动加载：触底追加下一页', async () => {
    if (!audit) return test.skip(true, 'L01 未执行');
    const { page, context } = audit;
    await patchSettings(context, { 'listEnhancement.enableScrollPaging': true });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
    await dismissAgeGateIfPresent(page);

    await expect
      .poll(() => consoleHas(/Scroll paging enabled and initialized/), {
        timeout: 60_000,
        intervals: [2_000],
      })
      .toBe(true);

    let initial = -1;
    await expect
      .poll(async () => {
        const count = await page.locator('.movie-list .item').count();
        if (initial < 0) initial = count;
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(2_000);
        return await page.locator('.movie-list .item').count();
      }, { timeout: 120_000, intervals: [3_000] })
      .toBeGreaterThan(initial);
    await patchSettings(context, { 'listEnhancement.enableScrollPaging': false });
  });

  test('Phase4 L16 资源标签：开开关 + 含字幕过滤列表出现中字标签', async () => {
    if (!audit) return test.skip(true, 'L01 未执行');
    const { page, context } = audit;
    await patchSettings(context, { 'listEnhancement.resourceTags': true });
    await page.goto(RESOURCE_TAG_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await dismissAgeGateIfPresent(page);

    await expect
      .poll(() => page.locator('.jdb-resource-tag', { hasText: '中字' }).count(), {
        timeout: 90_000,
        intervals: [3_000],
      })
      .toBeGreaterThanOrEqual(1);
    await patchSettings(context, { 'listEnhancement.resourceTags': false });
  });

  test('Phase5 L17 列表排序：开开关出现排序工具条', async () => {
    if (!audit) return test.skip(true, 'L01 未执行');
    const { page, context } = audit;
    await patchSettings(context, { 'listEnhancement.sorting.enabled': true });
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await dismissAgeGateIfPresent(page);

    await expect
      .poll(() => page.locator('.x-list-sort-toolbar').count(), {
        timeout: 60_000,
        intervals: [3_000],
      })
      .toBeGreaterThanOrEqual(1);
    await patchSettings(context, { 'listEnhancement.sorting.enabled': false });
  });

  test('Phase6 L03 主开关负向：关闭后无列表增强注入', async () => {
    if (!audit) return test.skip(true, 'L01 未执行');
    const { page, context } = audit;
    // 设计约定（listObserverPolicy）：主开关关闭时安装"独立状态观察器"，
    // 状态/收藏快捷按钮仅受各自子开关控制。故负向断言需同时关闭这两个子开关，
    // 主开关真正负责的是列表增强本体（x-btn / 水印 / 标题优化等）。
    await patchSettings(context, {
      'userExperience.enableListEnhancement': false,
      'listEnhancement.enableStatusQuickAction': false,
      'listEnhancement.enableListFavoriteQuickAction': false,
    });
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await dismissAgeGateIfPresent(page);

    // 等待若干轮处理后确认无任何注入
    await page.waitForTimeout(8_000);
    expect(await page.locator('.movie-list .item .x-btn').count(), '主开关关闭后仍注入 x-btn').toBe(0);
    expect(await page.locator('.jdb-list-status-actions').count(), '状态子开关关闭后仍注入状态快捷按钮').toBe(0);
    expect(await page.locator('.jdb-list-favorite-actions').count(), '收藏子开关关闭后仍注入收藏快捷按钮').toBe(0);
    expect(await page.locator('.x-actor-wm').count(), '主开关关闭后仍注入演员水印').toBe(0);
    // 还原
    await patchSettings(context, {
      'userExperience.enableListEnhancement': true,
      'listEnhancement.enableStatusQuickAction': true,
      'listEnhancement.enableListFavoriteQuickAction': true,
    });
  });
});

function pageErrorsSafe(): string[] {
  return audit?.pageErrors ?? [];
}
