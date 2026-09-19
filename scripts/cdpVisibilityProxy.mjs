/**
 * CDP 代理（S1-2 --real-visibility 专用）
 *
 * 在 Playwright 与 Chrome 的 DevTools 之间做 HTTP(/json*) + WebSocket 双向转发，
 * 并把出方向（Playwright→Chrome）的 `Emulation.setFocusEmulationEnabled {enabled:true}`
 * 改写为 `{enabled:false}` —— Playwright 默认会给每个 page 开「焦点模拟」，导致所有 tab
 * 的 document.visibilityState 恒为 visible；关掉后页面按真实窗口/tab 状态上报
 * （active=visible / 后台=hidden，visibilitychange 为真实事件），viewport 等其他
 * 默认值不受影响。
 *
 * 端口（环境变量可覆盖）：
 *   VIS_CDP_UPSTREAM_PORT  Chrome 的 --remote-debugging-port（默认 9555）
 *   VIS_CDP_HTTP_PORT      代理 HTTP /json 转发（默认 9556）
 *   VIS_CDP_WS_PORT        代理 WS 转发（默认 9557）
 *
 * 注意：CDP 帧必须以文本发送（binary:false），二进制帧会被 Chrome 静默丢弃。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** ws 不在根 node_modules（pnpm 布局），从虚拟存储里找（优先 playwright-core 依赖的同版本树） */
async function resolveWsModule() {
  const root = path.resolve(import.meta.dirname, '..');
  const pnpmDir = path.join(root, 'node_modules', '.pnpm');
  const candidates = [];
  if (fs.existsSync(pnpmDir)) {
    for (const entry of fs.readdirSync(pnpmDir)) {
      if (entry.startsWith('playwright-core@') || entry.startsWith('ws@')) {
        const p = path.join(pnpmDir, entry, 'node_modules', 'ws');
        if (fs.existsSync(path.join(p, 'index.js'))) candidates.push(p);
      }
    }
  }
  candidates.push(path.join(root, 'node_modules', 'ws'));
  const found = candidates.find((p) => fs.existsSync(path.join(p, 'index.js')));
  if (!found) throw new Error('找不到 ws 模块（CDP 代理依赖）：node_modules/.pnpm 下无 playwright-core@*/ws 或 ws@*/ws');
  return import(pathToFileURL(path.join(found, 'index.js')).href);
}

// ws 是 CJS 包：命名导出在 ESM 互操作下不可靠（实测只有 default），
// WebSocketServer 挂在 default 导出（WebSocket 类）的 Server/WebSocketServer 属性上
const wsMod = await resolveWsModule();
const WebSocket = wsMod.default ?? wsMod;
const WebSocketServer = WebSocket.WebSocketServer ?? WebSocket.Server;

const UP = Number(process.env.VIS_CDP_UPSTREAM_PORT ?? 9555);
const HTTP_PORT = Number(process.env.VIS_CDP_HTTP_PORT ?? 9556);
const WS_PORT = Number(process.env.VIS_CDP_WS_PORT ?? 9557);
let rewrites = 0;

const httpServer = http.createServer(async (req, res) => {
  try {
    const upstream = await (await fetch(`http://127.0.0.1:${UP}${req.url}`)).text();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(upstream);
  } catch (e) {
    res.writeHead(502);
    res.end(String(e));
  }
});
httpServer.on('error', (e) => { console.log(`[cdp-proxy] HTTP 端口占用/启动失败: ${e.message}`); process.exit(1); });
httpServer.listen(HTTP_PORT, '127.0.0.1');

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });
wss.on('error', (e) => { console.log(`[cdp-proxy] WS 端口占用/启动失败: ${e.message}`); process.exit(1); });
wss.on('listening', () => console.log(`[cdp-proxy] READY up=${UP} http=${HTTP_PORT} ws=${WS_PORT}`));

wss.on('connection', (client, req) => {
  console.log(`[cdp-proxy] client ${req.url}`);
  console.log(`[cdp-proxy] dialing upstream ws://127.0.0.1:${UP}${req.url}`);
  const upstream = new WebSocket(`ws://127.0.0.1:${UP}${req.url}`, { perMessageDeflate: false });
  let bridged = false;
  const pending = []; // 竞态窗口缓冲：Playwright 连上代理即可能发首帧（Browser.getVersion），
  // 早于 upstream open 到达的帧必须先缓存，否则 connectOverCDP 握手超时
  const sendUp = (text) => {
    let out = text;
    try {
      const m = JSON.parse(text);
      if (m.method === 'Emulation.setFocusEmulationEnabled' && m.params && m.params.enabled === true) {
        m.params.enabled = false;
        out = JSON.stringify(m);
        rewrites += 1;
        console.log(`[cdp-proxy] REWRITE setFocusEmulationEnabled true->false (第 ${rewrites} 次)`);
      }
    } catch { /* 非 JSON 帧原样转发 */ }
    try { upstream.send(out, { binary: false }); } catch {}
  };
  client.on('message', (d) => {
    const text = d.toString();
    if (!bridged) { pending.push(text); return; }
    sendUp(text);
  });
  upstream.on('open', () => {
    bridged = true;
    console.log(`[cdp-proxy] upstream OPEN，冲刷缓冲 ${pending.length} 帧`);
    for (const t of pending.splice(0)) sendUp(t);
    upstream.on('message', (d) => { try { client.send(d.toString(), { binary: false }); } catch {} });
  });
  upstream.on('error', (e) => console.log(`[cdp-proxy] upstream error: ${e.message}`));
  upstream.on('unexpected-response', (_rq, rs) => console.log(`[cdp-proxy] upstream HTTP ${rs.statusCode}`));
  upstream.on('close', (c, r) => console.log(`[cdp-proxy] upstream close ${c} ${r.toString()} bridged=${bridged} rewrites=${rewrites}`));
  client.on('close', () => { try { upstream.terminate(); } catch {} });
  client.on('error', () => {});
});
