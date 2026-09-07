/**
 * @file embyEnhancementScanBudget.test.ts
 * @description B6 调度算法性能预算：embyEnhancement「300ms 脏区合并窗口」扫描次数与扫描范围量化。
 *   预算律（防回归，任何「性能优化」不得破坏）：
 *   - 扫描次数 ≤ mutation 窗口数（每个 300ms 窗至多 flush 一次）；旧算法 = 每次 mutation 各一次全 body 扫描。
 *   - 脏区扫描只遍历脏根子树（visited 节点数远小于全量）；
 *     仅当回退条件触发（单批 >400 新增节点 / >200 脏根 / body 级变更）才允许全量扫描，且仍只扫一次。
 *   注意：spy 必须原样透传 createTreeWalker 的 whatToShow/filter 参数，
 *   否则 jsdom 会按 SHOW_ALL 遍历元素节点，遍历量统计失真。
 * @module tests/dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATE } from '../../apps/extension/src/features/contentState';
import { embyEnhancementManager } from '../../apps/extension/src/features/embyEnhancement/content';
import { DEFAULT_SETTINGS } from '../../apps/extension/src/utils/config';

type TreeWalkerFactory = (root: Node, whatToShow?: number, filter?: NodeFilter | null) => TreeWalker;

interface WalkCall {
  root: Node;
  visited: number;
}

let walkerCalls: WalkCall[] = [];
let walkerSpy: ReturnType<typeof vi.spyOn> | null = null;
/** 绕过 spy 的原始 TreeWalker 工厂（基准测量用，避免污染 walkerCalls） */
let originalCreateTreeWalker: TreeWalkerFactory | null = null;

function setEmbySettings(): void {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.emby = {
    ...settings.emby,
    enabled: true,
    recognitionEnabled: true,
    matchUrls: ['*'],
    mediaServers: [],
    videoCodePatterns: [],
    linkBehavior: 'javdb-search',
    enableAutoDetection: true,
    highlightStyle: {
      backgroundColor: '#fff3cd',
      color: '#856404',
      borderRadius: '3px',
      padding: '2px 4px',
    },
    showQuickSearchCode: false,
    showQuickSearchActor: false,
  };
  settings.searchEngines = [
    { id: 'javdb', name: 'JavDB', urlTemplate: 'https://javdb.com/search?q={{ID}}', icon: '' },
  ];
  STATE.settings = settings;
  STATE.records = {};
}

function installWalkerSpy(): void {
  walkerCalls = [];
  originalCreateTreeWalker = document.createTreeWalker.bind(document) as unknown as TreeWalkerFactory;
  const original = originalCreateTreeWalker;
  walkerSpy = vi.spyOn(document, 'createTreeWalker').mockImplementation(((root: Node, whatToShow?: number, filter?: NodeFilter | null) => {
    // 必须透传 whatToShow/filter：产品代码以 SHOW_TEXT + acceptNode 扫描
    const walker = original(root, whatToShow, filter);
    const originalNext = walker.nextNode.bind(walker);
    const call: WalkCall = { root, visited: 0 };
    walkerCalls.push(call);
    // 只统计真正访问到的节点（null 终止调用不计入遍历量）
    walker.nextNode = (): Node | null => {
      const node = originalNext();
      if (node !== null) call.visited += 1;
      return node;
    };
    return walker;
  }) as unknown as typeof document.createTreeWalker);
}

/** body 内文本节点总数（全量扫描的遍历量基准；走原始工厂，不经过 spy） */
function countBodyTextNodes(): number {
  const walker = (originalCreateTreeWalker as TreeWalkerFactory)(document.body, NodeFilter.SHOW_TEXT);
  let count = 0;
  while (walker.nextNode()) count += 1;
  return count;
}

