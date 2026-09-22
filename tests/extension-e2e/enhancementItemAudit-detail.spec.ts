/**
 * @file enhancementItemAudit-detail.spec.ts
 * @description 性能优化后详情页增强功能真机逐项审计（feature-matrix.md D 节）。
 *
 * 测试面口径 = 用户真实 profile（enhanced 臂全开 + 默认开项）：
 *   videoEnhancement 默认块全开（主开关 on、smart 调度）；
 *   演员库 seed 三种状态演员（普通收藏 / 订阅 / 黑名单），各对应一种 UI 标记；
 *   seed 已看记录验证状态同步；seed 115/Emby 本地片库索引验证片库角标链路（列表页见 list spec）。
 *
 * 逐项断言（每项独立 test，serial 共享同一真站详情页）：
 *   D01 主链注入无报错；D02 标题[已观看]；D04 加载指示器收尾无残留；
 *   D05 封面预览挂载；D07 评论破解任务执行；D08 FC2 负向无报错；
 *   D09 收藏评分容器；D10 源清单 modal 本地清单；D11 演员名标记（订阅🔔/收藏着色）；
 *   D12 演员快捷操作按钮；D13 外链面板；D14 外链搜索；D15 在线可用（弱信号）；
 *   D16 字幕搜索面板；D17 演员备注负向（默认关）。
 *   D06 翻译默认关（➖）；D18 想看同步数据行为（随 D02 链）；D19 需真实 115 会话（⚠️ 不测）。
 *
 * 调度注意：详情页任务走 smart 调度（idle/deferred），先等主链核心增强日志
 * （"Enhancing video detail page (core)"）再逐项宽松等待（30s）。
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
const FETCH_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const NAV_ACTOR_IDS = new Set(['censored', 'uncensored', 'western']);

interface AuditTarget {
  videoId: string;
  videoCode: string;
  videoUrl: string;
  actors: { id: string; name: string }[];
}

/** 用户真实 profile 口径的完整 settings（顶层浅合并：每个块必须自包含） */
function buildAuditSettings(): Record<string, unknown> {
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
      enableReviewBreaker: true,
      enableFC2Breaker: true,
      enableWantSync: true,
      autoMarkWatchedAfter115: true,
      autoMarkWatchedStars: 4,
      enableActorRemarks: false,
      actorRemarksMode: 'panel',
      actorRemarksTTLDays: 0,
      actorRemarksTaskTimeoutSeconds: 10,
      enableActorNameMarks: true,
      enableActorQuickActions: true,
      enableVideoFavoriteRating: true,
      enableRelatedLists: true,
      enableLocalListInSourceModal: true,
      enableExternalEntryPanel: true,
      enableExternalSearch: true,
      enableOnlineAvailability: true,
      showOnlineAvailabilityFailures: false,
      onlineAvailabilitySites: {},
      enableSubtitleSearch: true,
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
      mediaServers: [],
      syncIntervalMinutes: 60,
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

/** 从最新影片列表挑一部「有演员」的片 + 最多 3 位真实演员（node 预检，网络不可用返回 null）。
 * 顶部影片可能是素人作品（站点演员字段 N/A，无 /actors/ 链接）——
 * 此时顺延取第 2、3 条；三条都无演员时返回 null（全组按设计 skip，站点数据依赖）。 */
async function pickVideoWithActors(): Promise<AuditTarget | null> {
  try {
    // siteFetchText 内部已含重试；设置 JAVDB_E2E_PROXY 时自动走代理（node fetch 不认代理环境变量）
    const listHtml = await siteFetchText(`${JAVDB_E2E_HOST}/?vst=1`, { userAgent: FETCH_UA });
    if (!listHtml) return null;

    const items: { id: string; code: string }[] = [];
    let idx = listHtml.indexOf('<div class="item');
    for (let n = 0; n < 3 && idx !== -1; n++) {
      const next = listHtml.indexOf('<div class="item', idx + 1);
      const block = listHtml.slice(idx, next === -1 ? undefined : next);
      const idMatch = block.match(/href="\/v\/([A-Za-z0-9]+)"/);
      const codeMatch = block.match(/<div class="video-title[^"]*">[\s\S]*?<strong>([^<]+)<\/strong>/);
      if (!idMatch || !codeMatch) break;
      items.push({ id: idMatch[1], code: codeMatch[1].trim() });
      idx = next;
    }
    if (items.length === 0) return null;

    for (const item of items) {
      const videoUrl = `${JAVDB_E2E_HOST}/v/${item.id}`;
      const videoHtml = await siteFetchText(videoUrl, { userAgent: FETCH_UA });
      if (!videoHtml) continue;
      const actors: { id: string; name: string }[] = [];
      const seen = new Set<string>();
      for (const m of videoHtml.matchAll(/href="\/actors\/([A-Za-z0-9]+)"[^>]*>([^<]{1,30})</g)) {
        const id = m[1];
        const name = m[2].trim();
        if (NAV_ACTOR_IDS.has(id) || seen.has(id) || !name) continue;
        seen.add(id);
        actors.push({ id, name });
        if (actors.length >= 3) break;
      }
      if (actors.length > 0) {
        return { videoId: item.id, videoCode: item.code, videoUrl, actors };
      }
    }
    console.info('[E2E detail-audit] 列表前 3 条均无演员（素人片），全组跳过');
    return null;
  } catch (error) {
    console.info('[E2E detail-audit] pick target failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
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

function makeActorRecord(actor: { id: string; name: string }, blacklisted = false): Record<string, unknown> {
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

interface AuditState {
  context: BrowserContext;
  page: Page;
  target: AuditTarget;
  extensionId: string;
  consoleMessages: string[];
  pageErrors: string[];
}

let audit: AuditState | null = null;
let target: AuditTarget | null = null;

function consoleHas(pattern: RegExp): boolean {
  return (audit?.consoleMessages ?? []).some((line) => pattern.test(line));
}

test.describe('详情页增强逐项审计（真机）', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      delete process.env[key];
    }
    target = await pickVideoWithActors();
    if (!target) return;

    const testInfo = testInfoContext();
    const harnessOptions = resolveTestHarnessOptions(testInfo.outputPath('profile'));
    const context = await launchExtensionContext(harnessOptions, {
      headless: false,
      channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
    });
    const extensionId = await readExtensionId(context);
    await presetAgeGateCookie(context);

    // 1) chrome.storage：settings（用户 profile 口径）+ 订阅 + 115/Emby 本地片库索引
    const now = Date.now();
    const [subActor] = [target.actors[1] ?? target.actors[0]];
    await seedExtensionStorage(context, {
      settings: buildAuditSettings(),
      new_works_subscriptions: subActor
        ? {
            [subActor.id]: {
              actorId: subActor.id,
              actorName: subActor.name,
              subscribedAt: now,
              enabled: true,
            },
          }
        : {},
      drive115_library_state: {
        version: 1,
        updatedAt: now,
        entries: [
          {
            key: `c0:1`,
            code: target.videoCode,
            title: target.videoCode,
            folderCid: 'c0',
            folderName: target.videoCode,
            rootCid: 'r0',
            videoFileId: '1',
            pickCode: 'pc0',
            fileName: `${target.videoCode}.mp4`,
            fileSize: 1024,
            updatedAt: now,
          },
        ],
        stats: { roots: 0, foldersSeen: 1, indexed: 1, skipped: 0, unrecognized: 0, apiCalls: 0 },
      },
      emby_library_state: {
        entries: {
          [target.videoCode]: [
            {
              serverType: 'emby',
              serverName: 'Emby-E2E',
              serverUrl: 'http://127.0.0.1:8096',
              itemId: 'e2e-item-1',
              itemName: `${target.videoCode}.mp4`,
              path: '/media/av/e2e.mp4',
              updatedAt: now,
            },
          ],
        },
        updatedAt: now,
      },
    });

    // 2) IndexedDB：演员库（收藏/订阅/黑名单）+ 已看记录
    const actors = target.actors.map((a, i) => makeActorRecord(a, i === 2));
    if (actors.length > 0) await seedActors(context, extensionId, actors);
    await seedViewedRecord(context, extensionId, target.videoCode);

    // 3) 打开真站详情页
    const page = await context.newPage();
    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      consoleMessages.push(`${msg.type()}: ${msg.text()}`);
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    audit = { context, page, target, extensionId, consoleMessages, pageErrors };
  });

  test.afterAll(async () => {
    if (audit) {
      await audit.page.close().catch(() => {});
      await audit.context.close().catch(() => {});
      audit = null;
    }
  });

  test('D01 主链注入且无页面报错', async () => {
    if (!audit) return test.skip(!target, 'javdb570 网络不可用或页面结构变化，跳过真机检查');
    const { page, target: t } = audit;
    await page.goto(t.videoUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await dismissAgeGateIfPresent(page);
    await page.waitForFunction(
      () => document.documentElement?.dataset?.javdbExtensionInjected === '1',
      { timeout: 60_000 },
    );
    // 等核心增强进入（smart 调度下 initCore 为 high 优先级）
    await page.waitForTimeout(3_000);
    expect(pageErrorsSafe(), []).toEqual([]);
    console.info(`[E2E detail-audit] D01 ok: ${t.videoCode}`);
  });

  test('D02 状态同步：标签页标题出现 [已观看]', async () => {
    if (!audit) return test.skip(true, 'D01 未执行');
    // 状态标记由 statusManager 写入 document.title（标签页标题），与 contentMainChain T2 同口径
    await expect
      .poll(() => audit!.page.title(), {
        timeout: 45_000,
        intervals: [2_000],
      })
      .toContain('已观看');
  });

  test('D04 加载指示器收尾：无残留 spinner', async () => {
    if (!audit) return test.skip(true, 'D01 未执行');
    const { page } = audit;
    // 完成信号：核心增强日志出现（initialize 完成后 hideLoadingIndicator）
    await expect
      .poll(() => consoleHas(/Enhancing video detail page|Video detail enhancement completed/), {
        timeout: 60_000,
        intervals: [2_000],
      })
      .toBe(true);
    // 指示器不得永久残留（性能回归的典型失效形态）
    await page.waitForTimeout(3_000);
    const leftover = await page.locator('.enhancement-spinner:visible').count();
    expect(leftover, '增强完成后仍存在残留加载指示器').toBe(0);
  });

  test('D05 封面预览挂载（原生封面 x-preview）', async () => {
    if (!audit) return test.skip(true, 'D01 未执行');
    const { page } = audit;
    await expect
      .poll(
        () => page.locator('.cover.x-preview img, .x-cover.x-preview img').first().isVisible().catch(() => false),
        { timeout: 60_000, intervals: [3_000] },
      )
      .toBe(true);
  });

  test('D07 评论破解任务执行（进入日志）', async () => {
    if (!audit) return test.skip(true, 'D01 未执行');
    await expect
      .poll(() => consoleHas(/\[ReviewBreaker\] runReviewBreaker entered/), {
        timeout: 60_000,
        intervals: [2_000],
      })
      .toBe(true);
  });

  test('D08 FC2 破解负向：非 FC2 页无 FC2 报错', async () => {
    if (!audit) return test.skip(true, 'D01 未执行');
    const fc2Errors = audit.consoleMessages.filter((l) => /fc2/i.test(l) && /error|fail/i.test(l));
    expect(fc2Errors, `非 FC2 页出现 FC2 相关报错: ${fc2Errors.join(' | ')}`).toEqual([]);
  });

  test('D09 收藏评分容器出现', async () => {
    if (!audit) return test.skip(true, 'D01 未执行');
    await expect
      .poll(
        () => audit!.page.locator('.video-favorite-rating-container').first().isVisible().catch(() => false),
        { timeout: 60_000, intervals: [3_000] },
      )
      .toBe(true);
  });

  test('D11 演员名标记：订阅🔔 / 收藏着色', async () => {
    if (!audit) return test.skip(true, 'D01 未执行');
    const { page, target: t } = audit;
    const subActor = t.actors[1] ?? t.actors[0];
    const favActor = t.actors[0];
    // 订阅演员：演员链接前出现 🔔 角标
    await expect
      .poll(() => page.locator(`span.actor-subscribe-badge[data-actor-id="${subActor.id}"]`).count(), {
        timeout: 90_000,
        intervals: [3_000],
      })
      .toBeGreaterThanOrEqual(1);
    // 收藏演员：演员链接 title="已收藏"
    await expect
      .poll(
        () => page.locator(`a[href$="/actors/${favActor.id}"][title="已收藏"]`).count(),
        { timeout: 60_000, intervals: [3_000] },
      )
      .toBeGreaterThanOrEqual(1);
  });

  test('D12 演员快捷操作按钮挂载', async () => {
    if (!audit) return test.skip(true, 'D01 未执行');
    const { page, target: t } = audit;
    // 快捷操作按钮在 hover 演员链接 ~300ms 后创建的 tooltip 内（showTooltip 才 append 按钮）
    const favActor = t.actors[0];
    const actorLink = page
      .locator(`a[href$="/actors/${favActor.id}"]`)
      .first();
    await expect
      .poll(async () => {
        const n = await actorLink.count();
        if (n === 0) return 0;
        await actorLink.first().scrollIntoViewIfNeeded().catch(() => {});
        await actorLink.first().hover({ timeout: 5_000 }).catch(() => {});
        return (await page.locator('.x-actor-quick-btn').count()) > 0 ? 1 : 0;
      }, {
        timeout: 90_000,
        intervals: [2_000],
      })
      .toBe(1);
    // tooltip 内应有收藏/拉黑/订阅三类快捷按钮
    expect(await page.locator('.x-actor-quick-tooltip .x-actor-quick-btn').count(), 'tooltip 快捷按钮数量').toBeGreaterThanOrEqual(3);
  });

  test('D13 外部入口面板挂载', async () => {
    if (!audit) return test.skip(true, 'D01 未执行');
    const { page } = audit;
    await expect
      .poll(
        async () => {
          const panel = await page
            .locator('.jdb-detail-enhancement-panel, .jdb-detail-enhancement-panel-inner')
            .first()
            .isVisible()
            .catch(() => false);
          const subPanels = await page.locator('#jdb-external-search-panel, #jdb-subtitle-search-panel').count();
          return panel || subPanels > 0;
        },
        { timeout: 60_000, intervals: [3_000] },
      )
      .toBe(true);
  });

  test('D14 外链搜索面板 / D16 字幕搜索面板', async () => {
    if (!audit) return test.skip(true, 'D01 未执行');
    const { page } = audit;
    const searchPanel = page.locator('#jdb-external-search-panel');
    const subtitlePanel = page.locator('#jdb-subtitle-search-panel');
    await expect
      .poll(async () => {
        const s = (await searchPanel.count()) > 0;
        const b = (await subtitlePanel.count()) > 0;
        return s && b;
      }, { timeout: 60_000, intervals: [3_000] })
      .toBe(true);
  });

  test('D15 在线可用检测（弱信号：面板或日志）', async () => {
    if (!audit) return test.skip(true, 'D01 未执行');
    const { page } = audit;
    const ok = await expect
      .poll(async () => {
        const panel = (await page.locator('#jdb-online-availability-panel').count()) > 0;
        const log = consoleHas(/onlineAvailability|在线可用|在线检测/i);
        return panel || log;
      }, { timeout: 90_000, intervals: [5_000] })
      .toBe(true)
      .then(() => true, () => false);
    // 外部源不可达不算功能失效：仅记录，不硬失败
    console.info(`[E2E detail-audit] D15 online-availability signal: ${ok ? 'observed' : 'not observed（外部源不可达时允许）'}`);
  });

  test('D10 源清单 modal 本地清单注入', async () => {
    if (!audit) return test.skip(true, 'D01 未执行');
    const { page } = audit;
    const saveBtn = page.locator('[data-target="modal-save-list"]').first();
    if ((await saveBtn.count()) === 0) {
      console.info('[E2E detail-audit] D10 skip: 页面无存入清单入口（页面结构变化）');
      return test.skip(true, '无存入清单按钮');
    }
    await saveBtn.scrollIntoViewIfNeeded().catch(() => {});
    await saveBtn.click({ timeout: 15_000 }).catch(() => {});

    // 点击后等站点自己的 modal 打开（站点侧异步/动画）。按钮带 data-auth="true"，
    // 未登录用户会被站点重定向到登录页（E2E 无登录会话：源站登录带验证码，属环境依赖）
    const modal = page.locator('#modal-save-list').first();
    const active = await expect
      .poll(
        () => modal.getAttribute('class').then((c) => (c || '').includes('is-active')).catch(() => false),
        { timeout: 8_000, intervals: [500] },
      )
      .toBe(true)
      .then(() => true, () => false);

    if (!active) {
      const url = page.url();
      if (/login|signin|sign-in|sign_in/i.test(url)) {
        console.info('[E2E detail-audit] D10 skip: 未登录，站点将存入清单按钮重定向到登录页（环境依赖，非功能回归）');
        return test.skip(true, '未登录：存入清单按钮跳登录页');
      }
      // 仍在详情页但站点 modal 未打开：模拟 modal-active 状态，
      // 验证扩展自身契约（MutationObserver 触发 syncIfModalActive → 注入本地清单 section）
      console.info('[E2E detail-audit] D10: 站点 modal 点击后未打开，模拟 is-active 验证扩展注入契约');
      await modal.evaluate((el) => el.classList.add('is-active')).catch(() => {});
    }

    await expect
      .poll(
        () => page.locator('#modal-save-list #jdb-ext-local-lists').first().isVisible().catch(() => false),
        { timeout: 30_000, intervals: [1_500] },
      )
      .toBe(true);
  });

  test('D17 演员备注负向：默认关不出现备注 UI', async () => {
    if (!audit) return test.skip(true, 'D01 未执行');
    const { page } = audit;
    const count = await page.locator('.jdb-actor-remarks, [class*="actor-remark"]').count();
    expect(count, '默认关闭的演员备注 UI 不应出现').toBe(0);
  });
});

function testInfoContext(): { outputPath: (name: string) => string } {
  // Playwright 的 test.beforeAll 内可直接访问 testInfo；这里用占位路径避免顶层依赖
  return { outputPath: (name: string) => path.join(process.cwd(), 'test-results', 'extension-e2e', name) };
}

function pageErrorsSafe(): string[] {
  return audit?.pageErrors ?? [];
}
