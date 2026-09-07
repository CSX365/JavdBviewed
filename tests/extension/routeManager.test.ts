/**
 * @file routeManager.test.ts
 * @description RouteManager remote config 测试
 * @module tests/extension
 */
import { describe, expect, it, vi } from 'vitest';
import manifest from '../../apps/extension/src/manifest.json';
import { DEFAULT_SETTINGS } from '../../apps/extension/src/utils/config';
import { getChromeStorageSnapshot, setChromeStorage } from '../setup/chrome';

describe('RouteManager remote config', () => {
  it('updates routes from the server config endpoint before falling back to legacy routes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        updatedAt: '2026-05-27T00:00:00.000Z',
        routes: {
          javdb: {
            primary: 'https://javdb.com',
            alternatives: [
              {
                url: 'https://javdb-server-alt.example',
                status: 'active',
                description: 'server route',
              },
            ],
          },
          javbus: {
            primary: 'https://www.javbus.com',
            alternatives: [],
          },
        },
        announcements: [],
        updatePolicy: {
          latestVersion: '1.20.2',
          minimumVersion: '1.18.0',
          releaseUrl: 'https://github.com/JavdBviewed/JavdBviewed/releases/latest',
        },
        featureFlags: {
          telemetryRequired: true,
          remoteRoutesEnabled: true,
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    setChromeStorage({
      settings: {
        ...DEFAULT_SETTINGS,
        routes: {
          ...(DEFAULT_SETTINGS as any).routes,
          javdb: {
            ...(DEFAULT_SETTINGS as any).routes.javdb,
            alternatives: [
              {
                url: 'https://user-route.example',
                enabled: true,
                description: 'user custom',
                addedAt: 1,
              },
            ],
          },
        },
      },
    });

    const { SERVER_ENDPOINT_STATE_KEY } = await import('../../apps/extension/src/platform/network');
    setChromeStorage({
      [SERVER_ENDPOINT_STATE_KEY]: {
        apiBaseUrl: 'https://resolved-api.example',
        updatedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    });

    const { RouteManager } = await import('../../apps/extension/src/features/routeManagement');

    await expect(RouteManager.getInstance().checkAndUpdateRoutes(true)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      `https://resolved-api.example/v1/config?channel=stable&version=${manifest.version}&platform=unknown&locale=en-US`,
      expect.objectContaining({
        cache: 'no-cache',
      }),
    );
    const settings = getChromeStorageSnapshot().settings;
    expect(settings.routes.javdb.alternatives).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: 'https://javdb-server-alt.example',
        enabled: true,
        description: 'server route',
      }),
      expect.objectContaining({
        url: 'https://user-route.example',
        enabled: true,
        description: 'user custom',
      }),
    ]));
  });

  it('rejects server config updates when checksum validation fails', async () => {
    const tamperedConfig = {
      schemaVersion: 1,
      updatedAt: '2026-05-27T00:00:00.000Z',
      routes: {
        javdb: {
          primary: 'https://tampered.example',
          alternatives: [],
        },
        javbus: {
          primary: 'https://www.javbus.com',
          alternatives: [],
        },
      },
      announcements: [],
      updatePolicy: {
        latestVersion: '1.20.2',
        minimumVersion: '1.18.0',
        releaseUrl: 'https://github.com/JavdBviewed/JavdBviewed/releases/latest',
      },
      featureFlags: {
        telemetryRequired: true,
        remoteRoutesEnabled: true,
      },
    };
    const configBody = JSON.stringify(tamperedConfig);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => name.toLowerCase() === 'x-config-checksum' ? 'bad-checksum' : null,
      },
      text: async () => configBody,
      json: async () => tamperedConfig,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { SERVER_ENDPOINT_STATE_KEY } = await import('../../apps/extension/src/platform/network');
    setChromeStorage({
      settings: DEFAULT_SETTINGS,
      [SERVER_ENDPOINT_STATE_KEY]: {
        apiBaseUrl: 'https://resolved-api.example',
        updatedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    });

    const { RouteManager } = await import('../../apps/extension/src/features/routeManagement');

    await expect(RouteManager.getInstance().checkAndUpdateRoutes(true)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getChromeStorageSnapshot().settings.routes.javdb.primary).toBe(DEFAULT_SETTINGS.routes?.javdb.primary);
  });

  it('does not clobber sibling settings fields written concurrently during remote route merge', async () => {
    // 用 10ms 延迟包装 storage get/set，模拟真实 storage IPC 窗口内的读写交错
    const storage = chrome.storage.local;
    const origGet = storage.get.bind(storage);
    const origSet = storage.set.bind(storage);
    const LATENCY = 10;

    storage.get = ((keys?: string | string[] | Record<string, any> | null, callback?: (items: Record<string, any>) => void) => {
      const resultPromise = new Promise<Record<string, any>>((resolve) => {
        setTimeout(() => {
          (origGet as any)(keys, (result: Record<string, any>) => resolve(result));
        }, LATENCY);
      });
      if (callback) {
        resultPromise.then((result) => callback(result));
        return undefined;
      }
      return resultPromise;
    }) as any;

    storage.set = ((payload: Record<string, any>, callback?: () => void) => {
      const resultPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          (origSet as any)(payload, () => resolve());
        }, LATENCY);
      });
      if (callback) {
        resultPromise.then(() => callback());
        return undefined;
      }
      return resultPromise;
    }) as any;

    try {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          updatedAt: '2026-06-01T00:00:00.000Z',
          routes: {
            javdb: {
              primary: 'https://javdb.com',
              alternatives: [
                {
                  url: 'https://alt-a.example',
                  status: 'active',
                  description: 'server route',
                },
              ],
            },
            javbus: {
              primary: 'https://www.javbus.com',
              alternatives: [],
            },
          },
          announcements: [],
          updatePolicy: {
            latestVersion: '1.20.2',
            minimumVersion: '1.18.0',
            releaseUrl: 'https://github.com/JavdBviewed/JavdBviewed/releases/latest',
          },
          featureFlags: {
            telemetryRequired: true,
            remoteRoutesEnabled: true,
          },
        }),
      });
      vi.stubGlobal('fetch', fetchMock);
      setChromeStorage({
        settings: {
          ...DEFAULT_SETTINGS,
          routes: {
            ...(DEFAULT_SETTINGS as any).routes,
            javdb: {
              ...(DEFAULT_SETTINGS as any).routes.javdb,
              alternatives: [
                {
                  url: 'https://user-route.example',
                  enabled: true,
                  description: 'user custom',
                  addedAt: 1,
                },
              ],
            },
          },
        },
      });

      const { SERVER_ENDPOINT_STATE_KEY } = await import('../../apps/extension/src/platform/network');
      setChromeStorage({
        [SERVER_ENDPOINT_STATE_KEY]: {
          apiBaseUrl: 'https://resolved-api.example',
          updatedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      });

      const { RouteManager } = await import('../../apps/extension/src/features/routeManagement');
      const updatePromise = RouteManager.getInstance().checkAndUpdateRoutes(true);

      // 时序（每个包装的 storage 操作 10ms）：
      // t=0 getUpdateStatus / t=10 saveUpdateStatus / t=20 readEndpointState /
      // t=30 fetch→merge getSettings(读到 t=30 的快照) /
      // t=45 模拟其他 feature 完成一次并发写（兄弟字段 someFlag），
      // 此时 buggy 的整对象陈旧写将在 t=50 落盘，把它整个盖掉。
      await vi.advanceTimersByTimeAsync(45);
      setChromeStorage({
        settings: {
          ...getChromeStorageSnapshot().settings,
          someFlag: true,
        },
      });
      await vi.advanceTimersByTimeAsync(30);
      await expect(updatePromise).resolves.toBe(true);

      const settings = getChromeStorageSnapshot().settings;
      // 并发的兄弟字段写入不得被线路合并的陈旧整写抹掉
      expect(settings.someFlag).toBe(true);
      // 合并语义本身保持不变：服务端线路 + 用户自定义线路都保留
      expect(settings.routes.javdb.alternatives).toEqual(expect.arrayContaining([
        expect.objectContaining({
          url: 'https://alt-a.example',
          enabled: true,
          description: 'server route',
        }),
        expect.objectContaining({
          url: 'https://user-route.example',
          enabled: true,
          description: 'user custom',
        }),
      ]));
    } finally {
      storage.get = origGet as any;
      storage.set = origSet as any;
    }
  });

});
