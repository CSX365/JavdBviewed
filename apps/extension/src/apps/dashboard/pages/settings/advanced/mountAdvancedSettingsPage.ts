/**
 * @file mountAdvancedSettingsPage.ts
 * @description 挂载高级配置 React 全页
 * @module apps/dashboard/pages/settings/advanced
 */
import { AdvancedSettingsPage } from './AdvancedSettingsPage';
import { mountReactSettingsPage, unmountReactSettingsPage } from '../shared/mountReactSettingsPage';

export async function mountAdvancedSettingsPage(hostSelector = '#tab-settings'): Promise<void> {
  await mountReactSettingsPage({
    hostSelector,
    kind: 'subpage',
    element: AdvancedSettingsPage,
    markerAttr: 'data-advanced-settings-react',
    mountDataset: { advancedSettingsReact: '1' },
  });
}

export function unmountAdvancedSettingsPage(hostSelector = '#tab-settings'): void {
  unmountReactSettingsPage(hostSelector);
}
