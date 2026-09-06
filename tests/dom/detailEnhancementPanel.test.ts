/**
 * @file detailEnhancementPanel.test.ts
 * @description 详情页增强承载容器：锚点定位、幂等创建、inner 重建防御、插入目标判定。
 * @module tests/dom
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureDetailEnhancementPanel,
  findDetailEnhancementInsertionTarget,
} from '../../apps/extension/src/features/detailEnhancementPanel';

const PANEL_ID = 'jdb-detail-enhancement-panel';
const STYLES_ID = 'jdb-detail-enhancement-panel-styles';
const INNER_CLASS = 'jdb-detail-enhancement-panel-inner';

function createDetailAnchor(): HTMLElement {
  const columns = document.createElement('div');
  columns.className = 'columns is-desktop';

  const coverColumn = document.createElement('div');
  coverColumn.className = 'column';
  const cover = document.createElement('div');
  cover.className = 'column-video-cover';
  coverColumn.appendChild(cover);

  const infoColumn = document.createElement('div');
  infoColumn.className = 'column';
  const info = document.createElement('div');
  info.className = 'movie-panel-info';
  infoColumn.appendChild(info);

  columns.append(coverColumn, infoColumn);
  document.body.appendChild(columns);
  return columns;
}

describe('detailEnhancementPanel 容器工具', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('页面缺少详情锚点时返回 null 且不创建容器', () => {
    document.body.innerHTML = '<div class="movie-list"></div>';
    expect(ensureDetailEnhancementPanel()).toBeNull();
    expect(document.getElementById(PANEL_ID)).toBeNull();
  });

  it('锚点存在时在锚点后创建容器与 inner，并注入一次样式', () => {
    const anchor = createDetailAnchor();
    const inner = ensureDetailEnhancementPanel();
    expect(inner).toBeInstanceOf(HTMLElement);
    expect(inner?.className).toContain(INNER_CLASS);

    const container = document.getElementById(PANEL_ID);
    expect(container).not.toBeNull();
    expect(container!.contains(inner)).toBe(true);
    expect(anchor.nextSibling).toBe(container);
    expect(document.getElementById(STYLES_ID)).not.toBeNull();
  });

  it('重复调用幂等：返回同一 inner，不重复创建容器与样式', () => {
    createDetailAnchor();
    const first = ensureDetailEnhancementPanel();
    const second = ensureDetailEnhancementPanel();
    expect(second).toBe(first);
    expect(document.querySelectorAll(`#${PANEL_ID}`).length).toBe(1);
    expect(document.querySelectorAll(`#${STYLES_ID}`).length).toBe(1);
  });

  it('inner 被外部移除时（防御）在既有容器内重建 inner', () => {
    createDetailAnchor();
    const first = ensureDetailEnhancementPanel();
    first!.remove();
    const rebuilt = ensureDetailEnhancementPanel();
    expect(rebuilt).not.toBe(first);
    expect(rebuilt).toBeInstanceOf(HTMLElement);
    expect(rebuilt!.className).toContain(INNER_CLASS);
    expect(document.querySelectorAll(`#${PANEL_ID}`).length).toBe(1);
  });

  it('findDetailEnhancementInsertionTarget：before 在 panel 内时透传，否则置 null', () => {
    createDetailAnchor();
    const panel = ensureDetailEnhancementPanel()!;
    const marker = document.createElement('div');
    panel.appendChild(marker);
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    expect(findDetailEnhancementInsertionTarget(marker)).toEqual({ parent: panel, before: marker });
    expect(findDetailEnhancementInsertionTarget(outside)).toEqual({ parent: panel, before: null });
    expect(findDetailEnhancementInsertionTarget(null)).toEqual({ parent: panel, before: null });
  });

  it('锚点缺失时 findDetailEnhancementInsertionTarget 返回 null', () => {
    document.body.innerHTML = '<div class="movie-list"></div>';
    expect(findDetailEnhancementInsertionTarget()).toBeNull();
  });
});
