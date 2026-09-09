import { describe, expect, it } from 'vitest';
import { createInsightsExportRuntime } from './exportRuntime';

function makeRuntime() {
  const urls = {
    echarts: 'chrome-extension://id/assets/templates/echarts.min.js',
    runtime: 'chrome-extension://id/assets/templates/insights-runtime.js',
  };
  const fetchImpl = (async (input: unknown) => {
    const u = String(input);
    if (u.includes('echarts.min.js')) return { ok: true, text: async () => '/*ECHARTS_JS*/' };
    if (u.includes('insights-runtime.js')) return { ok: true, text: async () => '/*RUNTIME_JS*/' };
    return { ok: false, text: async () => '' };
  }) as unknown as typeof fetch;
  const runtime = createInsightsExportRuntime({
    documentRef: { createElement: () => ({}) } as unknown as Document,
    fetchImpl,
    getExtensionUrl: (path: string) => `chrome-extension://id/${path}`,
  });
  return { runtime, urls };
}

describe('insights export runtime defaultInlineAssets', () => {
  it('inlines echarts after <body> when the template no longer carries the script tag (S1-2)', async () => {
    const { runtime } = makeRuntime();
    const html = '<!doctype html><html><head></head><body class="report"><div id="insights-data">{}</div><script src="assets/templates/insights-runtime.js"></script></body></html>';

    const out = await runtime.inlineAssets(html);

    expect(out).toContain('/*ECHARTS_JS*/');
    expect(out).toContain('/*RUNTIME_JS*/');
    // echarts 内联块必须早于 runtime 内联块执行（runtime 末尾执行时会同步命中 window.echarts）
    expect(out.indexOf('/*ECHARTS_JS*/')).toBeLessThan(out.indexOf('/*RUNTIME_JS*/'));
    // 不应残留外部资源引用
    expect(out).not.toContain('src="assets/templates/echarts.min.js"');
    expect(out).not.toContain('src="assets/templates/insights-runtime.js"');
  });

  it('still replaces the legacy echarts tag in place for old exported reports', async () => {
    const { runtime } = makeRuntime();
    const html = '<!doctype html><html><head></head><body><p id="k">x</p><script src="assets/templates/echarts.min.js"></script><script src="assets/templates/insights-runtime.js"></script></body></html>';

    const out = await runtime.inlineAssets(html);

    expect(out).toContain('<script>/*ECHARTS_JS*/\n</script>');
    // 旧模板走原位替换，不应出现 body 开头注入的兜底注释
    expect(out).not.toContain('echarts inlined for export');
    expect(out).not.toContain('src="assets/templates/echarts.min.js"');
    expect(out).not.toContain('src="assets/templates/insights-runtime.js"');
  });
});
