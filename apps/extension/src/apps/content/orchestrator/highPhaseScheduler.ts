/**
 * @file highPhaseScheduler.ts
 * @description 高阶段任务并行执行器 —— 按优先级+依赖就绪调度，支持循环依赖检测
 * @module apps/content
 */
import { partitionTasksByDependencyReadiness, sortTasksByPriority } from './schedulingRules';
import type { ScheduledTask } from './types';

type RunHighPhaseTasksInput<T extends ScheduledTask> = {
  tasks: T[];                        // 待执行任务列表
  completedTasks: Set<string>;       // 已完成任务的标签集合（用于依赖判断）
  maxConcurrentTasks: number;        // 最大并发任务数
  runTask: (task: T) => Promise<void>;  // 单个任务执行函数
  log: (message: string, detail?: unknown) => void;  // 日志输出函数
  /**
   * S1-14 A1: 循环资格谓词。
   * 已移交后台退避定时器所有权的高任务（hidden 页容量型等待）不得被循环再次发起：
   * 其重跑由退避定时器 / 回前台事件 / SW 租约 prompt 驱动，循环只负责其余就绪任务。
   * 省略时所有任务视为合格（旧行为；前台 tab 的谓词恒真，行为逐帧不变）。
   */
  isLoopEligible?: (task: T) => boolean;
};

/** 将运行中的 promise 注入运行池，完成后自动移除 */
function trackRunningTask(runningTasks: Promise<void>[], taskPromise: Promise<void>): void {
  runningTasks.push(taskPromise);
  taskPromise.finally(() => {
    const index = runningTasks.indexOf(taskPromise);
    if (index > -1) {
      runningTasks.splice(index, 1);
    }
  });
}

/**
 * 按优先级+依赖就绪+并发上限执行高阶段任务
 * 使用 Promise.race 在任一任务完成时立即检查是否有就绪的等待任务
 * 如果所有等待任务都无法就绪 → 检测到循环依赖或缺失依赖，放弃等待直接执行
 */
export async function runHighPhaseTasks<T extends ScheduledTask>(input: RunHighPhaseTasksInput<T>): Promise<void> {
  const tasks = sortTasksByPriority(input.tasks);
  const runningTasks: Promise<void>[] = [];
  const pendingTasks = [...tasks];
  const isLoopEligible = input.isLoopEligible ?? (() => true);

  while (pendingTasks.length > 0 || runningTasks.length > 0) {
    const { readyTasks, notReadyTasks } = partitionTasksByDependencyReadiness(pendingTasks, input.completedTasks);

    pendingTasks.length = 0;
    pendingTasks.push(...notReadyTasks);

    const launchableTasks: T[] = [];
    for (const task of readyTasks) {
      if (isLoopEligible(task)) {
        launchableTasks.push(task);
      } else {
        // S1-14 A1: 退避定时器已持有该任务（hidden 容量型等待）—— 循环不发起、
        // 也不按缺失依赖告警；重跑由定时器 / 回前台 / SW prompt 驱动
        pendingTasks.push(task);
      }
    }

    while (launchableTasks.length > 0 && runningTasks.length < input.maxConcurrentTasks) {
      const nextTask = launchableTasks.shift();
      if (!nextTask) break;
      trackRunningTask(runningTasks, input.runTask(nextTask));
    }
    pendingTasks.unshift(...launchableTasks);

    if (runningTasks.length === 0 && pendingTasks.length > 0) {
      // S1-14 A1: 剩余全是退避 parked 任务时静默退出（它们有自己的唤醒路径）；
      // 只有存在未被持有、又无法就绪的任务（真缺依赖/循环依赖）才保留原告警
      const parkedOnly = pendingTasks.every((task) => !isLoopEligible(task));
      if (!parkedOnly) {
        input.log('warning: circular dependency or missing dependency detected', {
          pendingTasks: pendingTasks.map((task) => ({
            label: task.options.label,
            dependsOn: task.options.dependsOn,
          })),
        });
      }
      break;
    }

    if (runningTasks.length > 0) {
      await Promise.race(runningTasks);
    }
  }
}
