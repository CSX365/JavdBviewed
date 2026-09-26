/**
 * @file siteAdRemoval.test.ts
 * @description 去除原站广告：DOM 行为（开关两态）+ 磁力解耦回归
 * @module tests/dom
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { applySiteAdRemoval, removePromoButtons } from '../../apps/extension/src/features/siteAdRemoval';
import {
  injectMagnetSourceTagStyles,
  injectUnifiedMagnetListStyles,
} from '../../apps/extension/src/features/magnets/ui/magnetStyles';
import { MagnetSearchManager } from '../../apps/extension/src/features/magnets';

const STYLE_ID = 'x-javdb-site-ad-removal';

function seedDetailPage() {
  document.body.innerHTML = `
    <div class="top-meta">
      <span class="tags">标签</span>
      <div class="moj-content">推广位内容</div>
    </div>
    <article class="message video-panel">
      <div class="moj-content">面板推广位</div>
    </article>
    <div class="sub-header">顶部广告栏</div>
    <div class="app-desktop-banner"><div class="container">桌面App推广</div></div>
    <a href="https://app.javdb.com/download">官方App下载</a>
    <a href="https://t.me/javdbnews">JavDB公告频道</a>
    <a href="https://javdb.com/v/YwzWNz">普通链接</a>
  `;
}

describe('siteAdRemoval DOM 行为', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('主开关开：注入命名空间样式，.moj-content 计算样式 display:none，推广按钮被移除', () => {
    seedDetailPage();
    applySiteAdRemoval({ enabled: true, removePromoButtons: true, removeExtraAds: false });

    const style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    expect(style).toBeTruthy();
    expect(style!.textContent).toContain('.moj-content');
    expect(style!.textContent).toContain('display: none !important');

    const moj = document.querySelectorAll<HTMLElement>('.moj-content');
    expect(moj.length).toBe(2);
    moj.forEach(el => expect(getComputedStyle(el).display).toBe('none'));

    // 推广按钮（文字匹配）被 JS 移除；普通链接保留
    expect(document.querySelector('a[href="https://app.javdb.com/download"]')).toBeNull();
    expect(document.querySelector('a[href="https://t.me/javdbnews"]')).toBeNull();
    expect(document.querySelector('a[href="https://javdb.com/v/YwzWNz"]')).toBeTruthy();

    // 额外广告位默认关：仍可见
    expect(getComputedStyle(document.querySelector<HTMLElement>('.sub-header')!).display).not.toBe('none');
  });

  it('主开关关：不注入样式、不移除任何节点（DOM 原样）', () => {
    seedDetailPage();
    applySiteAdRemoval({ enabled: false, removePromoButtons: true, removeExtraAds: true });

    expect(document.getElementById(STYLE_ID)).toBeNull();
    const moj = document.querySelectorAll<HTMLElement>('.moj-content');
    expect(moj.length).toBe(2);
    expect(document.querySelector('a[href="https://app.javdb.com/download"]')).toBeTruthy();
  });

  it('removeExtraAds 开：.sub-header 与 .app-desktop-banner 被隐藏', () => {
    seedDetailPage();
    applySiteAdRemoval({ enabled: true, removePromoButtons: false, removeExtraAds: true });

    expect(getComputedStyle(document.querySelector<HTMLElement>('.sub-header')!).display).toBe('none');
    expect(getComputedStyle(document.querySelector<HTMLElement>('.app-desktop-banner')!).display).toBe('none');
    expect(getComputedStyle(document.querySelector<HTMLElement>('.moj-content')!).display).toBe('none');
  });

  it('重复调用幂等：只存在一条命名空间样式', () => {
    seedDetailPage();
    applySiteAdRemoval({ enabled: true, removePromoButtons: true, removeExtraAds: true });
    applySiteAdRemoval({ enabled: true, removePromoButtons: true, removeExtraAds: false });

    const styles = document.querySelectorAll(`style#${STYLE_ID}`);
    expect(styles.length).toBe(1);
  });

  it('removePromoButtons 只移除推广按钮，不误伤其他节点', () => {
    document.body.innerHTML = `
      <a href="https://example.com/app.javdb.backup">非推广链接（href 含 app.javdb 但无推广文案）</a>
      <button>官方App按钮（非 a 标签，不应触碰）</button>
    `;
    removePromoButtons();
    expect(document.body.querySelectorAll('a').length).toBe(1);
    expect(document.body.querySelector('button')).toBeTruthy();
  });
});

describe('磁力功能退出去广告职责（解耦回归）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('磁力样式注入不再包含 .moj-content 隐藏逻辑', () => {
    injectMagnetSourceTagStyles();
    injectUnifiedMagnetListStyles();

    const allStyles = Array.from(document.querySelectorAll('style'))
      .map(s => s.textContent || '')
      .join('\n');
    expect(allStyles).not.toContain('jdb-hidden-moj-content');
    expect(allStyles).not.toContain('moj-content[style');
  });

  it('MagnetSearchManager 默认配置不再含 blockMojContent 字段', () => {
    const manager = new MagnetSearchManager() as any;
    expect(manager.config).toBeDefined();
    expect(manager.config).not.toHaveProperty('blockMojContent');
  });
});
