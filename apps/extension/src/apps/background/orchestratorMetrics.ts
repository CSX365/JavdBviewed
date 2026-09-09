/**
 * @file orchestratorMetrics.ts
 * @description orchestratorMetrics
 * @module apps/background
 *
 * 写路径治理（performance-cycle-4 S1-1）：
 * - orchestratorTaskDetails 拆分为 hot（最新 ≤300 条，沿用旧键名，遗留数据天然在 hot）
 *   与 orchestratorTaskDetailsArchive（更旧数据，hot+archive 全局 cap 2000）
 * - saveTaskDetail 只入内存 buffer，resolve 于「已缓冲」而非「已落盘」
 *   （content 侧 fire-and-forget，语义变化：save 不再阻塞等待 storage 写）
 * - 1.5s 防抖合并写：burst 只落盘 1 次 hot（≤300 条 ≈146KB），替代旧的每次全量写
 * - archive 累积满 100 条（或全局 cap 触发裁剪）才持久化，archive 前缀不可变
 * - 读方合并 [...archive, ...hot]，读语义与旧的单数组一致
 * - SW onSuspend 急停落盘（telemetry 数据，丢失窗口 < 防抖周期，可接受）
 */
import { globalTaskCenter } from '../../platform/tasks/globalTaskCenter';
import { getValue, setValue } from '../../utils/storage';

const TASK_DETAILS_HOT_KEY = 'orchestratorTaskDetails';
const TASK_DETAILS_ARCHIVE_KEY = 'orchestratorTaskDetailsArchive';
/** hot 层容量：最新 300 条常驻主键（≈146KB，远低于 5MB 单条限制） */
const TASK_DETAILS_HOT_CAP = 300;
/** hot+archive 全局容量：与旧的单数组 cap 保持一致 */
const TASK_DETAILS_GLOBAL_CAP = 2000;
/** archive 落盘批量阈值：溢出不足该值时暂存内存，减少写次数 */
const TASK_DETAILS_ARCHIVE_CHUNK = 100;
/** 防抖合并写周期（ms） */
const TASK_DETAILS_FLUSH_DEBOUNCE_MS = 1500;

let taskDetailSaveQueue: Promise<void> = Promise.resolve();
/** 已归一化、待落盘的新条目（时间升序，最旧在前） */
let pendingTaskDetails: any[] = [];
/** 已从 hot 溢出、待持久化到 archive 的尾部（时间升序） */
let archivePendingTaskDetails: any[] = [];
let taskDetailsFlushTimer: ReturnType<typeof setTimeout> | null = null;
let taskDetailsFlushInflight: Promise<void> | null = null;

export async function handleSaveOrchestratorMetrics(metrics: any): Promise<void> {
  console.log('[Background] Saving orchestrator metrics:', metrics);
  try {
    if (!metrics) {
      console.warn('[Background] No metrics provided, skipping save');
      return;
    }

    const existingData = await getValue<any[]>('orchestratorMetrics', []);
    console.log('[Background] Existing metrics count:', existingData.length);

    existingData.push({
      ...metrics,
      savedAt: Date.now(),
    });

    const trimmedData = existingData.slice(-100);
    await setValue('orchestratorMetrics', trimmedData);

    console.log('[Background] Orchestrator metrics saved successfully, total records:', trimmedData.length);
  } catch (error) {
    console.error('[Background] Failed to save orchestrator metrics:', error);
    throw error;
  }
}

/** 合并读取 hot + archive（archive 恒旧于 hot，读语义与旧单数组一致） */
async function readTaskDetailsMerged(): Promise<any[]> {
  const [hotRaw, archiveRaw] = await Promise.all([
    getValue<any[]>(TASK_DETAILS_HOT_KEY, []),
    getValue<any[]>(TASK_DETAILS_ARCHIVE_KEY, []),
  ]);
  const hot = Array.isArray(hotRaw) ? hotRaw : [];
  const archive = Array.isArray(archiveRaw) ? archiveRaw : [];
  return [...archive, ...hot];
}

