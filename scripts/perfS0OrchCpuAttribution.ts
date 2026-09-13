/**
 * @file perfS0OrchCpuAttribution.ts
 * @description S0（cycle-8）：把页面 LoAF 条目的 CPU 时间（blockingDuration）离线归因到
 * orchestrator 任务标签。数据源均为页面内 performance.now() 同源时间戳：
 *   - timeline：orchestrator.getState().timeline（ts=事件发生时的绝对值，durationMs=任务执行墙钟时长）
 *   - loaf：LoAF observer 采集的 { s=startTime, b=blockingDuration }
 * 纯函数，便于单测；perfS0Profile.ts 的剧本 C 采集侧调用后落 `${label}-orch-cpu.json` sidecar。
 * @module scripts
 */

/** orchestrator timeline 条目（getState() 返回形态的子集） */
export interface OrchTimelineEntry {
  phase: string;
  label: string;
  status: 'scheduled' | 'running' | 'done' | 'error';
  ts: number;
  detail?: unknown;
  durationMs?: number;
}

/** LoAF 条目（采集侧字段：s=startTime, d=duration, b=blockingDuration, inv/u/f=归因元信息） */
export interface LoafCpuEntry {
  s: number;
  d?: number;
  b?: number;
  inv?: string;
  u?: string;
  f?: string;
}

export interface OrchCpuTaskAttribution {
  phase: string;
  label: string;
  /** 任务执行墙钟时长合计（同 label 多次执行求和；并发任务墙钟窗口可重叠，仅参考） */
  wallMs: number;
  /** 归因到的 LoAF CPU 时间合计（blockingDuration，ms） */
  cpuMs: number;
  /** 落入该任务窗口的 LoAF 帧数 */
  frames: number;
}

export interface OrchCpuAttributionResult {
  tasks: OrchCpuTaskAttribution[];
  unattributed: { cpuMs: number; frames: number };
  totalCpuMs: number;
  totalFrames: number;
}

interface TaskWindow {
  phase: string;
  label: string;
  start: number;
  end: number;
  durationMs: number;
}

/** 从 timeline 构建任务执行窗口：仅 done/error 且 durationMs>0 的条目构成 [ts-durationMs, ts] 窗口。 */
export function buildTaskWindows(timeline: OrchTimelineEntry[] | null | undefined): TaskWindow[] {
  if (!timeline) return [];
  const windows: TaskWindow[] = [];
  for (const entry of timeline) {
    if (!entry || (entry.status !== 'done' && entry.status !== 'error')) continue;
    const durationMs = entry.durationMs;
    if (!Number.isFinite(entry.ts) || typeof durationMs !== 'number' || !Number.isFinite(durationMs)) continue;
    if (durationMs <= 0) continue;
    windows.push({
      phase: entry.phase,
      label: entry.label || 'anonymous',
      start: entry.ts - durationMs,
      end: entry.ts,
      durationMs,
    });
  }
  return windows;
}

/**
 * 归因主函数：对每条 LoAF 记录，找包含其 startTime 的任务窗口；
 * 多个窗口重叠时归属最早开始的窗口（保守、确定性）；无窗口命中记 unattributed。
 * 同一 phase::label 的多个窗口合并累计。
 */
export function attributeLoafCpuToTasks(
  timeline: OrchTimelineEntry[] | null | undefined,
  loaf: LoafCpuEntry[] | null | undefined,
): OrchCpuAttributionResult {
  const windows = buildTaskWindows(timeline);
  const byKey = new Map<string, OrchCpuTaskAttribution & { start: number }>();
  let unattributedCpuMs = 0;
  let unattributedFrames = 0;
  let totalCpuMs = 0;
  let totalFrames = 0;

  if (loaf && loaf.length > 0) {
    for (const entry of loaf) {
      if (!entry || !Number.isFinite(entry.s)) continue;
      const cpu = Number.isFinite(entry.b) ? (entry.b as number) : 0;
      if (cpu <= 0) continue; // 无 blockingDuration 数据的帧不参与 CPU 归因（诚实口径）
      totalCpuMs += cpu;
      totalFrames += 1;

      let best: TaskWindow | null = null;
      for (const w of windows) {
        if (entry.s >= w.start && entry.s < w.end) {
          if (!best || w.start < best.start) best = w;
        }
      }
      if (!best) {
        unattributedCpuMs += cpu;
        unattributedFrames += 1;
        continue;
      }
      const key = `${best.phase}::${best.label}`;
      const acc = byKey.get(key) ?? {
        phase: best.phase,
        label: best.label,
        wallMs: 0,
        cpuMs: 0,
        frames: 0,
        start: best.start,
      };
      acc.cpuMs += cpu;
      acc.frames += 1;
      byKey.set(key, acc);
    }
  }

  // 墙钟时长按 phase::label 合并（所有 done/error 窗口，无论是否有 CPU 命中）
  for (const w of windows) {
    const key = `${w.phase}::${w.label}`;
    const acc = byKey.get(key) ?? { phase: w.phase, label: w.label, wallMs: 0, cpuMs: 0, frames: 0, start: w.start };
    acc.wallMs += w.durationMs;
    byKey.set(key, acc);
  }

  const tasks = [...byKey.values()]
    .map(({ start: _start, ...rest }) => ({
      ...rest,
      wallMs: Math.round(rest.wallMs),
      cpuMs: Math.round(rest.cpuMs),
    }))
    .sort((a, b) => b.cpuMs - a.cpuMs || b.wallMs - a.wallMs);

  return {
    tasks,
    unattributed: { cpuMs: Math.round(unattributedCpuMs), frames: unattributedFrames },
    totalCpuMs: Math.round(totalCpuMs),
    totalFrames,
  };
}

/** 跨 tab 汇总：把多个 tab 的归因结果按 phase::label 合并（窗口本身不可跨 tab 合并，各 tab 时钟独立）。 */
export function aggregateOrchCpuAttributions(results: OrchCpuAttributionResult[]): OrchCpuAttributionResult {
  const byKey = new Map<string, OrchCpuTaskAttribution>();
  let unattributedCpuMs = 0;
  let unattributedFrames = 0;
  let totalCpuMs = 0;
  let totalFrames = 0;
  for (const r of results) {
    if (!r) continue;
    totalCpuMs += r.totalCpuMs;
    totalFrames += r.totalFrames;
    unattributedCpuMs += r.unattributed?.cpuMs ?? 0;
    unattributedFrames += r.unattributed?.frames ?? 0;
    for (const t of r.tasks ?? []) {
      const key = `${t.phase}::${t.label}`;
      const acc = byKey.get(key) ?? { phase: t.phase, label: t.label, wallMs: 0, cpuMs: 0, frames: 0 };
      acc.cpuMs += t.cpuMs;
      acc.wallMs += t.wallMs;
      acc.frames += t.frames;
      byKey.set(key, acc);
    }
  }
  const tasks = [...byKey.values()]
    .map((t) => ({ ...t, wallMs: Math.round(t.wallMs), cpuMs: Math.round(t.cpuMs) }))
    .sort((a, b) => b.cpuMs - a.cpuMs || b.wallMs - a.wallMs);
  return {
    tasks,
    unattributed: { cpuMs: Math.round(unattributedCpuMs), frames: unattributedFrames },
    totalCpuMs: Math.round(totalCpuMs),
    totalFrames,
  };
}
