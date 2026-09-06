import { describe, expect, it } from 'vitest';

import {
  createPreviewCacheEntry,
  getPreviewSourceType,
  isHlsPreviewUrl,
  isKnownBadVbgflPreviewUrl,
  isVbgflMusumeCode,
  isVbgflPondoCode,
  normalizePreviewUrl,
  parsePreviewCacheEntry,
  serializePreviewCacheEntry,
} from './previewSourceRules';

const NOW = 1_750_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('previewSourceRules', () => {
  it('normalizes HTML-escaped ampersands and detects HLS urls case-insensitively', () => {
    expect(normalizePreviewUrl('https://a.example/v.mp4&amp;token=1')).toBe('https://a.example/v.mp4&token=1');
    expect(isHlsPreviewUrl('https://a.example/v.M3U8?x=1')).toBe(true);
    expect(isHlsPreviewUrl('https://a.example/v.m3u8#frag')).toBe(true);
    expect(isHlsPreviewUrl('https://a.example/v.m3u8x')).toBe(false);
    expect(isHlsPreviewUrl('https://a.example/v.mp4')).toBe(false);
    // &amp; 先归一化再判定（仅 ?/# 视为后缀分隔符）
    expect(isHlsPreviewUrl('https://a.example/v.m3u8?x=1&amp;y=2')).toBe(true);
  });

  it('maps url type to mp4 or mpegurl', () => {
    expect(getPreviewSourceType('https://a.example/v.mp4')).toBe('video/mp4');
    expect(getPreviewSourceType('https://a.example/v.m3u8')).toBe('application/vnd.apple.mpegurl');
  });

  it('creates cache entries with normalized url, type and zero failures', () => {
    const entry = createPreviewCacheEntry('https://a.example/v.mp4&amp;t=1', 'javdb', NOW);
    expect(entry).toEqual({
      url: 'https://a.example/v.mp4&t=1',
      type: 'video/mp4',
      source: 'javdb',
      verifiedAt: NOW,
      failures: 0,
    });
  });

  it('parses fresh JSON cache entries and rejects stale ones by type-specific TTL', () => {
    const mp4 = JSON.stringify({ url: 'https://a.example/v.mp4', source: 'javdb', verifiedAt: NOW - HOUR, failures: 1 });
    expect(parsePreviewCacheEntry(mp4, NOW)).toMatchObject({ url: 'https://a.example/v.mp4', source: 'javdb', failures: 1 });

    // mp4 7 天 TTL：8 天前过期
    const staleMp4 = JSON.stringify({ url: 'https://a.example/v.mp4', verifiedAt: NOW - 8 * DAY });
    expect(parsePreviewCacheEntry(staleMp4, NOW)).toBeNull();

    // hls 30 分钟 TTL：31 分钟前过期
    const staleHls = JSON.stringify({ url: 'https://a.example/v.m3u8', verifiedAt: NOW - 31 * 60 * 1000 });
    expect(parsePreviewCacheEntry(staleHls, NOW)).toBeNull();

    // 缺失 verifiedAt 视为不可信
    const noVerified = JSON.stringify({ url: 'https://a.example/v.mp4' });
    expect(parsePreviewCacheEntry(noVerified, NOW)).toBeNull();
  });

  it('falls back to the cache source name for unknown sources and to legacy for plain urls', () => {
    const weirdSource = JSON.stringify({ url: 'https://a.example/v.mp4', source: 'not-a-source', verifiedAt: NOW });
    expect(parsePreviewCacheEntry(weirdSource, NOW)).toMatchObject({ source: 'cache' });

    const legacy = parsePreviewCacheEntry('https://a.example/v.mp4', NOW);
    expect(legacy).toMatchObject({ url: 'https://a.example/v.mp4', source: 'legacy', verifiedAt: NOW });

    // 裸 m3u8 无缓存载体，直接拒绝
    expect(parsePreviewCacheEntry('https://a.example/v.m3u8', NOW)).toBeNull();
    expect(parsePreviewCacheEntry(null, NOW)).toBeNull();
    expect(parsePreviewCacheEntry('', NOW)).toBeNull();
  });

  it('serializes and parses cache entries losslessly', () => {
    // HLS 缓存 TTL 30 分钟，取 10 分钟前保证新鲜
    const entry = createPreviewCacheEntry('https://a.example/v.m3u8', 'avpreview', NOW - 10 * 60 * 1000);
    entry.failures = 2;
    expect(parsePreviewCacheEntry(serializePreviewCacheEntry(entry), NOW)).toEqual(entry);
  });

  it('recognizes vbgfl pondo and musume code shapes', () => {
    expect(isVbgflPondoCode('123456_123')).toBe(true);
    expect(isVbgflPondoCode('123456-123')).toBe(true);
    expect(isVbgflPondoCode('12345_123')).toBe(false);
    expect(isVbgflMusumeCode('123456_12')).toBe(true);
    expect(isVbgflMusumeCode('123456_123')).toBe(false);
  });

  it('flags known-bad vbgfl preview urls by host and code presence', () => {
    expect(isKnownBadVbgflPreviewUrl('123456_123', 'https://smovie.1pondo.tv/123456_123/index.html')).toBe(false);
    // 主机匹配但代码不在 URL 中
    expect(isKnownBadVbgflPreviewUrl('999999_999', 'https://smovie.1pondo.tv/123456_123/index.html')).toBe(true);
    // 代码形制不符（musume 代码 + pondo 主机）
    expect(isKnownBadVbgflPreviewUrl('123456_12', 'https://smovie.1pondo.tv/123456_12/index.html')).toBe(true);
    // 无关主机不判定
    expect(isKnownBadVbgflPreviewUrl('123456_123', 'https://other.example/v.mp4')).toBe(false);
  });
});