export async function handleGetAggregatedMetrics(): Promise<any> {
  console.log('[Background] Getting aggregated metrics...');
  try {
    const taskDetails = await readTaskDetailsMerged();
    const taskGroups = new Map<string, { root: any; items: any[] }>();
    for (const item of taskDetails) {
      const rootKey = String(item?.rootTaskId || item?.parentTaskId || item?.taskId || item?.label || 'unknown');
      const group = taskGroups.get(rootKey) || { root: item, items: [] };
      if (!group.root || !group.root.taskId) group.root = item;
      group.items.push(item);
      taskGroups.set(rootKey, group);
    }

    const deriveFromDetails = () => {
      const result = {
        batchTotal: taskGroups.size,
        batchCompleted: 0,
        batchFailed: 0,
        batchTimeout: 0,
        batchTotalDuration: 0,
        batchMaxDuration: 0,
        batchMinDuration: Infinity,
        batchMaxDurationTask: '',
        subtaskTotal: taskDetails.length,
        subtaskDone: 0,
        subtaskError: 0,
        subtaskTimeout: 0,
        subtaskTotalDuration: 0,
        subtaskMaxDuration: 0,
        subtaskMinDuration: Infinity,
        subtaskMaxDurationTask: '',
      };

      for (const [rootKey, group] of taskGroups.entries()) {
        const root = group.root || {};
        const rootStatus = String(root?.status || '').toLowerCase();
        const rootDuration = Number(root?.durationMs || 0);
        if (rootStatus === 'done') result.batchCompleted++;
        if (rootStatus === 'error' || rootStatus === 'canceled') result.batchFailed++;
        if (rootStatus === 'timeout') result.batchTimeout++;
        if (rootDuration > 0) {
          result.batchTotalDuration += rootDuration;
          if (rootDuration > result.batchMaxDuration) {
            result.batchMaxDuration = rootDuration;
            result.batchMaxDurationTask = String(root?.label || rootKey);
          }
          result.batchMinDuration = Math.min(result.batchMinDuration, rootDuration);
        }

        for (const item of group.items) {
          const status = String(item?.status || '').toLowerCase();
          const duration = Number(item?.durationMs || 0);
          if (status === 'done') result.subtaskDone++;
          if (status === 'error' || status === 'canceled') result.subtaskError++;
          if (status === 'timeout') result.subtaskTimeout++;
          if (duration > 0) {
            result.subtaskTotalDuration += duration;
            if (duration > result.subtaskMaxDuration) {
              result.subtaskMaxDuration = duration;
              result.subtaskMaxDurationTask = String(item?.label || rootKey);
            }
            result.subtaskMinDuration = Math.min(result.subtaskMinDuration, duration);
          }
        }
      }

      return result;
    };

    const treeMetrics = deriveFromDetails();
    const metricsData = await getValue<any[]>('orchestratorMetrics', []);
    console.log('[Background] Retrieved metrics records:', metricsData.length);

    if (metricsData.length === 0) {
      console.log('[Background] No metrics data found, returning zeros');
      return {
        totalTasks: 0,
        completedTasks: 0,
        failedTasks: 0,
        timeoutTasks: 0,
        avgDuration: 0,
        maxDuration: 0,
        minDuration: Infinity,
        totalDuration: 0,
        recordCount: 0,
        avgTasksPerPage: 0,
        successRate: 0,
        maxDurationTask: '',
        lastSavedAt: 0,
      };
    }

    const aggregated = {
      totalTasks: 0,
      completedTasks: 0,
      failedTasks: 0,
      timeoutTasks: 0,
      totalDuration: 0,
      maxDuration: 0,
      minDuration: Infinity,
      recordCount: metricsData.length,
      maxDurationTask: '',
      lastSavedAt: 0,
    };

    metricsData.forEach((record) => {
      aggregated.totalTasks += record.totalTasks || 0;
      aggregated.completedTasks += record.completedTasks || 0;
      aggregated.failedTasks += record.failedTasks || 0;
      aggregated.timeoutTasks += record.timeoutTasks || 0;
      aggregated.totalDuration += record.totalDuration || 0;

      if ((record.maxDuration || 0) > aggregated.maxDuration) {
        aggregated.maxDuration = record.maxDuration || 0;
        aggregated.maxDurationTask = record.maxDurationTask || '';
      }

      if (record.minDuration !== undefined && record.minDuration !== Infinity) {
        aggregated.minDuration = Math.min(aggregated.minDuration, record.minDuration);
      }

      if ((record.savedAt || 0) > aggregated.lastSavedAt) {
        aggregated.lastSavedAt = record.savedAt || 0;
      }
    });

    const avgDuration = aggregated.completedTasks > 0
      ? aggregated.totalDuration / aggregated.completedTasks
      : 0;
    const avgTasksPerPage = aggregated.recordCount > 0
      ? aggregated.totalTasks / aggregated.recordCount
      : 0;
    const successRate = aggregated.totalTasks > 0
      ? (aggregated.completedTasks / aggregated.totalTasks) * 100
      : 0;

    const result = {
      ...aggregated,
      ...treeMetrics,
      avgDuration,
      avgTasksPerPage,
      successRate,
      batchAvgDuration: treeMetrics.batchCompleted > 0 ? treeMetrics.batchTotalDuration / treeMetrics.batchCompleted : 0,
      subtaskAvgDuration: treeMetrics.subtaskDone > 0 ? treeMetrics.subtaskTotalDuration / treeMetrics.subtaskDone : 0,
    };

    console.log('[Background] Aggregated metrics:', result);
    return result;
  } catch (error) {
    console.error('[Background] Failed to get aggregated metrics:', error);
    throw error;
  }
}

