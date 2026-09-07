/**
 * 密码显示助手 - 独立内容脚本
 * 在所有网站上运行，提供密码显示功能
 *
 * 按需化设计（2026-09-07 性能周期 2 批四 / B2）：
 * - 首帧仅做一次 chrome.storage 读取，用于探测开关状态（唯一的 storage 读）；
 * - 启用态：延迟启动助手，并注册 onMessage / storage.onChanged 监听以支持热配置变更；
 * - 关闭态：首帧后零常驻监听、零重复读取，脚本完全静默。
 *   注意取舍：关闭态页面无法收到设置面板的热开启广播，需刷新页面生效；
 *   新打开/新导航的页面始终按最新配置即时生效。
 */

// 简单的日志函数（不依赖 state.ts）
const log = (...args: any[]) => {
    console.log('[PasswordHelper]', ...args);
};

const KEY_ENTER = 13;
const KEY_CTRL = 17;

class PasswordHelper {
    private showMethod: number = 0;
    private waitTime: number = 300;
    private modified: WeakSet<HTMLInputElement> = new WeakSet();
    private observer: MutationObserver | null = null;

    constructor(showMethod: number = 0, waitTime: number = 300) {
        this.showMethod = showMethod;
        this.waitTime = waitTime;
    }

    public init(): void {
        log('初始化密码显示助手', {
            showMethod: this.showMethod,
            waitTime: this.waitTime
        });

        this.modifyAllInputs();

        this.observer = new MutationObserver(() => {
            this.modifyAllInputs();
        });

        this.observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['type']
        });
    }

    public destroy(): void {
        log('销毁密码显示助手');

        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }

        this.modified = new WeakSet();
    }

    public updateConfig(showMethod: number, waitTime: number): void {
        log('更新配置', { showMethod, waitTime });

        this.showMethod = showMethod;
        this.waitTime = waitTime;

        this.destroy();
        this.init();
    }

    private modifyAllInputs(): void {
        const passwordInputs = document.querySelectorAll('input[type=password]');
        passwordInputs.forEach(input => {
            if (!this.modified.has(input as HTMLInputElement)) {
                this.applyBehavior(input as HTMLInputElement);
                this.modified.add(input as HTMLInputElement);
            }
        });
    }

    private applyBehavior(input: HTMLInputElement): void {
        const actions = [
            this.mouseOver.bind(this),
            this.mouseDblClick.bind(this),
            this.mouseFocus.bind(this),
            this.ctrlKeyShift.bind(this)
        ];

        actions[this.showMethod](input);
    }

    private mouseOver(input: HTMLInputElement): void {
        let isMouseOver = false;

        input.addEventListener('mouseover', () => {
            isMouseOver = true;
            setTimeout(() => {
                if (isMouseOver) {
                    input.type = 'text';
                }
            }, this.waitTime);
        }, false);

        input.addEventListener('mouseout', () => {
            isMouseOver = false;
            input.type = 'password';
        }, false);

        input.addEventListener('blur', () => {
            input.type = 'password';
        }, false);

        input.addEventListener('keydown', (e) => {
            if (e.keyCode === KEY_ENTER) {
                input.type = 'password';
            }
        }, false);
    }

    private mouseDblClick(input: HTMLInputElement): void {
        input.addEventListener('dblclick', () => {
            input.type = input.type === 'password' ? 'text' : 'password';
        }, false);

        input.addEventListener('blur', () => {
            input.type = 'password';
        }, false);

        input.addEventListener('keydown', (e) => {
            if (e.keyCode === KEY_ENTER) {
                input.type = 'password';
            }
        }, false);
    }

    private mouseFocus(input: HTMLInputElement): void {
        input.addEventListener('focus', () => {
            input.type = 'text';
        }, false);

        input.addEventListener('blur', () => {
            input.type = 'password';
        }, false);

        input.addEventListener('keydown', (e) => {
            if (e.keyCode === KEY_ENTER) {
                input.type = 'password';
            }
        }, false);
    }

    private ctrlKeyShift(input: HTMLInputElement): void {
        let isHide = true;
        let notPressCtrl = true;
        let onlyCtrl = true;

        input.addEventListener('blur', () => {
            input.type = 'password';
            isHide = true;
            notPressCtrl = true;
            onlyCtrl = true;
        }, false);

        input.addEventListener('keyup', (e) => {
            if (e.keyCode === KEY_CTRL) {
                if (onlyCtrl) {
                    isHide = !isHide;
                } else {
                    isHide = false;
                }

                if (isHide) {
                    input.type = 'password';
                } else {
                    input.type = 'text';
                }
                notPressCtrl = true;
                onlyCtrl = true;
            }
        }, false);

        input.addEventListener('keydown', (e) => {
            if (e.keyCode === KEY_ENTER) {
                input.type = 'password';
                isHide = true;
                notPressCtrl = true;
                onlyCtrl = true;
            } else if (e.keyCode === KEY_CTRL) {
                if (notPressCtrl) {
                    input.type = 'text';
                    notPressCtrl = false;
                    onlyCtrl = true;
                }
            } else {
                onlyCtrl = notPressCtrl;
            }
        }, false);
    }
}

