/**
 * @file perfS0OrchCpuAttribution.test.ts
 * @description S0-1（cycle-8）：LoAF CPU 时间 → orchestrator 任务标签 归因纯函数单测。
 * @module scripts
 */
import { describe, it, expect } from 'vitest';
import {
  buildTaskWindows,
  attributeLoafCpuToTasks,
  aggregateOrchCpuAttributions,
  type OrchTimelineEntry,
  type LoafCpuEntry,
} from './perfS0OrchCpuAttribution';

const done = (phase: string, label: string, ts: number, durationMs: number): OrchTimelineEntry => ({
  phase,
  label,
  status: 'done',
  ts,
  durationMs,
});

describe('buildTaskWindows', () => {
  it('null/undefined/空数组返回空窗口列表', () => {
    expect(buildTaskWindows(null)).toEqual([]);
    expect(buildTaskWindows(undefined)).toEqual([]);
    expect(buildTaskWindows([])).toEqual([]);
  });

  it('仅 done/error 且 durationMs>0 的条目构成窗口 [ts-durationMs, ts]', () => {
    const timeline: OrchTimelineEntry[] = [
      done('a', 't1', 100, 40), // 窗口 [60,100]
      { phase: 'b', label: 't2', status: 'scheduled', ts: 200, durationMs: 10 },
      { phase: 'b', label: 't3', status: 'running', ts: 300, durationMs: 10 },
      done('c', 't4', 400, 0), // durationMs=0 过滤
      { phase: 'c', label: 't5', status: 'error', ts: 500, durationMs: 5 }, // error 保留 [495,500]
      { phase: 'd', label: 't6', status: 'done', ts: 600 }, // 缺 durationMs 过滤
      done('e', 't7', 700, -3), // 负值过滤
    ];
    const windows = buildTaskWindows(timeline);
    expect(windows.map((w) => `${w.phase}/${w.label}:${w.start}-${w.end}`)).toEqual([
      'a/t1:60-100',
      'c/t5:495-500',
    ]);
  });

  it('ts/durationMs 非有限值被过滤', () => {
    const windows = buildTaskWindows([
      { phase: 'a', label: 't', status: 'done', ts: Number.NaN, durationMs: 10 },
      { phase: 'b', label: 't', status: 'done', ts: 100, durationMs: Infinity },
    ]);
    expect(windows).toEqual([]);
  });

  it('空 label 回退为 anonymous', () => {
    const windows = buildTaskWindows([{ phase: 'a', label: '', status: 'done', ts: 50, durationMs: 10 }]);
    expect(windows[0].label).toBe('anonymous');
  });
});

