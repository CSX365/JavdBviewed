/**
 * @vitest-environment jsdom
 */
/**
 * S1-2a：superRankingNav MutationObserver 早退 + FC2 链接改写计数门。
 *
 * 背景：observer 挂在 documentElement 上，列表增强爆发期每批 DOM 变更都会触发
 * applySuperRankingNav（全文档扫 navbar + 逐链接 textContent 读）+ rewriteNativeFc2Links
 * （全量扫 .tabs/.navbar 锚点并逐个读 textContent），是 16 tab 长帧的放大器之一。
 *
 * 契约：
 * 1. 导航增强对 MPA 静态 navbar 只完整跑一次，之后 mutation 不再触发 navbar 全文档扫描；
 * 2. FC2 改写按锚点数量做门：数量不变跳过全量扫描，数量变化（新链接加入）触发重扫并改写新链接；
 * 3. destroy 后重新 initialize 状态重置，完整重跑（开关重新启用语义不变）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SUPER_RANKING_FC2_URL,
  SUPER_RANKING_ITEMS,
  destroySuperRankingNav,
  initializeSuperRankingNav,
} from './superRankingNav';

const NAV_SELECTOR = '.navbar-item.has-dropdown';

function buildNavbar(): void {
  const nav = document.createElement('nav');
  nav.className = 'navbar';
  nav.innerHTML = `
    <div class="navbar-item has-dropdown">
      <a class="navbar-link" href="/rankings/movies?p=daily&t=censored">排行榜</a>
      <div class="navbar-dropdown">
        <a class="navbar-item" href="/rankings/movies?p=daily&t=censored">有碼</a>
      </div>
    </div>
  `;
  document.body.appendChild(nav);
}

function buildFc2Tabs(): HTMLElement {
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  tabs.innerHTML = `
    <a href="/tags?c10=1">有碼</a>
    <a href="/tags/uncensored?c10=1">無碼</a>
    <a href="/tags/fc2?c10=1">FC2</a>
  `;
  document.body.appendChild(tabs);
  return tabs;
}

const flushMicrotasks = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('superRankingNav 早退与计数门（S1-2a）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    buildNavbar();
    buildFc2Tabs();
    vi.spyOn(Document.prototype, 'querySelectorAll');
  });

  afterEach(() => {
    destroySuperRankingNav();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  const countNavScans = (): number => {
    let count = 0;
    (vi.mocked(Document.prototype.querySelectorAll).mock.calls).forEach((call) => {
      if (String(call[0]) === NAV_SELECTOR) count += 1;
    });
    return count;
  };

  const getRankingLink = (): HTMLAnchorElement =>
    document.querySelector<HTMLAnchorElement>('.navbar-item.has-dropdown .navbar-link')!;

  it('导航增强完成后，DOM 变更不再触发 navbar 全文档扫描', async () => {
    initializeSuperRankingNav('javdb.com');

    // 应用成功：标题替换 + 下拉 7 项
    expect(getRankingLink().querySelector('.jdb-super-ranking-title')?.textContent).toBe('超级排行榜');
    expect(document.querySelectorAll('.jdb-super-ranking-item').length).toBe(SUPER_RANKING_ITEMS.length);

    const scansAfterInit = countNavScans();
    expect(scansAfterInit).toBeGreaterThanOrEqual(1);

    // 模拟列表增强爆发期的一次 DOM 变更
    document.body.appendChild(document.createElement('div'));
    await flushMicrotasks();

    // 早退生效：没有新的 navbar 扫描
    expect(countNavScans()).toBe(scansAfterInit);
  });

  it('FC2 改写计数门：锚点数量不变跳过扫描，数量变化触发重扫并改写新链接', async () => {
    initializeSuperRankingNav('javdb.com');

    const tabs = document.querySelector('.tabs')!;
    const originalFc2 = tabs.querySelectorAll<HTMLAnchorElement>('a')[2];
    expect(originalFc2.getAttribute('href')).toBe(SUPER_RANKING_FC2_URL);
    expect(originalFc2.dataset.jdbSuperRankingOriginalFc2Href).toBe('/tags/fc2?c10=1');

    // 锚点数量不变的 DOM 变更：已改写链接保持不动
    tabs.appendChild(document.createElement('span'));
    await flushMicrotasks();
    expect(originalFc2.getAttribute('href')).toBe(SUPER_RANKING_FC2_URL);

    // 新增一个 FC2 锚点（数量 +1）：触发重扫，新链接被改写
    const newFc2 = document.createElement('a');
    // setAttribute 保持原始相对 href（.href 赋值会被 jsdom 解析成绝对 URL）
    newFc2.setAttribute('href', '/tags/fc2?c10=2');
    newFc2.textContent = 'FC2';
    tabs.appendChild(newFc2);
    await flushMicrotasks();
    expect(newFc2.getAttribute('href')).toBe(SUPER_RANKING_FC2_URL);
    expect(newFc2.dataset.jdbSuperRankingOriginalFc2Href).toBe('/tags/fc2?c10=2');
  });

  it('destroy 后重新 initialize 完整重跑（状态重置）', async () => {
    initializeSuperRankingNav('javdb.com');
    expect(getRankingLink().querySelector('.jdb-super-ranking-title')).not.toBeNull();

    destroySuperRankingNav();
    // destroy 恢复原始标记
    expect(getRankingLink().getAttribute('href')).toBe('/rankings/movies?p=daily&t=censored');
    expect(getRankingLink().querySelector('.jdb-super-ranking-title')).toBeNull();

    initializeSuperRankingNav('javdb.com');
    expect(getRankingLink().querySelector('.jdb-super-ranking-title')?.textContent).toBe('超级排行榜');
    expect(document.querySelectorAll('.jdb-super-ranking-item').length).toBe(SUPER_RANKING_ITEMS.length);
    const tabsFc2 = document.querySelector('.tabs')!.querySelectorAll<HTMLAnchorElement>('a')[2];
    expect(tabsFc2.getAttribute('href')).toBe(SUPER_RANKING_FC2_URL);
  });
});
