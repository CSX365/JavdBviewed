// @ts-nocheck
import { logAsync } from '../logger';
import { showMessage } from '../ui/toast';
import { showImportModal } from '../import';
import { sendRuntimeMessage } from '../../platform/browser/runtimeMessages';
import { showConfirm } from '../components/confirmModal';
import { dbViewedCleanInjectedSourceTags } from '../dbClient';
import { createBackupArchive, readBackupFileContent } from '../../features/webdavSync/application/backupArchive';
import { updateSyncStatus, setSyncingStatus } from './syncStatus';

type BackupActionResponse = {
  success?: boolean;
  data?: unknown;
  error?: string;
};


function queryBackupElement<T extends HTMLElement>(root: ParentNode, selector: string): T | null {
  return root.querySelector(selector) as T | null;
}

function markBackupActionBound(element: HTMLElement, action: string): boolean {
  const key = `backup${action}Bound`;
  if (element.dataset[key] === 'true') {
    return false;
  }

  element.dataset[key] = 'true';
  return true;
}

function getBackupActionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return fallback;
}

export function initBackupActions(root: ParentNode = document): void {
  const exportBtn = queryBackupElement<HTMLButtonElement>(root, '#exportBtn');
  const syncNowBtn = queryBackupElement<HTMLButtonElement>(root, '#syncNow');
  const syncDownBtn = queryBackupElement<HTMLButtonElement>(root, '#syncDown');
  const cleanupInjectedSourceTagsBtn = queryBackupElement<HTMLButtonElement>(root, '#cleanupInjectedSourceTags');
  const importFileInput = queryBackupElement<HTMLInputElement>(root, '#importFile');

  if (exportBtn && markBackupActionBound(exportBtn, 'Export')) {
    exportBtn.addEventListener('click', async () => {
      logAsync('INFO', '用户点击了"导出到本地"按钮');
      exportBtn.disabled = true;
      const originalHtml = exportBtn.innerHTML;
      exportBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>正在导出...</span>';
      try {
        const response = await sendRuntimeMessage<BackupActionResponse>({ type: 'collect-backup-data' });
        if (!response?.success) throw new Error(response?.error || '获取备份数据失败');
        const backupBlob = await createBackupArchive(response.data);
        const url = URL.createObjectURL(backupBlob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `javdb-extension-backup-${new Date().toISOString().replace(/[:.]/g, '-').split('Z')[0]}.zip`;
        anchor.click();
        URL.revokeObjectURL(url);
        showMessage('数据导出成功', 'success');
        logAsync('INFO', '本地数据导出成功');
      } catch (err: unknown) {
        const message = getBackupActionErrorMessage(err, '导出失败');
        showMessage(`导出失败: ${message}`, 'error');
        logAsync('ERROR', '本地数据导出失败', { error: message });
      } finally {
        exportBtn.disabled = false;
        exportBtn.innerHTML = originalHtml;
      }
    });
  }

  if (importFileInput && markBackupActionBound(importFileInput, 'Import')) {
    importFileInput.addEventListener('change', (event) => {
      logAsync('INFO', '用户选择了本地文件进行导入');
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) { logAsync('WARN', '用户取消了文件选择'); return; }
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const input = e.target?.result;
          if (!(input instanceof ArrayBuffer)) throw new Error('无法读取备份文件内容');
          const jsonData = await readBackupFileContent(file.name, input);
          showImportModal(jsonData);
        } catch (error: unknown) {
          const message = getBackupActionErrorMessage(error, '备份文件读取失败');
          showMessage(`读取备份失败：${message}`, 'error');
          logAsync('ERROR', '本地备份文件读取失败', { error: message, fileName: file.name });
        }
      };
      reader.onerror = () => { showMessage(`读取备份失败：${reader.error || '未知错误'}`, 'error'); logAsync('ERROR', '读取导入文件时发生错误', { error: reader.error as any }); };
      reader.readAsArrayBuffer(file);
      importFileInput.value = '';
    });
  }

  if (syncNowBtn && markBackupActionBound(syncNowBtn, 'Upload')) {
    syncNowBtn.addEventListener('click', async () => {
      const originalHtml = syncNowBtn.innerHTML;
      syncNowBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>正在上传...</span>';
      syncNowBtn.disabled = true;
      setSyncingStatus(true);
      logAsync('INFO', '用户点击“立即上传至云端”，开始上传数据');
      try {
        const response = await sendRuntimeMessage<BackupActionResponse>({ type: 'webdav-upload' });
        if (!response?.success) {
          throw new Error(response?.error || '上传失败');
        }

        showMessage('数据已成功上传至云端', 'success');
        logAsync('INFO', '数据成功上传至云端');
      } catch (error: unknown) {
        const message = getBackupActionErrorMessage(error, '上传失败');
        showMessage(`上传失败: ${message}`, 'error');
        logAsync('ERROR', '数据上传至云端失败', { error: message });
      } finally {
        syncNowBtn.innerHTML = originalHtml;
        syncNowBtn.disabled = false;
        setTimeout(() => updateSyncStatus(), 500);
      }
    });
  }

  if (syncDownBtn && markBackupActionBound(syncDownBtn, 'Restore')) {
    syncDownBtn.addEventListener('click', async () => {
      logAsync('INFO', '用户点击“从云端恢复”，打开恢复弹窗');
      // 动态加载恢复向导：webdavRestore 及其依赖（隐私模块树/webdavSync 应用层）不进 dashboard 入口闭包
      const { showWebDAVRestoreModal } = await import('../webdavRestore');
      showWebDAVRestoreModal();
    });
  }

  if (cleanupInjectedSourceTagsBtn && markBackupActionBound(cleanupInjectedSourceTagsBtn, 'CleanupInjectedSourceTags')) {
    cleanupInjectedSourceTagsBtn.addEventListener('click', async () => {
      const originalHtml = cleanupInjectedSourceTagsBtn.innerHTML;
      cleanupInjectedSourceTagsBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>正在扫描...</span>';
      cleanupInjectedSourceTagsBtn.disabled = true;
      logAsync('INFO', '用户点击“清理错误来源标签”，开始扫描历史记录');
      try {
        const preview = await dbViewedCleanInjectedSourceTags({ dryRun: true });
        if (!preview || preview.affectedCount <= 0) {
          showMessage('没有发现需要清理的错误来源标签', 'success');
          logAsync('INFO', '错误来源标签扫描完成，无需清理', { scannedCount: preview?.scannedCount || 0 });
          return;
        }

        const removedNames = Array.isArray(preview.removedTagNames) && preview.removedTagNames.length > 0
          ? preview.removedTagNames.join('、')
          : '已知错误来源标签';
        const totalRemoved = (preview.tagsRemoved || 0) + (preview.categoriesRemoved || 0);
        const confirmed = await showConfirm({
          title: '清理错误来源标签',
          message: `扫描到 ${preview.affectedCount} 条记录包含错误来源标签（${removedNames}），预计移除 ${totalRemoved} 个标签。此操作不会删除番号记录，是否继续？`,
          confirmText: '确认清理',
          cancelText: '取消',
          type: 'warning',
        });
        if (!confirmed) {
          logAsync('INFO', '用户取消清理错误来源标签', { affectedCount: preview.affectedCount });
          return;
        }

        cleanupInjectedSourceTagsBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>正在清理...</span>';
        const result = await dbViewedCleanInjectedSourceTags({ dryRun: false });
        const removed = (result.tagsRemoved || 0) + (result.categoriesRemoved || 0);
        showMessage(`已清理 ${result.affectedCount || 0} 条记录，移除 ${removed} 个错误标签`, 'success');
        logAsync('INFO', '错误来源标签清理完成', result);
      } catch (error: unknown) {
        const message = getBackupActionErrorMessage(error, '清理失败');
        showMessage(`清理失败: ${message}`, 'error');
        logAsync('ERROR', '错误来源标签清理失败', { error: message });
      } finally {
        cleanupInjectedSourceTagsBtn.innerHTML = originalHtml;
        cleanupInjectedSourceTagsBtn.disabled = false;
      }
    });
  }

  updateSyncStatus();
}
