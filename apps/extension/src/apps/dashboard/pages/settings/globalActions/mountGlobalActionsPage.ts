/**
 * @file mountGlobalActionsPage.ts
 * @description 挂载全局操作 React 全页
 * @module apps/dashboard/pages/settings/globalActions
 */
import { GlobalActionsPage } from './GlobalActionsPage';
import { mountReactSettingsPage, unmountReactSettingsPage } from '../shared/mountReactSettingsPage';

export async function mountGlobalActionsPage(hostSelector = '#tab-settings'): Promise<void> {
  await mountReactSettingsPage({
    hostSelector,
    kind: 'subpage',
    element: GlobalActionsPage,
    markerAttr: 'data-global-actions-react',
    mountDataset: { globalActionsReact: '1' },
  });
}

export function unmountGlobalActionsPage(hostSelector = '#tab-settings'): void {
  unmountReactSettingsPage(hostSelector);
}
