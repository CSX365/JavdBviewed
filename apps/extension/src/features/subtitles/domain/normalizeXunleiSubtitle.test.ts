import { describe, expect, it } from 'vitest';

import {
  formatXunleiSubtitleDuration,
  normalizeXunleiSubtitleHash,
  normalizeXunleiSubtitleItems,
  normalizeXunleiSubtitleLanguage,
  normalizeXunleiSubtitleRate,
  normalizeXunleiSubtitleSource,
} from './normalizeXunleiSubtitle';

describe('normalizeXunleiSubtitle', () => {
  it('normalizes items from data or subtitles arrays with field fallbacks', () => {
    const items = normalizeXunleiSubtitleItems({
      data: [
        { name: ' ABC-123 中文 ', sname: 'ignored', ext: 'ass', url: 'https://x.example/a.ass', language: ['en', 'zh-CN'], rate: '8.5', duration: 3661, extra_name: 'Subs（Team）', gcid: 'abcdef1234567890' },
        { sname: 'fallback-name', surl: 'https://x.example/b.srt', lang: 'jp' },
        null,
        'garbage',
      ],
    } as any);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      name: 'ABC-123 中文',
      ext: 'ass',
      url: 'https://x.example/a.ass',
      language: 'EN',
      rate: '8.5',
      duration: 3661,
      sourceLabel: 'SubsTeam',
      hash: 'ABCDEF12',
    });
    expect(items[1]).toMatchObject({ name: 'fallback-name', url: 'https://x.example/b.srt', language: 'JP' });
  });

  it('returns an empty list when the response has no item arrays and drops nameless url-less rows', () => {
    expect(normalizeXunleiSubtitleItems({} as any)).toEqual([]);
    expect(normalizeXunleiSubtitleItems({ subtitles: [{}] } as any)).toEqual([]);
  });

  it('normalizes language to the first non-empty value uppercased', () => {
    expect(normalizeXunleiSubtitleLanguage(['', 'zh-cn'])).toBe('ZH-CN');
    expect(normalizeXunleiSubtitleLanguage(undefined)).toBe('');
  });

  it('treats empty and zero rates as undefined', () => {
    expect(normalizeXunleiSubtitleRate('')).toBeUndefined();
    expect(normalizeXunleiSubtitleRate('0')).toBeUndefined();
    expect(normalizeXunleiSubtitleRate(0)).toBeUndefined();
    expect(normalizeXunleiSubtitleRate(' 9.1 ')).toBe('9.1');
  });

  it('strips parenthesized noise from source labels and drops zero values', () => {
    expect(normalizeXunleiSubtitleSource('Subs（Team）')).toBe('SubsTeam');
    expect(normalizeXunleiSubtitleSource('0')).toBe('');
    expect(normalizeXunleiSubtitleSource(undefined)).toBe('');
  });

  it('normalizes hashes to at most 8 uppercase hex chars', () => {
    expect(normalizeXunleiSubtitleHash('abcdef1234567890')).toBe('ABCDEF12');
    expect(normalizeXunleiSubtitleHash('zz-12')).toBe('12');
    expect(normalizeXunleiSubtitleHash(undefined)).toBe('');
  });

  it('formats durations in seconds or milliseconds as HH:MM:SS', () => {
    expect(formatXunleiSubtitleDuration(3661)).toBe('01:01:01');
    expect(formatXunleiSubtitleDuration(3661000)).toBe('01:01:01');
    expect(formatXunleiSubtitleDuration(61)).toBe('00:01:01');
    expect(formatXunleiSubtitleDuration(59)).toBe('00:00:59');
    expect(formatXunleiSubtitleDuration(0)).toBe('');
    expect(formatXunleiSubtitleDuration(-5)).toBe('');
    expect(formatXunleiSubtitleDuration('abc')).toBe('');
  });
});
