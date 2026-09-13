/**
 * @file taskVisibilityReporter.ts
 * @description 任务可见性上报器 —— 监听页面 visibilitychange 事件，通知 background 页面前后台切换
 * @module platform/tasks
 *
 * background 根据页面可见性调整任务调度策略（前台优先执行）
 */
import { TASK_CENTER_MESSAGE } from '../../shared/taskCenterProtocol';
import { countContentPerformanceEvent } from './contentPerformanceDiagnostics';

/** 安装页面可见性上报器 */
export function installTaskVisibilityReporter(getActiveTaskIds?: () => string[]): () => void {
  const report = () => {
    countContentPerformanceEvent('event.visibilityReport');
    try {
      const visible = document.visibilityState === 'visible';
      chrome.runtime.sendMessage({
        type: TASK_CENTER_MESSAGE.VISIBILITY,
        payload: {
          visible,
          pageUrl: window.location.href,
        },
      });
      getActiveTaskIds?.();
    } catch {}
  };

  // RC4 (cycle-7): tab 关闭 / 进入 bfcache 时主动上报 hidden —— 否则 SW 可见集合只增不减，
  // 已关闭页面仍以「假 visible」参与全局 cap 分摊（C 场景 16 页同见 visible 的结构性根因之一）
  const onPageHide = () => {
    try {
      chrome.runtime.sendMessage({
        type: TASK_CENTER_MESSAGE.VISIBILITY,
        payload: {
          visible: false,
          pageUrl: window.location.href,
        },
      });
    } catch {}
  };

  document.addEventListener('visibilitychange', report);
  window.addEventListener('pagehide', onPageHide);
  report();
  return () => {
    document.removeEventListener('visibilitychange', report);
    window.removeEventListener('pagehide', onPageHide);
  };
}
