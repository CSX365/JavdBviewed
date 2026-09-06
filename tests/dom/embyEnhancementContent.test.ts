/**
 * @file embyEnhancementContent.test.ts
 * @description Emby/Jellyfin 页面增强内容识别测试
 * @module tests/dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STATE } from '../../apps/extension/src/features/contentState';
import { embyEnhancementManager } from '../../apps/extension/src/features/embyEnhancement/content';
import { DEFAULT_SETTINGS } from '../../apps/extension/src/utils/config';

function setEmbySettings(videoCodePatterns: string[] = []): void {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.emby = {
    ...settings.emby,
    enabled: true,
    recognitionEnabled: true,
    matchUrls: ['*'],
    mediaServers: [],
    videoCodePatterns,
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
    {
      id: 'javdb',
      name: 'JavDB',
      urlTemplate: 'https://javdb.com/search?q={{ID}}',
      icon: '',
    },
  ];
  STATE.settings = settings;
  STATE.records = {};
}

function appendTextContainer(text: string): HTMLElement {
  const container = document.createElement('div');
  container.textContent = text;
  document.body.appendChild(container);
  return container;
}

describe('emby enhancement content recognition', () => {
  beforeEach(() => {
    setEmbySettings();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  afterEach(() => {
    embyEnhancementManager.destroy();
    STATE.settings = null;
    STATE.records = {};
    STATE.embyLibraryState = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('uses shared extraction to link standard and FC2 codes without custom patterns', async () => {
    appendTextContainer('Playlist includes ABC-123 and FC2PPV4903984');

    await embyEnhancementManager.initialize();

    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('.emby-video-link'));
    expect(links.map(link => link.textContent)).toEqual(['ABC-123', 'FC2-PPV-4903984']);
    expect(links[0]?.href).toBe('https://javdb.com/search?q=ABC-123');
    expect(links[1]?.href).toBe('https://javdb.com/search?q=FC2-PPV-4903984');
  });

  it('keeps configured videoCodePatterns as a fallback', async () => {
    setEmbySettings(['CUSTOM-\\d+']);
    appendTextContainer('Local title CUSTOM-998');

    await embyEnhancementManager.initialize();

    const link = document.querySelector<HTMLAnchorElement>('.emby-video-link');
    expect(link?.textContent).toBe('CUSTOM-998');
    expect(link?.href).toBe('https://javdb.com/search?q=CUSTOM-998');
  });

  it('does not parse page text as HTML while injecting links', async () => {
    const container = appendTextContainer('Unsafe text <img src=x onerror=alert(1)> ABC-123');

    await embyEnhancementManager.initialize();

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.querySelector('.emby-video-link')?.textContent).toBe('ABC-123');
  });

  it('does not duplicate links when refreshed after processing', async () => {
    appendTextContainer('Duplicate guard ABC-123');

    await embyEnhancementManager.initialize();
    await embyEnhancementManager.refresh();

    const links = document.querySelectorAll('.emby-video-link');
    expect(links).toHaveLength(1);
  });
});

describe('emby enhancement mutation dirty-region scan (B1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setEmbySettings();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    embyEnhancementManager.destroy();
    vi.useRealTimers();
    STATE.settings = null;
    STATE.records = {};
    STATE.embyLibraryState = null;
    document.body.innerHTML = '';
  });

  it('links small dynamic append via dirty-region scan without duplicating existing links', async () => {
    appendTextContainer('Existing ABC-123');

    await embyEnhancementManager.initialize();
    expect(document.querySelectorAll('.emby-video-link')).toHaveLength(1);

    const slot = document.createElement('div');
    document.body.appendChild(slot);
    const item = document.createElement('div');
    item.textContent = 'Appended SDD-456';
    slot.appendChild(item);

    // 脏区扫描为延迟合并执行（300ms 窗口）
    await vi.advanceTimersByTimeAsync(350);

    expect(slot.querySelector('.emby-video-link')?.textContent).toBe('SDD-456');
    expect(document.querySelectorAll('.emby-video-link')).toHaveLength(2);
  });

  it('does not re-link code text appended directly under an already-processed element (parity with old full scan)', async () => {
    const container = appendTextContainer('Existing ABC-123');

    await embyEnhancementManager.initialize();
    expect(container.querySelectorAll('.emby-video-link')).toHaveLength(1);

    // 已处理元素下直接追加文本节点：旧版全量扫描同样按 processedElements 跳过
    container.appendChild(document.createTextNode('Appended SDD-456'));

    await vi.advanceTimersByTimeAsync(350);

    expect(container.querySelectorAll('.emby-video-link')).toHaveLength(1);
  });

  it('links SPA text replacement (old text node removed, new one appended)', async () => {
    const item = document.createElement('div');
    item.textContent = 'No code initially';
    document.body.appendChild(item);

    await embyEnhancementManager.initialize();
    expect(document.querySelectorAll('.emby-video-link')).toHaveLength(0);

    // 等价于 SPA 文案刷新：旧文本节点被移除、新文本节点追加
    item.textContent = 'Updated HDF-789';

    await vi.advanceTimersByTimeAsync(350);

    expect(item.querySelector('.emby-video-link')?.textContent).toBe('HDF-789');
  });

  it('falls back to a full-body scan on bulk re-render and still links new codes', async () => {
    appendTextContainer('Existing ABC-123');

    await embyEnhancementManager.initialize();
    expect(document.querySelectorAll('.emby-video-link')).toHaveLength(1);

    const bulk = document.createElement('div');
    for (let i = 0; i < 450; i += 1) {
      const el = document.createElement('div');
      el.textContent = i === 10 ? `SDD-${456 + i}` : `Plain item ${i}`;
      bulk.appendChild(el);
    }
    document.body.appendChild(bulk);

    await vi.advanceTimersByTimeAsync(350);

    expect(bulk.querySelectorAll('.emby-video-link')).toHaveLength(1);
    expect(bulk.querySelector('.emby-video-link')?.textContent).toBe('SDD-466');
    expect(document.querySelectorAll('.emby-video-link')).toHaveLength(2);
  });

  it('does not duplicate links when a processed element is removed and re-appended', async () => {
    const item = document.createElement('div');
    item.textContent = 'Movable ABC-900';
    const holder = document.createElement('section');
    holder.appendChild(item);
    document.body.appendChild(holder);

    await embyEnhancementManager.initialize();
    expect(document.querySelectorAll('.emby-video-link')).toHaveLength(1);

    const link = item.querySelector('.emby-video-link');
    expect(link).not.toBeNull();

    item.remove();
    holder.appendChild(item);

    await vi.advanceTimersByTimeAsync(350);

    expect(link?.isConnected).toBe(true);
    expect(document.querySelectorAll('.emby-video-link')).toHaveLength(1);
  });

  it('stops processing after destroy even if a mutation was pending', async () => {
    appendTextContainer('Existing ABC-123');

    await embyEnhancementManager.initialize();

    const slot = document.createElement('div');
    document.body.appendChild(slot);
    slot.textContent = 'Appended SDD-456';

    embyEnhancementManager.destroy();
    await vi.advanceTimersByTimeAsync(500);

    expect(slot.querySelector('.emby-video-link')).toBeNull();
  });
});
