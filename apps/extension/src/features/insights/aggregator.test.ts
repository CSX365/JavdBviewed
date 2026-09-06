import { describe, expect, it } from 'vitest';

import type { ViewsDaily } from '../../types/insights';
import { aggregateMonthly } from './aggregator';

const day = (date: string, tags: Record<string, number>): ViewsDaily => ({ date, tags });

describe('aggregateMonthly', () => {
  it('ranks tags by count, caps at the default topN and reports ratios against the total', () => {
    const tags: Record<string, number> = {
      A: 12, B: 11, C: 10, D: 9, E: 8, F: 7, G: 6, H: 5, I: 4, J: 3, K: 2, L: 1,
    };
    const stats = aggregateMonthly([day('2026-08-01', tags)]);

    expect(stats.tagsTop.map(t => t.name)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
    expect(stats.tagsTop[0].count).toBe(12);
    expect(stats.tagsTop[0].ratio).toBeCloseTo(12 / 78);
    expect(stats.metrics?.totalAll).toBe(78);
    expect(stats.metrics?.daysCount).toBe(1);
    expect(stats.trend).toEqual([{ date: '2026-08-01', total: 78 }]);
  });

  it('excludes meaningless tags from totals, ranking and the tag count', () => {
    const stats = aggregateMonthly([day('2026-08-01', { 影片: 50, 'Import 来源': 20, 巨乳: 30 })]);

    expect(stats.tagsTop.map(t => t.name)).toEqual(['巨乳']);
    // 无价值标签不计入总盘：totalAll = 30
    expect(stats.metrics?.totalAll).toBe(30);
    expect(stats.tagsTop[0].ratio).toBeCloseTo(1);
  });

  it('keeps the total floored at 1 and stays safe when every tag is filtered out', () => {
    const stats = aggregateMonthly([day('2026-08-01', { 是: 4, 否: 2 })]);

    expect(stats.tagsTop).toEqual([]);
    expect(stats.metrics?.totalAll).toBe(1);
    expect(stats.metrics?.hhi).toBe(0);
    expect(stats.metrics?.entropy).toBeCloseTo(0);
    expect(stats.trend).toEqual([{ date: '2026-08-01', total: 0 }]);
  });

  it('orders the trend by date and fits the least-squares slope', () => {
    const stats = aggregateMonthly([
      day('2026-08-03', { A: 30 }),
      day('2026-08-01', { A: 10 }),
      day('2026-08-02', { A: 20 }),
    ]);

    expect(stats.trend.map(p => p.total)).toEqual([10, 20, 30]);
    // 每日总数 10/20/30 → 斜率 10
    expect(stats.metrics?.trendSlope).toBeCloseTo(10);
    expect(stats.metrics?.daysCount).toBe(3);
  });

  it('computes new tags and threshold-crossing risers/fallers against the previous month', () => {
    const stats = aggregateMonthly(
      [day('2026-08-01', { A: 45, B: 45, C: 6, D: 1 })],
      { previousDays: [day('2026-07-01', { A: 90, B: 10 })] },
    );

    // 当前 97（含 D:1 噪声）/ 上月 100：A -43.6pp（falling）、B +36.4pp（rising）、C +6.2pp（低于 8pp 阈值，不算 rising）
    expect(stats.changes.rising).toEqual(['B']);
    expect(stats.changes.falling).toEqual(['A']);
    // D 计数 1 < minTagCount 3 → 不算新增
    expect(stats.changes.newTags).toEqual(['C']);
    expect(stats.changes.risingDetailed?.[0]).toMatchObject({ name: 'B', cur: 45, prev: 10 });
    expect(stats.changes.fallingDetailed?.[0].diffRatio).toBeCloseTo(45 / 97 - 90 / 100);
    expect(stats.changes.newTagsDetailed).toEqual([{ name: 'C', count: 6 }]);
  });

  it('respects rising/falling limits and sorts changes by magnitude', () => {
    const stats = aggregateMonthly(
      [day('2026-08-01', { A: 40, B: 30, C: 20, D: 10, E: 10 })],
      { previousDays: [day('2026-07-01', { A: 100, B: 100 })], risingLimit: 2 },
    );

    // rising：C +18.2pp、D/E 各 +9.1pp（并列，保持插入序）→ 截断 2 条
    expect(stats.changes.rising).toEqual(['C', 'D']);
    // falling 按降幅从大到小：B -22.7pp 先于 A -13.6pp
    expect(stats.changes.falling).toEqual(['B', 'A']);
  });

  it('returns empty changes when no previous month is provided', () => {
    const stats = aggregateMonthly([day('2026-08-01', { A: 10 })]);

    expect(stats.changes.newTags).toEqual([]);
    expect(stats.changes.rising).toEqual([]);
    expect(stats.changes.falling).toEqual([]);
    expect(stats.changes.risingDetailed).toBeUndefined();
  });

  it('honours a custom change threshold that filters out small shifts', () => {
    const stats = aggregateMonthly(
      [day('2026-08-01', { A: 90, B: 10 })],
      { previousDays: [day('2026-07-01', { A: 100 })], changeThresholdRatio: 0.3 },
    );

    // A -10pp、B +10pp 均低于 30pp 阈值
    expect(stats.changes.rising).toEqual([]);
    expect(stats.changes.falling).toEqual([]);
    // 新增标签不受阈值影响
    expect(stats.changes.newTags).toEqual(['B']);
  });
});
