/**
 * @file mountPrivacySettingsPage.ts
 * @description 挂载隐私保护 React 全页
 * @module apps/dashboard/pages/settings/privacy
 */
import { PrivacySettingsPage } from './PrivacySettingsPage';
import { mountReactSettingsPage, unmountReactSettingsPage } from '../shared/mountReactSettingsPage';

export async function mountPrivacySettingsPage(hostSelector = '#tab-settings'): Promise<void> {
  await mountReactSettingsPage({
    hostSelector,
    kind: 'subpage',
    element: PrivacySettingsPage,
    markerAttr: 'data-privacy-settings-react',
    mountDataset: { privacySettingsReact: '1' },
  });
}

export function unmountPrivacySettingsPage(hostSelector = '#tab-settings'): void {
  unmountReactSettingsPage(hostSelector);
}
