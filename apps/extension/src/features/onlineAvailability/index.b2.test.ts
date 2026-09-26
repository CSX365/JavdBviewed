import { describe, expect, it, vi } from 'vitest';

/**
 * S1 B2 (cycle-14)：get 型可用性探测透传 firstByteTimeoutMs（首字节 3s 快速判败）。
 * 仅探测路径（probePrefixBytes>0）携带；parser 型整页抓取与 115/Emby 线路不受影响。
 */

vi.mock('../../platform/network/httpClient', () => ({
  defaultHttpClient: { getDocument: vi.fn() },
}));
vi.mock('../../platform/storage/sessionResultCache', () => ({
  getOrFetchSessionResult: vi.fn(async (_ns: string, _id: string, fetcher: () => Promise<unknown>) => {
    const data = await fetcher();
    return { data, fromCache: false };
  }),
}));

import { defaultHttpClient } from '../../platform/network/httpClient';
import { DEFAULT_ONLINE_AVAILABILITY_SITES, OnlineAvailabilityManager } from './index';

const fakeDoc = {
  title: '',
  body: null,
  querySelector: () => null,
  querySelectorAll: () => [],
} as unknown as Document;

function makeManager() {
  const mgr = new OnlineAvailabilityManager();
  const fanza = DEFAULT_ONLINE_AVAILABILITY_SITES.find((s) => s.key === 'fanza');
  const parserSite = DEFAULT_ONLINE_AVAILABILITY_SITES.find((s) => s.fetchType === 'parser');
  if (!fanza || !parserSite) throw new Error('missing test sites');
  mgr.updateConfig({
    enabled: true,
    autoCheck: false,
    showUnavailable: true,
    timeoutMs: 8000,
    sites: [fanza, parserSite],
  });
  return { mgr, fanza, parserSite };
}

describe('onlineAvailability S1 B2 (cycle-14)', () => {
  it('get 型探测传 firstByteTimeoutMs=3000 + maxBodyBytes；parser 型两者皆无', async () => {
    vi.mocked(defaultHttpClient.getDocument).mockResolvedValue(fakeDoc);
    const { mgr, fanza, parserSite } = makeManager();

    await (mgr as any).checkSiteUrl(fanza, 'AB-123', 'https://www.dmm.co.jp/digital/videoa/-/detail/=/cid/ab123/');
    const getCall = vi.mocked(defaultHttpClient.getDocument).mock.calls[0];
    expect(getCall[1].firstByteTimeoutMs).toBe(3000);
    expect(typeof getCall[1].maxBodyBytes).toBe('number');
    expect(getCall[1].maxBodyBytes).toBeGreaterThan(0);
    expect(getCall[1].retries).toBe(0); // 探测保持既有 0 重试（按冷却链走调度器）

    await (mgr as any).checkSiteUrl(parserSite, 'AB-123', 'https://netflav5.com/search?type=title&keyword=ab123');
    const parserCall = vi.mocked(defaultHttpClient.getDocument).mock.calls[1];
    expect(parserCall[1]).not.toHaveProperty('firstByteTimeoutMs');
    expect(parserCall[1]).not.toHaveProperty('maxBodyBytes');
  });
});
