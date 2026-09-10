(function () {
  var ECHARTS_SRC = 'assets/templates/echarts.min.js';
  var ECHARTS_LOAD_TIMEOUT_MS = 8000;
  function parseStats() {
    try {
      var tpl = document.getElementById('insights-data');
      if (!tpl) return null;
      var text = tpl.textContent || '';
      if (!text) return null;
      return JSON.parse(text);
    } catch (e) { return null; }
  }
  function safeEcharts() {
    try { return window.echarts; } catch { return undefined; }
  }
  function loadEchartsScript(src, timeoutMs) {
    // S1-2：ECharts（~1MB）改为运行时异步加载，首屏先渲染 KPI/排行等非图表内容
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (value) { if (!done) { done = true; resolve(value); } };
      var existing = safeEcharts();
      if (existing) { finish(existing); return; }
      try {
        var sc = document.createElement('script');
        sc.src = src || ECHARTS_SRC;
        sc.onload = function () { finish(safeEcharts() || null); };
        sc.onerror = function () { finish(safeEcharts() || null); };
        (document.head || document.documentElement).appendChild(sc);
      } catch (e) {
        finish(safeEcharts() || null);
        return;
      }
      setTimeout(function () { finish(safeEcharts() || null); }, typeof timeoutMs === 'number' ? timeoutMs : ECHARTS_LOAD_TIMEOUT_MS);
    });
  }
  function onReady(fn){
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(fn, 0);
    } else {
      try { document.addEventListener('DOMContentLoaded', fn); } catch { setTimeout(fn, 0);} 
    }
  }
  function renderFallback() {
    try {
      var charts = ['tags-pie','tags-top-bar','trend-line'];
      charts.forEach(function(id){
        var el = document.getElementById(id);
        if (el) {
          var p = document.createElement('div');
          p.style.color = '#888';
          p.style.fontSize = '12px';
          p.textContent = '图表未启用（缺少 ECharts 或数据为空）。';
          el.appendChild(p);
        }
      });
    } catch {}
  }
  function setText(id, text){
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  function fmtPct(x){ if (typeof x !== 'number' || !isFinite(x)) return '-'; return (x*100).toFixed(1) + '%'; }
  function trendWord(slope){ if (typeof slope !== 'number') return '-'; if (slope > 0.1) return '上升'; if (slope < -0.1) return '回落'; return '平稳'; }
  function renderKpis(stats){
    try{
      var m = (stats && stats.metrics) || {};
      setText('kpi-top3', fmtPct(m.concentrationTop3));
      setText('kpi-hhi', (typeof m.hhi==='number' && isFinite(m.hhi)) ? m.hhi.toFixed(4) : '-');
      setText('kpi-entropy', (typeof m.entropy==='number' && isFinite(m.entropy)) ? m.entropy.toFixed(2) : '-');
      setText('kpi-trend', trendWord(m.trendSlope));
    } catch{}
  }
  function renderRanking(stats){
    try{
      var body = document.getElementById('ranking-body');
      var top = (stats && (stats.tagsTop || stats.topTags)) || [];
      if (!body){ return; }
      var hasStatic = !!(body.innerHTML && body.innerHTML.trim().length);
      if (!top.length){
        // 若无可用数据，但模板已渲染静态行，则保留，不隐藏
        if (!hasStatic){
          var sec = document.getElementById('ranking');
          if (sec) sec.style.display = 'none';
        }
        return;
      }
      var total = (stats.metrics && stats.metrics.totalAll) || top.reduce(function(s, t){ return s + (t.count||0); }, 0) || 1;
      body.innerHTML = '';
      top.forEach(function(t, i){
        var tr = document.createElement('tr');
        var ratio = (typeof t.ratio === 'number') ? t.ratio : (t.count/total);
        tr.innerHTML = '<td>'+(i+1)+'</td><td>'+String(t.name||'')+'</td><td>'+(t.count||0)+'</td><td>'+fmtPct(ratio)+'</td>';
        body.appendChild(tr);
      });
    } catch{}
  }
  function renderChartEls(stats, echarts) {
    try {
      // Pie: tagsTop
      var pieEl = document.getElementById('tags-pie');
      var topArr = (stats && (stats.tagsTop || stats.topTags)) || [];
      if (pieEl && topArr.length) {
        pieEl.innerHTML = '';
        var pie = echarts.init(pieEl);
        pie.setOption({
          title: { text: '标签占比', left: 'center' },
          tooltip: { trigger: 'item' },
          series: [{
            type: 'pie', radius: '60%',
            data: topArr.map(function(t){ return { name: t.name, value: t.count }; })
          }]
        });
      } else { if (pieEl) pieEl.style.display='none'; }
      // Bar: topN
      var barEl = document.getElementById('tags-top-bar');
      if (barEl && topArr.length) {
        barEl.innerHTML = '';
        var bar = echarts.init(barEl);
        var cats = topArr.map(function(t){ return t.name; });
        var vals = topArr.map(function(t){ return t.count; });
        bar.setOption({
          title: { text: 'Top 标签计数', left: 'center' },
          tooltip: { trigger: 'axis' },
          xAxis: { type: 'category', data: cats },
          yAxis: { type: 'value' },
          series: [{ type: 'bar', data: vals }]
        });
      } else { if (barEl) barEl.style.display='none'; }
      // Line: trend
      var lineEl = document.getElementById('trend-line');
      if (lineEl && (stats.trend||[]).length) {
        lineEl.innerHTML = '';
        var line = echarts.init(lineEl);
        var x = (stats.trend||[]).map(function(p){ return p.date; });
        var y = (stats.trend||[]).map(function(p){ return p.total; });
        line.setOption({
          title: { text: '每日标签总计趋势', left: 'center' },
          tooltip: { trigger: 'axis' },
          xAxis: { type: 'category', data: x },
          yAxis: { type: 'value' },
          series: [{ type: 'line', data: y, smooth: true }]
        });
      } else { if (lineEl) lineEl.style.display='none'; }
    } catch (e) {
      renderFallback();
    }
  }
  function bootCharts(stats) {
    var echarts = safeEcharts();
    if (echarts) { renderChartEls(stats, echarts); return; }
    loadEchartsScript().then(function (ready) {
      if (ready) { renderChartEls(stats, ready); } else { renderFallback(); }
    });
  }
  function renderCharts(stats) {
    if (!stats) { renderFallback(); return; }
    // KPI & 排行立即渲染（不依赖 ECharts）
    renderKpis(stats);
    renderRanking(stats);
    // L-2（cycle-5 S1-A）：ECharts（~1MB 脚本 + 3 图 init）延迟到 #charts 区进入视口
    // （提前 200px 预载）才启动——预览 iframe 限高后图表通常在折叠线之下，
    // 首屏不再为看不见的图表付出脚本加载/解析/渲染成本。
    var chartsSec = document.getElementById('charts');
    if (!chartsSec || !('IntersectionObserver' in window)) { bootCharts(stats); return; }
    ['tags-pie','tags-top-bar','trend-line'].forEach(function(id){
      var el = document.getElementById(id);
      if (el && !el.innerHTML.trim()) {
        var ph = document.createElement('div');
        ph.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:#999;font-size:12px;';
        ph.textContent = '图表将在滚动到时自动加载';
        el.appendChild(ph);
      }
    });
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) { io.disconnect(); bootCharts(stats); break; }
      }
    }, { root: null, rootMargin: '200px' });
    io.observe(chartsSec);
  }
  try {
    onReady(function(){
      var s = parseStats();
      if (!s) s = { tagsTop: [], trend: [] };
      renderCharts(s);
    });
  } catch {}
})();
