import { describe, expect, it, vi } from 'vitest';
import { runHighPhaseTasks } from './highPhaseScheduler';
import type { ScheduledTask } from './types';

function task(label: string, priority?: number, dependsOn?: string[]): ScheduledTask {
  return {
    task: () => undefined,
    options: { label, priority, dependsOn },
  };
}

describe('runHighPhaseTasks', () => {
  it('runs tasks by priority with the configured concurrency limit', async () => {
    const runningLabels: string[] = [];
    const completedLabels: string[] = [];

    await runHighPhaseTasks({
      tasks: [
        task('low', 1),
        task('high', 9),
        task('middle', 5),
      ],
      completedTasks: new Set(),
      maxConcurrentTasks: 1,
      runTask: async (item) => {
        runningLabels.push(item.options.label || '');
        completedLabels.push(item.options.label || '');
      },
      log: vi.fn(),
    });

    expect(runningLabels).toEqual(['high', 'middle', 'low']);
    expect(completedLabels).toEqual(['high', 'middle', 'low']);
  });

  it('waits until dependencies are completed by earlier high tasks', async () => {
    const completedTasks = new Set<string>();
    const runningLabels: string[] = [];

    await runHighPhaseTasks({
      tasks: [
        task('dependent', 10, ['base']),
        task('base', 5),
      ],
      completedTasks,
      maxConcurrentTasks: 1,
      runTask: async (item) => {
        runningLabels.push(item.options.label || '');
        completedTasks.add(item.options.label || '');
      },
      log: vi.fn(),
    });

    expect(runningLabels).toEqual(['base', 'dependent']);
  });

  it('does not force blocked tasks with missing dependencies and logs diagnostics', async () => {
    const log = vi.fn();
    const runningLabels: string[] = [];

    await runHighPhaseTasks({
      tasks: [
        task('blocked', 10, ['missing']),
      ],
      completedTasks: new Set(),
      maxConcurrentTasks: 2,
      runTask: async (item) => {
        runningLabels.push(item.options.label || '');
      },
      log,
    });

    expect(runningLabels).toEqual([]);
    expect(log).toHaveBeenCalledWith('warning: circular dependency or missing dependency detected', {
      pendingTasks: [
        {
          label: 'blocked',
          dependsOn: ['missing'],
        },
      ],
    });
  });
});

describe('runHighPhaseTasks A1 (S1-14): 退避 parked 任务不再被循环重弹', () => {
  const isParked = (item: ScheduledTask) => item.options.label !== 'parked';

  it('循环不发起 parked 任务，全部 parked 时静默退出（不误报循环依赖）', async () => {
    const log = vi.fn();
    const launched: string[] = [];

    await runHighPhaseTasks({
      tasks: [task('p1', 9), task('p2', 5)],
      completedTasks: new Set(),
      maxConcurrentTasks: 2,
      runTask: async (item) => {
        launched.push(item.options.label || '');
      },
      log,
      isLoopEligible: () => false,
    });

    expect(launched).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('重入不再发起 parked 任务（弹跳修复），且不报循环依赖警告', async () => {
    const log = vi.fn();
    const launched: string[] = [];
    // 模拟真实时序：首次租约被拒前所有任务都合格；被拒移交退避定时器后 parked 失去资格
    let handedOffToBackoff = false;
    const isLoopEligible = (item: ScheduledTask) =>
      item.options.label !== 'parked' || !handedOffToBackoff;
    const input = (tasks: ScheduledTask[]) => ({
      tasks,
      completedTasks: new Set<string>(),
      maxConcurrentTasks: 2,
      runTask: async (item: ScheduledTask) => {
        launched.push(item.options.label || '');
        if (item.options.label === 'parked') handedOffToBackoff = true;
      },
      log,
      isLoopEligible,
    });

    // 首次进入：parked 尚未移交退避 → 正常发起（随后被拒、移交退避定时器）
    await runHighPhaseTasks(input([task('parked', 9), task('active', 5)]));
    expect(launched).toEqual(['parked', 'active']);

    // 后续重入（等价非 high 任务完成触发的 runHighTasksWithConcurrencyControl）：
    // parked 任务不得再次被发起 —— 这就是 A1 修复的 370~687ms 弹跳风暴
    launched.length = 0;
    await runHighPhaseTasks(input([task('parked', 9)]));
    expect(launched).toEqual([]);
    expect(log).not.toHaveBeenCalledWith(
      'warning: circular dependency or missing dependency detected',
      expect.anything(),
    );
  });

  it('parked 任务排队等待运行位时，运行任务完成后静默退出（不补发 parked）', async () => {
    const log = vi.fn();
    const launched: string[] = [];

    await runHighPhaseTasks({
      tasks: [task('parked', 9), task('slow', 5)],
      completedTasks: new Set(),
      maxConcurrentTasks: 1,
      runTask: (item) => {
        launched.push(item.options.label || '');
        if (item.options.label === 'slow') {
          return new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          });
        }
        return Promise.resolve();
      },
      log,
      isLoopEligible: isParked,
    });

    // slow 先跑；parked 优先级更高但已被退避定时器持有，循环不得发起
    expect(launched).toEqual(['slow']);
    expect(log).not.toHaveBeenCalledWith(
      'warning: circular dependency or missing dependency detected',
      expect.anything(),
    );
  });

  it('谓词恒真时行为与旧版一致（前台回归保护）', async () => {
    const runningLabels: string[] = [];

    await runHighPhaseTasks({
      tasks: [
        task('low', 1),
        task('high', 9),
        task('middle', 5),
      ],
      completedTasks: new Set(),
      maxConcurrentTasks: 1,
      runTask: async (item) => {
        runningLabels.push(item.options.label || '');
      },
      log: vi.fn(),
      isLoopEligible: () => true,
    });

    expect(runningLabels).toEqual(['high', 'middle', 'low']);
  });
});
