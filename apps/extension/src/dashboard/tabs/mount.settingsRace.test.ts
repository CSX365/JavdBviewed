// @vitest-environment jsdom
// @file mount.settingsRace.test.ts
// 回归：React 设置页 → partial 子页切换竞态（forensics 方案 A）。
// 旧页卸载 flush（防抖延迟写盘）与子页挂载读存在竞态：
// partial 分支挂载子页壳前必须等待模块级待写链 settle，
// 否则新页 init 可能读到旧值基线。
// 出处：.trellis/tasks/09-20-nonperf-pending-investigation/research/nonperf1-race-forensics.md
// 说明：用真定时器而非 fake timers —— vitest fake timers 会接管
// queueMicrotask/nextTick，卡住 vitest 动态 import 解析，与本竞态无关。
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountTabIfNeeded } from './mount';
import {
  mountSettingsSubpageShell,
} from '../../apps/dashboard/pages/settings/mountSettingsSubpageShell';
import { saveSettings } from '../../utils/storage';
import { useDebouncedSettingsSave } from '../../apps/dashboard/pages/settings/shared/settingsPersist';

vi.mock('../loaders/partialsLoader', () => ({
  ensureMounted: vi.fn(async () => undefined),
  loadPartial: vi.fn(async () => '<div id="about-settings">about-panel</div>'),
  injectPartial: vi.fn(async () => true),
}));

vi.mock('../loaders/stylesLoader', () => ({
  ensureStylesLoaded: vi.fn(async () => undefined),
  prefetchStyles: vi.fn(async () => undefined),
}));

vi.mock('../../utils/storage', () => ({
  getSettings: vi.fn(async () => ({})),
  saveSettings: vi.fn(async () => undefined),
}));

vi.mock('../../apps/dashboard/pages/settings/mountSettingsSubpageShell', () => ({
  mountSettingsSubpageShell: vi.fn(() => document.createElement('div')),
}));

vi.mock('../../apps/dashboard/pages/settings/mountSettingsIndexPage', () => ({
  mountSettingsIndexPage: vi.fn(),
  unmountSettingsIndexPage: vi.fn(),
}));

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 模拟"上一页"：挂载后 schedule 防抖保存，卸载时在防抖窗口内 flush */
function FlushHarness() {
  const { scheduleSave } = useDebouncedSettingsSave<boolean>({
    delayMs: 1000,
    persist: async (value) => {
      await saveSettings({ hideViewed: value });
    },
  });
  useEffect(() => {
    scheduleSave(true);
  }, [scheduleSave]);
  return null;
}

describe('mountTabIfNeeded 设置子页 partial 分支竞态', () => {
  let resolveSave: ((value?: unknown) => void) | undefined;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    resolveSave = undefined;
    saveSettings.mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          resolveSave = resolve;
        }),
    );
    window.location.hash = '#tab-settings/about-settings';
    document.body.innerHTML = '<div id="tab-settings"></div>';
  });

  afterEach(() => {
    window.location.hash = '';
    document.body.innerHTML = '';
  });

  it('前页卸载延迟写在飞时，partial 子页壳等待其落盘后才挂载', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(createElement(FlushHarness));
    });

    // 防抖窗口（1000ms）内卸载：cleanup 触发 flush，saveSettings 仍在飞
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    expect(saveSettings).toHaveBeenCalledTimes(1);

    const mountPromise = mountTabIfNeeded('tab-settings');

    // 未修复时子页壳此刻已挂载；修复后应阻塞在待写链上
    // （50ms 断言窗口 << awaitPendingSettingsPersist 1500ms fail-open）
    await act(async () => {
      await delay(50);
    });
    expect(mountSettingsSubpageShell).not.toHaveBeenCalled();

    await act(async () => {
      resolveSave?.(undefined);
      await Promise.resolve();
    });

    await act(async () => {
      await mountPromise;
    });
    expect(mountSettingsSubpageShell).toHaveBeenCalledTimes(1);
    expect(mountSettingsSubpageShell).toHaveBeenCalledWith(
      expect.objectContaining({
        panelHtml: '<div id="about-settings">about-panel</div>',
        panelRootId: 'about-settings',
      }),
    );
  });

  it('无在飞写链时立即挂载 partial 子页壳', async () => {
    const mountPromise = mountTabIfNeeded('tab-settings');

    await act(async () => {
      await delay(50);
      await mountPromise;
    });

    expect(mountSettingsSubpageShell).toHaveBeenCalledTimes(1);
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