function scheduleTaskDetailsFlush(): void {
  if (taskDetailsFlushTimer) clearTimeout(taskDetailsFlushTimer);
  taskDetailsFlushTimer = setTimeout(() => {
    taskDetailsFlushTimer = null;
    void flushTaskDetails('debounce').catch(() => {});
  }, TASK_DETAILS_FLUSH_DEBOUNCE_MS);
}

/**
 * 落盘缓冲数据（防抖 / 急停 / 手动）。
 * - 原子换出 pending buffer，新数据到来时由 scheduleTaskDetailsFlush 再触发
 * - hot 溢出头部移入 archive；全局 cap 溢出只裁 archive 头（hot 永不被裁）
 * - archive 前缀不可变：未持久化时只缓存尾部，持久化时整段写入
 */
export function flushTaskDetails(reason: string = 'manual'): Promise<void> {
  if (taskDetailsFlushInflight) return taskDetailsFlushInflight;
  const run = (async () => {
    if (taskDetailsFlushTimer) {
      clearTimeout(taskDetailsFlushTimer);
      taskDetailsFlushTimer = null;
    }
    const batch = pendingTaskDetails;
    pendingTaskDetails = [];
    if (batch.length === 0 && archivePendingTaskDetails.length === 0) return;

    try {
      const [hotStoredRaw, archiveStoredRaw] = await Promise.all([
        getValue<any[]>(TASK_DETAILS_HOT_KEY, []),
        getValue<any[]>(TASK_DETAILS_ARCHIVE_KEY, []),
      ]);
      const hotStored = Array.isArray(hotStoredRaw) ? hotStoredRaw : [];
      const archiveStored = Array.isArray(archiveStoredRaw) ? archiveStoredRaw : [];

      // 遗留单数组升级兼容：hot 键中 ≤2000 条旧数据在此自然拆分为 hot/archive
      const hotMerged = [...hotStored, ...batch];
      let moved: any[] = [];
      let hotFinal = hotMerged;
      if (hotMerged.length > TASK_DETAILS_HOT_CAP) {
        moved = hotMerged.slice(0, hotMerged.length - TASK_DETAILS_HOT_CAP);
        hotFinal = hotMerged.slice(hotMerged.length - TASK_DETAILS_HOT_CAP);
      }

      const archiveCandidate = [...archiveStored, ...archivePendingTaskDetails, ...moved];
      const unpersistedCount = archiveCandidate.length - archiveStored.length;
      archivePendingTaskDetails = [];

      let trimmed = false;
      const totalAfterMerge = hotFinal.length + archiveCandidate.length;
      if (totalAfterMerge > TASK_DETAILS_GLOBAL_CAP) {
        const overflow = totalAfterMerge - TASK_DETAILS_GLOBAL_CAP;
        archiveCandidate.splice(0, Math.min(overflow, archiveCandidate.length));
        trimmed = true;
      }

      const persistArchive = trimmed || unpersistedCount >= TASK_DETAILS_ARCHIVE_CHUNK;
      const persistHot = batch.length > 0 || moved.length > 0;

      if (persistHot) await setValue(TASK_DETAILS_HOT_KEY, hotFinal);
      if (persistArchive) {
        await setValue(TASK_DETAILS_ARCHIVE_KEY, archiveCandidate);
      } else {
        // 只保留未持久化尾部（archiveStored 是 archiveCandidate 的前缀）
        archivePendingTaskDetails = archiveCandidate.slice(archiveStored.length);
      }

      console.log('[Background] flushTaskDetails:done', {
        reason,
        buffered: batch.length,
        moved: moved.length,
        hotSize: hotFinal.length,
        archiveSize: archiveCandidate.length,
        persistHot,
        persistArchive,
      });
    } catch (error) {
      console.error('[Background] Failed to flush task details:', error, { reason });
      // 回滚未落盘 batch 并重排 flush，避免 telemetry 静默丢失
      if (batch.length > 0) pendingTaskDetails = [...batch, ...pendingTaskDetails];
      scheduleTaskDetailsFlush();
      throw error;
    }
  })();
  taskDetailsFlushInflight = run;
  // 派生链吞掉 rejection（错误已在内部记录），仅用于复位 inflight 标记
  run.catch(() => {}).finally(() => {
    if (taskDetailsFlushInflight === run) taskDetailsFlushInflight = null;
  });
  return run;
}