describe('embyEnhancement dirty-region scan budget (B6 调度性能预算)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setEmbySettings();
    document.body.innerHTML = '';
    installWalkerSpy();
  });

  afterEach(() => {
    embyEnhancementManager.destroy();
    walkerSpy?.mockRestore();
    walkerSpy = null;
    vi.useRealTimers();
    STATE.settings = null;
    STATE.records = {};
    STATE.embyLibraryState = null;
    document.body.innerHTML = '';
  });

  it('单窗口内 50 次连续追加 = 1 次脏区扫描（旧算法 = 50 次全 body 扫描）', async () => {
    await embyEnhancementManager.initialize();
    const baseline = walkerCalls.length;
    walkerCalls = walkerCalls.slice(baseline);

    const slot = document.createElement('div');
    document.body.appendChild(slot);
    for (let i = 0; i < 50; i += 1) {
      const item = document.createElement('div');
      item.textContent = i === 0 ? 'SDD-456' : `plain item ${i}`;
      slot.appendChild(item);
    }

    await vi.advanceTimersByTimeAsync(350);

    // 预算律：窗口内任意多次 mutation 至多 1 次扫描
    expect(walkerCalls.length).toBe(1);
    // 扫描范围 = 脏根子树，不是 body
    expect(walkerCalls[0].root).toBe(slot);
    // 行为不回退：脏区里的番号仍被链接化
    expect(slot.querySelector('.emby-video-link')?.textContent).toBe('SDD-456');
  });

  it('20 个窗口 = 20 次扫描（每次至多 1 次，不多扫）', async () => {
    await embyEnhancementManager.initialize();
    walkerCalls = walkerCalls.slice(walkerCalls.length);

    const slot = document.createElement('div');
    document.body.appendChild(slot);
    const items: Element[] = [];
    for (let windowIndex = 0; windowIndex < 20; windowIndex += 1) {
      const item = document.createElement('div');
      item.textContent = `batch ${windowIndex}`;
      slot.appendChild(item);
      items.push(item);
      await vi.advanceTimersByTimeAsync(400); // 300ms 窗 + 余量
    }

    // 预算律：每窗口至多 1 次扫描，不多扫
    expect(walkerCalls.length, '每窗口至多 1 次扫描').toBe(20);
    // 扫描根永远是脏区：首窗的顶层脏根是 slot 自身（slot 与 item0 同回调入队，slot 包含 item0），
    // 后续窗口的顶层脏根就是当窗追加的 item 本身；任何一窗都不允许全 body 扫描
    const allowedRoots = new Set<Node>([slot, ...items]);
    for (const call of walkerCalls) {
      expect(call.root, '不得回退全 body 扫描').not.toBe(document.body);
      expect(allowedRoots.has(call.root), '扫描根必须是 slot 或当窗追加项').toBe(true);
    }
  });

  it('脏区扫描遍历量 < 全量扫描遍历量（同一 DOM）', async () => {
    // 既有 30 个已处理条目（init 全量扫描过）+ 1 个脏区 slot
    for (let i = 0; i < 30; i += 1) {
      const el = document.createElement('div');
      el.textContent = `existing ${i}`;
      document.body.appendChild(el);
    }
    const slot = document.createElement('div');
    document.body.appendChild(slot);

    await embyEnhancementManager.initialize();
    walkerCalls = walkerCalls.slice(walkerCalls.length);

    const bodyTextNodes = countBodyTextNodes() + 2; // +wrapper 内即将追加的 2 个文本
    const wrapper = document.createElement('div');
    const a = document.createElement('div');
    a.textContent = 'New HDF-101';
    wrapper.appendChild(a);
    const b = document.createElement('div');
    b.textContent = 'plain sibling';
    wrapper.appendChild(b);
    slot.appendChild(wrapper); // 一次 append = 一个顶层脏根 = 一次脏区扫描

    await vi.advanceTimersByTimeAsync(350);

    expect(walkerCalls.length).toBe(1);
    const dirty = walkerCalls[0];
    expect(dirty.root).toBe(wrapper);
    expect(dirty.visited, '脏区遍历量应仅覆盖 wrapper 内 2 个文本节点').toBe(2);
    expect(dirty.visited).toBeLessThan(bodyTextNodes);
    expect(slot.querySelector('.emby-video-link')?.textContent).toBe('HDF-101');
  });

  it('单批 >400 新增节点回退全量扫描，但只扫一次（旧语义保持）', async () => {
    await embyEnhancementManager.initialize();
    walkerCalls = walkerCalls.slice(walkerCalls.length);

    // 同一同步块直接向 body 连 append 450 个元素：同一 MutationObserver 回调内
    // addedNodes=450 > MAX_ADDED_NODES_FOR_DIRTY_SCAN(400)，才真正触发全量回退
    for (let i = 0; i < 450; i += 1) {
      const el = document.createElement('div');
      el.textContent = i === 10 ? 'SDD-777' : `bulk ${i}`;
      document.body.appendChild(el);
    }

    await vi.advanceTimersByTimeAsync(350);

    expect(walkerCalls.length, '回退全量也只得一次扫描').toBe(1);
    expect(walkerCalls[0].root).toBe(document.body);
    expect(document.body.querySelector('.emby-video-link')?.textContent).toBe('SDD-777');
  });

  it('>200 个脏根回退全量扫描，且只扫一次', async () => {
    await embyEnhancementManager.initialize();
    walkerCalls = walkerCalls.slice(walkerCalls.length);

    for (let i = 0; i < 201; i += 1) {
      const el = document.createElement('div');
      el.textContent = `root ${i}`;
      document.body.appendChild(el);
    }

    await vi.advanceTimersByTimeAsync(350);

    expect(walkerCalls.length).toBe(1);
    expect(walkerCalls[0].root).toBe(document.body);
  });
});
