import { describe, expect, it, vi } from 'vitest';
import { createHomeChartRenderQueue, scheduleDeferredRender, scheduleHomeChartRender, yieldToBrowser } from './homeRenderScheduler';

describe('yieldToBrowser', () => {
  it('waits for an animation frame and a macrotask before continuing', async () => {
    const frame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const timeout = vi.fn((callback: TimerHandler) => {
      if (typeof callback === 'function') callback();
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', frame);
    vi.stubGlobal('setTimeout', timeout);

    await yieldToBrowser();

    expect(frame).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('scheduleHomeChartRender', () => {
  it('defers a non-critical chart until an idle callback and can cancel it', () => {
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 8 } as IdleDeadline);
      return 17;
    });
    const cancelIdleCallback = vi.fn();
    const render = vi.fn();
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);

    const task = scheduleHomeChartRender(render);

    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(1);
    task.cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(17);
    vi.unstubAllGlobals();
  });

  it('uses a timeout fallback when requestIdleCallback is unavailable', () => {
    const timeout = vi.fn((callback: TimerHandler) => {
      if (typeof callback === 'function') callback();
      return 23;
    });
    const render = vi.fn();
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.stubGlobal('setTimeout', timeout);

    const task = scheduleHomeChartRender(render, { timeoutMs: 900 });

    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 900);
    expect(render).toHaveBeenCalledTimes(1);
    task.cancel();
    vi.unstubAllGlobals();
  });
});

describe('createHomeChartRenderQueue', () => {
  it('runs non-critical charts one idle slice at a time', () => {
    const callbacks: IdleRequestCallback[] = [];
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const cancelIdleCallback = vi.fn();
    const render = vi.fn();
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);

    const queue = createHomeChartRenderQueue();
    queue.enqueue(() => render('first'));
    queue.enqueue(() => render('second'));

    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
    callbacks.shift()?.({ didTimeout: false, timeRemaining: () => 8 } as IdleDeadline);
    expect(render).toHaveBeenCalledWith('first');
    expect(requestIdleCallback).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledTimes(1);
    callbacks.shift()?.({ didTimeout: false, timeRemaining: () => 8 } as IdleDeadline);
    expect(render).toHaveBeenCalledWith('second');

    queue.cancel();
    expect(cancelIdleCallback).toHaveBeenCalledTimes(0);
    vi.unstubAllGlobals();
  });
});

describe('scheduleDeferredRender', () => {
  const fireIdle = (callbacks: IdleRequestCallback[]) => {
    callbacks.shift()?.({ didTimeout: false, timeRemaining: () => 8 } as IdleDeadline);
  };

  it('先等满 guardMs 保护窗再进入空闲队列（首屏保护）', () => {
    const callbacks: IdleRequestCallback[] = [];
    const requestIdleCallback = vi.fn((cb: IdleRequestCallback) => { callbacks.push(cb); return 1; });
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);
    vi.useFakeTimers();
    const run = vi.fn();
    const task = scheduleDeferredRender(run, { guardMs: 100, timeoutMs: 500 });
    expect(requestIdleCallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(run).not.toHaveBeenCalled();
    expect(requestIdleCallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 500 });
    fireIdle(callbacks);
    expect(run).toHaveBeenCalledTimes(1);
    task.cancel();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('guardMs=0 时直接进入空闲队列（刷新场景）', () => {
    const callbacks: IdleRequestCallback[] = [];
    const requestIdleCallback = vi.fn((cb: IdleRequestCallback) => { callbacks.push(cb); return 2; });
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    const run = vi.fn();
    scheduleDeferredRender(run, { guardMs: 0 });
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    fireIdle(callbacks);
    expect(run).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('guard 期内 abort 终止任务（计时器被清掉）', () => {
    const controller = new AbortController();
    vi.stubGlobal('requestIdleCallback', undefined);
    const run = vi.fn();
    vi.useFakeTimers();
    scheduleDeferredRender(run, { guardMs: 100, signal: controller.signal });
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('空闲期内 abort 取消空闲任务', () => {
    const callbacks: IdleRequestCallback[] = [];
    const requestIdleCallback = vi.fn((cb: IdleRequestCallback) => { callbacks.push(cb); return 3; });
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);
    const controller = new AbortController();
    const run = vi.fn();
    scheduleDeferredRender(run, { guardMs: 0, signal: controller.signal });
    expect(callbacks.length).toBe(1);
    controller.abort();
    expect(cancelIdleCallback).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('signal 已 abort 时任务不会执行', () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn();
    vi.stubGlobal('requestIdleCallback', vi.fn(() => 4));
    scheduleDeferredRender(run, { guardMs: 0, signal: controller.signal });
    expect(run).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('cancel() 后不再执行，即使 guard 到期', () => {
    vi.stubGlobal('requestIdleCallback', vi.fn(() => 5));
    const run = vi.fn();
    vi.useFakeTimers();
    const task = scheduleDeferredRender(run, { guardMs: 100 });
    task.cancel();
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