export function handleSaveTaskDetail(taskDetail: any, sender?: chrome.runtime.MessageSender): Promise<void> {
  // 队列串联保证归一化 FIFO；单个失败不阻断后续（双 then 接住 rejection）
  const step = async (): Promise<void> => {
    try {
      if (!taskDetail) {
        console.log('[Background] saveTaskDetail skipped: empty payload');
        return;
      }

      const normalizedDetail = {
        ...taskDetail,
        tabId: typeof taskDetail?.tabId === 'number' ? taskDetail.tabId : (typeof sender?.tab?.id === 'number' ? sender.tab.id : -1),
        savedAt: Date.now(),
      };

      // 可观测性：补齐 bucket / queueAgeMs（旧记录或 content 未写时）
      try {
        const { resolveTaskBucket } = await import('../../platform/tasks/taskPolicy');
        if (!normalizedDetail.bucket && normalizedDetail.label) {
          normalizedDetail.bucket = resolveTaskBucket(String(normalizedDetail.label));
        }
        if (
          typeof normalizedDetail.queueAgeMs !== 'number'
          && typeof normalizedDetail.registeredAt === 'number'
          && typeof normalizedDetail.startedAt === 'number'
          && normalizedDetail.registeredAt > 0
          && normalizedDetail.startedAt > 0
        ) {
          normalizedDetail.queueAgeMs = Math.max(0, normalizedDetail.startedAt - normalizedDetail.registeredAt);
        }
      } catch {}

      console.log('[Background] saveTaskDetail:buffered', {
        label: normalizedDetail.label,
        parentLabel: normalizedDetail.parentLabel,
        pageInstanceId: normalizedDetail.pageInstanceId,
        mainId: normalizedDetail.mainId,
        tabId: normalizedDetail.tabId,
        bucket: normalizedDetail.bucket,
        pending: pendingTaskDetails.length + 1,
      });

      pendingTaskDetails.push(normalizedDetail);
      scheduleTaskDetailsFlush();
    } catch (error) {
      console.error('[Background] Failed to buffer task detail:', error, {
        label: taskDetail?.label,
        parentLabel: taskDetail?.parentLabel,
        pageInstanceId: taskDetail?.pageInstanceId,
        mainId: taskDetail?.mainId,
      });
      throw error;
    }
  };

  taskDetailSaveQueue = taskDetailSaveQueue.then(step, step);
  return taskDetailSaveQueue;
}