describe('attributeLoafCpuToTasks', () => {
  it('null/空输入返回零结果', () => {
    const r = attributeLoafCpuToTasks(null, null);
    expect(r.tasks).toEqual([]);
    expect(r.unattributed).toEqual({ cpuMs: 0, frames: 0 });
    expect(r.totalCpuMs).toBe(0);
    expect(r.totalFrames).toBe(0);

    const r2 = attributeLoafCpuToTasks([done('a', 't1', 100, 40)], []);
    expect(r2.totalCpuMs).toBe(0);
    expect(r2.totalFrames).toBe(0);
    // 无 CPU 命中的窗口仍以 wallMs 出现
    expect(r2.tasks).toHaveLength(1);
    expect(r2.tasks[0]).toEqual({ phase: 'a', label: 't1', wallMs: 40, cpuMs: 0, frames: 0 });
  });

  it('窗口内 LoAF 帧归因到对应任务（含边界：起点含、终点不含）', () => {
    const timeline = [done('video', 'runCover', 100, 40)]; // [60,100)
    const loaf: LoafCpuEntry[] = [
      { s: 60, b: 8 }, // 起点 → 命中
      { s: 99.9, b: 5 }, // 内部 → 命中
      { s: 100, b: 5 }, // 终点 → 不命中
      { s: 59.9, b: 5 }, // 窗口前 → 不命中
    ];
    const r = attributeLoafCpuToTasks(timeline, loaf);
    expect(r.totalCpuMs).toBe(23);
    expect(r.totalFrames).toBe(4);
    expect(r.tasks[0].cpuMs).toBe(13);
    expect(r.tasks[0].frames).toBe(2);
    expect(r.unattributed).toEqual({ cpuMs: 10, frames: 2 });
  });

  it('重叠窗口归属最早开始者', () => {
    const timeline = [
      done('a', 'early', 100, 100), // [0,100]
      done('b', 'late', 110, 60), // [50,110]
    ];
    const loaf: LoafCpuEntry[] = [{ s: 80, b: 7 }]; // 两窗口重叠区间内
    const r = attributeLoafCpuToTasks(timeline, loaf);
    expect(r.tasks.filter((t) => t.cpuMs > 0).map((t) => `${t.phase}/${t.label}:${t.cpuMs}`)).toEqual(['a/early:7']);
    // 未命中窗口仍以 wallMs 出现（报告完整性）
    expect(r.tasks.find((t) => t.label === 'late')).toEqual({ phase: 'b', label: 'late', wallMs: 60, cpuMs: 0, frames: 0 });
    expect(r.unattributed.cpuMs).toBe(0);
  });

  it('无窗口命中记 unattributed', () => {
    const timeline = [done('a', 't1', 10, 5)]; // [5,10]
    const loaf: LoafCpuEntry[] = [{ s: 500, b: 12 }];
    const r = attributeLoafCpuToTasks(timeline, loaf);
    expect(r.tasks[0].cpuMs).toBe(0);
    expect(r.tasks[0].frames).toBe(0);
    expect(r.unattributed).toEqual({ cpuMs: 12, frames: 1 });
  });

  it('b 缺失/≤0/非有限的帧不参与 CPU 归因（诚实口径，不计 totalFrames）', () => {
    const timeline = [done('a', 't1', 100, 40)]; // [60,100]
    const loaf: LoafCpuEntry[] = [
      { s: 70 }, // 无 b
      { s: 71, b: 0 }, // b=0
      { s: 72, b: -1 }, // b<0
      { s: 73, b: Number.NaN }, // b 非有限
      { s: 74, b: 6 }, // 有效
    ];
    const r = attributeLoafCpuToTasks(timeline, loaf);
    expect(r.totalCpuMs).toBe(6);
    expect(r.totalFrames).toBe(1);
    expect(r.tasks[0].cpuMs).toBe(6);
    expect(r.tasks[0].frames).toBe(1);
    expect(r.unattributed.cpuMs).toBe(0);
    expect(r.unattributed.frames).toBe(0);
  });

  it('s 非有限的 LoAF 条目被忽略', () => {
    const timeline = [done('a', 't1', 100, 40)];
    const loaf: LoafCpuEntry[] = [{ s: Number.NaN, b: 9 }, { s: undefined as unknown as number, b: 9 }];
    const r = attributeLoafCpuToTasks(timeline, loaf);
    expect(r.totalCpuMs).toBe(0);
    expect(r.totalFrames).toBe(0);
  });

  it('同 phase::label 多窗口合并累计 cpuMs/wallMs/frames', () => {
    const timeline = [
      done('video', 'runCover', 50, 20), // [30,50]
      done('video', 'runCover', 200, 30), // [170,200]
      done('video', 'other', 300, 10), // [290,300]
    ];
    const loaf: LoafCpuEntry[] = [
      { s: 40, b: 3 },
      { s: 45, b: 4 },
      { s: 180, b: 5 },
      { s: 295, b: 2 },
    ];
    const r = attributeLoafCpuToTasks(timeline, loaf);
    const cover = r.tasks.find((t) => t.label === 'runCover');
    expect(cover).toBeDefined();
    expect(cover!.cpuMs).toBe(12);
    expect(cover!.frames).toBe(3);
    expect(cover!.wallMs).toBe(50);
    const other = r.tasks.find((t) => t.label === 'other');
    expect(other!.cpuMs).toBe(2);
    expect(other!.wallMs).toBe(10);
  });

  it('排序：cpuMs 降序，其次 wallMs 降序', () => {
    const timeline = [
      done('a', 'big-wall', 100, 1000), // 无命中
      done('b', 'mid-cpu', 200, 10),
      done('c', 'top-cpu', 300, 10),
      done('d', 'mid-cpu2', 400, 20), // 与 mid-cpu 同 cpu、更大 wall
    ];
    const loaf: LoafCpuEntry[] = [
      { s: 195, b: 5 }, // [190,200)
      { s: 295, b: 9 }, // [290,300)
      { s: 395, b: 5 }, // [380,400)
    ];
    const r = attributeLoafCpuToTasks(timeline, loaf);
    expect(r.tasks.map((t) => t.label)).toEqual(['top-cpu', 'mid-cpu2', 'mid-cpu', 'big-wall']);
  });

  it('结果数值取整', () => {
    const timeline = [done('a', 't1', 100, 3.4)];
    const loaf: LoafCpuEntry[] = [{ s: 99, b: 1.6 }];
    const r = attributeLoafCpuToTasks(timeline, loaf);
    expect(r.tasks[0].wallMs).toBe(3);
    expect(r.tasks[0].cpuMs).toBe(2);
    expect(r.totalCpuMs).toBe(2);
    expect(r.unattributed.cpuMs).toBe(0);
  });
});

describe('aggregateOrchCpuAttributions', () => {
  it('空数组返回零结果', () => {
    const r = aggregateOrchCpuAttributions([]);
    expect(r.tasks).toEqual([]);
    expect(r.totalCpuMs).toBe(0);
    expect(r.totalFrames).toBe(0);
    expect(r.unattributed).toEqual({ cpuMs: 0, frames: 0 });
  });

  it('按 phase::label 跨 tab 合并累计 cpuMs/wallMs/frames 并汇总 unattributed/total', () => {
    const a = attributeLoafCpuToTasks([done('video', 'runCover', 50, 20)], [{ s: 40, b: 3 }]);
    const b = attributeLoafCpuToTasks([done('video', 'runCover', 90, 10)], [{ s: 85, b: 4 }, { s: 500, b: 2 }]);
    const c = attributeLoafCpuToTasks([done('list', 'tagInject', 30, 5)], [{ s: 28, b: 1.4 }]);
    const r = aggregateOrchCpuAttributions([a, b, c]);
    const cover = r.tasks.find((t) => t.label === 'runCover');
    expect(cover).toEqual({ phase: 'video', label: 'runCover', wallMs: 30, cpuMs: 7, frames: 2 });
    expect(r.tasks.find((t) => t.label === 'tagInject')!.cpuMs).toBe(1);
    expect(r.totalCpuMs).toBe(10); // 3 + (4+2) + 1（各自取整后相加：1.4→1）
    expect(r.totalFrames).toBe(4);
    expect(r.unattributed).toEqual({ cpuMs: 2, frames: 1 });
  });

  it('忽略 null 项', () => {
    const a = attributeLoafCpuToTasks([done('a', 't1', 10, 5)], [{ s: 8, b: 2 }]);
    const r = aggregateOrchCpuAttributions([a, null as unknown as ReturnType<typeof attributeLoafCpuToTasks>]);
    expect(r.totalCpuMs).toBe(2);
  });
});
