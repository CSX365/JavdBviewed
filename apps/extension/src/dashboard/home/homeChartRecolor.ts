// cycle-13：首页图表「主题切换轻量重着色」模块（纯函数 + 薄 applier，可单测）。
//
// 背景：themeManager 的 light/dark 切换原先会触发 initOrUpdateHomeCharts() 全量刷新
// （加载遮罩 + DB 重拉 + 重渲 8 图）。cycle-13 初版用 G2Plot inst.update(patch) 做「只改颜色」，
// 但真机验证 vendored g2plot 2.4.35 的 update() = chart.clear() + 全量重渲，视觉上就是
// 「图表重新加载」闪烁，用户不可接受。本版改为 G2Plot **就地改属性**：
// 直接改已有 geometry shape 的 fill/stroke 与图例/统计/坐标轴 DOM 节点，
// 不重建图表、不动数据、不触发任何重绘管线之外的布局。
//
// 真机（vendored G2）已验证的内部结构：
//   - element.shape.get('fill') 返回 null，读写一律走 shape.attr()；
//     attr(对象) 走 setAttr → afterAttrsChange → autoDraw 时重画，值未变则跳过（天然幂等）；
//   - el.labelShape 是数组，labelShape[0] 是 Group，柱值标签的 text 节点要从 get('el') 的 DOM 里找；
//   - 轴控制器 axis.axisContainer / axis.gridContainer 是 Group，DOM 需递归遍历
//     （text → fill，path/line → stroke）；
//   - 图例 DOM 有确定性 id：-legend-item-<name>-marker|-name|-background|-radio
//     （donut 的 marker 是 fill 着色，trend 的 marker 是 stroke 着色）；
//   - donut 的 statistic 是 2 个 HTML 节点（div.g2-html-annotation）而非 SVG：
//     「总数」标题（font-weight 300）+ 数字内容（font-weight 700），首渲颜色不跟主题，需补涂。
//
// 顺带修的首渲 bug：vendored bundle 里 interval（Bar）的 color 回调/数组通道失效，
// tagsTop 柱会全部画成 G2 默认蓝 #5B8FF9（Pie/Line 的 color 通道正常）。
// 修法：渲染完成后用同一套「调色板补涂」（bar op）幂等修正，首渲与主题切换共用。

import {
  buildHomeStatusData,
  buildHomeTagsBarData,
  HOME_TAGS_BAR_PAGE_SIZE,
  readHomeChartColors,
  type HomeChartColors,
  type HomeStatusData,
} from './homeChartData';

export interface HomeNewWorksStats {
  today?: number;
  week?: number;
  unread?: number;
}

/**
 * 渲染 pass 结束时的数据快照。recolor 只依赖它 + 当前主题颜色，不触碰任何数据源。
 * - g2plot 路径：ins 为 insights 聚合，records/actors/newWorks 为趋势原始数组；
 * - echarts 路径：趋势图不渲染，三者为 []；ins 为 aggregateMonthly 结果（仅存档）。
 */
export interface HomeChartsRecolorContext {
  renderer: 'g2plot' | 'echarts';
  s: HomeStatusData | null;
  w: HomeNewWorksStats | null;
  ins: any;
  tagsTop: Array<{ name: string; count: number }>;
  records: any[];
  actors: any[];
  newWorks: any[];
}

export type HomeG2PlotChartKey =
  | 'statusDonut'
  | 'tagsTop'
  | 'recordsTrend'
  | 'actorsTrend'
  | 'newWorksTrend';

const TREND_CHART_KEYS = ['recordsTrend', 'actorsTrend', 'newWorksTrend'] as const;
type TrendChartKey = (typeof TREND_CHART_KEYS)[number];

const TREND_SERIES_COLOR_KEYS: Record<TrendChartKey, Record<string, keyof HomeChartColors>> = {
  recordsTrend: { '总记录': 'primary', '已观看': 'success', '已浏览': 'info', '想看': 'warning' },
  actorsTrend: { '总演员数': 'primary', '女性': 'success', '男性': 'info', '拉黑': 'danger' },
  newWorksTrend: { '当天总量': 'primary', '未读': 'warning', '已读': 'success' },
};

