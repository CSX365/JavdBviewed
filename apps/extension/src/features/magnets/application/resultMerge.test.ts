import { describe, expect, it } from 'vitest';

import type { MagnetResult } from '../domain/types';
import { appendMagnetResults, extractMagnetHash, getResultSources } from './resultMerge';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

function makeResult(overrides: Partial<MagnetResult> = {}): MagnetResult {
  return {
    name: 'ABC-123 测试',
    magnet: `magnet:?xt=urn:btih:${HASH_A}`,
    size: '1GB',
    sizeBytes: 1024 ** 3,
    date: '2026-01-01',
    source: 'sukebei',
    hasSubtitle: false,
    ...overrides,
  };
}

describe('resultMerge', () => {
  it('extracts the lowercase info hash and falls back to the raw magnet', () => {
    const upper = 'A'.repeat(40);
    expect(extractMagnetHash(`magnet:?xt=urn:btih:${upper}`)).toBe(HASH_A);
    expect(extractMagnetHash('not-a-magnet')).toBe('not-a-magnet');
  });

  it('canonicalizes and dedupes source labels, splitting on slashes', () => {
    const result = makeResult({ source: 'Sukebei / btdig', sources: ['btdig', 'JAVBUS'] });
    expect(getResultSources(result)).toEqual(['BTdig', 'JAVBUS', 'Sukebei']);
    expect(getResultSources(makeResult({ source: '' }))).toEqual([]);
  });

  it('appends new results and merges same-hash results with union sources', () => {
    const target: MagnetResult[] = [makeResult({ seeders: 1, source: 'sukebei' })];
    const next = appendMagnetResults(target, [
      makeResult({ magnet: `magnet:?xt=urn:btih:${HASH_B}`, source: 'btdig' }),
      makeResult({ seeders: 9, source: 'btsow' }),
    ]);

    // 同 hash 结果就地合并，target 长度保持 2
    expect(next).toBe(2);
    expect(target).toHaveLength(2);

    const merged = target[0];
    expect(merged.seeders).toBe(9);
    expect(merged.sources).toEqual(['Sukebei', 'BTSOW']);
    expect(merged.source).toBe('Sukebei / BTSOW');
  });
});
