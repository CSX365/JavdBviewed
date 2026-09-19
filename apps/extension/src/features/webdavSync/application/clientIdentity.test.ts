import { describe, expect, it, vi } from 'vitest';
import { ensureWebDAVClientIdentity, type WebDAVSettingsAdapter } from './clientIdentity';

/**
 * 竞态场景背景：SW 启动期 ensureWebDAVClientIdentity 做读-改-写全量 settings，
 * 读与写之间窗口内落盘的并发写入（测试 seed / 用户操作）会被旧读值覆盖。
 * 修复后：写回只基于“写回前重读的原始值 + 自身 delta”，绝不写全默认值实例。
 */

interface InMemoryStore {
  raw: Record<string, any> | null;
  rawReads: number;
  rawSequence: Array<Record<string, any> | null>;
  saved: Array<Record<string, any>>;
}

function makeAdapter(store: InMemoryStore): WebDAVSettingsAdapter & { getRawCalls: () => number } {
  const DEFAULTS: Record<string, any> = {
    videoEnhancement: { enabled: true },
    webdav: {},
  };
  return {
    getSettings: async () => ({ ...DEFAULTS, ...store.raw, webdav: { ...(store.raw?.webdav || {}) } }),
    saveSettings: async (settings: any) => {
      store.saved.push(JSON.parse(JSON.stringify(settings)));
      store.raw = settings;
    },
    readRawSettings: async () => {
      store.rawReads += 1;
      if (store.rawSequence.length > 0 && store.rawReads <= store.rawSequence.length) {
        return store.rawSequence[store.rawReads - 1];
      }
      return store.raw;
    },
    getRawCalls: () => store.rawReads,
  };
}

describe('ensureWebDAVClientIdentity 竞态安全', () => {
  it('并发 seed 落盘在重读窗口内时，seed 内容被保留而非被全默认值覆盖', async () => {
    const store: InMemoryStore = { raw: null, rawReads: 0, rawSequence: [null, { videoEnhancement: { enabled: false } }], saved: [] };
    const adapter = makeAdapter(store);

    await ensureWebDAVClientIdentity(adapter);

    expect(store.saved).toHaveLength(1);
    const saved = store.saved[0];
    // seed 的内容必须保留（旧实现会写 videoEnhancement.enabled=true 的全默认实例）
    expect(saved.videoEnhancement).toEqual({ enabled: false });
    // 身份字段补全
    expect(saved.webdav.clientId).toBeTruthy();
    expect(saved.webdav.clientInstalledAt).toBeTruthy();
    expect(saved.webdav.browserName).toBeTruthy();
    expect(saved.webdav.deviceLabel).toBeTruthy();
  });

  it('fresh profile 下只写 partial blob（webdav 身份节），不写全默认值实例', async () => {
    const store: InMemoryStore = { raw: null, rawReads: 0, rawSequence: [], saved: [] };
    const adapter = makeAdapter(store);

    await ensureWebDAVClientIdentity(adapter);

    expect(store.saved).toHaveLength(1);
    const saved = store.saved[0];
    expect(Object.keys(saved)).toEqual(['webdav']);
    expect(saved.webdav.clientId).toBeTruthy();
  });

  it('身份字段齐全时不写回，直接返回 merged 视图', async () => {
    const store: InMemoryStore = {
      raw: { webdav: { clientId: 'existing-id', clientInstalledAt: '2026-01-01T00:00:00.000Z', browserName: 'Chrome', deviceLabel: 'Chrome' } },
      rawReads: 0,
      rawSequence: [],
      saved: [],
    };
    const adapter = makeAdapter(store);

    const result = await ensureWebDAVClientIdentity(adapter);

    expect(store.saved).toHaveLength(0);
    expect(result.webdav.clientId).toBe('existing-id');
  });

  it('部分身份已存在时只补缺失字段，不覆盖已有值', async () => {
    const store: InMemoryStore = { raw: { webdav: { clientId: 'existing-id' } }, rawReads: 0, rawSequence: [], saved: [] };
    const adapter = makeAdapter(store);

    await ensureWebDAVClientIdentity(adapter);

    expect(store.saved).toHaveLength(1);
    expect(store.saved[0].webdav.clientId).toBe('existing-id');
    expect(store.saved[0].webdav.browserName).toBeTruthy();
  });

  it('adapter 未提供 readRawSettings 时保持旧行为（merged 视图全量写回）', async () => {
    const saved: Array<Record<string, any>> = [];
    const legacyAdapter: WebDAVSettingsAdapter = {
      getSettings: async () => ({ videoEnhancement: { enabled: true }, webdav: {} }),
      saveSettings: async (settings: any) => { saved.push(settings); },
    };

    await ensureWebDAVClientIdentity(legacyAdapter);

    expect(saved).toHaveLength(1);
    // 旧契约：全量 merged 视图 + 身份
    expect(saved[0].videoEnhancement).toEqual({ enabled: true });
    expect(saved[0].webdav.clientId).toBeTruthy();
  });

  it('readRawSettings 抛错时回退旧行为，不阻断身份初始化', async () => {
    const saved: Array<Record<string, any>> = [];
    const adapter: WebDAVSettingsAdapter = {
      getSettings: async () => ({ videoEnhancement: { enabled: false }, webdav: {} }),
      saveSettings: async (settings: any) => { saved.push(settings); },
      readRawSettings: async () => { throw new Error('boom'); },
    };

    await ensureWebDAVClientIdentity(adapter);

    expect(saved).toHaveLength(1);
    expect(saved[0].webdav.clientId).toBeTruthy();
  });

  it('写回返回值包含补全后的身份字段', async () => {
    const store: InMemoryStore = { raw: null, rawReads: 0, rawSequence: [], saved: [] };
    const adapter = makeAdapter(store);

    const result = await ensureWebDAVClientIdentity(adapter);

    expect(result.webdav.clientId).toBeTruthy();
    expect(result.webdav.browserName).toBeTruthy();
  });
});
