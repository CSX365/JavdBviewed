export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    const afterFrame = () => {
      setTimeout(resolve, 0);
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(afterFrame);
    } else {
      setTimeout(afterFrame, 0);
    }
  });
}

export interface HomeChartRenderTask {
  cancel: () => void;
}

export interface ScheduleDeferredRenderOptions {
  /** 最小等待（首屏保护窗）：到期后才进入空闲队列；0 表示直接排空闲。 */
  guardMs?: number;
  /** 空闲超时上限（透传给 scheduleHomeChartRender）。 */
  timeoutMs?: number;
  /** 取消信号：guard 期或空闲期 abort 都终止任务。 */
  signal?: AbortSignal;
}

/**
 * L-5：两段式延迟调度「非首屏必需」的重活（如 g2plot ~1MB 脚本注入）。
 * 先等 guardMs 保护窗（避开冷启动顶层求值高峰），再等主线程空闲执行。
 * guard 期用 setTimeout、空闲期用 requestIdleCallback（不可用时退化为 setTimeout），
 * signal abort 或 cancel 在任一阶段都立即终止。
 */
export function scheduleDeferredRender(
  run: () => void,
  options: ScheduleDeferredRenderOptions = {},
): HomeChartRenderTask {
  let cancelled = false;
  let guardTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTask: HomeChartRenderTask | null = null;
  const onAbort = (): void => {
    if (cancelled) return;
    cancelled = true;
    if (guardTimer !== null) {
      clearTimeout(guardTimer);
      guardTimer = null;
    }
    idleTask?.cancel();
  };
  const finish = (): void => {
    if (cancelled) return;
    cancelled = true;
    run();
  };
  const startIdle = (): void => {
    if (cancelled) return;
    idleTask = scheduleHomeChartRender(finish, { timeoutMs: options.timeoutMs });
  };
  if (options.signal?.aborted) return { cancel: () => undefined };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const guardMs = options.guardMs ?? 0;
  if (guardMs > 0) {
    guardTimer = setTimeout(startIdle, guardMs);
  } else {
    startIdle();
  }
  return {
    cancel: (): void => {
      onAbort();
      options.signal?.removeEventListener('abort', onAbort);
    },
  };
}

export function createHomeChartRenderQueue(
  options: { timeoutMs?: number; gapFrames?: number } = {},
): {
  enqueue: (render: () => void | Promise<void>) => void;
  cancel: () => void;
} {
  const pending: Array<() => void | Promise<void>> = [];
  let active: HomeChartRenderTask | null = null;
  // cycle-9 A2：任务间帧间隙。旧实现在上一个空闲回调内就排下一个，
  // 连续图表渲染会在同一帧内背靠背执行（首渲爆发）；
  // 现在等当前任务体（含 async 尾部）完成后让出 gapFrames 帧再排下一个。
  const gapFrames = Math.max(0, options.gapFrames ?? 0);
  const scheduleNext = (): void => {
    if (active || pending.length === 0) return;
    const body = pending.shift();
    if (!body) return;
    active = scheduleHomeChartRender(async () => {
      const result = body();
      if (result && typeof (result as Promise<void>).then === 'function') {
        try { await (result as Promise<void>); } catch { /* 任务体内部异常自吞 */ }
      }
      for (let i = 0; i < gapFrames; i += 1) {
        try { await yieldToBrowser(); } catch { break; }
      }
      active = null;
      scheduleNext();
    }, options);
  };
  return {
    enqueue: (render: () => void | Promise<void>): void => {
      pending.push(render);
      scheduleNext();
    },
    cancel: (): void => {
      pending.length = 0;
      active?.cancel();
      active = null;
    },
  };
}

export function scheduleHomeChartRender(
  render: () => void,
  options: { timeoutMs?: number } = {},
): HomeChartRenderTask {
  let cancelled = false;
  let idleId: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const run = (): void => {
    if (cancelled) return;
    cancelled = true;
    render();
  };
  const timeoutMs = options.timeoutMs ?? 1200;
  const scheduler = globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof scheduler.requestIdleCallback === 'function') {
    idleId = scheduler.requestIdleCallback(run, { timeout: timeoutMs });
  } else {
    timeoutId = setTimeout(run, timeoutMs);
  }
  return {
    cancel: () => {
      cancelled = true;
      if (idleId !== null && typeof scheduler.cancelIdleCallback === 'function') {
        scheduler.cancelIdleCallback(idleId);
      }
      if (timeoutId !== null) clearTimeout(timeoutId);
    },
  };
}
