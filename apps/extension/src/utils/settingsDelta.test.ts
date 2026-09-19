/**
 * @file settingsDelta.test.ts
 * @description settings 分节 delta 并发安全写原语（S1-3）
 */
import { describe, expect, it, vi } from 'vitest';
import { readRawSettingsOrUndefined, saveSettingsSectionDelta } from './settingsDelta';

function makeWriter(overrides: {
  raw?: () => Promise<any>;
  rawError?: boolean;
  merged?: () => Promise<any>;
  saved?: any[];
} = {}) {
  const saved: any[] = overrides.saved || [];
  return {
    writer: {
      readRawSettings: overrides.raw === undefined
        ? (overrides.rawError ? (() => { throw new Error('storage down'); }) : undefined)
        : overrides.raw,
      getMergedSettings: overrides.merged,
      saveSettings: vi.fn(async (s: any) => { saved.push(s); }),
    },
    saved,
  };
}

describe('readRawSettingsOrUndefined', () => {
  it('读取器未提供时返回 undefined', async () => {
    expect(await readRawSettingsOrUndefined()).toBeUndefined();
    expect(await readRawSettingsOrUndefined(undefined)).toBeUndefined();
  });

  it('读取器抛错时返回 undefined（回退旧行为）', async () => {
    expect(await readRawSettingsOrUndefined(() => Promise.reject(new Error('x')))).toBeUndefined();
  });

  it('读取器返回 null/数组时返回空对象而非 undefined', async () => {
    expect(await readRawSettingsOrUndefined(async () => null)).toEqual({});
    expect(await readRawSettingsOrUndefined(async () => [1, 2] as any)).toEqual({});
  });
});

describe('saveSettingsSectionDelta', () => {
  it('并发 seed 在重读窗口内落盘时，其他节被保留，delta 基于最新节合并', async () => {
    const { writer, saved } = makeWriter({
      raw: async () => ({
        webdav: { clientId: 'seed-client' },
        drive115: { v2AccessToken: 'latest-at', v2MinRefreshIntervalMin: 90 },
      }),
    });
    const stale = { drive115: { v2AccessToken: 'stale-at' }, display: { theme: 'dark' } };

    const written = await saveSettingsSectionDelta(writer, stale, 'drive115', (latestDrv) => ({
      v2AccessToken: 'new-at',
      v2Extra: Number(latestDrv.v2MinRefreshIntervalMin) * 2,
    }));

    expect(saved).toHaveLength(1);
    // 并发写入的其他节保留
    expect(written.webdav).toEqual({ clientId: 'seed-client' });
    // 陈旧快照里独有的其他节（display）不被写入
    expect(written.display).toBeUndefined();
    // 最新节字段保留 + 自身 delta 生效
    expect(written.drive115.v2AccessToken).toBe('new-at');
    expect(written.drive115.v2MinRefreshIntervalMin).toBe(90);
    expect(written.drive115.v2Extra).toBe(180);
    expect(written).toBe(saved[0]);
  });

  it('原始读未提供时回退 getMergedSettings（写前新鲜 merged 重读）', async () => {
    const { writer, saved } = makeWriter({
      merged: async () => ({ webdav: { url: 'https://dav.example' }, other: { kept: true } }),
    });

    await saveSettingsSectionDelta(writer, null, 'webdav', () => ({ clientLastSyncAt: 't' }));

    expect(saved).toHaveLength(1);
    expect(saved[0].other).toEqual({ kept: true });
    expect(saved[0].webdav).toEqual({ url: 'https://dav.example', clientLastSyncAt: 't' });
  });

  it('原始读未提供且无 getMergedSettings 时回退 staleBase（入口快照整对象）', async () => {
    const { writer, saved } = makeWriter({});
    const stale = { drive115: { a: 1 }, display: { theme: 'dark' } };

    await saveSettingsSectionDelta(writer, stale, 'drive115', () => ({ b: 2 }));

    expect(saved[0].display).toEqual({ theme: 'dark' });
    expect(saved[0].drive115).toEqual({ a: 1, b: 2 });
  });

  it('原始读抛错时回退 getMergedSettings，不阻断写入', async () => {
    const { writer, saved } = makeWriter({
      rawError: true,
      merged: async () => ({ webdav: {} }),
    });

    await saveSettingsSectionDelta(writer, { legacy: true }, 'webdav', () => ({ x: 1 }));

    expect(saved).toHaveLength(1);
    expect(saved[0].webdav).toEqual({ x: 1 });
    expect(saved[0].legacy).toBeUndefined();
  });

  it('getMergedSettings 抛错时继续回退 staleBase', async () => {
    const { writer, saved } = makeWriter({
      rawError: true,
      merged: () => Promise.reject(new Error('merged down')),
    });

    await saveSettingsSectionDelta(writer, { drive115: { keep: 1 } }, 'drive115', () => ({ add: 1 }));

    expect(saved[0].drive115).toEqual({ keep: 1, add: 1 });
  });

  it('目标节缺失时按空节处理，不报错', async () => {
    const { writer, saved } = makeWriter({ raw: async () => ({}) });

    await saveSettingsSectionDelta(writer, null, 'drive115', () => ({ v2AccessToken: 't' }));

    expect(saved[0].drive115).toEqual({ v2AccessToken: 't' });
  });
});
