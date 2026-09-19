/**
 * @file realVisibilityLaunch.ts
 * @description S1-2 --real-visibility 启动模式：手动启动 Chrome（--remote-debugging-port）
 *   + CDP 代理（cdpVisibilityProxy.mjs 把 Playwright 的 Emulation.setFocusEmulationEnabled
 *   从 true 改写为 false）+ connectOverCDP，使 tab 按真实窗口状态上报 visibilityState
 *   （active=visible / 后台=hidden，visibilitychange 为真实事件）。
 *
 * 为什么不用 launchPersistentContext 直连：Playwright 会在自己的 CDP session 上默认开启
 * 「焦点模拟」，导致所有 tab 的 document.visibilityState 恒为 visible，扩展后台调度路径
 * （hidden 早退/指数退避）在测试环境永远不触发。代理方案改写的是 Playwright 自己会话的
 * 原始命令，viewport/UA 等其他默认值完全不变（两臂一致）。
 *
 * 仅供 perfS0Profile.ts --real-visibility 使用；其他 E2E 启动路径不受影响。
 */
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createChromiumExtensionArgs } from './extensionHarness';
import type { ExtensionHarnessOptions, LaunchExtensionContextOptions } from './extensionHarness';

/** Chrome DevTools 端口（手动启动用；两臂一致） */
const CDP_PORT = 9555;
const PROXY_HTTP_PORT = 9556;
const PROXY_WS_PORT = 9557;

export interface RealVisibilityLaunch {
  context: BrowserContext;
  browser: Browser;
  /** 先关 CDP 连接、等 Chrome 退出（进程组 SIGKILL 兜底），再关代理 */
  cleanup: () => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitHttpJson(url: string, tries: number, what: string): Promise<Record<string, string>> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return (await res.json()) as Record<string, string>;
    } catch { /* 未就绪，继续轮询 */ }
    await sleep(300);
  }
  throw new Error(`${what} 未就绪（${url}，轮询 ${tries} 次）`);
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    sleep(ms).then(() => { throw new Error(`${what} 超时（${ms}ms）`); }),
  ]);
}

/**
 * 探测 Playwright 当前版本 persistent-context 实际传给 Chrome 的完整启动参数。
 * 默认参数集随 Playwright 版本变化，不硬编码：短启一个探针浏览器，从 /proc/<pid>/cmdline
 * 抄全集（含 --disable-background-timer-throttling 等影响调度的旗标，必须与 harness 口径一致），
 * 关闭后返回完整 argv。
 */
async function probePlaywrightDefaultArgs(
  options: ExtensionHarnessOptions,
  launchOptions: LaunchExtensionContextOptions,
): Promise<string[]> {
  const args = createChromiumExtensionArgs(options.extensionDir);
  if (launchOptions.extraArgs?.length) args.push(...launchOptions.extraArgs);
  const probe = await chromium.launchPersistentContext(options.userDataDir, {
    channel: launchOptions.channel ?? 'chromium',
    headless: launchOptions.headless ?? false,
    args,
  });
  try {
    const marker = `--user-data-dir=${options.userDataDir}`;
    const entries = fs.readdirSync('/proc').filter((e) => /^\d+$/.test(e));
    for (const pid of entries) {
      let raw: string;
      try { raw = fs.readFileSync(path.join('/proc', pid, 'cmdline'), 'utf8'); } catch { continue; }
      const argv = raw.split('\0').filter(Boolean);
      if (argv[0]?.includes('chrome') && argv.includes(marker) && !argv.some((a) => a.startsWith('--type='))) {
        return argv;
      }
    }
    throw new Error('探针浏览器主进程未找到，无法获取 Playwright 默认启动参数（非 Linux？/proc 不可用？）');
  } finally {
    await probe.close();
  }
}

