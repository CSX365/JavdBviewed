/**
 * @file enhancementSettingsActions.test.ts
 * @description 增强设置广播单测（09-26-display-settings-audit B6 口径锁定：
 * 统一小写 settings-updated + 带 settings payload，不再双发大写 SETTINGS_UPDATED）
 * @module apps/dashboard/pages/settings/enhancement
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

function stubChromeTabs(tabs: Array<{ id?: number; url?: string }>) {
  const sendMessage = vi.fn((_tabId: number, _msg: unknown, cb?: () => void) => {
    cb?.();
  });
  const query = vi.fn((_q: unknown, cb: (list: Array<{ id?: number; url?: string }>) => void) => {
    cb(tabs);
  });
  vi.stubGlobal('chrome', {
    tabs: { query, sendMessage },
    runtime: { lastError: null },
  });
  return { query, sendMessage };
}

describe('broadcastEnhancementSettings（B6）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('对每个有 id 的 javdb 标签页广播小写 settings-updated 且携带 settings payload', async () => {
    const { query, sendMessage } = stubChromeTabs([
      { id: 11, url: 'https://javdb.com/v/abc' },
      { id: 22, url: 'https://javdb.com/' },
      { url: 'https://javdb.com/no-id' },
    ]);
    const { broadcastEnhancementSettings } = await import('./enhancementSettingsActions');
    const settings = { display: { hideViewed: true } } as any;
    broadcastEnhancementSettings(settings);

    expect(query).toHaveBeenCalledWith({ url: '*://javdb.com/*' }, expect.any(Function));
    // 无 id 的 tab 跳过，只发两条
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      11,
      { type: 'settings-updated', settings },
      expect.any(Function),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      22,
      { type: 'settings-updated', settings },
      expect.any(Function),
    );
  });

  it('全仓口径：广播消息 type 只允许小写 settings-updated（大写 SETTINGS_UPDATED 已移除）', async () => {
    const { sendMessage } = stubChromeTabs([{ id: 1, url: 'https://javdb.com/' }]);
    const { broadcastEnhancementSettings } = await import('./enhancementSettingsActions');
    broadcastEnhancementSettings({} as any);
    for (const call of sendMessage.mock.calls) {
      expect((call[1] as { type: string }).type).toBe('settings-updated');
    }
  });

  it('无 javdb 标签页时静默不发', async () => {
    const { sendMessage } = stubChromeTabs([]);
    const { broadcastEnhancementSettings } = await import('./enhancementSettingsActions');
    expect(() => broadcastEnhancementSettings({} as any)).not.toThrow();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