export async function handleGetTaskDetails(options: any = {}): Promise<any> {
  try {
    const taskDetails = await readTaskDetailsMerged();
    let filtered = [...taskDetails];
    filtered.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const maxRecords = 5000;
    if (filtered.length > maxRecords) {
      filtered = filtered.slice(0, maxRecords);
    }

    const page = options.page || 1;
    const pageSize = options.pageSize || 20;
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedDetails = filtered.slice(startIndex, endIndex);

    return {
      details: paginatedDetails,
      total: filtered.length,
      page,
      pageSize,
      totalPages: Math.ceil(filtered.length / pageSize),
    };
  } catch (error) {
    console.error('[Background] Failed to get task details:', error);
    throw error;
  }
}

export async function handleClearTaskDetails(): Promise<any> {
  try {
    console.log('[Background] Clearing orchestrator task details and metrics...');
    // 先清内存状态再落盘空数组，防止在途 flush 把已清除数据复活
    if (taskDetailsFlushTimer) {
      clearTimeout(taskDetailsFlushTimer);
      taskDetailsFlushTimer = null;
    }
    pendingTaskDetails = [];
    archivePendingTaskDetails = [];
    if (taskDetailsFlushInflight) {
      await taskDetailsFlushInflight.catch(() => {});
    }
    await setValue(TASK_DETAILS_HOT_KEY, []);
    await setValue(TASK_DETAILS_ARCHIVE_KEY, []);
    await setValue('orchestratorMetrics', []);
    const clearedGlobalState = globalTaskCenter.clearAll();
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (typeof tab.id === 'number' && tab.id >= 0) {
          chrome.tabs.sendMessage(tab.id, { type: 'orchestrator:resetMetrics' }, () => {
            void chrome.runtime.lastError;
          });
        }
      }
    } catch (broadcastErr) {
      console.warn('[Background] Failed to broadcast resetMetrics:', broadcastErr);
    }
    console.log('[Background] Cleared orchestrator task details and metrics');
    return { success: true, clearedGlobalState };
  } catch (error) {
    console.error('[Background] Failed to clear task details:', error);
    return { success: false, error: String(error) };
  }
}

export async function handleStopAllTasks(): Promise<any> {
  try {
    const result = globalTaskCenter.stopAllActiveTasks('manual-stop-all');
    const cleared = globalTaskCenter.clearTerminalTasks();
    return { success: true, canceled: result.canceled || 0, cleared: cleared.cleared || 0 };
  } catch (error) {
    console.error('[Background] Failed to stop all tasks:', error);
    return { success: false, error: String(error) };
  }
}

// SW 急停前落盘未持久化的 task details（MV3 onSuspend）
try {
  if (typeof chrome !== 'undefined' && chrome.runtime?.onSuspend) {
    chrome.runtime.onSuspend.addListener(() => {
      void flushTaskDetails('suspend').catch(() => {});
    });
  }
} catch {}
