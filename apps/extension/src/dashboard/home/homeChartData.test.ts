import { describe, expect, it } from 'vitest';
import {
  buildHomeStatusData,
  buildHomeTagsBarData,
  buildHomeTagsBarOptions,
  buildHomeStatusDonutOptions,
  HOME_CHART_COLOR_FALLBACKS,
  HOME_TAGS_BAR_COLORS,
  HOME_TAGS_BAR_PAGE_SIZE,
  readHomeChartColors,
} from './homeChartData';

describe('buildHomeStatusData', () => {
  it('builds the three status slices with theme-aware colors', () => {
    expect(buildHomeStatusData(
      { byStatus: { viewed: 2, browsed: 3, want: 4 } },
      { success: '#0a0', info: '#0bb', warning: '#f90' },
      false,
    )).toEqual([
      { name: '已观看', value: 2, color: '#0a0' },
      { name: '已浏览', value: 3, color: '#0bb' },
      { name: '想看', value: 4, color: '#f90' },
    ]);
  });
});
describe('readHomeChartColors', () => {
  it('非浏览器环境（node）返回 10 个兜底 token', () => {
    expect(readHomeChartColors()).toEqual({
      primary: '#3b82f6',
      success: '#22c55e',
      info: '#14b8a6',
      warning: '#f59e0b',
      danger: '#ef4444',
      text: '#111827',
      muted: '#6b7280',
      border: '#e5e7eb',
      surface: '#ffffff',
      pieBorder: '#f5f7fb',
    });
    expect(readHomeChartColors()).toEqual(HOME_CHART_COLOR_FALLBACKS);
  });
});

describe('buildHomeTagsBarData', () => {
  const tags = Array.from({ length: 25 }, (_, i) => ({ name: `tag${i}`, count: 25 - i }));

  it('按页切片：page=1 size=10 取第 10~19 条，颜色按页内下标循环', () => {
    const page = buildHomeTagsBarData(tags, 1, HOME_TAGS_BAR_PAGE_SIZE);
    expect(page.length).toBe(10);
    expect(page[0]).toEqual({ name: 'tag10', value: 15, color: HOME_TAGS_BAR_COLORS[0] });
    expect(page[9]).toEqual({ name: 'tag19', value: 6, color: HOME_TAGS_BAR_COLORS[9] });
  });

  it('越界页返回空数组，非法页码不抛错', () => {
    expect(buildHomeTagsBarData(tags, 5, 10)).toEqual([]);
    expect(buildHomeTagsBarData(tags, -3, 10)).toEqual(buildHomeTagsBarData(tags, 0, 10));
  });

  it('空名/非法计数被过滤，脏输入不炸', () => {
    const mixed = [
      { name: '  ', count: 5 },
      { name: 'ok', count: 3 },
      { name: 'bad', count: 'x' as any },
      null,
    ];
    // 颜色按原始位置索引循环：'ok' 在原数组第 1 位，颜色取 palette[1]
    expect(buildHomeTagsBarData(mixed as any, 0, 10)).toEqual([{ name: 'ok', value: 3, color: HOME_TAGS_BAR_COLORS[1] }]);
    expect(buildHomeTagsBarData(undefined as any, 0, 10)).toEqual([]);
  });
});

describe('buildHomeTagsBarOptions / buildHomeStatusDonutOptions', () => {
  it('主题色注入坐标轴/标签，donut 中心标题颜色跟随 muted', () => {
    const theme = { text: '#111', muted: '#666', border: '#eee' };
    const opts = buildHomeTagsBarOptions([{ name: 'a', value: 1, color: '#fff' }], theme);
    expect(opts.xAxis.label.style.fill).toBe('#666');
    expect(opts.xAxis.line.style.stroke).toBe('#eee');
    expect(opts.yAxis.label.style.fill).toBe('#666');
    expect(opts.label.style.fill).toBe('#111');
    expect(opts.color({ name: 'a', value: 1, color: '#abc' })).toBe('#abc');

    const donut = buildHomeStatusDonutOptions({ text: '#111', muted: '#666' });
    expect(donut.statistic.title.style.fill).toBe('#666');
    expect(donut.label.style.fill).toBe('#fff');
  });
});
