import { describe, expect, it } from 'vitest';
import {
  applyHomeEchartsRecolor,
  applyHomeG2PlotRecolorOps,
  buildHomeDonutSectorFills,
  buildHomeEchartsRecolorPatches,
  buildHomeG2PlotRecolorOps,
  homeChartShellId,
  buildHomeTagsBarFills,
  buildHomeTrendSeriesFills,
  paintHomeG2PlotChart,
  recolorHomeChartsInPlace,
  type HomeChartsRecolorContext,
  type HomeG2PlotRecolorOp,
} from './homeChartRecolor';
import { HOME_CHART_COLOR_FALLBACKS, HOME_TAGS_BAR_COLORS } from './homeChartData';

const LIGHT = { ...HOME_CHART_COLOR_FALLBACKS, success: '#22c55e', info: '#14b8a6', warning: '#f59e0b' };
const DARK = { ...LIGHT, primary: '#60a5fa', text: '#f1f5f9', muted: '#cbd5e1', border: '#334155' };

function makeContext(overrides: Partial<HomeChartsRecolorContext> = {}): HomeChartsRecolorContext {
  return {
    renderer: 'g2plot',
    s: { byStatus: { viewed: 2, browsed: 3, want: 4 } },
    w: { today: 1, week: 7, unread: 9 },
    ins: null,
    tagsTop: Array.from({ length: 25 }, (_, i) => ({ name: `tag${i}`, count: 25 - i })),
    records: [],
    actors: [],
    newWorks: [],
    ...overrides,
  };
}

function findOps(ops: HomeG2PlotRecolorOp[], chart: string, op?: string) {
  return ops.filter((o) => o.chart === chart && (!op || o.op === op));
}

describe('纯颜色映射', () => {
  it('donut 扇区：深色用亮色固定值，浅色用主题 token', () => {
    expect(buildHomeDonutSectorFills({ byStatus: { viewed: 2, browsed: 3, want: 4 } }, DARK, true))
      .toEqual({ '已观看': '#4ade80', '已浏览': '#2dd4bf', '想看': '#fbbf24' });
    expect(buildHomeDonutSectorFills(null, LIGHT, false))
      .toEqual({ '已观看': LIGHT.success, '已浏览': LIGHT.info, '想看': LIGHT.warning });
  });

  it('tagsTop 柱：按页取数并映射固定调色板（第 1 页 = 第 10~19 条）', () => {
    const fills = buildHomeTagsBarFills(
      Array.from({ length: 25 }, (_, i) => ({ name: `tag${i}`, count: 25 - i })), 1,
    );
    expect(Object.keys(fills).length).toBe(10);
    expect(fills['tag10']).toBe(HOME_TAGS_BAR_COLORS[0]);
    expect(fills['tag19']).toBe(HOME_TAGS_BAR_COLORS[9]);
    expect(fills['tag9']).toBeUndefined();
    expect(buildHomeTagsBarFills([], 0)).toEqual({});
  });

  it('趋势系列：按系列名映射主题 token', () => {
    expect(buildHomeTrendSeriesFills('recordsTrend', LIGHT))
      .toEqual({ '总记录': LIGHT.primary, '已观看': LIGHT.success, '已浏览': LIGHT.info, '想看': LIGHT.warning });
    expect(buildHomeTrendSeriesFills('actorsTrend', LIGHT)['拉黑']).toBe(LIGHT.danger);
    expect(buildHomeTrendSeriesFills('newWorksTrend', LIGHT))
      .toEqual({ '当天总量': LIGHT.primary, '未读': LIGHT.warning, '已读': LIGHT.success });
  });
});

