// @vitest-environment jsdom
/**
 * S1-2a：processListItems per-card 同步段分块的行为契约。
 *
 * 背景：24 张卡片的 processItem 同步循环在 16 tab 争用下被拉伸成 0.3-2.4s 长帧（s6 实测）。
 * 分块后：首块（12 张）同步完成保证确定性，剩余块让出主线程（jsdom 无 rIC，走 setTimeout(0) 兜底）。
 * 行为不变量：全部卡片最终恰好处理一次、状态标签照常渲染、重复调用幂等。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STATE } from '../../contentState';
import { VIDEO_STATUS } from '../../../utils/config';
import { processListItems } from './itemProcessor';

function buildItem(code: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'item';
  item.innerHTML = `
    <a href="/v/${code}" class="box" title="${code} test title">
      <div class="video-title x-ellipsis x-title"><strong>${code}</strong> <span>test title</span></div>
      <div class="tags has-addons"></div>
    </a>
  `;
  return item;
}

const flushAsync = (ms = 20): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('processListItems 分块（S1-2a）', () => {
  const originalState = {
    settings: STATE.settings,
    records: STATE.records,
    recordSummaries: STATE.recordSummaries,
    isSearchPage: STATE.isSearchPage,
  };

  beforeEach(() => {
    STATE.settings = null;
    STATE.records = {};
    STATE.recordSummaries = {};
    STATE.isSearchPage = false;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    STATE.settings = originalState.settings;
    STATE.records = originalState.records;
    STATE.recordSummaries = originalState.recordSummaries;
    STATE.isSearchPage = originalState.isSearchPage;
  });

  it('24 张卡片：首块 12 张同步完成，其余块让出主线程后完成，行为不变', async () => {
    const list = document.createElement('div');
    list.className = 'movie-list';
    for (let i = 0; i < 24; i += 1) {
      const code = `TEST-${String(i).padStart(3, '0')}`;
      list.appendChild(buildItem(code));
      STATE.records[code] = {
        id: code,
        status: VIDEO_STATUS.VIEWED,
        tags: [],
        createdAt: 1,
        updatedAt: 1,
      };
    }
    document.body.appendChild(list);

    const items = Array.from(document.querySelectorAll<HTMLElement>('.movie-list .item'));
    processListItems(items);

    // 首块（12 张）同步完成
    expect(document.querySelectorAll('.item[data-processed]').length).toBe(12);
    // 首块的状态标签已渲染（行为不变）
    expect(document.querySelectorAll('.custom-status-tag').length).toBe(12);

    // 剩余块在主线程让出后完成（jsdom 无 rIC → setTimeout(0) 兜底）
    await flushAsync();
    expect(document.querySelectorAll('.item[data-processed]').length).toBe(24);
    expect(document.querySelectorAll('.custom-status-tag').length).toBe(24);

    // 每张卡的状态标签内容不变
    document.querySelectorAll<HTMLElement>('.item').forEach((item) => {
      const tag = item.querySelector<HTMLElement>('.custom-status-tag');
      expect(tag).not.toBeNull();
      expect(tag?.textContent).toBe('已观看');
    });

    // 幂等：重复调用不会二次处理、不会重复挂标签
    processListItems(items);
    await flushAsync();
    expect(document.querySelectorAll('.item[data-processed]').length).toBe(24);
    expect(document.querySelectorAll('.custom-status-tag').length).toBe(24);
  });

  it('单张/少张（observer 增量路径）保持同步一次性完成', async () => {
    const list = document.createElement('div');
    list.className = 'movie-list';
    for (let i = 0; i < 3; i += 1) {
      const code = `INC-${String(i).padStart(3, '0')}`;
      list.appendChild(buildItem(code));
      STATE.records[code] = {
        id: code,
        status: VIDEO_STATUS.WANT,
        tags: [],
        createdAt: 1,
        updatedAt: 1,
      };
    }
    document.body.appendChild(list);

    const items = Array.from(document.querySelectorAll<HTMLElement>('.movie-list .item'));
    processListItems(items);

    // 单块以内直接同步完成，无等待
    expect(document.querySelectorAll('.item[data-processed]').length).toBe(3);
    expect(document.querySelectorAll('.custom-status-tag').length).toBe(3);
    document.querySelectorAll<HTMLElement>('.item').forEach((item) => {
      expect(item.querySelector<HTMLElement>('.custom-status-tag')?.textContent).toBe('我想看');
    });
  });
});
