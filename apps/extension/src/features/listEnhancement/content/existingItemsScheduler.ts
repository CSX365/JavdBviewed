/**
 * @file existingItemsScheduler.ts
 * @description 列表冷启动「已有卡片 enhance」的分块调度（S1-1b：cold 相位长任务治理）。
 *
 * 背景：列表页冷启动时 processExistingItems 同步对所有已有卡片逐个 enhance，
 * 16 tab 场景下单次 ~300ms+ 的长任务阻塞列表首帧。本模块把 enhance 循环拆成
 * 每 12 张一 chunk：首 chunk 同步执行（保持初始化路径确定性），后续 chunk
 * 用 requestIdleCallback（500ms 超时兜底）让出主线程；全部完成后回调
 * onAllEnhanced（由调用方执行 processListItems，保持既有先后关系）。
 *
 * 幂等：enhance 回调由调用方保证幂等（data-list-enhanced 守卫），
 * 因此分块窗口内 observer 对新卡片的并发 enhance 不会重复处理。
 * @module features/listEnhancement/content
 */

/** 每个 chunk 的卡片数（24 张/页 → 2 chunk，兼顾长任务时长与批次数）。 */
export const DEFAULT_EXISTING_ITEMS_CHUNK_SIZE = 12;

/** requestIdleCallback 的超时兜底（避免主线程繁忙时 chunk 永远不排）。 */
export const DEFAULT_EXISTING_ITEMS_IDLE_TIMEOUT_MS = 500;

export type ExistingItemsIdleScheduler = (cb: () => void) => void;

export interface ExistingItemsScheduleOptions {
  items: readonly HTMLElement[];
  enhance: (item: HTMLElement) => void;
  /** 全部 items enhance 完成后调用（恰一次）；items 为空时同步调用。 */
  onAllEnhanced: () => void;
  chunkSize?: number;
  /** 注入用（测试）；默认 requestIdleCallback，缺失时回退 setTimeout(0)。 */
  scheduleIdle?: ExistingItemsIdleScheduler;
}

/** 默认空闲调度：rIC 优先，500ms 超时兜底；无 rIC 环境回退 setTimeout(0)。 */
export function defaultScheduleIdle(cb: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => cb(), { timeout: DEFAULT_EXISTING_ITEMS_IDLE_TIMEOUT_MS });
  } else {
    setTimeout(cb, 0);
  }
}

export function scheduleExistingItemsEnhancement(options: ExistingItemsScheduleOptions): void {
  const { items, enhance, onAllEnhanced } = options;
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_EXISTING_ITEMS_CHUNK_SIZE);
  const scheduleIdle = options.scheduleIdle ?? defaultScheduleIdle;

  let index = 0;
  const step = (): void => {
    const end = Math.min(index + chunkSize, items.length);
    for (; index < end; index += 1) {
      enhance(items[index]);
    }
    if (index < items.length) {
      scheduleIdle(step);
    } else {
      onAllEnhanced();
    }
  };

  if (items.length === 0) {
    onAllEnhanced();
    return;
  }
  step();
}
