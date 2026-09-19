/**
 * @file mountCloudSettingsPage.ts
 * @description 挂载 Cloud 多端同步 React 设置页
 * @module apps/dashboard/pages/settings/cloud
 */
import { CloudSettingsPage } from './CloudSettingsPage';
import { mountReactSettingsPage, unmountReactSettingsPage } from '../shared/mountReactSettingsPage';

export async function mountCloudSettingsPage(hostSelector = '#tab-settings'): Promise<void> {
  await mountReactSettingsPage({
    hostSelector,
    kind: 'subpage',
    element: CloudSettingsPage,
    markerAttr: 'data-cloud-settings-react',
    mountDataset: { cloudSettingsReact: '1' },
  });
}

export function unmountCloudSettingsPage(hostSelector = '#tab-settings'): void {
  unmountReactSettingsPage(hostSelector);
}
