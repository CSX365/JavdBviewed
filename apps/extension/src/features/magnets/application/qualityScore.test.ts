import { describe, expect, it } from 'vitest';

import type { MagnetResult } from '../domain/types';
import { calculateMagnetQualityScore } from './qualityScore';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function makeResult(overrides: Partial<MagnetResult> = {}): MagnetResult {
  return {
    name: 'ABCD-123 完整名称的测试片',
    magnet: 'magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc',
    size: '2GB',
    sizeBytes: 2 * GB,
    date: '2026-01-01',
    seeders: 50,
    source: 'sukebei',
    hasSubtitle: true,
    ...overrides,
  };
}

describe('calculateMagnetQualityScore', () => {
  it('scores a strong result as excellent with the contributing reasons', () => {
    const { score, level, reasons } = calculateMagnetQualityScore(makeResult({
      quality: '1080p',
      sources: ['sukebei', 'btdig'],
    }));
    // 15 基线 + 5 做种 + 12.67 体积(2GB) + 26 1080p + 12 字幕 + 8 名称完整 + 4 多源
    expect(score).toBe(83);
    expect(level).toBe('excellent');
    expect(reasons).toEqual(['做种较多', '大小合理', '1080p', '字幕', '名称完整', '多源命中']);
  });

  it('penalizes tiny files, unknown seeders and incomplete names down to the low level', () => {
    const { score, level, reasons } = calculateMagnetQualityScore(makeResult({
      sizeBytes: 100 * MB,
      seeders: 0,
      name: 'x',
      hasSubtitle: false,
    }));
    expect(score).toBe(0);
    expect(level).toBe('low');
    expect(reasons).toEqual(['做种少', '文件过小', '信息不足']);
  });

  it('lets the explicit quality label win over name detection and keeps 4K above 1080p', () => {
    const fourK = calculateMagnetQualityScore(makeResult({ quality: '4K', name: 'ABC-1 2160p' })).score;
    const labelled1080 = calculateMagnetQualityScore(makeResult({ quality: '1080p', name: 'ABC-2 720p' })).score;
    const detected4K = calculateMagnetQualityScore(makeResult({ name: 'ABC-3 4K' })).score;
    expect(fourK).toBeGreaterThan(labelled1080);
    expect(detected4K).toBeGreaterThan(labelled1080);
  });

  it('adds cracked and detected-subtitle bonuses', () => {
    // hasSubtitle 默认 true，须显式关闭以隔离名称检测的增量
    const plain = calculateMagnetQualityScore(makeResult({ name: 'ABCD-123 测试片', hasSubtitle: false })).score;
    const cracked = calculateMagnetQualityScore(makeResult({ name: 'ABCD-123 测试片 破解', hasSubtitle: false })).score;
    expect(cracked).toBe(plain + 5);

    const zhName = calculateMagnetQualityScore(makeResult({ name: 'ABCD-123 测试片 中字', hasSubtitle: false })).score;
    expect(zhName).toBe(plain + 12);
  });

  it('clamps the score into the 0..100 band and maps levels at 40/60/80', () => {
    expect(calculateMagnetQualityScore(makeResult()).score).toBeGreaterThanOrEqual(0);
    expect(calculateMagnetQualityScore(makeResult()).score).toBeLessThanOrEqual(100);
    expect(calculateMagnetQualityScore(makeResult({ quality: '4K', sizeBytes: 25 * GB, seeders: 500, sources: ['sukebei', 'btdig', 'btsow'] }))).toMatchObject({ level: 'excellent' });
  });
});