/** 手动 spawn Chrome：Playwright 默认参数全集 + 远程调试端口（替换 --remote-debugging-pipe） */
function spawnChrome(bin: string, chromeArgs: string[], logPath: string): ChildProcess {
  const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
  // 与 perfS0Profile.stripProxyEnv 同口径：代理 env 会劫持站点直连
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete spawnEnv[key];
  }
  const fd = fs.openSync(logPath, 'a');
  const child = spawn(bin, chromeArgs, {
    env: spawnEnv,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  return child;
}

export async function launchRealVisibilityContext(
  options: ExtensionHarnessOptions,
  launchOptions: LaunchExtensionContextOptions = {},
): Promise<RealVisibilityLaunch> {
  // 1) 探测 Playwright 默认参数全集（探针浏览器，用完即关）
  const argv = await probePlaywrightDefaultArgs(options, launchOptions);
  const bin = argv[0];
  const chromeArgs = argv
    .slice(1)
    .flatMap((a) => (a === '--remote-debugging-pipe' ? [`--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*'] : [a]));

  // 2) 手动启动 Chrome（同一 user-data-dir，扩展/会话数据与 harness 口径一致）
  const logDir = path.dirname(options.userDataDir);
  const chrome = spawnChrome(bin, chromeArgs, path.join(logDir, 'cdp-chrome.log'));
  const chromePid = chrome.pid;
  if (!chromePid) throw new Error('Chrome 启动失败（拿不到 pid）');

  const cleanupChrome = async (): Promise<void> => {
    for (let i = 0; i < 25 && isPidAlive(chromePid); i += 1) await sleep(400);
    try { process.kill(-chromePid, 'SIGKILL'); } catch { /* 已退出或非组长 */ }
    try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ }
  };

  let browser: Browser | null = null;
  let proxy: ChildProcess | null = null;
  try {
    await waitHttpJson(`http://127.0.0.1:${CDP_PORT}/json/version`, 50, 'Chrome CDP');

    // 3) 起 CDP 代理（改写 focusEmulation）
    proxy = spawn(process.execPath, [path.join(import.meta.dirname, 'cdpVisibilityProxy.mjs')], {
      env: {
        ...process.env,
        VIS_CDP_UPSTREAM_PORT: String(CDP_PORT),
        VIS_CDP_HTTP_PORT: String(PROXY_HTTP_PORT),
        VIS_CDP_WS_PORT: String(PROXY_WS_PORT),
      },
      stdio: ['ignore', fs.openSync(path.join(logDir, 'cdp-proxy.log'), 'a'), fs.openSync(path.join(logDir, 'cdp-proxy.log'), 'a')],
      detached: true,
    });
    proxy.unref();
    await waitHttpJson(`http://127.0.0.1:${PROXY_HTTP_PORT}/json/version`, 25, 'CDP 代理');

    // 4) connectOverCDP（走代理端口，webSocketDebuggerUrl 的 host:port 换到代理）
    const proxied = await waitHttpJson(`http://127.0.0.1:${PROXY_HTTP_PORT}/json/version`, 5, 'CDP 代理(二次)');
    const wsUrl = (proxied.webSocketDebuggerUrl ?? '').replace(`127.0.0.1:${CDP_PORT}`, `127.0.0.1:${PROXY_WS_PORT}`);
    if (!wsUrl) throw new Error(`代理未返回 webSocketDebuggerUrl：${JSON.stringify(proxied)}`);
    browser = await chromium.connectOverCDP(wsUrl);
    const context = browser.contexts()[0];
    if (!context) throw new Error('connectOverCDP 后拿不到 default context');

    const cleanup = async (): Promise<void> => {
      try { await withTimeout(browser!.close(), 8_000, 'browser.close'); } catch { /* 已断开 */ }
      await cleanupChrome();
      if (proxy) { try { proxy.kill('SIGKILL'); } catch { /* 已退出 */ } }
    };
    return { context, browser, cleanup };
  } catch (e) {
    // 失败兜底：先关浏览器再杀 Chrome 进程组、杀代理，然后原样抛出
    // （不用 async helper：TS 对 await never 的 CFA 收窄不可靠，显式 throw 最稳）
    if (browser) { try { await withTimeout(browser.close(), 5_000, 'browser.close'); } catch { /* 已断开 */ } }
    await cleanupChrome();
    if (proxy) { try { proxy.kill('SIGKILL'); } catch { /* 已退出 */ } }
    throw e;
  }
}
