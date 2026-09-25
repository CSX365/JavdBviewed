// @vitest-environment jsdom
/**
 * @file initOrchestrator.leasePrompt.test.ts
 * @description S1-14 A3：SW 槽位释放 prompt → 编排器立即重请求最老 hidden 退避任务。
 *  1) prompt 只唤醒最老一条退避任务（其余继续按各自退避定时器排程）
 *  2) 被唤醒任务的原退避定时器被取消（不会在旧到期点二次触发）
 *  3) backgroundLeaseDenials 不重置 —— 唤醒后再被拒绝，退避按升级步长排（不降级回 base）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function attemptsFor(label: string): number {
  const all = [...managedTaskRunner.mock.calls, ...registeredTaskRunner.mock.calls];
  return all.filter((call) => (call[0] as { label?: string })?.label === label).length;
}

describe('InitOrchestrator SW 租约 prompt 唤醒 hidden 退避任务（S1-14 A3）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 退避抖动固定为 0 → delay = base × 2^n × 0.8（960/1920/3840…）
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        sendMessage: chromeSendMessage,
        onMessage: { addListener: onMessageAddListener },
        lastError: null,
      },
    };
    chromeSendMessage.mockReset();
    onMessageAddListener.mockReset();
    const rejectRunner = async (_descriptor: unknown, _runner: () => Promise<unknown>) => ({
      executed: false,
      waitReason: 'bucket:translate',
    });
    managedTaskRunner.mockImplementation(rejectRunner);
    registeredTaskRunner.mockImplementation(rejectRunner);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.clearAllMocks();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  it('prompt 只唤醒最老退避任务，取消其在飞定时器，denials 不重置（退避不降级）', async () => {
    const ref = { value: 'hidden' as DocumentVisibilityState };
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => ref.value);
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => ref.value === 'hidden');
    const mod = await import('./initOrchestrator');
    // 模块尾单例同样会订阅 prompt —— dispose 摘除，保证只有被测实例响应
    mod.initOrchestrator.dispose();
    const orchestrator = new mod.InitOrchestrator();
    (orchestrator as unknown as { verbose: boolean }).verbose = true;

    const A = 'preview:bgA';
    const B = 'preview:bgB';
    await orchestrator.add('idle', vi.fn(() => undefined), { label: A, visibilityPolicy: 'background_throttled' });
    await orchestrator.add('idle', vi.fn(() => undefined), { label: B, visibilityPolicy: 'background_throttled' });
    await orchestrator.run();
    await vi.advanceTimersByTimeAsync(50);

    // 两次尝试都被容量型拒绝 → 均进退避（base 960ms，denials 各 1）
    expect(attemptsFor(A)).toBe(1);
    expect(attemptsFor(B)).toBe(1);

    // 取回 runtimeMessaging 注册的 onMessage 监听器（prompt 入口）
    const listeners = onMessageAddListener.mock.calls.map((call) => call[0] as PromptListener);
    expect(listeners.length).toBeGreaterThan(0);
    const firePrompt = () => listeners.forEach((fn) => fn({ type: 'task-center:lease-prompt', payload: { reason: 'task-completed' } }));

    firePrompt();
    await vi.advanceTimersByTimeAsync(10);

    // ① 只唤醒最老一条（A）：A 立即重请求，B 仍在退避中
    expect(attemptsFor(A)).toBe(2);
    expect(attemptsFor(B)).toBe(1);

    // ② A 的原退避定时器（base 960ms，t≈1010 到期）被取消：
    //    到该点 B 的定时器正常触发（B 第 2 次尝试），A 不二次触发
    await vi.advanceTimersByTimeAsync(970);
    expect(attemptsFor(B)).toBe(2);
    expect(attemptsFor(A)).toBe(2);

    // ③ denials 不重置：A 被 prompt 唤醒后再次拒绝 → 按升级步长（1920ms）重排，
    //    而不是重置回 base 960ms（否则 t≈1010 就该再触发，上面已断言未触发）
    const aDelays = consoleLogDelays('deferred retry scheduled', A);
    expect(aDelays).toEqual([960, 1920]);

    // A 的升级退避（≈t=50+1920=1970）到期 → 第 3 次尝试；
    // B 的下一条升级退避（≈t=1010+1920=2930）尚未到期
    await vi.advanceTimersByTimeAsync(1000);
    expect(attemptsFor(A)).toBe(3);
    expect(attemptsFor(B)).toBe(2);

    orchestrator.dispose();
  });

  it('visible 页忽略 prompt（退避集只存在于 hidden 态，防御性早退）', async () => {
    const ref = { value: 'visible' as DocumentVisibilityState };
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => ref.value);
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => ref.value === 'hidden');
    const mod = await import('./initOrchestrator');
    mod.initOrchestrator.dispose();
    const orchestrator = new mod.InitOrchestrator();
    (orchestrator as unknown as { verbose: boolean }).verbose = true;

    const A = 'preview:bgA';
    await orchestrator.add('idle', vi.fn(() => undefined), { label: A, visibilityPolicy: 'background_throttled' });
    await orchestrator.run();
    await vi.advanceTimersByTimeAsync(50);
    // 前台容量型拒绝走普通退避（400ms），不进 pendingBackgroundLeaseRetries
    expect(attemptsFor(A)).toBe(1);

    const listeners = onMessageAddListener.mock.calls.map((call) => call[0] as PromptListener);
    expect(listeners.length).toBeGreaterThan(0);
    listeners.forEach((fn) => fn({ type: 'task-center:lease-prompt', payload: { reason: 'task-completed' } }));
    await vi.advanceTimersByTimeAsync(10);
    // prompt 早退：不额外触发任务
    expect(attemptsFor(A)).toBe(1);

    orchestrator.dispose();
  });
});

/** 从 console.log 调用中抽取指定消息的 retryDelayMs 序列（verbose 日志） */
function consoleLogDelays(message: string, label: string): number[] {
  const logSpy = vi.mocked(console.log);
  return logSpy.mock.calls
    .filter((call) => call[1] === message && (call[2] as { label?: string })?.label === label)
    .map((call) => (call[2] as { retryDelayMs?: number }).retryDelayMs ?? -1);
}
