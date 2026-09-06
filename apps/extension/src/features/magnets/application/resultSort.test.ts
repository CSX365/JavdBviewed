import { describe, expect, it } from 'vitest';

import type { MagnetResult, MagnetSortMode } from '../domain/types';
import { normalizeMagnetSortMode, sortMagnetResultsByMode } from './resultSort';

const GB = 1024 ** 3;

function makeResult(overrides: Partial<MagnetResult> = {}): MagnetResult {
  return {
    name: 'ABCD-123 测试',
    magnet: `magnet:?xt=urn:btih:${'c'.repeat(40)}`,
    size: '1GB',
    sizeBytes: 1 * GB,
    date: '2026-01-01',
    seeders: 10,
    source: 'sukebei',
    hasSubtitle: false,
    ...overrides,
  };
}

const names = (results: MagnetResult[]): string[] => results.map(r => r.name);

describe('magnet sort', () => {
  it('normalizes unknown or non-string sort modes to default', () => {
    expect(normalizeMagnetSortMode('seeders')).toBe('seeders');
    expect(normalizeMagnetSortMode('bogus')).toBe('default');
    expect(normalizeMagnetSortMode(undefined)).toBe('default');
    expect(normalizeMagnetSortMode(3 as unknown as string)).toBe('default');
  });

  it('never mutates the input and always returns every item', () => {
    const input = [makeResult({ name: 'a' }), makeResult({ name: 'b' })];
    const copy = [...input];
    for (const mode of ['default', 'quality', 'seeders', 'size', 'date', 'subtitle'] as MagnetSortMode[]) {
      const sorted = sortMagnetResultsByMode(input, mode);
      expect(sorted).not.toBe(input);
      expect(input).toEqual(copy);
      expect(sorted).toHaveLength(2);
      expect(sorted.map(r => r.name).sort()).toEqual(['a', 'b']);
    }
  });

  it('sorts by seeders, size and date descending', () => {
    const results = [
      makeResult({ name: 'low', seeders: 1, sizeBytes: 1 * GB, date: '2025-01-01' }),
      makeResult({ name: 'mid', seeders: 10, sizeBytes: 2 * GB, date: '2026-01-01' }),
      makeResult({ name: 'high', seeders: 99, sizeBytes: 3 * GB, date: '2027-01-01' }),
    ];
    expect(names(sortMagnetResultsByMode(results, 'seeders'))).toEqual(['high', 'mid', 'low']);
    expect(names(sortMagnetResultsByMode(results, 'size'))).toEqual(['high', 'mid', 'low']);
    expect(names(sortMagnetResultsByMode(results, 'date'))).toEqual(['high', 'mid', 'low']);
  });

  it('prefers subtitled results in subtitle mode', () => {
    const results = [
      makeResult({ name: 'plain', hasSubtitle: false }),
      makeResult({ name: 'sub', hasSubtitle: true }),
    ];
    expect(names(sortMagnetResultsByMode(results, 'subtitle'))).toEqual(['sub', 'plain']);
  });

  it('sorts quality mode by score descending', () => {
    const weak = makeResult({ name: '弱片', seeders: 0, sizeBytes: 100 * 1024 * 1024, hasSubtitle: false, quality: undefined });
    const strong = makeResult({ name: '强片', seeders: 200, sizeBytes: 4 * GB, hasSubtitle: true, quality: '1080p' });
    expect(names(sortMagnetResultsByMode([weak, strong], 'quality'))).toEqual(['强片', '弱片']);
  });
});
