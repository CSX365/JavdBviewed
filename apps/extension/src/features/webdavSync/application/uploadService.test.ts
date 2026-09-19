/**
 * @file uploadService.test.ts
 * @description WebDAV 备份收尾写回的读-改-写竞态回归（S1-3 写者③）
 *
 * 背景：performWebDAVUpload 上传跨长网络段，收尾若写回 merged 视图整对象，
 * 会把全量 DEFAULT_SETTINGS 推进存储 blob，并覆盖上传窗口内的并发写入。
 * 提供 readRawSettings 后：写前重读原始值，只合并自身 webdav 节 delta。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  collectBackupData: vi.fn(),
  byteSizeOf: vi.fn(),
  createBackupArchive: vi.fn(),
  ensureWebDAVSupportDirs: vi.fn(),
  updateWebDAVClientRegistry: vi.fn(),
  appendWebDAVUploadIndex: vi.fn(),
  cleanupOldBackups: vi.fn(),
  getWebDAVClientProfile: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('./backupCollector', () => ({
  collectBackupData: mocks.collectBackupData,
  byteSizeOf: mocks.byteSizeOf,
}));
vi.mock('./backupArchive', () => ({ createBackupArchive: mocks.createBackupArchive }));
vi.mock('../infrastructure/webdavClient', () => ({ ensureWebDAVSupportDirs: mocks.ensureWebDAVSupportDirs }));
vi.mock('./clientRegistry', () => ({ updateWebDAVClientRegistry: mocks.updateWebDAVClientRegistry }));
vi.mock('./uploadIndex', () => ({ appendWebDAVUploadIndex: mocks.appendWebDAVUploadIndex }));
vi.mock('./cleanupService', () => ({ cleanupOldBackups: mocks.cleanupOldBackups }));
vi.mock('./clientIdentity', () => ({ getWebDAVClientProfile: mocks.getWebDAVClientProfile }));

import { beforeEach } from 'vitest';
import { performWebDAVUpload } from './uploadService';

const WEBDAV_BASE = {
  enabled: true,
  url: 'https://dav.example.com/dav',
  username: 'user',
  password: 'pass',
};

function setupMocks() {
  vi.clearAllMocks();
  mocks.collectBackupData.mockResolvedValue({ data: { viewed: { 'id-1': {} } }, version: 1 });
  mocks.byteSizeOf.mockReturnValue(10);
  mocks.createBackupArchive.mockResolvedValue({ size: 100 });
  mocks.ensureWebDAVSupportDirs.mockResolvedValue(undefined);
  mocks.updateWebDAVClientRegistry.mockResolvedValue(undefined);
  mocks.appendWebDAVUploadIndex.mockResolvedValue(undefined);
  mocks.cleanupOldBackups.mockResolvedValue(undefined);
  mocks.getWebDAVClientProfile.mockImplementation((_settings: any, overrides: any) => ({
    clientId: 'client-1',
    deviceLabel: 'test-device',
    browserName: 'TestBrowser',
    platform: 'test-platform',
    extensionVersion: '9.9.9',
    ...overrides,
  }));
  mocks.fetch.mockResolvedValue({ ok: true });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeInMemory(raw: any) {
  let rawStore: any = raw;
  return {
    get raw() { return rawStore; },
    set raw(v: any) { rawStore = v; },
    getSettings: vi.fn(async () => ({ ...rawStore, webdav: { ...(rawStore?.webdav || {}) } })),
    readRawSettings: () => Promise.resolve(rawStore),
    saveSettings: vi.fn(async (s: any) => { rawStore = s; }),
  };
}

describe('performWebDAVUpload 收尾写回竞态安全', () => {
  beforeEach(() => {
    setupMocks();
  });
  it('提供 readRawSettings 时，上传窗口内并发落盘的其他节被保留，且不写全默认值实例', async () => {
    const store = makeInMemory({
      webdav: { ...WEBDAV_BASE },
      actorLibrary: { someSeed: 'keep-me' },
    });
    // 模拟上传网络段内并发写入：fetch 触发时另一个上下文落盘了新节
    mocks.fetch.mockImplementation(async () => {
      store.raw = { ...store.raw, emby: { servers: ['seed-emby'] } };
      return { ok: true };
    });
    vi.stubGlobal('fetch', mocks.fetch);

    const result = await performWebDAVUpload({
      getSettings: store.getSettings,
      saveSettings: store.saveSettings,
      readRawSettings: store.readRawSettings,
    });

    expect(result).toEqual({ success: true });
    expect(store.saveSettings).toHaveBeenCalledTimes(1);
    // 并发写入的其他节保留
    expect(store.raw.emby).toEqual({ servers: ['seed-emby'] });
    expect(store.raw.actorLibrary).toEqual({ someSeed: 'keep-me' });
    // 自身 webdav delta 写入
    expect(store.raw.webdav.clientLastSyncStatus).toBe('success');
    expect(store.raw.webdav.clientLastSyncAt).toBeTruthy();
    expect(store.raw.webdav.clientLastUploadId).toMatch(/_client-1$/);
    expect(store.raw.webdav.lastSync).toBeTruthy();
    expect(store.raw.webdav.knownDevices).toHaveLength(1);
    expect(store.raw.webdav.knownDevices[0].clientId).toBe('client-1');
    // 不把 merged 视图的默认节推进 blob
    const savedPayload: any = store.saveSettings.mock.calls[0][0];
    expect(Object.keys(savedPayload).sort()).toEqual(['actorLibrary', 'emby', 'webdav']);
  });

  it('未提供 readRawSettings 时保持旧行为（merged 视图重读整对象写回）', async () => {
    const store = makeInMemory({ webdav: { ...WEBDAV_BASE } });
    // merged 视图携带默认节（模拟 getSettings 合并 DEFAULT_SETTINGS）
    store.getSettings = vi.fn(async () => ({
      webdav: { ...WEBDAV_BASE },
      videoEnhancement: { enabled: false },
      translation: { enabled: true },
    }));
    vi.stubGlobal('fetch', mocks.fetch);

    const result = await performWebDAVUpload({
      getSettings: store.getSettings,
      saveSettings: store.saveSettings,
    });

    expect(result).toEqual({ success: true });
    const savedPayload: any = store.saveSettings.mock.calls[0][0];
    // 旧行为：merged 默认节被整对象写回（钉住，防止误改回退语义）
    expect(savedPayload.videoEnhancement).toEqual({ enabled: false });
    expect(savedPayload.translation).toEqual({ enabled: true });
    expect(savedPayload.webdav.clientLastSyncStatus).toBe('success');
  });

  it('指定 configId 时更新对应 config 的 lastSync，其他 config 不变', async () => {
    const cfg1 = { id: 'cfg1', name: '主库', url: 'https://dav.example.com/dav', username: 'user', password: 'pass' };
    const cfg2 = { id: 'cfg2', name: '从库', url: 'https://dav2.example.com/dav', username: 'user', password: 'pass' };
    const store = makeInMemory({
      webdav: { ...WEBDAV_BASE, activeConfigId: 'cfg1', configs: [cfg1, cfg2] },
    });
    vi.stubGlobal('fetch', mocks.fetch);

    const result = await performWebDAVUpload({
      getSettings: store.getSettings,
      saveSettings: store.saveSettings,
      readRawSettings: store.readRawSettings,
      configId: 'cfg1',
    });

    expect(result).toEqual({ success: true });
    const configs = store.raw.webdav.configs;
    expect(configs[0].lastSync).toBeTruthy();
    expect(configs[1].lastSync).toBeUndefined();
    // 原始读对象不被直接变异（写入的是新对象）
    expect(cfg1.lastSync).toBeUndefined();
  });

  it('readRawSettings 抛错时回退 merged 重读，上传成功不阻断', async () => {
    const store = makeInMemory({ webdav: { ...WEBDAV_BASE } });
    store.getSettings = vi.fn(async () => ({ webdav: { ...WEBDAV_BASE }, otherSection: { kept: true } }));
    const readRawSettings = vi.fn(() => Promise.reject(new Error('storage down')));
    vi.stubGlobal('fetch', mocks.fetch);

    const result = await performWebDAVUpload({
      getSettings: store.getSettings,
      saveSettings: store.saveSettings,
      readRawSettings,
    });

    expect(result).toEqual({ success: true });
    expect(store.raw.otherSection).toEqual({ kept: true });
    expect(store.raw.webdav.clientLastSyncStatus).toBe('success');
  });
});