describe('buildHomeG2PlotRecolorOps', () => {
  it('donut 恒出 sector/legend/statistic 三个 op', () => {
    const ops = buildHomeG2PlotRecolorOps(makeContext(), LIGHT, false, 0);
    expect(findOps(ops, 'statusDonut', 'sector')[0].fills).toEqual(
      buildHomeDonutSectorFills({ byStatus: { viewed: 2, browsed: 3, want: 4 } }, LIGHT, false),
    );
    expect(findOps(ops, 'statusDonut', 'legend')[0].nameFill).toBe(LIGHT.muted);
    const stat = findOps(ops, 'statusDonut', 'statistic')[0] as any;
    expect(stat.titleFill).toBe(LIGHT.muted);
    expect(stat.contentFill).toBe(LIGHT.text);
  });

  it('tagsTop 当前页有数据才出 bar/barLabel/axis', () => {
    const ops = buildHomeG2PlotRecolorOps(makeContext(), LIGHT, false, 1);
    const bar = findOps(ops, 'tagsTop', 'bar')[0] as any;
    expect(bar.fills['tag10']).toBe(HOME_TAGS_BAR_COLORS[0]);
    expect((findOps(ops, 'tagsTop', 'barLabel')[0] as any).fill).toBe(LIGHT.text);
    const axis = findOps(ops, 'tagsTop', 'axis')[0] as any;
    expect(axis.labelFill).toBe(LIGHT.muted);
    expect(axis.stroke).toBe(LIGHT.border);

    expect(buildHomeG2PlotRecolorOps(makeContext({ tagsTop: [] }), LIGHT, false, 0)
      .filter((o) => o.chart === 'tagsTop')).toHaveLength(0);
  });

  it('三条趋势各出 line + legendMarker', () => {
    const ops = buildHomeG2PlotRecolorOps(makeContext(), LIGHT, false, 0);
    for (const key of ['recordsTrend', 'actorsTrend', 'newWorksTrend'] as const) {
      expect(findOps(ops, key, 'line')).toHaveLength(1);
      expect(findOps(ops, key, 'legendMarker')).toHaveLength(1);
      expect((findOps(ops, key, 'line')[0] as any).fills).toEqual(buildHomeTrendSeriesFills(key, LIGHT));
    }
  });

  it('ctx 为 null 时仍出 donut/trend op，不出 tagsTop op', () => {
    const ops = buildHomeG2PlotRecolorOps(null, LIGHT, false, 0);
    expect(ops.some((o) => o.chart === 'statusDonut')).toBe(true);
    expect(ops.some((o) => o.chart === 'recordsTrend')).toBe(true);
    expect(ops.some((o) => o.chart === 'tagsTop')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G2Plot applier（fake 实例 + fake DOM 节点）
// ---------------------------------------------------------------------------

function fakeShape() {
  return {
    calls: [] as Array<Record<string, string>>,
    attr(attrs: Record<string, string>) { this.calls.push(attrs); },
  };
}

function fakeElement(data: any, shape: ReturnType<typeof fakeShape>, labelShape?: any) {
  return { data, shape, labelShape };
}

function fakeChart(elements: any[], axisDom: { axis?: any; grid?: any } = {}) {
  return {
    chart: {
      getGeometries: () => [{ getElements: () => elements }],
      getController: (name: string) => (name === 'axis'
        ? {
          axisContainer: { get: () => axisDom.axis ?? null },
          gridContainer: { get: () => axisDom.grid ?? null },
        }
        : null),
    },
  };
}

function fakeNode(tag: string, children: any[] = []) {
  return {
    nodeType: 1,
    tagName: tag,
    attrs: {} as Record<string, string>,
    childNodes: children,
    setAttribute(key: string, value: string) { (this as any).attrs[key] = value; },
  };
}

function fakeShell(nodes: any[]) {
  return {
    querySelectorAll(sel: string): any[] {
      if (sel === '[id$="-marker"]') return nodes.filter((n) => n.id.endsWith('-marker'));
      if (sel === '[id$="-name"]') return nodes.filter((n) => n.id.endsWith('-name'));
      if (sel === 'div.g2-html-annotation') return nodes.filter((n) => n.ann);
      return [];
    },
  };
}

function fakeLegendMarker(id: string) {
  return { id, attrs: {} as Record<string, string>, setAttribute(key: string, value: string) { (this as any).attrs[key] = value; } };
}
function fakeLegendName(id: string) {
  return { id, attrs: {} as Record<string, string>, setAttribute(key: string, value: string) { (this as any).attrs[key] = value; } };
}
function fakeAnn(text: string, fontWeight: string) {
  return { ann: true, textContent: text, style: { fontWeight, color: '' } };
}

describe('applyHomeG2PlotRecolorOps', () => {
  it('sector op：按 element.data.name 改扇区 fill', () => {
    const a = fakeShape();
    const b = fakeShape();
    const chart = fakeChart([
      fakeElement({ name: '已观看' }, a),
      fakeElement({ name: '已浏览' }, b),
      fakeElement({ name: '未知状态' }, fakeShape()),
    ]);
    const applied = applyHomeG2PlotRecolorOps({ statusDonut: chart }, [
      { chart: 'statusDonut', op: 'sector', fills: { '已观看': '#111', '已浏览': '#222' } },
    ]);
    expect(applied).toBe(1);
    expect(a.calls).toEqual([{ fill: '#111' }]);
    expect(b.calls).toEqual([{ fill: '#222' }]);
  });

  it('line op：数组型 data 取 data[0].type 映射系列色', () => {
    const a = fakeShape();
    const chart = fakeChart([
      fakeElement([{ type: '总记录' }, a], a),
    ]);
    applyHomeG2PlotRecolorOps({ recordsTrend: chart }, [
      { chart: 'recordsTrend', op: 'line', fills: { '总记录': '#abc' } },
    ]);
    expect(a.calls).toEqual([{ stroke: '#abc' }]);
  });

  it('barLabel op：从 labelShape[0].get("el") 的 DOM 里找 text 改 fill', () => {
    const labelDom = { querySelector: (sel: string) => (sel === 'text' ? fakeNode('text') : null) };
    const labelShape = [{ get: (key: string) => (key === 'el' ? labelDom : null) }];
    // labelDom.querySelector 返回的节点需要 setAttribute 记录
    const textNode = { attrs: {} as Record<string, string>, setAttribute(key: string, value: string) { this.attrs[key] = value; } };
    labelDom.querySelector = (sel: string) => (sel === 'text' ? textNode : null);
    const chart = fakeChart([fakeElement({ name: 'tag0' }, fakeShape(), labelShape)]);
    applyHomeG2PlotRecolorOps({ tagsTop: chart }, [{ chart: 'tagsTop', op: 'barLabel', fill: '#fff' }]);
    expect(textNode.attrs).toEqual({ fill: '#fff' });
  });

  it('legend op：marker 按名字 fill 着色，name 文字统一 muted', () => {
    const marker1 = fakeLegendMarker('-legend-item-已观看-marker');
    const marker2 = fakeLegendMarker('-legend-item-已浏览-marker');
    const name1 = fakeLegendName('-legend-item-已观看-name');
    const shell = fakeShell([marker1, marker2, name1]);
    const chart = fakeChart([]);
    applyHomeG2PlotRecolorOps({ statusDonut: chart }, [
      { chart: 'statusDonut', op: 'legend', fills: { '已观看': '#111', '已浏览': '#222' }, nameFill: '#muted' },
    ], { getShell: () => shell });
    expect(marker1.attrs).toEqual({ fill: '#111' });
    expect(marker2.attrs).toEqual({ fill: '#222' });
    expect(name1.attrs).toEqual({ fill: '#muted' });
  });

  it('legendMarker op：trend 图例 marker 按系列 stroke 着色', () => {
    const marker = fakeLegendMarker('-legend-item-总记录-marker');
    const shell = fakeShell([marker]);
    applyHomeG2PlotRecolorOps({ recordsTrend: fakeChart([]) }, [
      { chart: 'recordsTrend', op: 'legendMarker', fills: { '总记录': '#abc' } },
    ], { getShell: () => shell });
    expect(marker.attrs).toEqual({ stroke: '#abc' });
  });

  it('statistic op：标题与内容分色（font-weight 700 判内容）', () => {
    const title = fakeAnn('总数', '300');
    const content = fakeAnn('21', '700');
    const shell = fakeShell([title, content]);
    applyHomeG2PlotRecolorOps({ statusDonut: fakeChart([]) }, [
      { chart: 'statusDonut', op: 'statistic', titleFill: '#t', contentFill: '#c' },
    ], { getShell: () => shell });
    expect(title.style.color).toBe('#t');
    expect(content.style.color).toBe('#c');
  });

  it('axis op：递归遍历 axisContainer/gridContainer（text→fill，path/line→stroke）', () => {
    const axisRoot = fakeNode('g', [
      fakeNode('g', [fakeNode('text'), fakeNode('line')]),
      fakeNode('text'),
    ]);
    const gridRoot = fakeNode('g', [fakeNode('path')]);
    const chart = fakeChart([], { axis: axisRoot, grid: gridRoot });
    applyHomeG2PlotRecolorOps({ tagsTop: chart }, [
      { chart: 'tagsTop', op: 'axis', labelFill: '#m', stroke: '#b' },
    ]);
    // axisRoot 本身是 g（不改），内部 text/line/path 全改
    expect(axisRoot.childNodes[1].attrs).toEqual({ fill: '#m' });
    expect(axisRoot.childNodes[0].childNodes[0].attrs).toEqual({ fill: '#m' });
    expect(axisRoot.childNodes[0].childNodes[1].attrs).toEqual({ stroke: '#b' });
    expect(gridRoot.childNodes[0].attrs).toEqual({ stroke: '#b' });
  });

  it('缺实例的图跳过；单个 op 抛错不影响其余；计数按图表去重', () => {
    const chart = fakeChart([
      fakeElement({ name: '已观看' }, { attr() { throw new Error('boom'); } }),
    ]);
    const okShape = fakeShape();
    const charts = {
      statusDonut: chart,
      recordsTrend: fakeChart([fakeElement([{ type: '总记录' }], okShape)]),
      // tagsTop 缺实例
    };
    const applied = applyHomeG2PlotRecolorOps(charts as any, [
      { chart: 'statusDonut', op: 'sector', fills: { '已观看': '#111' } },
      { chart: 'tagsTop', op: 'bar', fills: { tag0: '#222' } },
      { chart: 'recordsTrend', op: 'line', fills: { '总记录': '#333' } },
      { chart: 'recordsTrend', op: 'legendMarker', fills: { '总记录': '#333' } },
    ], { getShell: () => null });
    expect(applied).toBe(2);
    expect(okShape.calls).toEqual([{ stroke: '#333' }]);
  });
});

describe('homeChartShellId', () => {
  it('首字母大写拼接 home 前缀（回归：曾直接小写拼接导致 shell 查找全部落空）', () => {
    expect(homeChartShellId('statusDonut')).toBe('homeStatusDonut');
    expect(homeChartShellId('tagsTop')).toBe('homeTagsTop');
    expect(homeChartShellId('recordsTrend')).toBe('homeRecordsTrend');
    expect(homeChartShellId('actorsTrend')).toBe('homeActorsTrend');
    expect(homeChartShellId('newWorksTrend')).toBe('homeNewWorksTrend');
  });
});

describe('recolorHomeChartsInPlace / paintHomeG2PlotChart', () => {
  it('g2plot 走就地 ops，echarts 走 setOption', () => {
    const calls: string[] = [];
    const echartsInst = {
      setOption(patch: any) { calls.push(JSON.stringify(patch)); },
    };
    const ctx = makeContext({ renderer: 'echarts' });
    recolorHomeChartsInPlace({ statusDonut: echartsInst }, ctx, LIGHT, false, 0);
    expect(calls[0]).toBe(JSON.stringify({ animation: false }));
    expect(calls.some((c) => c.includes('总数'))).toBe(true);

    const g2 = fakeChart([fakeElement({ name: '已观看' }, fakeShape())]);
    const g2Applied = recolorHomeChartsInPlace({ statusDonut: g2 } as any, makeContext(), LIGHT, false, 0);
    expect(g2Applied).toBeGreaterThan(0);
  });

  it('paintHomeG2PlotChart 只作用指定图表（node 环境用兜底色 + 注入 getShell）', () => {
    const shape = fakeShape();
    const charts = { statusDonut: fakeChart([fakeElement({ name: '已观看' }, shape)]) } as any;
    const marker = fakeLegendMarker('-legend-item-已观看-marker');
    paintHomeG2PlotChart(charts, makeContext(), 'statusDonut', { getShell: () => fakeShell([marker]) });
    // 扇区 + 图例 marker 都被补上兜底浅色主题色
    expect(shape.calls).toEqual([{ fill: HOME_CHART_COLOR_FALLBACKS.success }]);
    expect(marker.attrs).toEqual({ fill: HOME_CHART_COLOR_FALLBACKS.success });
  });
});

describe('buildHomeEchartsRecolorPatches / applyHomeEchartsRecolor', () => {
  it('donut data 按 name 带 itemStyle 颜色，graphic 中心文字颜色跟随主题', () => {
    const patch = buildHomeEchartsRecolorPatches(makeContext(), LIGHT, false) as any;
    const series = patch.statusDonut.series[0];
    expect(series.data).toEqual([
      { name: '已观看', value: 2, itemStyle: { color: LIGHT.success } },
      { name: '已浏览', value: 3, itemStyle: { color: LIGHT.info } },
      { name: '想看', value: 4, itemStyle: { color: LIGHT.warning } },
    ]);
    expect(series.itemStyle.borderColor).toBe(LIGHT.pieBorder);
    expect(series.itemStyle.shadowBlur).toBe(6);
    const dark = buildHomeEchartsRecolorPatches(makeContext(), LIGHT, true) as any;
    expect(dark.statusDonut.series[0].itemStyle.shadowBlur).toBe(10);
    expect(patch.statusDonut.graphic[0].style.fill).toBe(LIGHT.text);
    expect(patch.statusDonut.graphic[0].style.text).toBe('总数\n9');
    expect(patch.statusDonut.legend.textStyle.color).toBe(LIGHT.muted);
  });

  it('柱状/条形图坐标轴与文字颜色跟随主题', () => {
    const patch = buildHomeEchartsRecolorPatches(makeContext(), LIGHT, false) as any;
    expect(patch.newWorksBars.series[0].itemStyle.color).toBe(LIGHT.primary);
    expect(patch.newWorksBars.xAxis.axisLabel.color).toBe(LIGHT.muted);
    expect(patch.newWorksBars.yAxis.splitLine.lineStyle.color).toBe(LIGHT.border);
    expect(patch.tagsTop.series[0].label.color).toBe(LIGHT.text);
    expect(patch.tagsChange.xAxis.axisLabel.color).toBe(LIGHT.muted);
    expect(patch.newTagsTop.yAxis.axisLine.lineStyle.color).toBe(LIGHT.border);
  });

  it('apply：先 animation:false 再 patch，逐实例计数', () => {
    const calls: string[] = [];
    const inst = { setOption(patch: any) { calls.push(JSON.stringify(patch)); } };
    const patches = buildHomeEchartsRecolorPatches(makeContext(), LIGHT, false);
    const applied = applyHomeEchartsRecolor({ statusDonut: inst, missing: {} } as any, patches);
    expect(calls[0]).toBe(JSON.stringify({ animation: false }));
    // 只有 statusDonut 有实例，其余 4 个图跳过
    expect(applied).toBe(1);
    // 无 setOption 的实例跳过不报错
    expect(() => applyHomeEchartsRecolor({ statusDonut: null } as any, patches)).not.toThrow();
  });
});
