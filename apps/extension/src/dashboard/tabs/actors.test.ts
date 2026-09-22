// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const actorInitialize = vi.fn();
const searchActors = vi.fn();
const getStats = vi.fn();
const getSettings = vi.fn();
const getSubscriptions = vi.fn();
const renderActorListRuntime = vi.fn();

vi.mock('../../features/actors', () => ({
  actorManager: {
    initialize: actorInitialize,
    searchActors,
    getStats,
  },
}));

vi.mock('../../features/newWorks', () => ({
  newWorksManager: {
    getSubscriptions,
  },
}));

vi.mock('../../utils/storage', () => ({
  getSettings,
  saveSettings: vi.fn(),
}));

vi.mock('../ui/toast', () => ({
  showMessage: vi.fn(),
}));

vi.mock('./actors/actorControlsRuntime', () => ({
  setupActorControlsRuntime: vi.fn(),
  syncActorViewModeButton: vi.fn(),
}));

vi.mock('./actors/viewPreferenceModel', () => ({
  readActorViewMode: vi.fn(() => 'list'),
  writeActorViewMode: vi.fn(),
}));

vi.mock('./actors/actorListRuntime', () => ({
  renderActorListRuntime,
}));

vi.mock('./actors/statsRuntime', () => ({
  renderActorStats: vi.fn(),
}));

describe('ActorsTab initialization', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="actorListContainer"></div>
      <div id="actorPaginationContainer"></div>
      <div id="actorStatsContainer"></div>
      <div id="actorListLoading"></div>
    `;
    actorInitialize.mockReset().mockResolvedValue(undefined);
    searchActors.mockReset();
    getStats.mockReset();
    getSettings.mockReset().mockResolvedValue({
      actorLibrary: { blacklist: { hideInList: false, showBadge: false } },
    });
    getSubscriptions.mockReset().mockResolvedValue([]);
    renderActorListRuntime.mockReset();
  });

  it('defers actor stats until the first actor page is available', async () => {
    vi.useFakeTimers();
    let resolveActors: ((result: unknown) => void) | undefined;
    searchActors.mockImplementation(() => new Promise(resolve => {
      resolveActors = resolve;
    }));
    getStats.mockResolvedValue({
      total: 0,
      byGender: {},
      byCategory: {},
      recentlyAdded: 0,
      recentlyUpdated: 0,
      blacklisted: 0,
    });

    const { ActorsTab } = await import('./actors');
    const startup = new ActorsTab().initActorsTab();
    await vi.waitFor(() => expect(searchActors).toHaveBeenCalledTimes(1));

    expect(getStats).not.toHaveBeenCalled();

    resolveActors?.({ actors: [], total: 0, page: 1, pageSize: 20, hasMore: false });
    await startup;
    expect(getStats).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();
    expect(getStats).toHaveBeenCalledTimes(1);
  }, 15_000); // fake-timers 时序用例：全量 377 文件并行时 worker 负载高，5s 预算偶发不够（单跑 ~360ms），放宽到 15s 防 flake

  it('restores the cached actor page without re-querying when data is unchanged while hidden', async () => {
    vi.useFakeTimers();
    searchActors.mockResolvedValue({
      actors: [{ id: 'actor-1', name: 'Actor 1', aliases: [], gender: 'female', category: 'A' }],
      total: 1,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
    getStats.mockResolvedValue({
      total: 1,
      byGender: { female: 1 },
      byCategory: { A: 1 },
      recentlyAdded: 0,
      recentlyUpdated: 0,
      blacklisted: 0,
    });

    const { ActorsTab } = await import('./actors');
    const { dashboardTabLifecycle } = await import('./tabLifecycle');
    const tab = new ActorsTab();
    await tab.initActorsTab();
    const searchCallsAfterInitialLoad = searchActors.mock.calls.length;
    const renderCallsAfterInitialLoad = renderActorListRuntime.mock.calls.length;

    dashboardTabLifecycle.notify('hidden', 'tab-actors');
    dashboardTabLifecycle.notify('restore', 'tab-actors');

    // 温恢复：缓存重渲染一次；隐藏期无数据变更 → 不触发后台重查（S1 §9.2 去双渲染）
    expect(renderActorListRuntime).toHaveBeenCalledTimes(renderCallsAfterInitialLoad + 1);
    expect(searchActors).toHaveBeenCalledTimes(searchCallsAfterInitialLoad);

    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    expect(searchActors).toHaveBeenCalledTimes(searchCallsAfterInitialLoad);
    dashboardTabLifecycle.notify('dispose', 'tab-actors');
  });

  it('refreshes on restore when actor data changed while the tab was hidden', async () => {
    vi.useFakeTimers();
    searchActors.mockResolvedValue({
      actors: [{ id: 'actor-1', name: 'Actor 1', aliases: [], gender: 'female', category: 'A' }],
      total: 1,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
    getStats.mockResolvedValue({
      total: 1,
      byGender: { female: 1 },
      byCategory: { A: 1 },
      recentlyAdded: 0,
      recentlyUpdated: 0,
      blacklisted: 0,
    });

    const { ActorsTab } = await import('./actors');
    const { dashboardTabLifecycle } = await import('./tabLifecycle');
    const tab = new ActorsTab();
    await tab.initActorsTab();
    const searchCallsAfterInitialLoad = searchActors.mock.calls.length;

    dashboardTabLifecycle.notify('hidden', 'tab-actors');
    // 隐藏期数据变更 → 置 dirty，恢复时一次性刷新
    document.dispatchEvent(new Event('actors-data-updated'));
    dashboardTabLifecycle.notify('restore', 'tab-actors');

    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    expect(searchActors).toHaveBeenCalledTimes(searchCallsAfterInitialLoad + 1);
    dashboardTabLifecycle.notify('dispose', 'tab-actors');
  });
});
