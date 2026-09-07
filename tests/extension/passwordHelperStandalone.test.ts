/**
 * @file passwordHelperStandalone.test.ts
 * @description passwordHelper-standalone 按需化（B2）：关闭态首帧后零常驻监听、storage 单次读取；
 * 启用态监听器生命周期与热配置（message / storage.onChanged 双通道）。
 * 注：jsdom 默认 URL 为 https://javdb.com/v/abc123 —— 模块导入时自动 init 走「主站跳过」路径，
 * 测试通过显式 initialize(hostname) 驱动外站路径。
 * @module tests/extension
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setChromeStorage } from '../setup/chrome';

const MODULE_PATH = '../../apps/extension/src/content/passwordHelper-standalone.ts';

/** 记录本用例内加载过的模块实例：jsdom document 全文件共享，必须断开旧实例的 MutationObserver，避免跨用例污染 */
const loadedModules: Array<{ disposeForTests: () => void }> = [];

afterEach(() => {
  for (const mod of loadedModules.splice(0)) {
    mod.disposeForTests();
  }
  document.body.innerHTML = '';
});

async function loadModuleWithSettings(settings: Record<string, any>) {
  vi.resetModules();
  setChromeStorage({ settings });
  const mod = await import(MODULE_PATH);
  loadedModules.push(mod);
  return mod;
}



function createPasswordInput(): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'password';
  document.body.appendChild(input);
  return input;
}

function onMessageHasListeners(): boolean {
  return chrome.runtime.onMessage.hasListeners();
}

function storageChangedHasListeners(): boolean {
  return chrome.storage.onChanged.hasListeners();
}

describe('passwordHelper-standalone 按需化', () => {
  it('主站（javdb）自动 init 跳过：不读 storage、不注册任何监听器', async () => {
    setChromeStorage({ settings: { userExperience: { enablePasswordHelper: true } } });
    vi.resetModules();
    // jsdom URL = javdb.com → 模块顶部自动 initialize() 走主站跳过分支
    const autoMod = await import(MODULE_PATH);
    loadedModules.push(autoMod);
    // 跳过分支发生在首帧同步段（storage 读之前），导入完成即无挂起任务
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(onMessageHasListeners()).toBe(false);
    expect(storageChangedHasListeners()).toBe(false);
  });

  it('外站关闭态：首帧仅 1 次 storage 读取，首帧后零常驻监听', async () => {
    const mod = await loadModuleWithSettings({
      userExperience: { enablePasswordHelper: false },
      passwordHelper: { showMethod: 0, waitTime: 300 },
    });
    await mod.initialize('example.com');

    expect(chrome.storage.local.get).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.get).toHaveBeenCalledWith('settings');
    expect(onMessageHasListeners(), '关闭态不应持有 runtime.onMessage 监听').toBe(false);
    expect(storageChangedHasListeners(), '关闭态不应持有 storage.onChanged 监听').toBe(false);

    // 静默期不产生任何新增 storage 读取
    await vi.advanceTimersByTimeAsync(5000);
    expect(chrome.storage.local.get).toHaveBeenCalledTimes(1);
  });

  it('外站启用态：注册双通道监听，延迟 1s 启动并挂接双击行为', async () => {
    const input = createPasswordInput();
    const mod = await loadModuleWithSettings({
      userExperience: { enablePasswordHelper: true },
      passwordHelper: { showMethod: 1, waitTime: 300 },
    });
    await mod.initialize('example.com');

    expect(onMessageHasListeners()).toBe(true);
    expect(storageChangedHasListeners()).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    input.dispatchEvent(new MouseEvent('dblclick'));
    expect(input.type).toBe('text');
    input.dispatchEvent(new MouseEvent('dblclick'));
    expect(input.type).toBe('password');
  });

  it('启用态热关闭（runtime settings-updated 通道）：销毁助手并注销全部监听器', async () => {
    createPasswordInput();
    const mod = await loadModuleWithSettings({
      userExperience: { enablePasswordHelper: true },
      passwordHelper: { showMethod: 1, waitTime: 300 },
    });
    await mod.initialize('example.com');
    await vi.advanceTimersByTimeAsync(1000);
    expect(onMessageHasListeners()).toBe(true);
    expect(storageChangedHasListeners()).toBe(true);

    chrome.runtime.onMessage.dispatch(
      { type: 'settings-updated', settings: { userExperience: { enablePasswordHelper: false } } },
      { tab: { id: 1 } } as any,
      () => undefined,
    );

    expect(onMessageHasListeners(), '关闭后应注销 onMessage 监听').toBe(false);
    expect(storageChangedHasListeners(), '关闭后应注销 storage.onChanged 监听').toBe(false);
  });

  it('启用态热关闭（storage.onChanged 通道）：注销全部监听器', async () => {
    createPasswordInput();
    await loadModuleWithSettings({
      userExperience: { enablePasswordHelper: true },
      passwordHelper: { showMethod: 1, waitTime: 300 },
    });
    await vi.advanceTimersByTimeAsync(0);
    // 显式触发模块内 initialize 的外站路径（模块导入时 auto-init 走 javdb 跳过分支）
    const mod = loadedModules[loadedModules.length - 1] as unknown as typeof import('../../apps/extension/src/content/passwordHelper-standalone.ts');
    await mod.initialize('example.org');
    await vi.advanceTimersByTimeAsync(1000);
    expect(onMessageHasListeners()).toBe(true);

    // mock 的 storage.local.set 会向 onChanged 派发 changes
    await chrome.storage.local.set({ settings: { userExperience: { enablePasswordHelper: false } } });

    expect(onMessageHasListeners()).toBe(false);
    expect(storageChangedHasListeners()).toBe(false);
  });

  it('启用态热更新（showMethod 变更）：助手重建后按新方式响应', async () => {
    const input = createPasswordInput();
    await loadModuleWithSettings({
      userExperience: { enablePasswordHelper: true },
      passwordHelper: { showMethod: 0, waitTime: 300 },
    });
    const mod = loadedModules[loadedModules.length - 1] as unknown as typeof import('../../apps/extension/src/content/passwordHelper-standalone.ts');
    await mod.initialize('example.net');
    await vi.advanceTimersByTimeAsync(1000);

    // 初始 showMethod=0（mouseover）：dblclick 不生效
    input.dispatchEvent(new MouseEvent('dblclick'));
    expect(input.type).toBe('password');

    chrome.runtime.onMessage.dispatch(
      {
        type: 'SETTINGS_UPDATED',
        settings: {
          userExperience: { enablePasswordHelper: true },
          passwordHelper: { showMethod: 1, waitTime: 300 },
        },
      },
      { tab: { id: 1 } } as any,
      () => undefined,
    );

    // updateConfig 内 destroy+init 为同步路径
    input.dispatchEvent(new MouseEvent('dblclick'));
    expect(input.type).toBe('text');
    input.dispatchEvent(new MouseEvent('dblclick'));
    expect(input.type).toBe('password');
  });
});
