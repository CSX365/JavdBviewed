/**
 * @file settingsNavModel.test.ts
 * @description 设置导航目录纯函数测试
 * @module apps/dashboard/pages/settings
 */
import { describe, expect, it } from 'vitest';
import {
  filterSettingsNavItems,
  resolveSettingsSubpageMeta,
  SETTINGS_NAV_ITEMS,
  settingsNavHref,
} from './settingsNavModel';

describe('settingsNavModel', () => {
  it('has a stable non-empty catalog including emby and update', () => {
    expect(SETTINGS_NAV_ITEMS.length).toBeGreaterThanOrEqual(10);
    expect(SETTINGS_NAV_ITEMS.some((i) => i.id === 'emby-settings')).toBe(true);
    expect(SETTINGS_NAV_ITEMS.some((i) => i.id === 'update-settings')).toBe(true);
  });

  it('builds settings hash', () => {
    expect(settingsNavHref('enhancement-settings')).toBe('#tab-settings/enhancement-settings');
  });

  it('drops the display-settings entry after the IA migration', () => {
    // 2026-09-27 IA 裁决：显示设置整页迁入功能增强 · 列表页增强，入口卡片随之移除
    expect(SETTINGS_NAV_ITEMS.some((i) => i.id === 'display-settings')).toBe(false);
  });

  it('filters by title description or id', () => {
    const hits = filterSettingsNavItems(SETTINGS_NAV_ITEMS, 'webdav');
    expect(hits.some((i) => i.id === 'webdav-settings')).toBe(true);
    expect(filterSettingsNavItems(SETTINGS_NAV_ITEMS, '不存在的词')).toEqual([]);
  });

  it('includes cloud multi-end sync entry distinct from webdav backup', () => {
    expect(SETTINGS_NAV_ITEMS.some((i) => i.id === 'cloud-settings')).toBe(true);
    expect(SETTINGS_NAV_ITEMS.some((i) => i.id === 'webdav-settings')).toBe(true);
    const cloudHits = filterSettingsNavItems(SETTINGS_NAV_ITEMS, 'cloud');
    expect(cloudHits.some((i) => i.id === 'cloud-settings')).toBe(true);
  });
});
