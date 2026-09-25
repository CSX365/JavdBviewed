// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const managedTaskRunner = vi.hoisted(() => vi.fn());
const registeredTaskRunner = vi.hoisted(() => vi.fn());
const chromeSendMessage = vi.hoisted(() => vi.fn());

// 同时替换注册前（runManagedTask）与注册后（runRegisteredManagedTask）两条执行路径，
// 使任务体直接执行 —— 本测试关注指标落盘时机，不覆盖租约机制
vi.mock('../../../platform/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/tasks')>();
  return {
    ...actual,
    runManagedTask: managedTaskRunner,
    runRegisteredManagedTask: registeredTaskRunner,
  };
});

/** 统计 chrome.runtime.sendMessage 中的 orchestrator:saveMetrics 落盘消息 */
function saveMetricsCount(): number {
  return chromeSendMessage.mock.calls.filter(
    (call) => (call[0] as { type?: string })?.type === 'orchestrator:saveMetrics',
  ).length;
}

describe('InitOrchestrator hidden 指标落盘（S1-14 A2）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 后台错峰窗固定为 0（0 × 25000ms），保证阶段立即启动
    vi.spyOn(Math, 'random').mockReturnValue(0);
    (globalThis as Record<string, unknown>).chrome = {
      runtime: { sendMessage: chromeSendMessage, lastError: null },
    };
    chromeSendMessage.mockReset();
    const execRunner = async (_descriptor: unknown, runner: () => Promise<unknown>) => ({
      executed: true,
      result: await runner(),
    });
    managedTaskRunner.mockImplementation(execRunner);
    registeredTaskRunner.mockImplementation(execRunner);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.clearAllMocks();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  async function createOrchestrator(visibility: DocumentVisibilityState) {
    // jsdom 的 document.hidden 不跟随 visibilityState getter 的 spy，需一并打桩
    const visibilityRef: { value: DocumentVisibilityState } = { value: visibility };
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityRef.value);
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => visibilityRef.value === 'hidden');
    const mod = await import('./initOrchestrator');
    // 模块尾单例在 import 时构造并同样向 jsdom document 挂 visibilitychange 监听；
    // dispose 摘除它，否则跨测试（vi.resetModules 产生新模块实例）监听器累积，
    // dispatch 时旧单例会跟着 flush 出自己的 saveMetrics 消息
    mod.initOrchestrator.dispose();
    const orchestrator = new mod.InitOrchestrator();
    return { orchestrator, visibilityRef };
  }

  it('hidden 期间 saveMetrics 0 落盘：长时间推进不触发 1s flush，回前台一次性 flush', async () => {
    const { orchestrator, visibilityRef } = await createOrchestrator('hidden');
    const task = vi.fn(() => undefined);

    await orchestrator.add('idle', task, { label: 'preview:init' });
    await orchestrator.run();
    await vi.advanceTimersByTimeAsync(50);

    // 后台任务完成 → updateMetrics → scheduleMetricsSave（hidden 分支：不建定时器）
    expect(task).toHaveBeenCalledTimes(1);
    expect(saveMetricsCount()).toBe(0);

    // 长时间推进：hidden 期间 1s flush 定时器不得存在（0 落盘门禁）
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saveMetricsCount()).toBe(0);

    // 再完成一个任务 → 仍然 0 落盘
    const task2 = vi.fn(() => undefined);
    await orchestrator.add('idle', task2, { label: 'preview:init2' });
    await vi.advanceTimersByTimeAsync(50);
    expect(task2).toHaveBeenCalledTimes(1);
    expect(saveMetricsCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(saveMetricsCount()).toBe(0);

    // 回前台 → visibilitychange 统一 flush（含 hidden 期间全部累积指标）
    visibilityRef.value = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1);
    expect(saveMetricsCount()).toBe(1);

    // flush 后无新任务 → 不重复落盘
    await vi.advanceTimersByTimeAsync(2_000);
    expect(saveMetricsCount()).toBe(1);

    orchestrator.dispose();
  });

  it('转 hidden 时取消未触发的 1s 定时器，回前台补发（不丢 flush、不重复发）', async () => {
    const { orchestrator, visibilityRef } = await createOrchestrator('visible');

    await orchestrator.add('idle', vi.fn(() => undefined), { label: 'preview:init' });
    await orchestrator.run();
    await vi.advanceTimersByTimeAsync(50);
    expect(saveMetricsCount()).toBe(0);

    // 防抖窗（1s）内页面转 hidden → 未触发的定时器被取消
    visibilityRef.value = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(saveMetricsCount()).toBe(0);

    // 回前台 → 补发一次
    visibilityRef.value = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1);
    expect(saveMetricsCount()).toBe(1);

    orchestrator.dispose();
  });

  it('前台 1s 防抖落盘行为不变（回归保护）：窗内多次完成合并为一条', async () => {
    const { orchestrator } = await createOrchestrator('visible');

    await orchestrator.add('idle', vi.fn(() => undefined), { label: 'preview:init' });
    await orchestrator.run();
    await vi.advanceTimersByTimeAsync(50);
    expect(saveMetricsCount()).toBe(0);

    // 1s 防抖到期 → 落盘一次
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saveMetricsCount()).toBe(1);

    // 防抖窗内连续完成两个任务 → 合并为一条
    await orchestrator.add('idle', vi.fn(() => undefined), { label: 'preview:init2' });
    await orchestrator.add('idle', vi.fn(() => undefined), { label: 'preview:init3' });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(saveMetricsCount()).toBe(2);

    orchestrator.dispose();
  });
});