// ---------------------------------------------------------------------------
// 纯颜色映射（可单测）
// ---------------------------------------------------------------------------

/** donut 扇区：状态名 → 颜色（深色主题用亮色固定值，与首渲 buildHomeStatusData 一致）。 */
export function buildHomeDonutSectorFills(
  stats: HomeStatusData | null | undefined,
  colors: HomeChartColors,
  isDark: boolean,
): Record<string, string> {
  return Object.fromEntries(buildHomeStatusData(stats, colors, isDark).map((d) => [d.name, d.color]));
}

/** tagsTop 柱：标签名 → 固定调色板颜色（与 buildHomeTagsBarData 的取页/过滤逻辑一致）。 */
export function buildHomeTagsBarFills(
  tags: Array<{ name: string; count: number }>,
  page: number,
  pageSize: number = HOME_TAGS_BAR_PAGE_SIZE,
): Record<string, string> {
  return Object.fromEntries(buildHomeTagsBarData(tags, page, pageSize).map((d) => [d.name, d.color]));
}

/** 趋势线：系列名 → 主题 token 颜色。 */
export function buildHomeTrendSeriesFills(chart: TrendChartKey, colors: HomeChartColors): Record<string, string> {
  const map = TREND_SERIES_COLOR_KEYS[chart];
  return Object.fromEntries(Object.entries(map).map(([name, token]) => [name, colors[token]]));
}

// ---------------------------------------------------------------------------
// G2Plot 就地重着色 ops（纯描述，可单测）
// ---------------------------------------------------------------------------

export type HomeG2PlotRecolorOp =
  | { chart: 'statusDonut'; op: 'sector'; fills: Record<string, string> }
  | { chart: 'statusDonut'; op: 'legend'; fills: Record<string, string>; nameFill: string }
  | { chart: 'statusDonut'; op: 'statistic'; titleFill: string; contentFill: string }
  | { chart: 'tagsTop'; op: 'bar'; fills: Record<string, string> }
  | { chart: 'tagsTop'; op: 'barLabel'; fill: string }
  | { chart: 'tagsTop'; op: 'axis'; labelFill: string; stroke: string }
  | { chart: TrendChartKey; op: 'line'; fills: Record<string, string> }
  | { chart: TrendChartKey; op: 'legendMarker'; fills: Record<string, string> };

/**
 * 构造一次完整主题切换需要的就地改色 ops。
 * - donut 三个 op 恒出（实例存在即需要，空数据也是零值扇区）；
 * - tagsTop 仅当前页有数据时出（空列表走 empty state，没有图表实例）；
 * - 三条趋势恒出（零数据也会渲染占位线，实例一直在）。
 */
