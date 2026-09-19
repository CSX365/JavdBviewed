/**
 * @file syncStatus.ts
 * @description 备份同步状态显示（轻量模块：仅依赖 STATE）
 * @module dashboard/backup
 *
 * S1-C 架构级入口拆分：从 backup/actions.ts 拆出。actions.ts 携带
 * import.ts / dbClient / backupArchive / confirmModal 等重依赖，只随
 * backup tab 激活时加载；而 updateSyncStatus / setSyncingStatus 在入口
 * 首屏与 storage.onChanged 监听中就需要调用，故独立成本轻量模块留在入口闭包。
 */
import { STATE } from '../state';

function updateSyncDisplay(lastSyncTimeElement: HTMLSpanElement, syncIndicator: HTMLDivElement, lastSync: string, warningDays: number): void {
  const warningBanner = document.getElementById('webdavWarningBanner') as HTMLDivElement;
  const warningMessage = document.getElementById('webdavWarningMessage') as HTMLDivElement;
  
  if (lastSync) {
    const syncDate = new Date(lastSync);
    const now = new Date();
    const rawDiffMs = now.getTime() - syncDate.getTime();
    const diffMs = Number.isFinite(rawDiffMs) ? Math.max(0, rawDiffMs) : 0;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    let timeText = '';
    if (diffDays > 0) timeText = `${diffDays}天前`;
    else if (diffHours > 0) timeText = `${diffHours}小时前`;
    else { const diffMinutes = Math.floor(diffMs / (1000 * 60)); timeText = diffMinutes > 0 ? `${diffMinutes}分钟前` : '刚刚'; }
    lastSyncTimeElement.textContent = timeText;
    lastSyncTimeElement.title = syncDate.toLocaleString('zh-CN');
    syncIndicator.className = 'sync-indicator';
    
    // 显示/隐藏预警横幅
    if (warningDays > 0 && diffDays > warningDays) {
      syncIndicator.classList.add('error');
      const statusText = syncIndicator.querySelector('.sync-status-text') as HTMLSpanElement | null;
      if (statusText) statusText.textContent = '需要同步';
      
      // 显示预警横幅
      if (warningBanner && warningMessage) {
        warningBanner.style.display = 'flex';
        warningMessage.textContent = `已超过 ${diffDays} 天未备份，建议尽快同步`;
      }
    } else {
      // 隐藏预警横幅
      if (warningBanner) {
        warningBanner.style.display = 'none';
      }
      
      if (diffDays > 1) {
        syncIndicator.classList.add('synced');
        const statusText = syncIndicator.querySelector('.sync-status-text') as HTMLSpanElement | null;
        if (statusText) statusText.textContent = '已同步';
      } else {
        syncIndicator.classList.add('synced');
        const statusText = syncIndicator.querySelector('.sync-status-text') as HTMLSpanElement | null;
        if (statusText) statusText.textContent = '最新';
      }
    }
  } else {
    lastSyncTimeElement.textContent = '从未';
    lastSyncTimeElement.title = '尚未进行过同步';
    syncIndicator.className = 'sync-indicator';
    const text = syncIndicator.querySelector('.sync-status-text') as HTMLSpanElement | null;
    if (text) text.textContent = '未同步';
    
    // 显示预警横幅（从未备份）
    if (warningDays > 0 && warningBanner && warningMessage) {
      syncIndicator.classList.add('error');
      warningBanner.style.display = 'flex';
      warningMessage.textContent = '尚未进行过备份，建议立即同步';
    } else if (warningBanner) {
      warningBanner.style.display = 'none';
    }
  }
}

export function updateSyncStatus(): void {
  try {
    const lastSyncTimeElement = document.getElementById('lastSyncTime') as HTMLSpanElement;
    const lastSyncTimeSettings = document.getElementById('last-sync-time') as HTMLSpanElement;
    const syncIndicator = document.getElementById('syncIndicator') as HTMLDivElement;
    const webdavSettings = STATE.settings?.webdav || {};
    const lastSync = webdavSettings.lastSync || '';
    const warningDays = Number(webdavSettings.warningDays ?? 7);
    if (lastSyncTimeElement && syncIndicator) {
      updateSyncDisplay(lastSyncTimeElement, syncIndicator, lastSync, Number.isFinite(warningDays) ? warningDays : 7);
    }
    if (lastSyncTimeSettings) {
      lastSyncTimeSettings.textContent = lastSync ? new Date(lastSync).toLocaleString('zh-CN') : '从未';
    }
    if (lastSync && Number.isFinite(warningDays) && warningDays > 0) {
      const diffMs = Date.now() - new Date(lastSync).getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      // 预警横幅已经在 updateSyncDisplay 中显示，不需要额外的 toast 消息
    }
  } catch (error) {
    console.error('更新同步状态时出错:', error);
    const lastSyncTimeElement = document.getElementById('lastSyncTime') as HTMLSpanElement;
    const lastSyncTimeSettings = document.getElementById('last-sync-time') as HTMLSpanElement;
    const syncIndicator = document.getElementById('syncIndicator') as HTMLDivElement;
    if (lastSyncTimeElement) lastSyncTimeElement.textContent = '从未';
    if (lastSyncTimeSettings) lastSyncTimeSettings.textContent = '从未';
    if (syncIndicator) {
      syncIndicator.className = 'sync-indicator';
      const statusText = syncIndicator.querySelector('.sync-status-text');
      if (statusText) (statusText as HTMLSpanElement).textContent = '未同步';
    }
  }
}

export function setSyncingStatus(isUploading: boolean = false): void {
  const syncIndicator = document.getElementById('syncIndicator') as HTMLDivElement;
  if (!syncIndicator) return;
  syncIndicator.className = 'sync-indicator syncing';
  const statusText = syncIndicator.querySelector('.sync-status-text') as HTMLSpanElement | null;
  if (statusText) statusText.textContent = isUploading ? '上传中...' : '同步中...';
}
