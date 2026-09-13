import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_LEASE_RETRY_MAX_MS,
  BACKGROUND_START_STAGGER_MAX_MS,
  createDeferredRetryKey,
  createTaskKey,
  getBackgroundLeaseRetryDelayMs,
  getBackgroundStartStaggerMs,
  getDeferredRetryDelayMs,
  getDependencyWaitLimitMs,
  getHiddenIdleDelayMs,
  getPhaseTaskCost,
  isLeaseAvailabilityWaitReason,
  isDeferredWaitReason,
  partitionTasksByDependencyReadiness,
  sortTasksByPriority,
} from './schedulingRules';
import type { ScheduledTask } from './types';

function task(label: string, priority?: number, dependsOn?: string[]): ScheduledTask {
  return {
    task: () => undefined,
    options: { label, priority, dependsOn },
  };
}

describe('orchestrator scheduling rules', () => {
  it('creates stable retry and task keys', () => {
    expect(createDeferredRetryKey('idle', 'preview:init')).toBe('idle::preview:init');
    expect(createTaskKey('high', 'status:init')).toBe('high|status:init');
  });

  it('maps phases to global task costs', () => {
    expect(getPhaseTaskCost('critical')).toBe('heavy');
    expect(getPhaseTaskCost('high')).toBe('medium');
    expect(getPhaseTaskCost('deferred')).toBe('light');
    expect(getPhaseTaskCost('idle')).toBe('light');
  });

  it('resolves deferred retry and hidden idle delays', () => {
    expect(getDeferredRetryDelayMs('tab-hidden')).toBe(1200);
    expect(getDeferredRetryDelayMs('bucket:light')).toBe(400);
    expect(getHiddenIdleDelayMs('background_allowed')).toBe(300);
    expect(getHiddenIdleDelayMs('foreground_first')).toBe(150);
  });

  it('backs off background lease denials exponentially with jitter and a cap', () => {
    // 首次拒绝：base 1200ms ±20%
    expect(getBackgroundLeaseRetryDelayMs(0, 0)).toBe(960);
    expect(getBackgroundLeaseRetryDelayMs(0, 1)).toBe(1440);
    // 指数递增：1200 → 2400 → 4800 → 9600 → 19200
    expect(getBackgroundLeaseRetryDelayMs(1, 0.5)).toBe(2400);
    expect(getBackgroundLeaseRetryDelayMs(2, 0.5)).toBe(4800);
    expect(getBackgroundLeaseRetryDelayMs(3, 0.5)).toBe(9600);
    expect(getBackgroundLeaseRetryDelayMs(4, 0.5)).toBe(19200);
    // 封顶 30s（含抖动后 ≤36s）
    expect(getBackgroundLeaseRetryDelayMs(10, 0.5)).toBe(BACKGROUND_LEASE_RETRY_MAX_MS);
    expect(getBackgroundLeaseRetryDelayMs(99, 1)).toBeLessThanOrEqual(BACKGROUND_LEASE_RETRY_MAX_MS * 1.2 + 1);
    expect(getBackgroundLeaseRetryDelayMs(99, 0)).toBeGreaterThanOrEqual(BACKGROUND_LEASE_RETRY_MAX_MS * 0.8 - 1);
    // 负数/非法输入不崩溃，按 0 处理
    expect(getBackgroundLeaseRetryDelayMs(-3, 0.5)).toBe(1200);
  });

  it('computes a bounded background start stagger', () => {
    expect(getBackgroundStartStaggerMs(0)).toBe(0);
    expect(getBackgroundStartStaggerMs(1)).toBe(BACKGROUND_START_STAGGER_MAX_MS);
    expect(getBackgroundStartStaggerMs(0.5)).toBe(BACKGROUND_START_STAGGER_MAX_MS / 2);
    const j = getBackgroundStartStaggerMs();
    expect(j).toBeGreaterThanOrEqual(0);
    expect(j).toBeLessThanOrEqual(BACKGROUND_START_STAGGER_MAX_MS);
  });

  it('detects deferred wait reasons', () => {
    expect(isDeferredWaitReason('tab-hidden')).toBe(true);
    expect(isDeferredWaitReason('higher-priority-wait')).toBe(true);
    expect(isDeferredWaitReason('bucket:medium')).toBe(true);
    expect(isDeferredWaitReason('source-page-heavy-budget')).toBe(true);
    expect(isDeferredWaitReason('dependency-wait')).toBe(false);
  });

  it('separates scheduler availability waits from execution failures', () => {
    expect(isLeaseAvailabilityWaitReason('source-page-heavy-budget')).toBe(true);
    expect(isLeaseAvailabilityWaitReason('background-global-budget')).toBe(true);
    expect(isLeaseAvailabilityWaitReason('tab-hidden')).toBe(true);
    expect(isLeaseAvailabilityWaitReason('retryable-error')).toBe(false);
    expect(isLeaseAvailabilityWaitReason('lease-timeout')).toBe(false);
  });

  it('computes dependency wait limits from timeout', () => {
    expect(getDependencyWaitLimitMs()).toBe(5000);
    expect(getDependencyWaitLimitMs(2000)).toBe(5000);
    expect(getDependencyWaitLimitMs(8000)).toBe(10000);
  });

  it('sorts high tasks by descending priority', () => {
    const sorted = sortTasksByPriority([
      task('middle', 5),
      task('low', 1),
      task('high', 9),
    ]);

    expect(sorted.map((item) => item.options.label)).toEqual(['high', 'middle', 'low']);
  });

  it('partitions tasks by dependency readiness', () => {
    const completed = new Set(['records:load']);
    const result = partitionTasksByDependencyReadiness([
      task('ready-with-deps', 5, ['records:load']),
      task('ready-without-deps'),
      task('blocked', 5, ['missing']),
    ], completed);

    expect(result.readyTasks.map((item) => item.options.label)).toEqual(['ready-with-deps', 'ready-without-deps']);
    expect(result.notReadyTasks.map((item) => item.options.label)).toEqual(['blocked']);
  });
});
