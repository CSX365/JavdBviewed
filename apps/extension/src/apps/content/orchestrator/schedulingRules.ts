/**
 * @file schedulingRules.ts
 * @description schedulingRules
 * @module apps/content
 */
import type { GlobalTaskCost } from '../../../shared/taskCenterTypes';
import { isDeferredTaskWaitReason } from '../../../platform/tasks/waitPolicy';
import type { InitPhase, ScheduledTask } from './types';

export function createDeferredRetryKey(phase: InitPhase, label: string): string {
  return `${phase}::${label}`;
}

export function createTaskKey(phase: InitPhase, label: string): string {
  return `${phase}|${label}`;
}

export function getPhaseTaskCost(phase: InitPhase): GlobalTaskCost {
  if (phase === 'critical') return 'heavy';
  if (phase === 'high') return 'medium';
  return 'light';
}

export function getDeferredRetryDelayMs(waitReason?: string): number {
  if (waitReason === 'smart-background-global-budget' || waitReason === 'smart-background-page-budget') {
    return 1200;
  }
  return waitReason === 'tab-hidden' ? 1200 : 400;
}

/**
 * 后台 tab 被租约预算拒绝后的重排延迟：指数退避 + 抖动。
 * S0 实测：16 后台 tab 以 1200ms 定频重排 → request-lease 放大 20~40× SW 消息风暴 + 冷相位 CPU 250%→550~602%。
 * base 1200ms × 2^n，封顶 30s；抖动 ±20% 打散跨 tab 重排同频。
 */
export const BACKGROUND_LEASE_RETRY_BASE_MS = 1200;
export const BACKGROUND_LEASE_RETRY_MAX_MS = 30_000;

/**
 * S1-14 C1: prompt 唤醒最小间隔（距上次 lease 尝试，hidden 容量型等待）。
 * AttrC2 归因：denials≥5 后指数退避恒 30s 封顶，有效重请求节奏=prompt 广播节奏
 * （实测周期 3.5~17s；20 tab 稳态 ~6.6 次尝试/s，每次 2 条消息 + 36~65ms content JS），
 * 构成 hidden tab 纯租约乒乓（零真实工作，占 renderer 臂差 50~85%、browser 臂差 5~15%）。
 * prompt 到达时若距上次尝试 <15s 则跳过该任务（交指数退避定时器兜底），
 * 稳态重请求周期升至 15~36s，尝试率 3~10×↓；预算真释放后最多多等一个 15s 门控窗。
 */
export const BACKGROUND_LEASE_PROMPT_MIN_INTERVAL_MS = 15_000;

export function getBackgroundLeaseRetryDelayMs(consecutiveDenials: number, jitter: number = Math.random()): number {
  const step = Math.min(Math.max(0, Math.floor(consecutiveDenials)), 10);
  const capped = Math.min(BACKGROUND_LEASE_RETRY_MAX_MS, BACKGROUND_LEASE_RETRY_BASE_MS * 2 ** step);
  const j = Math.min(1, Math.max(0, jitter));
  return Math.round(capped * (0.8 + j * 0.4));
}

/**
 * 后台 tab 重任务阶段（high/deferred/idle）错峰启动：随机延迟 0~25s，打平 16 tab 冷峰。
 * 仅后台 tab 使用；前台 tab 不受影响。
 * S1-C: 12s → 25s —— S1 首测冷峰 453%（扩展增量 ~203%）仍高于 60% 压降目标；
 * 冷相位窗口约 50s，15 个后台 tab 的 video 重任务摊到 25s 起跑可把并发执行数从 ~15 压到 ~6；
 * 用户切到某后台 tab 时 visibilitychange 提前结束错峰窗，前台 UX 不受延迟影响。
 */
export const BACKGROUND_START_STAGGER_MAX_MS = 25_000;

export function getBackgroundStartStaggerMs(jitter: number = Math.random()): number {
  const j = Math.min(1, Math.max(0, jitter));
  return Math.floor(j * BACKGROUND_START_STAGGER_MAX_MS);
}

export function isDeferredWaitReason(waitReason?: string): boolean {
  return waitReason === 'retryable-error'
    || isDeferredTaskWaitReason(waitReason || '');
}

/** Scheduler capacity waits must remain queued; they are not execution failures. */
export function isLeaseAvailabilityWaitReason(waitReason?: string): boolean {
  return waitReason !== undefined
    && waitReason !== 'retryable-error'
    && isDeferredWaitReason(waitReason);
}

export function getDependencyWaitLimitMs(timeoutMs?: number): number {
  return Math.max(5000, (timeoutMs || 0) + 2000);
}

export function getHiddenIdleDelayMs(visibilityPolicy?: string): number {
  if (visibilityPolicy === 'background_throttled') return 1000;
  return visibilityPolicy === 'background_allowed' ? 300 : 150;
}

export function sortTasksByPriority<T extends ScheduledTask>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => (b.options.priority ?? 5) - (a.options.priority ?? 5));
}

export function partitionTasksByDependencyReadiness<T extends ScheduledTask>(
  tasks: T[],
  completedTasks: Set<string>,
): { readyTasks: T[]; notReadyTasks: T[] } {
  const readyTasks: T[] = [];
  const notReadyTasks: T[] = [];

  for (const task of tasks) {
    const deps = task.options.dependsOn || [];
    if (deps.length > 0 && !deps.every((dep) => completedTasks.has(dep))) {
      notReadyTasks.push(task);
    } else {
      readyTasks.push(task);
    }
  }

  return { readyTasks, notReadyTasks };
}
