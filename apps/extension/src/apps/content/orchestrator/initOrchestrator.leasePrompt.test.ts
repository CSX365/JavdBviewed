// @vitest-environment jsdom
/**
 * @file initOrchestrator.leasePrompt.test.ts
 * @description S1-14 A3/C1：SW 槽位释放 prompt → 编排器立即重请求最老【满足间隔】的 hidden 退避任务。
 *  A3 语义（保留）：
 *  1) 每 prompt 至多唤醒一条（取 Map 插入序第一条满足间隔的），其余继续按各自退避定时器排程
 *  2) 被唤醒任务的原退避定时器被取消（不会在旧到期点二次触发）
 *  3) backgroundLeaseDenials 不重置 —— 唤醒后再被拒绝，退避按升级步长排（不降级回 base）
 *  4) visible 页忽略 prompt（防御性早退；前台容量型拒绝走普通 400ms 退避，行为与改前逐帧一致）
 *  C1 门控（15s 最小间隔，距任务上次 lease 尝试）：
 *  5) prompt 距上次尝试 <15s → 跳过该任务，退避定时器照旧（退避链不受门控影响）
 *  6) 间隔 ≥15s → 正常唤醒，且取消在飞退避定时器
 *  7) 多任务时跳过未达间隔者、取下一条；每 prompt 至多一条
 *  8) 门控不改变退避序列（denials 语义不变，delay 单调升级不回落）
 *
 *  时序口径（Math.random=0 → 抖动 0.8×）：退避链 960/1920/3840/7680/15360/24000ms；
 *  首次尝试在 run()+50ms 窗内发生（t1≤50），此后各尝试间隔=上一轮记录的退避 delay。
 *
 *  测量环境踩坑备忘（S1-14 C1 实踩）：
 *  - C1 门控判定读 performance.now()，必须与 setTimeout 同一 fake clock → 显式
 *    vi.useFakeTimers({ toFake: [..., 'performance'] })（vitest 默认 toFake 不含 performance 时门控恒真）。
 *  - platform/tasks（RM）的 lease prompt chrome 监听器按模块实例只装一次（ensure 幂等）；
 *    vi.resetModules 下 RM 实例状态跨测试存续、其注册历史被 mockReset 抹掉，只 fire 本轮
 *    mock.calls 会漏掉真正的 RM dispatcher → 本文件跨测试累积全部已注册监听器（见 allChromeListeners），
 *    陈旧监听器无害（stale 实例已 dispose 退避集为空；dashboard 监听器对 lease-prompt 类型不响应）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const managedTaskRunner = vi.hoisted(() => vi.fn());
const registeredTaskRunner = vi.hoisted(() => vi.fn());
const chromeSendMessage = vi.hoisted(() => vi.fn());
const onMessageAddListener = vi.hoisted(() => vi.fn());

// 容量型租约拒绝：任务体不执行，走 scheduleDeferredRetry 退避路径
vi.mock('../../../platform/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platform/tasks')>();
  return {
    ...actual,
    runManagedTask: managedTaskRunner,
    runRegisteredManagedTask: registeredTaskRunner,
  };
});

type PromptListener = (message: unknown) => void;

/** C1 门控判定读 performance.now()，必须与 setTimeout 同一 fake clock（显式 toFake 含 performance） */
const FAKE_TARGETS = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'Date',
  'performance',
] as const;

/** 跨测试累积全部已注册的 chrome onMessage 监听器（含 RM dispatcher 的历史注册，见文件头踩坑备忘） */
const allChromeListeners: PromptListener[] = [];

function resetChromeMocks(): void {
  chromeSendMessage.mockReset();
  onMessageAddListener.mockReset();
  onMessageAddListener.mockImplementation((fn: unknown) => {
    allChromeListeners.push(fn as PromptListener);
  });
}

function attemptsFor(label: string): number {
  const all = [...managedTaskRunner.mock.calls, ...registeredTaskRunner.mock.calls];
  return all.filter((call) => (call[0] as { label?: string })?.label === label).length;
}