// 从 chrome.storage 获取设置
async function getSettings() {
    try {
        const result = await chrome.storage.local.get('settings');
        return result.settings || {};
    } catch (error) {
        log('Failed to get settings:', error);
        return {};
    }
}

/** 主 content bootstrap 已覆盖的站点：避免与 passwordHelper:init 双份注入 */
function isCoveredByMainContentScript(hostname: string): boolean {
    const host = String(hostname || '').toLowerCase();
    return (
        host === 'javdb.com' ||
        host.endsWith('.javdb.com') ||
        host === 'javdb36.com' ||
        host.endsWith('.javdb36.com') ||
        host.includes('javdb')
    );
}

type RuntimeMessageListener = (message: any, sender?: any, sendResponse?: (response?: any) => void) => void;
type StorageChangedListener = (changes: { [key: string]: any }, areaName: string) => void;

/** 模块运行态：helper 实例与当前已注册的监听器引用 */
const runtimeState = {
    helper: null as PasswordHelper | null,
    messageListener: null as RuntimeMessageListener | null,
    storageListener: null as StorageChangedListener | null,
    startedForHost: '' as string,
};

function startHelper(config: { showMethod?: number; waitTime?: number }): void {
    if (runtimeState.helper) return;
    const helper = new PasswordHelper(config.showMethod || 0, config.waitTime || 300);
    runtimeState.helper = helper;
    // 延迟到首帧后再挂 MutationObserver，降低页面初始化成本
    setTimeout(() => {
        runtimeState.helper?.init();
        log('Password helper initialized on', window.location.hostname);
    }, 1000);
}

function stopHelper(): void {
    if (runtimeState.helper) {
        runtimeState.helper.destroy();
        runtimeState.helper = null;
        log('Password helper disabled');
    }
}

/** 启用态才持有监听器；关闭态注销全部监听（零常驻） */
function ensureListenersRegistered(): void {
    if (runtimeState.messageListener === null) {
        const listener: RuntimeMessageListener = (message) => {
            if (message.type === 'settings-updated' || message.type === 'SETTINGS_UPDATED') {
                applySettings(message.settings);
            }
        };
        chrome.runtime.onMessage.addListener(listener);
        runtimeState.messageListener = listener;
    }
    if (runtimeState.storageListener === null) {
        const listener: StorageChangedListener = (changes, area) => {
            if (area !== 'local' || !changes['settings']) return;
            applySettings(changes['settings'].newValue || {});
        };
        try {
            chrome.storage.onChanged.addListener(listener);
            runtimeState.storageListener = listener;
        } catch (e) {
            log('storage.onChanged bind failed', e);
        }
    }
}

function unregisterListeners(): void {
    if (runtimeState.messageListener) {
        try {
            chrome.runtime.onMessage.removeListener(runtimeState.messageListener);
        } catch (e) {
            log('onMessage removeListener failed', e);
        }
        runtimeState.messageListener = null;
    }
    if (runtimeState.storageListener) {
        try {
            chrome.storage.onChanged.removeListener(runtimeState.storageListener);
        } catch (e) {
            log('storage.onChanged removeListener failed', e);
        }
        runtimeState.storageListener = null;
    }
}

function applySettings(newSettings: any): void {
    if (newSettings?.userExperience?.enablePasswordHelper) {
        const newConfig = newSettings.passwordHelper || { showMethod: 0, waitTime: 300 };
        if (runtimeState.helper) {
            runtimeState.helper.updateConfig(newConfig.showMethod || 0, newConfig.waitTime || 300);
        } else {
            startHelper(newConfig);
        }
        ensureListenersRegistered();
        log('Password helper config updated');
    } else {
        stopHelper();
        unregisterListeners();
    }
}

// 初始化密码助手
export async function initialize(hostname: string = window.location.hostname): Promise<void> {
    try {
        if (runtimeState.startedForHost === hostname) return;
        runtimeState.startedForHost = hostname;

        // 全站独立脚本：JavDB 主站由 apps/content/bootstrap 的 passwordHelper:init 负责
        if (isCoveredByMainContentScript(hostname)) {
            log('Skip standalone on main content host', hostname);
            return;
        }

        // 首帧唯一一次 storage 读：探测开关状态
        const settings = await getSettings() as any;
        if (settings?.userExperience?.enablePasswordHelper) {
            applySettings(settings);
        } else {
            // 关闭态：不注册任何监听器，脚本静默（刷新后按最新配置生效）
            log('Password helper is disabled; no listeners registered until next navigation');
        }
    } catch (error) {
        log('Initialization failed:', error);
    }
}

/**
 * 清理钩子（供测试 teardown 使用）：注销全部监听器、断开 DOM 观察并复位站点标记。
 * 生产环境内容脚本生命周期内不会调用。
 */
export function disposeForTests(): void {
    stopHelper();
    unregisterListeners();
    runtimeState.startedForHost = '';
}

// 启动
void initialize();