export function buildHomeG2PlotRecolorOps(
  ctx: HomeChartsRecolorContext | null | undefined,
  colors: HomeChartColors,
  isDark: boolean,
  tagsTopPage: number = 0,
): HomeG2PlotRecolorOp[] {
  const ops: HomeG2PlotRecolorOp[] = [];
  const sectorFills = buildHomeDonutSectorFills(ctx?.s, colors, isDark);
  ops.push({ chart: 'statusDonut', op: 'sector', fills: sectorFills });
  ops.push({ chart: 'statusDonut', op: 'legend', fills: sectorFills, nameFill: colors.muted });
  ops.push({ chart: 'statusDonut', op: 'statistic', titleFill: colors.muted, contentFill: colors.text });

  const tagsFills = ctx ? buildHomeTagsBarFills(ctx.tagsTop, tagsTopPage) : {};
  if (Object.keys(tagsFills).length > 0) {
    ops.push({ chart: 'tagsTop', op: 'bar', fills: tagsFills });
    ops.push({ chart: 'tagsTop', op: 'barLabel', fill: colors.text });
    ops.push({ chart: 'tagsTop', op: 'axis', labelFill: colors.muted, stroke: colors.border });
  }

  for (const key of TREND_CHART_KEYS) {
    const fills = buildHomeTrendSeriesFills(key, colors);
    ops.push({ chart: key, op: 'line', fills });
    ops.push({ chart: key, op: 'legendMarker', fills });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// G2Plot applier（薄胶水：G2 实例操作 + 图表容器 DOM 操作）
// ---------------------------------------------------------------------------

export interface HomeG2PlotRecolorDeps {
  /** 按 HC 键取图表容器（生产实现 = document.getElementById('home' + key)）。 */
  getShell: (chartKey: string) => { querySelectorAll: (sel: string) => ArrayLike<any> } | null;
}

/**
 * 图表容器 DOM id：'home' + 首字母大写 key（statusDonut → homeStatusDonut）。
 * 图表 key 是小写开头，DOM id 首字母大写，直接拼接会让 shell 查找全部落空
 * （legend/statistic 改色静默失效的真机 bug，cycle-13 S1 返工定位）。
 */
export function homeChartShellId(chartKey: string): string {
  return 'home' + chartKey.charAt(0).toUpperCase() + chartKey.slice(1);
}

function defaultGetShell(key: string): any {
  try {
    return typeof document === 'undefined' ? null : document.getElementById(homeChartShellId(key));
  } catch { return null; }
}

function eachGeometryElement(chart: any, fn: (el: any) => void): void {
  const geoms = chart?.getGeometries ? chart.getGeometries() : [];
  for (const geom of geoms || []) {
    const els = geom?.getElements ? geom.getElements() : [];
    for (const el of els || []) fn(el);
  }
}

function legendNameFromId(id: string, suffix: string): string {
  const prefix = '-legend-item-';
  if (!id || !id.startsWith(prefix) || !id.endsWith(suffix)) return '';
  return id.slice(prefix.length, id.length - suffix.length);
}

/** 递归遍历坐标轴 DOM：text → 标签色，path/line → 边框色（网格虚线样式独立保留）。 */
function walkAxisDom(node: any, labelFill: string, stroke: string): void {
  if (!node || node.nodeType !== 1) return;
  const tag = String(node.tagName || '').toLowerCase();
  try {
    if (tag === 'text') node.setAttribute('fill', labelFill);
    else if (tag === 'path' || tag === 'line') node.setAttribute('stroke', stroke);
  } catch {}
  const kids = node.childNodes;
  if (!kids) return;
  for (let i = 0; i < kids.length; i += 1) walkAxisDom(kids[i], labelFill, stroke);
}

function applyOneOp(inst: any, op: HomeG2PlotRecolorOp, getShell: (key: string) => any): void {
  const chart = inst?.chart;
  if (!chart) return;

  switch (op.op) {
    case 'sector':
    case 'bar':
      eachGeometryElement(chart, (el) => {
        const color = op.fills[el?.data?.name];
        if (!color || !el?.shape?.attr) return;
        try { el.shape.attr({ fill: color }); } catch {}
      });
      return;

    case 'line':
      eachGeometryElement(chart, (el) => {
        const d = el?.data;
        const series = Array.isArray(d) ? d[0]?.type : d?.type;
        const color = op.fills[series];
        if (!color || !el?.shape?.attr) return;
        try { el.shape.attr({ stroke: color }); } catch {}
      });
      return;

    case 'barLabel':
      eachGeometryElement(chart, (el) => {
        const ls = el?.labelShape;
        const group = Array.isArray(ls) ? ls[0] : ls;
        if (!group) return;
        let dom: any = null;
        try { dom = group.get ? group.get('el') : group.el; } catch {}
        const text = dom?.querySelector ? dom.querySelector('text') : null;
        if (!text?.setAttribute) return;
        try { text.setAttribute('fill', op.fill); } catch {}
      });
      return;

    case 'legend':
    case 'legendMarker': {
      const shell = getShell(op.chart);
      if (!shell) return;
      const markers = (shell.querySelectorAll('[id$="-marker"]') || []) as any[];
      for (const node of markers) {
        const color = op.fills[legendNameFromId(String(node.id || ''), '-marker')];
        if (!color) continue;
        try {
          // donut 图例 marker 是圆点（fill 着色），trend 图例 marker 是线段（stroke 着色）。
          if (op.op === 'legend') node.setAttribute('fill', color);
          else node.setAttribute('stroke', color);
        } catch {}
      }
      if (op.op === 'legend') {
        const names = (shell.querySelectorAll('[id$="-name"]') || []) as any[];
        for (const node of names) {
          try { node.setAttribute('fill', op.nameFill); } catch {}
        }
      }
      return;
    }

    case 'statistic': {
      const shell = getShell(op.chart);
      if (!shell) return;
      const anns = (shell.querySelectorAll('div.g2-html-annotation') || []) as any[];
      for (const div of anns) {
        const titleText = (div.textContent || '').trim();
        const isTitle = titleText === '总数' || String((div.style || {}).fontWeight) !== '700';
        try { div.style.color = isTitle ? op.titleFill : op.contentFill; } catch {}
      }
      return;
    }

    case 'axis': {
      const axis = chart.getController ? chart.getController('axis') : null;
      for (const container of [axis?.axisContainer, axis?.gridContainer]) {
        let dom: any = null;
        try { dom = container ? (container.get ? container.get('el') : container.el) : null; } catch {}
        walkAxisDom(dom, op.labelFill, op.stroke);
      }
      return;
    }
  }
}

/**
 * 把就地改色 ops 打到已有 G2Plot 实例上，逐 op try/catch。
 * 返回实际作用过的图表数（缺实例的图跳过，不报错）。
 */
export function applyHomeG2PlotRecolorOps(
  charts: Record<string, any>,
  ops: HomeG2PlotRecolorOp[],
  deps: Partial<HomeG2PlotRecolorDeps> = {},
): number {
  const getShell = deps.getShell || (defaultGetShell as (key: string) => any);
  const touched = new Set<string>();
  for (const op of ops) {
    const inst = charts[op.chart];
    if (!inst) continue;
    try {
      applyOneOp(inst, op, getShell);
    } catch {}
    touched.add(op.chart);
  }
  return touched.size;
}

// ---------------------------------------------------------------------------
// ECharts 回退路径（setOption merge 模式，结构与首渲一致）
// ---------------------------------------------------------------------------

function buildStatusDonutData(ctx: HomeChartsRecolorContext, colors: HomeChartColors, isDark: boolean) {
  const data = buildHomeStatusData(ctx.s, colors, isDark);
  const total = data.reduce((sum, d) => sum + Number(d.value || 0), 0);
  return { data, total };
}

/** ECharts 各图表的重着色 patch（不含任何数据拉取）。 */
export function buildHomeEchartsRecolorPatches(
  ctx: HomeChartsRecolorContext,
  colors: HomeChartColors,
  isDark: boolean,
): Record<string, Record<string, any> | null> {
  const { data: statusData, total } = buildStatusDonutData(ctx, colors, isDark);
  const patches: Record<string, Record<string, any> | null> = {};

  patches.statusDonut = {
    legend: { textStyle: { color: colors.muted } },
    graphic: [{
      type: 'text',
      left: 'center',
      top: 'middle',
      z: 10,
      style: {
        text: `总数\n${total}`,
        textAlign: 'center',
        fill: colors.text,
        lineHeight: 18,
        fontSize: 14,
        fontWeight: 700,
      },
    }],
    series: [{
      itemStyle: {
        borderRadius: 12,
        borderWidth: 2,
        borderColor: colors.pieBorder,
        shadowBlur: isDark ? 10 : 6,
        shadowColor: isDark ? 'rgba(15, 23, 42, 0.35)' : 'rgba(15, 23, 42, 0.10)',
      },
      data: statusData.map((d) => ({ name: d.name, value: d.value, itemStyle: { color: d.color } })),
    }],
  };

  patches.newWorksBars = {
    xAxis: { axisLine: { lineStyle: { color: colors.border } }, axisLabel: { color: colors.muted } },
    yAxis: {
      axisLine: { lineStyle: { color: colors.border } },
      axisLabel: { color: colors.muted },
      splitLine: { lineStyle: { color: colors.border } },
    },
    series: [{ itemStyle: { color: colors.primary } }],
  };

  patches.tagsTop = {
    xAxis: { axisLine: { lineStyle: { color: colors.border } }, axisLabel: { color: colors.muted } },
    yAxis: { axisLine: { lineStyle: { color: colors.border } }, axisLabel: { color: colors.muted } },
    series: [{ label: { color: colors.text } }],
  };

  patches.tagsChange = {
    xAxis: {
      axisLine: { lineStyle: { color: colors.border } },
      axisLabel: { color: colors.muted },
      splitLine: { lineStyle: { color: colors.border } },
    },
    yAxis: { axisLine: { lineStyle: { color: colors.border } }, axisLabel: { color: colors.muted } },
    series: [{ label: { color: colors.text } }],
  };

  patches.newTagsTop = {
    xAxis: { axisLine: { lineStyle: { color: colors.border } }, axisLabel: { color: colors.muted } },
    yAxis: { axisLine: { lineStyle: { color: colors.border } }, axisLabel: { color: colors.muted } },
    series: [{ label: { color: colors.text } }],
  };

  return patches;
}

/** 把 patch 打到已有 ECharts 实例上，逐实例 try/catch；返回成功应用的图表数。 */
export function applyHomeEchartsRecolor(
  charts: Record<string, any>,
  patches: Record<string, Record<string, any> | null>,
): number {
  let applied = 0;
  for (const key of Object.keys(patches)) {
    const patch = patches[key];
    if (!patch) continue;
    const inst = charts[key];
    if (!inst || typeof inst.setOption !== 'function') continue;
    try { inst.setOption({ animation: false }); } catch {}
    try { inst.setOption(patch); applied += 1; } catch {}
  }
  return applied;
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

/** 按上下文渲染器把主题颜色就地打到已有图表上（G2Plot 就地改属性 / ECharts merge）。 */
export function recolorHomeChartsInPlace(
  charts: Record<string, any>,
  ctx: HomeChartsRecolorContext,
  colors: HomeChartColors,
  isDark: boolean,
  tagsTopPage: number,
): number {
  return ctx.renderer === 'g2plot'
    ? applyHomeG2PlotRecolorOps(charts, buildHomeG2PlotRecolorOps(ctx, colors, isDark, tagsTopPage))
    : applyHomeEchartsRecolor(charts, buildHomeEchartsRecolorPatches(ctx, colors, isDark));
}

function currentThemeIsDark(): boolean {
  try {
    return typeof document !== 'undefined' && document.documentElement?.getAttribute('data-theme') === 'dark';
  } catch {
    return false;
  }
}

/**
 * 首渲/翻页/漂移兜底后，按「当前主题」给单张图补色（幂等，颜色未变时 G2 内部跳过）。
 * 同时承担 tagsTop 调色板首渲 bug 的修正：Bar 的 color 回调通道在 vendored bundle 里失效，
 * 渲染完必须补涂固定调色板，之后主题切换走同一份 op，天然保持一致。
 */
export function paintHomeG2PlotChart(
  charts: Record<string, any>,
  ctx: HomeChartsRecolorContext | null | undefined,
  chartKey: HomeG2PlotChartKey,
  deps: Partial<HomeG2PlotRecolorDeps> = {},
): void {
  try {
    const colors = readHomeChartColors();
    const page = Number(charts?.__tagsTopPager?.page ?? 0) || 0;
    const ops = buildHomeG2PlotRecolorOps(ctx, colors, currentThemeIsDark(), page)
      .filter((o) => o.chart === chartKey);
    if (ops.length > 0) applyHomeG2PlotRecolorOps(charts, ops, deps);
  } catch {}
}