/** 从 console.log 调用中抽取指定消息的 retryDelayMs 序列（verbose 日志） */
function consoleLogDelays(message: string, label: string): number[] {
  const logSpy = vi.mocked(console.log);
  return logSpy.mock.calls
    .filter((call) => call[1] === message && (call[2] as { label?: string })?.label === label)
    .map((call) => (call[2] as { retryDelayMs?: number }).retryDelayMs ?? -1);
}

/** 建 orchestrator（指定 visibility），add 指定任务并 run() 到首次尝试完成（t1≤50ms） */
async function setup(visibility: DocumentVisibilityState, labels: string[]) {
  vi.useFakeTimers({ toFake: [...FAKE_TARGETS] });
  // 退避抖动固定为 0 → delay = min(30s, 1200 × 2^n) × 0.8
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      sendMessage: chromeSendMessage,
      onMessage: { addListener: onMessageAddListener },
      lastError: null,
    },
  };
  resetChromeMocks();
  const rejectRunner = async (_descriptor: unknown, _runner: () => Promise<unknown>) => ({
    executed: false,
    waitReason: 'bucket:translate',
  });
  managedTaskRunner.mockImplementation(rejectRunner);
  registeredTaskRunner.mockImplementation(rejectRunner);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => visibility === 'hidden');
  const mod = await import('./initOrchestrator');
  // 模块尾单例同样会订阅 prompt —— dispose 摘除，保证只有被测实例响应
  mod.initOrchestrator.dispose();
  const orchestrator = new mod.InitOrchestrator();
  (orchestrator as unknown as { verbose: boolean }).verbose = true;
  for (const label of labels) {
    await orchestrator.add('idle', vi.fn(() => undefined), { label, visibilityPolicy: 'background_throttled' });
  }
  await orchestrator.run();
  await vi.advanceTimersByTimeAsync(50);
  // fire 本文件累积的全部监听器：RM dispatcher（可能由首个测试的模块实例安装）与
  // 各模块的 dashboard 监听器都在其中；对被测实例，只有 RM dispatcher 会触发 handleLeasePrompt
  const firePrompt = () =>
    allChromeListeners.forEach((fn) => fn({ type: 'task-center:lease-prompt', payload: { reason: 'task-completed' } }));
  expect(allChromeListeners.length).toBeGreaterThan(0);
  return { orchestrator, firePrompt };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.clearAllMocks();
  delete (globalThis as Record<string, unknown>).chrome;
});

