/**
 * @file perfProfileSeed.ts
 * @description 性能 S0 数据 seed 脚本：向隔离 profile 注入接近用户真实规模的数据集。
 *
 * 数据量口径（2026-09-06 用户确认真实规模）：
 *   - 番号库 viewedRecords：20000（viewed 3000 / browsed 5000 / want 2000 / untracked 10000，收藏 300）
 *   - 媒体库：3000 条（buildPerformanceMediaFixture，115 + Emby 双片库，serverUrl 留空）
 *   - 新作品 newWorks：2000（未读 1800）
 *   - 演员 actors：50（黑名单 3）
 *   - 设置：复刻用户真实 profile 的增强开关（水印/状态按钮/快捷收藏/黑名单隐藏/库匹配）
 *
 * 铁律：无凭证、serverUrl 留空、不产生任何对真实 115/Emby/Cloud 的调用；
 *       封面用本地 SVG data-URI（无远程请求）；profile 与生产 profile 完全隔离。
 *
 * 用法：
 *   pnpm tsx scripts/perfProfileSeed.ts          # 幂等：已 seed 过则跳过
 *   pnpm tsx scripts/perfProfileSeed.ts --reset  # 清空后重新 seed
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extensionPageUrl,
  launchExtensionContext,
  readExtensionId,
  resolveExtensionHarnessOptions,
} from './extensionHarness';
import { buildPerformanceMediaFixture } from './performanceMediaFixture';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CWD = path.resolve(__dirname, '..');

const TARGETS = {
  viewedTotal: 20_000,
  viewed: 3_000,
  browsed: 5_000,
  want: 2_000,
  untracked: 10_000,
  favorites: 300,
  newWorks: 2_000,
  newWorksRead: 200,
  actors: 50,
  actorsBlacklisted: 3,
  mediaLibrary: 3_000,
};

interface SeedReport {
  alreadySeeded: boolean;
  reset: boolean;
  before: { viewed: number; newWorks: number; actors: number };
  after: {
    viewed: number;
    newWorks: number;
    actors: number;
    favorites: number;
    byStatus: Record<string, number>;
    storage: Record<string, number>;
  };
}

interface SeedArgs {
  reset: boolean;
  targets: typeof TARGETS;
  media: {
    emby_library_state: Record<string, unknown>;
    drive115_library_state: Record<string, unknown>;
  };
  settings: Record<string, unknown>;
}

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const profileDir = path.resolve(CWD, '.test-profiles', 'perf-s0');
  process.env.JAVDB_EXTENSION_PROFILE = profileDir;
  // S0 使用 fixture 数据集，绝不复制真实 Chrome profile（铁律）
  process.env.JAVDB_EXTENSION_USE_CHROME_DATA = '0';

  const harnessOptions = resolveExtensionHarnessOptions(process.env, CWD);
  const context = await launchExtensionContext(harnessOptions, {
    headless: false,
    channel: process.env.JAVDB_EXTENSION_CHANNEL ?? 'chromium',
    extraArgs: ['--no-proxy-server'],
  });

  try {
    const extensionId = await readExtensionId(context);
    const page = await context.newPage();
    await page.goto(extensionPageUrl(extensionId, 'dashboard/dashboard.html'), {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });

    const mediaFixture = buildPerformanceMediaFixture(TARGETS.mediaLibrary);
    const settings = {
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

    // 页面侧逻辑以纯 JS 文件注入（tsx 转换会向函数体注入 __name helper，页面上下文无此 helper 导致 ReferenceError）
    // Playwright 对字符串 pageFunction（isFunction:false）只 eval 表达式、不会调用函数（coreBundle 注入脚本实证），
    // 因此必须包成 IIFE 并把参数内联为 JSON，否则返回的函数对象会被序列化成 undefined
    const pageSource = readFileSync(path.join(__dirname, 'perfProfileSeed.page.js'), 'utf8');
    const seedArgs: SeedArgs = {
      reset,
      targets: TARGETS,
      media: {
        emby_library_state: mediaFixture.emby_library_state,
        drive115_library_state: mediaFixture.drive115_library_state,
      },
      settings,
    };
    const callExpression = `(${pageSource})(${JSON.stringify(seedArgs)})`;
    const report = await page.evaluate<SeedReport, void>(callExpression, undefined);

    console.log('[perfProfileSeed] 完成：');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error('[perfProfileSeed] 失败：', error);
  process.exitCode = 1;
});
