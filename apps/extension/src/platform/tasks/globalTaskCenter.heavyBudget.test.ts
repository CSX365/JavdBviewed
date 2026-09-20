/**
 * @file globalTaskCenter.heavyBudget.test.ts
 * @description S1-2b (cycle-11)：全局重相位（critical/high）并发槽
 *  1) 后台页请求：全 tab 重租约在跑 ≥ totalHeavy(4) → 拒 global-heavy-budget
 *  2) 可见页请求：后台重租约在跑 ≥ hiddenHeavy(2) → 拒 global-heavy-budget（保护前台主线程）
 *  3) 后台重租约 < 2 时，可见页重任务不受阻（前台不被误伤）
 *  4) 轻相位（deferred）任务不受重槽约束
 *  5) 释放一个重租约后，被拒任务重试即可授予（唤醒路径有效）
 *  6) 已持有租约的重任务重入走快速路径，不与自身计数死锁
 */
import { describe, expect, it } from 'vitest';
import { GlobalTaskCenter } from './globalTaskCenter';
import type { GlobalTaskDescriptor } from '../../shared/taskCenterTypes';

function descriptor(
  label: string,
  tabId: number,
  overrides: Partial<GlobalTaskDescriptor> = {},
): GlobalTaskDescriptor {
  return {
    taskId: `task-${label}`,
    label,
    tabId,
    pageUrl: `https://javdb.com/v/${label}`,
    pageType: 'detail',
    mainId: label,
    pageInstanceId: `page-${label}`,
    phase: 'high',
    priority: 5,
    cost: 'light',
    visibilityPolicy: 'foreground_first',
    timeoutMs: 10_000,
    retryLimit: 0,
    resumePolicy: 'restart',
    createdAt: Date.now(),
    ...overrides,
  };
}

/** 可见页重任务（前台） */
function visibleHeavy(label: string, tabId: number): GlobalTaskDescriptor {
  return descriptor(label, tabId, { phase: 'high', visibilityPolicy: 'foreground_first' });
}

/** 后台页重任务（与真机 listEnhancement/superRankingNav 注册口径一致） */
function hiddenHeavy(label: string, tabId: number, phase: 'critical' | 'high' = 'critical'): GlobalTaskDescriptor {
  return descriptor(label, tabId, { phase, visibilityPolicy: 'background_allowed' });
}

/**
 * 铺底：2 可见重任务 + 2 后台重任务全部在跑（totalHeavy=4）。
 * 返回各任务 id，调用方保证按序 requestLease。
 */
function setupSaturated(center: GlobalTaskCenter): { a: string; b: string; c: string; d: string } {
  const a = center.registerTask(visibleHeavy('listEnhancement:init:a', 1)).taskId;
  const b = center.registerTask(visibleHeavy('listEnhancement:init:b', 2)).taskId;
  const c = center.registerTask(hiddenHeavy('superRankingNav:init:c', 3)).taskId;
  const d = center.registerTask(hiddenHeavy('listEnhancement:init:d', 4)).taskId;
  center.updateVisibility(1, true);
  center.updateVisibility(2, true);
  center.updateVisibility(3, false);
  center.updateVisibility(4, false);
  expect(center.requestLease(a).granted).toBe(true);
  expect(center.requestLease(b).granted).toBe(true);
  expect(center.requestLease(c).granted).toBe(true);
  expect(center.requestLease(d).granted).toBe(true);
  return { a, b, c, d };
}

describe('GlobalTaskCenter 全局重相位并发槽（S1-2b）', () => {
  it('后台页请求：全 tab 重租约在跑 ≥4 时拒 global-heavy-budget', () => {
    const center = new GlobalTaskCenter();
    const { c, d } = setupSaturated(center);

    const e = center.registerTask(hiddenHeavy('listEnhancement:init:e', 5)).taskId;
    center.updateVisibility(5, false);
    const denied = center.requestLease(e);

    expect(denied).toEqual({ granted: false, waitReason: 'global-heavy-budget' });
    expect(center.queryState().tasks.find((t) => t.taskId === e)?.status).toBe('queued');
    // 铺底的 4 个重租约不受影响
    for (const id of [c, d]) {
      expect(center.queryState().tasks.find((t) => t.taskId === id)?.status).toBe('leased');
    }
  });

  it('可见页请求：后台重租约在跑 ≥2 时拒 global-heavy-budget（保护前台）', () => {
    const center = new GlobalTaskCenter();
    setupSaturated(center);

    const f = center.registerTask(visibleHeavy('listEnhancement:init:f', 5)).taskId;
    center.updateVisibility(5, true);
    const denied = center.requestLease(f);

    expect(denied).toEqual({ granted: false, waitReason: 'global-heavy-budget' });
    expect(center.queryState().tasks.find((t) => t.taskId === f)?.status).toBe('queued');
  });

  it('后台重租约 <2 时，可见页重任务不受阻（前台不被误伤）', () => {
    const center = new GlobalTaskCenter();
    const a = center.registerTask(visibleHeavy('listEnhancement:init:a', 1)).taskId;
    const c = center.registerTask(hiddenHeavy('superRankingNav:init:c', 3)).taskId;
    center.updateVisibility(1, true);
    center.updateVisibility(3, false);
    expect(center.requestLease(a).granted).toBe(true);
    expect(center.requestLease(c).granted).toBe(true);

    const f = center.registerTask(visibleHeavy('listEnhancement:init:f', 5)).taskId;
    center.updateVisibility(5, true);
    expect(center.requestLease(f).granted).toBe(true);
  });

  it('轻相位（deferred）任务不受重槽约束', () => {
    const center = new GlobalTaskCenter();
    const c = center.registerTask(hiddenHeavy('superRankingNav:init:c', 3)).taskId;
    const d = center.registerTask(hiddenHeavy('listEnhancement:init:d', 4, 'high')).taskId;
    center.updateVisibility(3, false);
    center.updateVisibility(4, false);
    expect(center.requestLease(c).granted).toBe(true);
    expect(center.requestLease(d).granted).toBe(true);

    // 2 个后台重租约在跑（已达 hiddenHeavy 上限），可见页的 deferred 轻任务照常授予
    const f = center.registerTask(descriptor('ux:shortcuts:init:f', 5, {
      phase: 'deferred',
      visibilityPolicy: 'foreground_first',
    })).taskId;
    center.updateVisibility(5, true);
    expect(center.requestLease(f).granted).toBe(true);
  });

  it('释放一个重租约后，被拒任务重试即可授予', () => {
    const center = new GlobalTaskCenter();
    const { c } = setupSaturated(center);

    const e = center.registerTask(hiddenHeavy('listEnhancement:init:e', 5)).taskId;
    center.updateVisibility(5, false);
    expect(center.requestLease(e).waitReason).toBe('global-heavy-budget');

    center.completeTask(c);
    expect(center.requestLease(e).granted).toBe(true);
  });

  it('已持有租约的重任务重入走快速路径（不与自身计数死锁）', () => {
    const center = new GlobalTaskCenter();
    const { a } = setupSaturated(center);
    // totalHeavy 已 =4，重入 A 不应被自己的租约卡住
    expect(center.requestLease(a)).toEqual({ granted: true });
  });
});
