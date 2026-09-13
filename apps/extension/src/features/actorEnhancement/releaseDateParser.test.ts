import { describe, expect, it } from 'vitest';
import { parseReleaseDateText } from './releaseDateParser';

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

describe('parseReleaseDateText', () => {
  it('parses server-rendered year-first dates (YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD)', () => {
    expect(parseReleaseDateText('2026-09-16')).toBe(at(2026, 9, 16));
    expect(parseReleaseDateText(' 2025/4/10 ')).toBe(at(2025, 4, 10));
    expect(parseReleaseDateText('2025.08.07')).toBe(at(2025, 8, 7));
  });

  it('parses unambiguous locale dates when one part > 12', () => {
    // 站点按 locale 重渲染：2025-04-21 → en-GB 显示 21/04/2025（A>12 → DD/MM）
    expect(parseReleaseDateText('21/04/2025')).toBe(at(2025, 4, 21));
    // 2025-04-21 → en-US 显示 04/21/2025（B>12 → MM/DD）
    expect(parseReleaseDateText('04/21/2025')).toBe(at(2025, 4, 21));
  });

  it('parses locale month-first dates (MM/DD/YYYY, month > 12 impossible → day > 12)', () => {
    // 2025-04-10 在 en-US 下渲染为 04/10/2025（10 不 >12，走歧义分支）
    expect(parseReleaseDateText('04/10/2025', at(2025, 8, 1))).toBe(at(2025, 4, 10));
    // B>12 时 A 必为月：2026-01-20 → 01/20/2026
    expect(parseReleaseDateText('01/20/2026')).toBe(at(2026, 1, 20));
  });

  it('disambiguates A/B ≤12 using the descending list order (previousTs)', () => {
    // 前一项 2025-08-01；当前 04/10/2025：较新解读=2025-10-04 会破坏降序 → 取 2025-04-10
    expect(parseReleaseDateText('04/10/2025', at(2025, 8, 1))).toBe(at(2025, 4, 10));
    // 前一项 2025-03-01：两种解读都不破坏降序 → 保守取较新解读 2025-10-04
    expect(parseReleaseDateText('04/10/2025', at(2025, 3, 1))).toBe(at(2025, 10, 4));
    // 无前一项 → 保守取较新解读
    expect(parseReleaseDateText('04/10/2025')).toBe(at(2025, 10, 4));
  });

  it('falls back to year-month and rejects unparseable text', () => {
    expect(parseReleaseDateText('2025-04')).toBe(at(2025, 4, 1));
    expect(parseReleaseDateText('')).toBeNull();
    expect(parseReleaseDateText('2025')).toBeNull();
    expect(parseReleaseDateText('unknown')).toBeNull();
  });
});
