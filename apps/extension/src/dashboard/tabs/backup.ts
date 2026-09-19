/**
 * @file backup.ts
 * @description 备份与恢复标签页初始化
 * @module dashboard/tabs
 */

import { initBackupActions } from '../backup/actions';
import { updateSyncStatus } from '../backup/syncStatus';

export function initBackupTab(): void {
  const root = document.getElementById('tab-backup');
  if (!root) {
    return;
  }

  initBackupActions(root);
  updateSyncStatus();
}
