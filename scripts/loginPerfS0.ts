/**
 * 一次性登录助手：在 :10.0 桌面打开 perf-s0 测试浏览器（用户可见），
 * 用户手动登录 javdb570 后脚本自动检测并优雅关闭（cookie 落盘）。不提交。
 */
import { mkdirSync } from 'node:fs';
import {
  launchExtensionContext,
  readExtensionId,
  resolveExtensionHarnessOptions,
} from './extensionHarness';

const CWD = process.cwd();
const TAGS_URL = 'https://javdb570.com/tags?c10=1';
interface LoginState {
  t: string;
  href: string;
  aBox: number;
  items: number;
}

const STATE_EXPR = `(() => ({
  href: location.href,
  aBox: document.querySelectorAll('a.box').length,
}))()`;

async function main() {
  process.env.JAVDB_EXTENSION_PROFILE = '.test-profiles/perf-s0';
  process.env.JAVDB_EXTENSION_USE_CHROME_DATA = '0';
  const options = resolveExtensionHarnessOptions(process.env, CWD);
  mkdirSync(options.userDataDir, { recursive: true });
  const context = await launchExtensionContext(options, {
    headless: false,
    channel: 'chromium',
    extraArgs: ['--no-proxy-server'],
  });
  const extensionId = await readExtensionId(context, 30_000);
  console.log(`[login] 扩展已加载 ${extensionId}，浏览器窗口已打开（用户桌面可见）`);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(TAGS_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});

  // 年龄门自动点（若有）
  const over18 = page.locator('a[href*="over18?respond=1"]').first();
  try {
    await over18.waitFor({ state: 'visible', timeout: 10_000 });
    await over18.click({ timeout: 10_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    console.log('[login] 已点击年龄门');
  } catch { /* 无门 */ }

  console.log('[login] 等待用户手动登录（上限 15 分钟）…');
  const deadline = Date.now() + 15 * 60_000;
  let confirmed = false;
  let lastBeat = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3_000);
    const state = await page.evaluate<LoginState>(STATE_EXPR).catch(() => null);
    if (Date.now() - lastBeat > 30_000) {
      lastBeat = Date.now();
      console.log(`[login] …当前页面: ${state?.href ?? '未知'}`);
    }
    if (!state) continue;
    if (state.aBox > 0) {
      confirmed = true;
      break;
    }
    // 用户已离开登录页（登录完成）但尚未到列表页：主动导航验证
    if (!state.href.includes('/login') && state.href.includes('javdb570.com')) {
      console.log('[login] 检测到已离开登录页，导航到列表页验证…');
      await page.goto(TAGS_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      try {
        await page.waitForSelector('a.box', { timeout: 20_000 });
        confirmed = true;
        break;
      } catch { /* 继续等 */ }
    }
  }
  if (confirmed) {
    console.log('[login] 登录成功：列表页已渲染，会话 cookie 将随关闭落盘');
    await page.waitForTimeout(3_000);
  } else {
    console.log('[login] 超时未检测到登录成功。请手动关闭浏览器窗口（正常关闭会落盘 cookie），或重跑本脚本。');
  }
  await context.close();
  process.exit(confirmed ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
