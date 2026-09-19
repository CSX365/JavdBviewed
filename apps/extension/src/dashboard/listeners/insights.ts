// src/dashboard/listeners/insights.ts

// 首页图表模块懒加载（S1-C）：insights 监听仅在 DB 变更事件后触发刷新，届时再动态加载
let homeChartsModulePromise: Promise<typeof import('../home/charts')> | null = null;
function loadHomeChartsModule(): Promise<typeof import('../home/charts')> {
  if (!homeChartsModulePromise) {
    homeChartsModulePromise = import('../home/charts').catch((error) => {
      homeChartsModulePromise = null; // 失败后允许下次事件重试
      throw error;
    });
  }
  return homeChartsModulePromise;
}
import { shouldRefreshHomeCharts } from './insightsRefreshPolicy';

export function createInsightsRefreshScheduler(
  refresh: () => void | Promise<void>,
  delayMs = 250,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let refreshPromise: Promise<void> | null = null;
  let dirty = false;

  const schedule = (): void => {
    dirty = true;
    if (timer || refreshPromise) return;
    timer = setTimeout(() => {
      timer = null;
      if (!dirty || refreshPromise) return;
      dirty = false;
      refreshPromise = Promise.resolve()
        .then(() => refresh())
        .catch(() => {})
        .finally(() => {
          refreshPromise = null;
          if (dirty) schedule();
        });
    }, Math.max(0, delayMs));
  };

  return schedule;
}

export type InsightsViewsChangedContext = {
  activeTabId: string | null;
  visibilityState: DocumentVisibilityState;
};

export function handleInsightsViewsChanged(
  context: InsightsViewsChangedContext,
  invalidate: () => void,
  schedule: () => void,
): void {
  if (!shouldRefreshHomeCharts(context)) return;
  invalidate();
  schedule();
}

export function bindInsightsListeners(): void {
  try {
    const W: any = window as any;
    if (!W.__INSIGHTS_CHANGED_BOUND__) {
      const scheduleRefresh = createInsightsRefreshScheduler(() => loadHomeChartsModule().then((charts) => charts.initOrUpdateHomeCharts()));
      chrome.runtime.onMessage.addListener((msg: any) => {
        try {
          if (msg && msg.type === 'DB:INSIGHTS_VIEWS_CHANGED') {
            const activeTabId = document.querySelector<HTMLElement>('.tab-content.active')?.id ?? null;
            handleInsightsViewsChanged(
              { activeTabId, visibilityState: document.visibilityState },
              () => { loadHomeChartsModule().then((charts) => charts.invalidateHomeOverview()).catch(() => {}); },
              scheduleRefresh,
            );
          }
        } catch {}
      });
      W.__INSIGHTS_CHANGED_BOUND__ = true;
    }
  } catch {}
}
