/**
 * @file enhancementItemAudit-actor.spec.ts
 * @description 性能优化后演员页增强功能真机逐项审计（feature-matrix.md A 节，A01–A04）。
 *
 * 测试面口径 = 用户真实 profile（actorEnhancement 块全开：主开关 + 默认 tag
 * 自动应用 + 时间分段分隔线 + 动作按钮 + 扫描新作品按钮；列表/详情增强全关，
 * 隔离演员页自身功能）。
 *
 * node 预检（真站网络）：
 *   1) 取 /?vst=1 前 8 项，逐项抓详情页第 1–3 位演员 → 候选池（去重）；
 *   2) 逐个抓演员页，解析首屏作品日期与 tag 栏代码（a.tag[href*="?t="]）；
 *   3) primary = 第一个可解析演员（A01/A03/A04 目标）；
 *      divider = 第一个首屏含 6 个月前作品（留 7 天缓冲）的演员（A02 目标）；
 *      defaultTags = ['p','s','d','c'] ∩ primary tag 栏（保持 p,s,d,c 序）。
 *   候选均不满足时对应 test 记数据依赖 skip（真实发现，不硬调断言）。
 *
 * 逐项断言（每项独立 test，serial 共享同一 context）：
 *   A01 启用日志（演员ID）+ 拉黑/订阅/扫描新作品三按钮注入（拉黑文案=拉黑）；
 *   A03 autoApplyTags 生效：URL 带 t=<defaultTags> 与 sort_type + 应用日志；
 *   A02 时间分段：首屏有旧作品 → .x-actor-seg-divider「— 更早（6个月前） —」
 *       （800ms 定时注入 + MutationObserver，滚动仅作兜底）；
 *   A04 负向：userExperience.enableActorEnhancement=false + 裸 URL reload →
 *       无按钮/无分隔线/无 t= 导航；测完还原。
 *
 * 注意：A03 的 t= 导航发生在 init 后 ~1s（location.href），A01 的按钮断言
 * 必须在导航稳定后进行（先等 URL 带 t=，再轮询按钮，双载后按钮重注入）。
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
const LIST_URL = `${JAVDB_E2E_HOST}/?vst=1`;
const FETCH_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const NAV_ACTOR_IDS = new Set(['censored', 'uncensored', 'western']);
const SEGMENTATION_MONTHS = 6;
/** 预检旧作品判定的安全缓冲（天），避免阈值边界抖动导致浏览器端无分隔线 */
const OLD_WORK_BUFFER_DAYS = 7;
const TAG_PRIORITY = ['p', 's', 'd', 'c'];

interface ActorRef {
  id: string;
  name: string;
}

interface ActorAuditTarget {
  /** A01/A03/A04 目标：第一个可解析演员 */
  primary: ActorRef & { tags: string[] };
  /** A02 目标：首屏含旧作品的演员（null → A02 数据依赖 skip） */
  divider: ActorRef | null;
  /** A03 默认 tag（[] → A03 数据依赖 skip） */
  defaultTags: string[];
}

// siteFetchText 内部已含重试；设置 JAVDB_E2E_PROXY 时自动走代理（node fetch 不认代理环境变量）
async function fetchText(url: string): Promise<string | null> {
  return siteFetchText(url, { userAgent: FETCH_UA });
}

/** 解析演员页首屏 .item 的 .meta 日期（与 parseReleaseDateFromItem 同口径） */
function parseActorPageDates(html: string): number[] {
  const dates: number[] = [];
  const blocks = html.split(/<div class="item[" >]/).slice(1);
  for (const block of blocks) {
    const meta = block.match(/<div class="meta[^"]*">[\s\S]*?<\/div>/)?.[0] ?? '';
    const m = meta.match(/(20\d{2}|19\d{2})[./-](\d{1,2})[./-](\d{1,2})/);
    if (!m) continue;
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    if (!Number.isNaN(t)) dates.push(t);
  }
  return dates;
}

