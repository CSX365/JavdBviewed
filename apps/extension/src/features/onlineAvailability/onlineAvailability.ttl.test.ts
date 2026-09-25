/**
 * @file onlineAvailability.ttl.test.ts
 * @description D 项 P1 回归：parser 型站点检测走 PARSER_AVAILABILITY_TTL_MS，get 型维持命名空间表值（12min）
 * @module features/onlineAvailability
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../platform/browser', () => ({
  extractVideoIdFromPage: vi.fn(() => 'abc-123'),
}));

vi.mock('../../platform/network/httpClient', () => ({
  defaultHttpClient: { getDocument: vi.fn() },
}));

vi.mock('../../platform/storage/sessionResultCache', () => ({
  getOrFetchSessionResult: vi.fn(),
}));

vi.mock('../detailEnhancementPanel', () => ({
  ensureDetailEnhancementPanel: vi.fn(() => null),
}));

import { PARSER_AVAILABILITY_TTL_MS, OnlineAvailabilityManager } from './index';
import { getOrFetchSessionResult } from '../../platform/storage/sessionResultCache';
import type { OnlineAvailabilitySite } from './index';

const parserSite: OnlineAvailabilitySite = {
  key: '123av',
  name: '123AV',
  url: 'https://123av.com/zh/search?keyword={{code}}',
  fetchType: 'parser',
  enabled: true,
};

const getSite: OnlineAvailabilitySite = {
  key: 'fanza',
  name: 'FANZA 動画',
  url: 'https://www.dmm.co.jp/digital/videoa/-/detail/=/cid={{code}}/',
  fetchType: 'get',
  enabled: true,
};

describe('onlineAvailability TTL（D 项 P1）', () => {
  let manager: OnlineAvailabilityManager;

  beforeEach(() => {
    vi.stubGlobal('document', {
      getElementById: () => null,
      querySelector: () => null,
      createElement: () => ({}),
    });
    vi.mocked(getOrFetchSessionResult).mockImplementation(async (_ns, identity) => ({
      data: { siteKey: String(identity), siteName: '', available: true, url: '', tags: [] },
      fromCache: true,
    }));
    manager = new OnlineAvailabilityManager();
    manager.updateConfig({ sites: [parserSite, getSite] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parser 型站点：getOrFetchSessionResult 收到 ttlMs = PARSER_AVAILABILITY_TTL_MS', async () => {
    await manager.checkAvailability('abc-123');

    const calls = vi.mocked(getOrFetchSessionResult).mock.calls;
    const parserCall = calls.find(call => String(call[1]).startsWith('abc-123|123av|'));
    expect(parserCall).toBeDefined();
    expect(parserCall![3]).toMatchObject({ ttlMs: PARSER_AVAILABILITY_TTL_MS });
    expect(PARSER_AVAILABILITY_TTL_MS).toBe(45 * 60 * 1000);
  });

  it('get 型站点：不传 ttlMs（走 onlineAvailability 表值 12min）', async () => {
    await manager.checkAvailability('abc-123');

    const calls = vi.mocked(getOrFetchSessionResult).mock.calls;
    const getCall = calls.find(call => String(call[1]).startsWith('abc-123|fanza|'));
    expect(getCall).toBeDefined();
    expect(getCall![3]).toMatchObject({ ttlMs: undefined });
  });
});