describe('InitOrchestrator SW 租约 prompt 唤醒（S1-14 A3/C1）', () => {
  it('C1: prompt 距上次尝试 <15s → 门控跳过，退避链与 denials 语义不受影响', async () => {
    const A = 'preview:bgA';
    const { orchestrator, firePrompt } = await setup('hidden', [A]);
    expect(attemptsFor(A)).toBe(1);

    // ① 首次尝试后 40ms 内 prompt 到达：间隔 <15s → 门控，不唤醒
    firePrompt();
    await vi.advanceTimersByTimeAsync(40);
    expect(attemptsFor(A)).toBe(1);

    // ② 退避定时器照常触发（a2，960ms）；尝试后立刻 prompt → 仍门控（定时器未被 prompt 干扰）
    await vi.advanceTimersByTimeAsync(960);
    expect(attemptsFor(A)).toBe(2);
    firePrompt();
    await vi.advanceTimersByTimeAsync(40);
    expect(attemptsFor(A)).toBe(2);

    // ③ a3 由定时器触发；退避序列 [960,1920,3840] 完整 —— 门控只拦 prompt，不改退避链
    await vi.advanceTimersByTimeAsync(1920);
    expect(attemptsFor(A)).toBe(3);
    expect(consoleLogDelays('deferred retry scheduled', A)).toEqual([960, 1920, 3840]);
    orchestrator.dispose();
  });

  it('C1: 间隔 ≥15s → 正常唤醒，且在飞退避定时器被取消（旧到期点不二次触发）', async () => {
    const A = 'preview:bgA';
    const { orchestrator, firePrompt } = await setup('hidden', [A]);
    expect(attemptsFor(A)).toBe(1);

    // a2~a5：退避链推进到第 5 次尝试；此刻 last=t5，在飞定时器=t5+15360（denials=4 轮）
    await vi.advanceTimersByTimeAsync(960 + 1920 + 3840 + 7680);
    expect(attemptsFor(A)).toBe(5);

    // 距 last 15060ms（≥15s 门控窗，且未越过在飞定时器到期点）→ prompt 唤醒 a6
    await vi.advanceTimersByTimeAsync(15060);
    firePrompt();
    await vi.advanceTimersByTimeAsync(10);
    expect(attemptsFor(A)).toBe(6);

    // 在飞退避定时器（旧到期点 ≈t5+15360）已被取消：越过该点无第 7 次尝试；
    // a6 被拒后的新退避（24000ms）也尚未到期 → 总数保持 6
    await vi.advanceTimersByTimeAsync(20000);
    expect(attemptsFor(A)).toBe(6);
    orchestrator.dispose();
  });

  it('C1: 多任务跳过未达间隔者取下一条，每 prompt 至多唤醒一条', async () => {
    const A = 'preview:bgA';
    const B = 'preview:bgB';
    const { orchestrator, firePrompt } = await setup('hidden', [A, B]);
    expect(attemptsFor(A)).toBe(1);
    expect(attemptsFor(B)).toBe(1);

    // a2~a5 / b2~b5：A、B 退避链并行推进（A 先入 Map）
    await vi.advanceTimersByTimeAsync(960 + 1920 + 3840 + 7680);
    expect(attemptsFor(A)).toBe(5);
    expect(attemptsFor(B)).toBe(5);

    // 第一次 prompt：A（先插入）满足间隔 → 唤醒 A；B 继续按自己的退避定时器排程
    await vi.advanceTimersByTimeAsync(15060);
    firePrompt();
    await vi.advanceTimersByTimeAsync(10);
    expect(attemptsFor(A)).toBe(6);
    expect(attemptsFor(B)).toBe(5);

    // 第二次 prompt（500ms 后）：A 刚尝试过（间隔 500ms<15s）→ 跳过；B 满足间隔 → 唤醒 B
    await vi.advanceTimersByTimeAsync(500);
    firePrompt();
    await vi.advanceTimersByTimeAsync(10);
    expect(attemptsFor(A)).toBe(6);
    expect(attemptsFor(B)).toBe(6);
    orchestrator.dispose();
  });

  it('C1: 唤醒后再次被拒，退避不降级（denials 不重置，A3 核心语义在门控下保留）', async () => {
    const A = 'preview:bgA';
    const { orchestrator, firePrompt } = await setup('hidden', [A]);
    await vi.advanceTimersByTimeAsync(960 + 1920 + 3840 + 7680);
    expect(attemptsFor(A)).toBe(5);
    await vi.advanceTimersByTimeAsync(15060);
    firePrompt();
    await vi.advanceTimersByTimeAsync(10);
    expect(attemptsFor(A)).toBe(6);
    // a6（prompt 唤醒）被拒后按 denials=5 排 24000ms（封顶步长），而不是重置回 base 960ms：
    // 完整退避序列单调升级、无回落
    expect(consoleLogDelays('deferred retry scheduled', A)).toEqual([960, 1920, 3840, 7680, 15360, 24000]);
    orchestrator.dispose();
  });

  it('visible 页忽略 prompt（防御性早退；前台容量型拒绝走普通 400ms 退避，行为与改前一致）', async () => {
    const A = 'preview:bgA';
    const { orchestrator, firePrompt } = await setup('visible', [A]);
    expect(attemptsFor(A)).toBe(1);

    firePrompt();
    await vi.advanceTimersByTimeAsync(10);
    // prompt 早退：不额外触发任务
    expect(attemptsFor(A)).toBe(1);

    // 前台容量型拒绝不进 hidden 退避集，走普通 400ms 退避照常重请求
    await vi.advanceTimersByTimeAsync(400);
    expect(attemptsFor(A)).toBe(2);
    orchestrator.dispose();
  });
});
