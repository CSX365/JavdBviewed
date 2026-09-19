/**
 * @file tokenRefreshConcurrentWrite.test.ts
 * @description 115 v2 token 自动刷新持久化的读-改-写竞态回归（S1-3 写者①）
 *
 * 背景：getValidAccessToken 入口读到的 settings 是陈旧快照，入口读与刷新成功持久化
 * 之间跨过了 await refreshToken(...) 网络段。其他上下文（用户保存设置、webdav 身份
 * 补写等）在这段窗口内落盘的写入，会被「入口快照整对象写回」覆盖。
 * 修复后：写前紧贴重读原始存储值（不合并默认值），只在其上合并自身 drive115 节 delta；
 * 原始读抛错时回退旧行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  getValue: vi.fn(),
  addLogV2: vi.fn(),
  emitRefreshEvent: vi.fn(),
}));

vi.mock('../../../utils/storage', () => ({
  getSettings: mocks.getSettings,
  saveSettings: mocks.saveSettings,
  getValue: mocks.getValue,
}));
vi.mock('./logs', () => ({ addLogV2: mocks.addLogV2 }));
vi.mock('./tokenRefreshEvents', () => ({ emitDrive115TokenRefreshEvent: mocks.emitRefreshEvent }));

import { getDrive115V2Service } from './index';

const nowSec = () => Math.floor(Date.now() / 1000);

function expiredStaleSettings(): Record<string, any> {
  return {
    display: { theme: 'dark' },
    drive115: {
      v2AccessToken: 'stale-access-token',
      v2RefreshToken: 'refresh-token',
      v2TokenExpiresAt: nowSec() - 120,
      v2AutoRefresh: true,
      v2AutoRefreshSkewSec: 60,
      v2RefreshTokenStatus: 'valid',
      v2TokenRefreshHistorySec: [nowSec() - 3600],
    },
  };
}

const refreshedToken = {
  access_token: 'refreshed-access-token',
  refresh_token: 'refreshed-refresh-token',
  expires_at: nowSec() + 7200,
};

let service: ReturnType<typeof getDrive115V2Service>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveSettings.mockResolvedValue(undefined);
  mocks.addLogV2.mockResolvedValue(undefined);
  service = getDrive115V2Service();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Drive115V2Service token 刷新持久化竞态安全', () => {
  it('并发 seed 在写前重读窗口内落盘时，seed 与其他节被保留，delta 按最新值合并', async () => {
    // 入口读：陈旧快照（无 seed，min interval 未设置）
    mocks.getSettings.mockResolvedValue(expiredStaleSettings());
    // 写前重读的原始值：并发写入已落盘（webdav 身份节 + drive115 节最新字段）
    mocks.getValue.mockResolvedValue({
      webdav: { clientId: 'seed-client-id' },
      drive115: {
        v2AccessToken: 'stale-access-token',
        v2RefreshToken: 'refresh-token',
        v2TokenExpiresAt: nowSec() - 120,
        v2AutoRefresh: true,
        v2AutoRefreshSkewSec: 60,
        v2RefreshTokenStatus: 'valid',
        v2MinRefreshIntervalMin: 75,
        v2TokenRefreshHistorySec: [nowSec() - 7200],
      },
    });
    vi.spyOn(service, 'refreshToken').mockResolvedValue({ success: true, token: refreshedToken });

    const result = await service.getValidAccessToken({ forceAutoRefresh: true, forceRefresh: true });

    expect(result).toEqual({ success: true, accessToken: 'refreshed-access-token' });
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);

    const payload: any = mocks.saveSettings.mock.calls[0][0];
    // 并发写入的其他节不被覆盖
    expect(payload.webdav).toEqual({ clientId: 'seed-client-id' });
    // 自身 delta 写入
    const drv = payload.drive115;
    expect(drv.v2AccessToken).toBe('refreshed-access-token');
    expect(drv.v2RefreshToken).toBe('refreshed-refresh-token');
    expect(drv.v2LastTokenRefreshAtSec).toBeGreaterThanOrEqual(nowSec() - 5);
    expect(drv.v2RefreshTokenIssuedAtSec).toBe(drv.v2LastTokenRefreshAtSec);
    expect(drv.v2MaxRefreshPer2h).toBe(3);
    // 非 delta 字段以最新原始值为准（而不是入口快照的缺失/默认）
    expect(drv.v2MinRefreshIntervalMin).toBe(75);
    expect(drv.v2AutoRefresh).toBe(true);
    expect(drv.v2RefreshTokenStatus).toBe('valid');
    // 历史：最新原始值的历史 + 本次刷新时间戳，过滤并截断
    const hist: number[] = drv.v2TokenRefreshHistorySec;
    expect(hist).toContain(nowSec() - 7200);
    expect(hist.some((v: number) => Math.abs(v - nowSec()) <= 5)).toBe(true);
    expect(hist.length).toBeLessThanOrEqual(20);
    // 不把全默认值实例写回 blob
    expect(payload.videoEnhancement).toBeUndefined();
    expect(payload.translation).toBeUndefined();
  });

  it('并发刷新历史超过 1 天的记录被过滤', async () => {
    mocks.getSettings.mockResolvedValue(expiredStaleSettings());
    mocks.getValue.mockResolvedValue({
      drive115: {
        ...expiredStaleSettings().drive115,
        v2TokenRefreshHistorySec: [nowSec() - 90000, nowSec() - 3600],
      },
    });
    vi.spyOn(service, 'refreshToken').mockResolvedValue({ success: true, token: refreshedToken });

    await service.getValidAccessToken({ forceAutoRefresh: true, forceRefresh: true });

    const payload: any = mocks.saveSettings.mock.calls[0][0];
    const hist: number[] = payload.drive115.v2TokenRefreshHistorySec;
    expect(hist.some((v: number) => Math.abs(v - (nowSec() - 90000)) <= 5)).toBe(false);
    expect(hist.some((v: number) => Math.abs(v - (nowSec() - 3600)) <= 5)).toBe(true);
    expect(hist.some((v: number) => Math.abs(v - nowSec()) <= 5)).toBe(true);
  });

  it('原始读抛错时回退旧行为（入口快照整对象写回），不阻断持久化', async () => {
    const stale = expiredStaleSettings();
    mocks.getSettings.mockResolvedValue(stale);
    mocks.getValue.mockRejectedValue(new Error('storage unavailable'));
    vi.spyOn(service, 'refreshToken').mockResolvedValue({ success: true, token: refreshedToken });

    const result = await service.getValidAccessToken({ forceAutoRefresh: true, forceRefresh: true });

    expect(result).toEqual({ success: true, accessToken: 'refreshed-access-token' });
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
    const payload: any = mocks.saveSettings.mock.calls[0][0];
    expect(payload.display).toEqual({ theme: 'dark' });
    expect(payload.drive115.v2AccessToken).toBe('refreshed-access-token');
    expect(payload.drive115.v2MinRefreshIntervalMin).toBe(60); // 入口快照缺失 → clamp 默认 60
  });
});