/** 解析演员页 tag 栏代码（a.tag[href*="?t="]，扩展 parseAvailableTags 同来源） */
function parseActorPageTags(html: string): string[] {
  const tags = new Set<string>();
  for (const m of html.matchAll(/<a class="tag[^"]*" href="[^"]*?t=([A-Za-z0-9]+)&/g)) {
    tags.add(m[1]);
  }
  return [...tags];
}

function countActorPageItems(html: string): number {
  return (html.match(/<div class="item[" >]/g) ?? []).length;
}

/** 详情页第 1–3 位真实演员（排除导航占位） */
function pickActorsFromDetail(detailHtml: string): ActorRef[] {
  const actors: ActorRef[] = [];
  const seen = new Set<string>();
  for (const m of detailHtml.matchAll(/href="\/actors\/([A-Za-z0-9]+)"[^>]*>([^<]{1,30})</g)) {
    const id = m[1];
    const name = m[2].trim();
    if (NAV_ACTOR_IDS.has(id) || seen.has(id) || !name) continue;
    seen.add(id);
    actors.push({ id, name });
    if (actors.length >= 3) break;
  }
  return actors;
}

/** 预检：候选演员池 → primary（A01/A03/A04）+ divider（A02）+ defaultTags */
async function pickActorAuditTarget(): Promise<ActorAuditTarget | null> {
  try {
    const listHtml = await fetchText(LIST_URL);
    if (!listHtml) return null;
    const listIds: string[] = [];
    const seenIds = new Set<string>();
    for (const m of listHtml.matchAll(/href="\/v\/([A-Za-z0-9]+)"/g)) {
      if (!seenIds.has(m[1])) {
        seenIds.add(m[1]);
        listIds.push(m[1]);
      }
      if (listIds.length >= 8) break;
    }
    if (listIds.length < 2) return null;

    const candidates: ActorRef[] = [];
    const seenActors = new Set<string>();
    for (const vid of listIds) {
      const detailHtml = await fetchText(`${JAVDB_E2E_HOST}/v/${vid}`);
      if (!detailHtml) continue;
      for (const a of pickActorsFromDetail(detailHtml)) {
        if (!seenActors.has(a.id)) {
          seenActors.add(a.id);
          candidates.push(a);
        }
      }
      if (candidates.length >= 12) break;
    }
    if (candidates.length === 0) return null;

    const threshold = Date.now() - (SEGMENTATION_MONTHS * 30 + OLD_WORK_BUFFER_DAYS) * 24 * 60 * 60 * 1000;
    let primary: (ActorRef & { tags: string[] }) | null = null;
    let divider: ActorRef | null = null;

    for (const actor of candidates) {
      const html = await fetchText(`${JAVDB_E2E_HOST}/actors/${actor.id}`);
      if (!html || countActorPageItems(html) === 0) continue;
      const tags = parseActorPageTags(html);
      if (!primary) primary = { ...actor, tags };
      const dates = parseActorPageDates(html);
      if (!divider && dates.some((d) => d < threshold)) divider = { id: actor.id, name: actor.name };
      if (primary && divider) break;
    }
    if (!primary) return null;

    const defaultTags = TAG_PRIORITY.filter((t) => primary!.tags.includes(t));
    if (!defaultTags.length) {
      console.info(`[E2E actor-audit] A03 skip 预检: primary ${primary.id} tag 栏无 p/s/d/c`);
    }
    if (!divider) {
      console.info('[E2E actor-audit] A02 skip 预检: 候选演员首屏均无 6 个月前作品');
    }
    return { primary, divider, defaultTags };
  } catch (error) {
    console.info('[E2E actor-audit] pick target failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** 用户真实 profile 口径的完整 settings（顶层浅合并：每个块必须自包含） */
function buildActorAuditSettings(defaultTags: string[]): Record<string, unknown> {
  return {
    userExperience: {
      enableContentFilter: false,
      enableKeyboardShortcuts: false,
      enableMagnetSearch: false,
      enableAnchorOptimization: false,
      enableListEnhancement: false,
      enableActorEnhancement: true,
      enableSuperRanking: false,
      showEnhancedTooltips: false,
      enablePasswordHelper: false,
    },
    videoEnhancement: {
      enabled: true,
      schedulingMode: 'smart',
      enableCoverImage: false,
      showLoadingIndicator: false,
      enableReviewBreaker: false,
      enableFC2Breaker: false,
      enableWantSync: false,
      autoMarkWatchedAfter115: false,
      autoMarkWatchedStars: 4,
      enableActorRemarks: false,
      enableActorNameMarks: false,
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
      enabled: false,
      enableClickEnhancement: false,
      enableClickEnhancementList: false,
      enableClickEnhancementDetail: false,
      enableVideoPreview: false,
      enableScrollPaging: false,
      enableListOptimization: false,
      previewDelay: 1000,
      previewVolume: 0.2,
      enableRightClickBackground: false,
      enableActorWatermark: false,
      actorWatermarkPosition: 'top-right',
      actorWatermarkOpacity: 0.4,
      hideBlacklistedActorsInList: false,
      hideNonFavoritedActorsInList: false,
      hideUnrecognizedActorsInList: false,
      treatSubscribedAsFavorited: true,
      listDisplayControl: {
        enabled: false,
        columnCount: 4,
        containerWidth: 100,
        enableContainerExpansion: false,
      },
      showStatusBadge: false,
      enableStatusQuickAction: false,
      enableListFavoriteQuickAction: false,
      resourceTags: false,
      sorting: {
        enabled: false,
        appendStrategy: 'prompt',
        autoResortPosition: 'preserve',
      },
    },
    actorEnhancement: {
      enabled: true,
      autoApplyTags: true,
      defaultTags,
      defaultSortType: 0,
      enableActionButtons: true,
      enableTimeSegmentationDivider: true,
      timeSegmentationMonths: SEGMENTATION_MONTHS,
      enableScanNewWorks: true,
    },
    emby: {
      enabled: false,
      recognitionEnabled: false,
      libraryEnabled: false,
      matchUrls: [],
      videoCodePatterns: ['[A-Z]{2,6}-\\d{2,6}'],
      linkBehavior: 'javdb-search',
      enableAutoDetection: false,
      highlightStyle: {
        backgroundColor: '#e3f2fd',
        color: '#1976d2',
        borderRadius: '4px',
        padding: '2px 4px',
      },
      showQuickSearchCode: false,
      showQuickSearchActor: false,
      mediaServers: [],
      syncIntervalMinutes: 10080,
      libraryStatus: { enabled: false, showOnList: false, showOnDetail: false },
      realtimeCheck: {
        enabled: false,
        concurrency: 1,
        batchSize: 20,
        cacheTtlMinutes: 10,
      },
    },
    dataEnhancement: {
      enableMultiSource: false,
      enableVideoPreview: false,
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

function makeActorRecord(actor: ActorRef): Record<string, unknown> {
  const now = Date.now();
  return {
    id: actor.id,
    name: actor.name,
    aliases: [actor.name],
    gender: 'unknown',
    category: 'unknown',
    profileUrl: `${JAVDB_E2E_HOST}/actors/${actor.id}`,
    createdAt: now,
    updatedAt: now,
    blacklisted: false,
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
  target: ActorAuditTarget;
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

test.describe('演员页增强逐项审计（真机）', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(async () => {
    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      delete process.env[key];
    }
    const target = await pickActorAuditTarget();
    if (!target) return;

    const harnessOptions = resolveTestHarnessOptions(
      testInfoContext().outputPath('actor-audit-profile'),
    );
    const context = await launchExtensionContext(harnessOptions, {
      headless: false,
      channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
    });
    const extensionId = await readExtensionId(context);
    await presetAgeGateCookie(context);

    // 1) chrome.storage：settings（actorEnhancement 全开，列表/详情增强隔离关闭）
    await seedExtensionStorage(context, {
      settings: buildActorAuditSettings(target.defaultTags),
    });

    // 2) 演员库：primary（+divider 若不同演员）普通收藏，供拉黑按钮读取本地状态
    const records = [makeActorRecord(target.primary)];
    if (target.divider && target.divider.id !== target.primary.id) {
      records.push(makeActorRecord(target.divider));
    }
    await seedActors(context, extensionId, records);

    // 3) 打开真站演员页（裸 URL；autoApplyTags 会在 ~1s 后导航到 t= URL）
    const page = await context.newPage();
    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      consoleMessages.push(`${msg.type()}: ${msg.text()}`);
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    audit = { context, page, target, extensionId, consoleMessages, pageErrors };
    await page.goto(`${JAVDB_E2E_HOST}/actors/${target.primary.id}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await dismissAgeGateIfPresent(page);
    console.info(
      `[E2E actor-audit] precheck: primary=${target.primary.id}(${target.primary.name}) ` +
        `divider=${target.divider ? target.divider.id : '无'} defaultTags=[${target.defaultTags.join(',')}]`,
    );
  }, { timeout: 300_000 });

  test.afterAll(async () => {
    if (audit) {
      await audit.page.close().catch(() => {});
      await audit.context.close().catch(() => {});
      audit = null;
    }
  });

  test('A01 启用日志 + 拉黑/订阅/扫描新作品按钮注入（未登录：登录墙守卫不跳 t=）', async () => {
    if (!audit) return test.skip(true, 'javdb570 网络不可用或演员结构变化，跳过真机检查');
    const { page, target } = audit;

    // autoApplyTags 在 ~1s 触发（导航或守卫跳过）；等 12s 让结果尘埃落定
    await page.waitForTimeout(12_000);

    // 站点登录态：未登录时顶部导航存在 a.navbar-item[href="/login"]
    const loggedIn = (await page.locator('a.navbar-item[href="/login"]').count()) === 0;
    if (loggedIn) {
      // 已登录：t= 导航会整页刷新，等 URL 稳定到 t= 再断言按钮
      if (target.defaultTags.length > 0) {
        await expect
          .poll(() => new URL(page.url()).searchParams.get('t'), {
            timeout: 45_000,
            intervals: [1_000],
          })
          .toBe(target.defaultTags.join(','));
      }
    } else {
      // 未登录：站点要求登录才能 t= 过滤（302 /login）→ 守卫应跳过自动导航
      if (target.defaultTags.length > 0) {
        expect(new URL(page.url()).searchParams.get('t'), '未登录时发生了 t= 导航（会被站点 302 到 /login）').toBeNull();
      }
      expect(page.url(), '未登录时被站点重定向到登录页').toContain('/actors/');
    }

    const blacklistBtn = page.locator('#button-blacklist-actor');
    await expect
      .poll(() => blacklistBtn.count(), { timeout: 90_000, intervals: [3_000] })
      .toBeGreaterThanOrEqual(1);
    await expect(page.locator('#button-subscribe-actor')).toHaveCount(1);
    await expect(page.locator('#button-scan-new-works')).toHaveCount(1);
    // seed 为普通收藏（非黑名单）→ 拉黑按钮文案应为「拉黑」
    await expect(blacklistBtn).toHaveText('拉黑');

    expect(
      consoleHas(new RegExp(`🎭 演员页增强功能已启用，演员ID: ${target.primary.id}`)),
      '演员页增强启用日志缺失',
    ).toBe(true);
    expect(pageErrorsSafe(), '演员页增强注入出现 JS 报错').toEqual([]);
    console.info(`[E2E actor-audit] A01 ok: ${target.primary.id} (loggedIn=${loggedIn})`);
  });

  test('A03 默认 tag 自动应用（已登录：URL t=；未登录：守卫日志不导航）', async () => {
    if (!audit) return test.skip(true, 'A01 未执行');
    const { page, target } = audit;
    if (target.defaultTags.length === 0) {
      return test.skip(true, 'primary 演员 tag 栏无 p/s/d/c，数据依赖 skip');
    }
    const loggedIn = (await page.locator('a.navbar-item[href="/login"]').count()) === 0;
    if (loggedIn) {
      const url = new URL(page.url());
      expect(url.searchParams.get('t'), 'URL 应携带默认 tag 过滤参数').toBe(target.defaultTags.join(','));
      expect(url.searchParams.get('sort_type'), 'URL 应携带默认排序参数').toBe('0');
      expect(
        consoleHas(new RegExp(`🔄 应用默认tag过滤器: ${target.defaultTags.join(',')}`)),
        '默认 tag 应用日志缺失',
      ).toBe(true);
    } else {
      // 未登录：守卫跳过自动导航，URL 保持裸演员页，控制台有守卫日志
      expect(new URL(page.url()).searchParams.get('t'), '未登录时仍发生了 t= 导航').toBeNull();
      expect(page.url(), '未登录时页面离开了演员页').toContain(`/actors/${target.primary.id}`);
      expect(
        consoleHas(/站点要求登录后才能使用 tag 过滤，已跳过自动导航/),
        '未登录守卫日志缺失',
      ).toBe(true);
    }
  });

  test('A02 时间分段分隔线（首屏旧作品 → 更早分隔线）', async () => {
    if (!audit) return test.skip(true, 'A01 未执行');
    const { page, context, target } = audit;
    if (!target.divider) {
      return test.skip(true, '候选演员首屏均无 6 个月前作品，数据依赖 skip');
    }
    // 关 autoApplyTags 避免 t= 导航把旧作品过滤掉；用裸 URL 直达
    await patchSettings(context, { 'actorEnhancement.autoApplyTags': false });
    await page.goto(`${JAVDB_E2E_HOST}/actors/${target.divider.id}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await dismissAgeGateIfPresent(page);

    const divider = page.locator('.x-actor-seg-divider');
    await expect
      .poll(async () => {
        if ((await divider.count()) > 0) return 1;
        // 兜底：滚动触底（预检已确认首屏含旧作品，正常 800ms 定时注入即可出现）
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(2_500);
        return 0;
      }, { timeout: 120_000, intervals: [2_000] })
      .toBe(1);
    const text = await divider.first().textContent();
    expect(text, '分隔线文案应含「更早」与月数').toContain(`更早（${SEGMENTATION_MONTHS}个月前）`);
    console.info(`[E2E actor-audit] A02 ok: ${target.divider.id} → ${text}`);
  });

  test('A04 主开关负向：关闭后无注入无导航', async () => {
    if (!audit) return test.skip(true, 'A01 未执行');
    const { page, context, target } = audit;
    await patchSettings(context, { 'userExperience.enableActorEnhancement': false });
    await page.goto(`${JAVDB_E2E_HOST}/actors/${target.primary.id}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await dismissAgeGateIfPresent(page);
    await page.waitForTimeout(10_000);

    expect(await page.locator('#button-blacklist-actor').count(), '主开关关闭后仍注入拉黑按钮').toBe(0);
    expect(await page.locator('#button-subscribe-actor').count(), '主开关关闭后仍注入订阅按钮').toBe(0);
    expect(await page.locator('#button-scan-new-works').count(), '主开关关闭后仍注入扫描按钮').toBe(0);
    expect(await page.locator('.x-actor-seg-divider').count(), '主开关关闭后仍注入分段分隔线').toBe(0);
    expect(new URL(page.url()).searchParams.get('t'), '主开关关闭后仍发生 t= 导航').toBeNull();
    // 还原
    await patchSettings(context, { 'userExperience.enableActorEnhancement': true });
  });
});

function pageErrorsSafe(): string[] {
  return audit?.pageErrors ?? [];
}
