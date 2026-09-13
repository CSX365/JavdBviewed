/**
 * @file releaseDateParser.ts
 * @description 解析 JavDB 列表项 .meta 中的发行日期（纯函数，便于单测）。
 *
 * 站点原始 HTML 的 .meta 为服务端渲染的 `YYYY-MM-DD`；但站点客户端 JS 会按
 * 浏览器 locale 重渲染（如 en 环境显示 `04/10/2025`），因此两种形态都要支持。
 */

/**
 * 解析日期文本为时间戳（尽力而为，无法识别返回 null）。
 *
 * @param text 日期文本（.meta 的 textContent）
 * @param previousTs 列表中前一项已解析的时间戳。作品列表按发行日期降序排列，
 *                   用于消歧"月/日均 ≤12"的 locale 化日期（如 `04/10/2025`）。
 */
export function parseReleaseDateText(text: string, previousTs: number | null = null): number | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  // 年份在前：YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD（服务端原始格式）
  const m = trimmed.match(/(20\d{2}|19\d{2})[.\/\-](\d{1,2})[.\/\-](\d{1,2})/);
  if (m) {
    const dt = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)).getTime();
    return Number.isNaN(dt) ? null : dt;
  }

  // 年份在后：A/B/YYYY（站点客户端按 locale 重渲染，如 DD/MM/YYYY 或 MM/DD/YYYY）
  const m3 = trimmed.match(/(\d{1,2})[.\/\-](\d{1,2})[.\/\-](20\d{2}|19\d{2})/);
  if (m3) {
    const a = parseInt(m3[1], 10);
    const b = parseInt(m3[2], 10);
    const y = parseInt(m3[3], 10);
    let dt: number;
    if (a > 12 && b <= 12) {
      dt = new Date(y, b - 1, a).getTime(); // A 必为日 → DD/MM
    } else if (b > 12 && a <= 12) {
      dt = new Date(y, a - 1, b).getTime(); // B 必为日 → MM/DD
    } else {
      // 歧义（两者均 ≤12）：保守取较新解读；仅当较新解读破坏降序而较旧解读不破坏时取较旧
      const mmFirst = new Date(y, a - 1, b).getTime();
      const ddFirst = new Date(y, b - 1, a).getTime();
      const newer = Math.max(mmFirst, ddFirst);
      const older = Math.min(mmFirst, ddFirst);
      dt = previousTs !== null && newer > previousTs && older <= previousTs ? older : newer;
    }
    return Number.isNaN(dt) ? null : dt;
  }

  // 兜底：YYYY-MM（没有日）
  const m2 = trimmed.match(/(20\d{2}|19\d{2})[.\/\-](\d{1,2})(?![\d.\/\-])/);
  if (m2) {
    const dt = new Date(parseInt(m2[1], 10), parseInt(m2[2], 10) - 1, 1).getTime();
    return Number.isNaN(dt) ? null : dt;
  }

  return null;
}
