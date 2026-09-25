// 首页图表数据/选项构建器（纯函数，可单测）
// cycle-13：主题切换轻量重着色（recolor）需要与首渲共用同一套构建器，
// 故从 charts.ts 搬入本模块，charts.ts 以 re-export 保持 API 兼容。

export interface HomeStatusData {
  byStatus?: {
    viewed?: number;
    browsed?: number;
    want?: number;
  };
}

export interface HomeStatusColors {
  success: string;
  info: string;
  warning: string;
}

export function buildHomeStatusData(
  stats: HomeStatusData | null | undefined,
  colors: HomeStatusColors,
  isDark: boolean,
): Array<{ name: string; value: number; color: string }> {
  return [
    { name: '已观看', value: stats?.byStatus?.viewed ?? 0, color: isDark ? '#4ade80' : colors.success },
    { name: '已浏览', value: stats?.byStatus?.browsed ?? 0, color: isDark ? '#2dd4bf' : colors.info },
    { name: '想看', value: stats?.byStatus?.want ?? 0, color: isDark ? '#fbbf24' : colors.warning },
  ];
}

/**
 * 首页图表用到的 10 个 CSS 变量颜色 token。
 * cycle-13：原先 charts.ts 里 ECharts / G2Plot 两条渲染路径各有一份内联 COLORS，
 * 现在统一由 readHomeChartColors() 读取，成为唯一颜色来源。
 */
export interface HomeChartColors {
  [key: string]: string;
  primary: string;
  success: string;
  info: string;
  warning: string;
  danger: string;
  text: string;
  muted: string;
  border: string;
  surface: string;
  pieBorder: string;
}

export const HOME_CHART_COLOR_FALLBACKS: HomeChartColors = {
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
};

const HOME_CHART_COLOR_VARS: Array<[keyof HomeChartColors, string]> = [
  ['primary', '--primary'],
  ['success', '--success'],
  ['info', '--info'],
  ['warning', '--warning'],
  ['danger', '--danger'],
  ['text', '--text'],
  ['muted', '--muted'],
  ['border', '--border'],
  ['surface', '--surface'],
  ['pieBorder', '--bg-primary'],
];

/**
 * 读取当前主题下的图表颜色 token（非浏览器环境返回兜底值）。
 * themeManager 先改 data-theme（CSS 变量随之生效）再通知监听器，
 * 因此主题切换回调里调用本函数拿到的就是新主题颜色。
 */
export function readHomeChartColors(): HomeChartColors {
  const colors: HomeChartColors = { ...HOME_CHART_COLOR_FALLBACKS };
  try {
    if (typeof document === 'undefined' || !document.documentElement) {
      return colors;
    }
    const style = getComputedStyle(document.documentElement);
    for (const [key, varName] of HOME_CHART_COLOR_VARS) {
      const v = style.getPropertyValue(varName).trim();
      if (v) colors[key] = v;
    }
  } catch {}
  return colors;
}

export interface HomeTagsBarTheme {
  text: string;
  muted: string;
  border: string;
}

export interface HomeTagsBarDatum {
  name: string;
  value: number;
  color: string;
}

export const HOME_TAGS_BAR_PAGE_SIZE = 10;

export const HOME_TAGS_BAR_COLORS = ['#60a5fa','#34d399','#fbbf24','#f472b6','#a78bfa','#f59e0b','#ef4444','#06b6d4','#84cc16','#fb7185'];

export function buildHomeTagsBarData(
  tags: Array<{ name: string; count: number }>,
  page: number,
  pageSize: number,
): HomeTagsBarDatum[] {
  const start = Math.max(0, page) * Math.max(1, pageSize);
  return (Array.isArray(tags) ? tags : [])
    .filter(tag => tag && typeof tag === 'object')
    .slice(start, start + Math.max(1, pageSize))
    .map((tag, index) => ({
      name: String(tag.name || '').trim(),
      value: Number(tag.count || 0),
      color: HOME_TAGS_BAR_COLORS[index % HOME_TAGS_BAR_COLORS.length],
    }))
    .filter(tag => tag.name && Number.isFinite(tag.value));
}

export function buildHomeTagsBarOptions(data: HomeTagsBarDatum[], theme: HomeTagsBarTheme): any {
  return {
    data,
    xField: 'value',
    yField: 'name',
    legend: false,
    autoFit: false,
    barStyle: { radius: [0, 6, 6, 0] },
    label: {
      position: 'right',
      style: { fill: theme.text, fontWeight: 700 },
    },
    tooltip: { showTitle: false },
    xAxis: {
      min: 0,
      nice: true,
      label: { style: { fill: theme.muted } },
      line: { style: { stroke: theme.border } },
      tickLine: { style: { stroke: theme.border } },
      grid: { line: { style: { stroke: theme.border, lineDash: [4, 4] } } },
    },
    yAxis: {
      label: { autoHide: true, autoEllipsis: true, style: { fill: theme.muted } },
      line: { style: { stroke: theme.border } },
      tickLine: null,
      grid: null,
    },
    color: (datum: HomeTagsBarDatum) => datum.color,
  };
}

export function buildHomeStatusDonutOptions(theme: Pick<HomeTagsBarTheme, 'text' | 'muted'>): any {
  return {
    label: {
      type: 'inner',
      offset: '-50%',
      formatter: (datum: any) => String(Number(datum?.value) || 0),
      style: { fill: '#fff', fontWeight: 700 },
    },
    statistic: {
      title: { content: '总数', style: { fill: theme.muted, fontSize: 12 } },
    },
  };
}
