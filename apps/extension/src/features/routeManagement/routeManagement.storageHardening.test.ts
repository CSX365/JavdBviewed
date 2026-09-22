/**
 * @file routeManagement.storageHardening.test.ts
 * @description 回归：chrome.storage.local.get 回调以 undefined 被调用时
 *      （storage 异常 / SW 生命周期边缘场景），RouteManager 不得在回调内抛异常、
 *      不得挂死 Promise。真机崩溃：
 *      "Error handling response: TypeError: Cannot read properties of undefined
 *       (reading 'routes_update_status')"（该前缀为 Chrome message binding 内部日志）
 * @module features/routeManagement
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteManager } from './index';

type StorageCb = (result: Record<string, unknown> | undefined) => void;

/**
 * 安装 chrome.storage 模拟。
 * options.routesUpdateStatusCallbackUndefined = true 时，
 * 对 'routes_update_status' 的回调式读取以 undefined 回调，复现真机崩溃边缘场景。
 */
function installChromeMock(options: { routesUpdateStatusCallbackUndefined?: boolean }) {
    const state: Record<string, unknown> = {};
    const chromeMock = {
        runtime: {
            lastError: undefined,
            getManifest: () => ({ version: '2.0.0' }),
            sendMessage: vi.fn(),
        },
        storage: {
            local: {
                get: vi.fn((key: string | string[] | Record<string, unknown>, cb?: StorageCb) => {
                    const keys = Array.isArray(key) ? key : typeof key === 'string' ? [key] : Object.keys(key ?? {});
                    const result: Record<string, unknown> = {};
                    for (const k of keys) {
                        if (k in state) result[k] = state[k];
                    }
                    if (typeof cb === 'function') {
                        if (options.routesUpdateStatusCallbackUndefined && keys.includes('routes_update_status')) {
                            cb(undefined);
                        } else {
                            cb(result);
                        }
                        return undefined;
                    }
                    return Promise.resolve(result);
                }),
                set: vi.fn((obj: Record<string, unknown>, cb?: () => void) => {
                    Object.assign(state, obj);
                    cb?.();
                    return Promise.resolve();
                }),
                remove: vi.fn((key: string, cb?: () => void) => {
                    delete state[key];
                    cb?.();
                    return Promise.resolve();
                }),
            },
        },
    };
    vi.stubGlobal('chrome', chromeMock);
    return { state, chromeMock };
}

function installFetchMock() {
    const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

/** 给 Promise 套超时，证明「不挂死」：挂死则测试以明确错误失败 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 未 settle（Promise 挂死）`)), ms);
    });
    try {
        return await Promise.race([p, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

describe('RouteManager storage 回调加固', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('storage 回调以 undefined 被调用时不挂死、不抛异常（真机崩溃场景）', async () => {
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        installChromeMock({ routesUpdateStatusCallbackUndefined: true });
        const fetchMock = installFetchMock();

        const manager = RouteManager.getInstance();
        const result = await withTimeout(manager.checkAndUpdateRoutes(true), 5000, 'checkAndUpdateRoutes(true)');

        // 远程拉取 404 → 优雅返回 false；全程不得挂死、不得把异常抛到微任务外
        expect(result).toBe(false);
        // 流程推进到了远程拉取（说明 getUpdateStatus 已正常 settle，未挂死在回调上）
        expect(fetchMock).toHaveBeenCalled();
        consoleWarn.mockRestore();
        consoleInfo.mockRestore();
        consoleError.mockRestore();
    });

    it('storage 正常返回数据时，24 小时内跳过更新且不打远程', async () => {
        const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { state } = installChromeMock({ routesUpdateStatusCallbackUndefined: false });
        state.routes_update_status = {
            lastCheckTime: Date.now() - 60_000,
            lastUpdateTime: 0,
            currentVersion: '1.0.0',
        };
        const fetchMock = installFetchMock();

        const manager = RouteManager.getInstance();
        const result = await withTimeout(manager.checkAndUpdateRoutes(false), 5000, 'checkAndUpdateRoutes(false)');

        expect(result).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
        consoleDebug.mockRestore();
        consoleWarn.mockRestore();
    });
});
