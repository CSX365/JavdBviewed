/**
 * @file globalTaskCenter.ts
 * @description 全局任务中心 —— 管理所有异步任务的生命周期、排队、租约、超时和去重
 * @module platform/tasks
 *
 * 任务生命周期：registered → queued → leased → running → done/error/canceled
 * 核心机制：
 * - 优先级队列：priority 越大越优先
 * - 租约（lease）：前台页面先获得执行权，后台排队等待
 * - 去重：通过 dedupeKey 防止重复创建同类任务
 * - 超时守卫：running 超过 timeoutMs 自动标记 error
 */
import {
  TASK_BUCKET_LIMITS,
  TASK_GLOBAL_LEASE_LIMITS,
  TASK_LEASE_GROUP_LIMITS,
  TASK_PAGE_LEASE_LIMITS,
  TASK_SMART_BACKGROUND_PREWARM_LIMITS,
  isSourcePageSyncLabel,
  resolveTaskBucket,
  resolveTaskLeaseGroup,
} from './taskPolicy';
import { TaskStateStore } from './taskStateStore';
import { TASK_CENTER_MESSAGE } from '../../shared/taskCenterProtocol';
import type { GlobalTaskDescriptor, GlobalTaskRecord, GlobalTaskRuntimeState } from '../../shared/taskCenterTypes';
import { computeTaskDisposition, getEffectiveBucketLimit } from './taskCenterPolicyRuntime';

/** 租约响应：是否授予执行权，未授予时附带等待原因 */
type LeaseResponse = { granted: boolean; waitReason?: string };

type TaskRegistrationResult = {
  ok: true;
  taskId: string;
  tabId: number;
  reused?: boolean;
  status?: string;
};

/** 排队候选任务（附带优先级评分） */
type QueueCandidate = {
  record: ReturnType<TaskStateStore['listTasks']>[number];
  score: number;
};

export class GlobalTaskCenter {
  private store = new TaskStateStore();
  private dedupeIndex = new Map<string, string>();
  // S1-B: 1h → 5min —— 终态记录仅作历史展示，缩短保留期防止快照无界增长（S0-2/S0-3：每轮净增 +39,620B）
  private readonly taskRetentionMs = 5 * 60 * 1000;
  // S1-B: 终态记录条数硬上限（LRU），与保留期共同保证快照体积有界
  private readonly terminalTaskMax = 50;
  private readonly pendingTaskMaxAgeMs = 60 * 1000;
  private readonly pausedTaskMaxAgeMs = 3 * 60 * 1000;
  private readonly hiddenRunningTaskMaxAgeMs = 45 * 1000;
  private readonly starvationThresholdMs = 15 * 1000;
  private readonly idleStarvationScore = 2500;
  private readonly deferredStarvationScore = 2500;
  // P1 FIX: 跨页面依赖同步 - 在 background 维护全局已完成任务集合
  private completedTaskLabels = new Set<string>();
  private readonly storageKey = 'taskCenter:snapshot';
  private readonly dedupeStorageKey = 'taskCenter:dedupeIndex'; // P2 FIX: dedupe 持久化
  private isRestored = false;
  private persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly persistDebounceMs = 500;
  // S1-B (I-4a): 冷启动写合并窗口 —— 首次写后 3s 内的突发写合并为窗口结束时一次写（S0 实测 0~3s 写风暴 7~8 次 → ≤2 次）
  private readonly persistBurstWindowMs = 3000;
  private persistBurstAnchorMs: number | null = null;
  private persistBurstTimer: ReturnType<typeof setTimeout> | null = null;
  private persistBurstPendingJson: string | null = null;
  private persistBurstPendingPayload: Record<string, unknown> | null = null;
  private persistBurstPendingDedupeJson: string | null = null;
  private persistBurstPendingMode: 'hot' | 'full' = 'hot';
  private persistBurstWaiters: Array<() => void> = [];
  // S1-C: 热/冷分层基线 —— hot（非终态任务）与 full（全量快照）各自维护内容指纹，互不干扰
  private lastHotContentJson: string | null = null;
  private lastFullContentJson: string | null = null;
  // S1-C: dedupe 独立基线 —— 仅当 dedupe 内容变化时随快照合写（原每次快照写都全量重写 dedupe）
  private lastPersistedDedupeJson: string | null = null;
  private lastGrantedLeasePersistence: Promise<void> = Promise.resolve();
  // S1-A (cycle-6): 租约授予合并窗口 —— N 次并发授予的 N 次全量快照写合并为一次写，
  // flush 完成后再 sendResponse（见 handleMessage REQUEST_LEASE）；SW 重启暴露窗口封顶于此值（原立即写为 0）
  private readonly leaseGrantCoalesceMs = 150;
  private leaseGrantFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private leaseGrantWaiters: Array<() => void> = [];
  // S2-2 (cycle-7): 事件驱动的租约唤醒 —— 替代前台页 500ms 定频 request-lease 轮询（S2-1 归因：占 SW 消息 55~62%）
  private leasePromptLastSentAt = new Map<number, number>();
  private readonly leasePromptCoalesceMs = 500;
  // S2-2 (cycle-7 r3 定案): 500ms 每 tab 合并窗吞掉同步链主任务(fullRefresh)完成时的槽位释放 prompt
  // (r3 取证: 槽位空转 2.6s, 尾部交接延迟 1.8~2.6s), 同步链释放路径改走 100ms 微窗豁免;
  // 一次 run 全程同步链释放仅 ~15 次量级, 100ms 限流足以防突发刷屏
  private readonly leasePromptBypassCoalesceMs = 100;
  private static readonly leasePromptStaleMs = 5 * 60 * 1000;
  /** S2-2: 唤醒发送函数（测试可注入；默认 chrome.tabs.sendMessage，已关闭的 tab 吞错，页面侧轮询兜底） */
  sendTabPrompt?: (tabId: number, message: { type: string; payload: Record<string, unknown> }) => void;
  // S1-A: 提交序号 —— 用于识别 burst 窗口内的过期 pending（存在更新的提交时丢弃旧 pending，防快照回滚）
  private persistCommitSeq = 0;
  private persistBurstPendingSeq = 0;

  private getPhaseWeight(phase: string): number {
    if (phase === 'critical') return 4000;
    if (phase === 'high') return 3000;
    if (phase === 'deferred') return 2000;
    if (phase === 'idle') return 1000;
    return 0;
  }

  private getStarvationScore(record: QueueCandidate['record'], now: number): number {
    const maxScore = record.descriptor.phase === 'idle'
      ? this.idleStarvationScore
      : record.descriptor.phase === 'deferred'
        ? this.deferredStarvationScore
        : 0;
    if (maxScore === 0) return 0;
    const waitedMs = Math.max(0, now - record.descriptor.createdAt);
    return waitedMs >= this.starvationThresholdMs ? maxScore : 0;
  }

  // P1 FIX: Service Worker 重启后，从 chrome.storage 恢复任务状态
  async restoreFromStorage(): Promise<void> {
    if (this.isRestored) return;
    try {
      // P2 FIX: 一次性读取两个 key，避免多次 chrome.storage 调用
      const item = await new Promise<any>((resolve, reject) => {
        chrome.storage.local.get([this.storageKey, this.dedupeStorageKey], (result) => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          resolve(result);
        });
      });
      const data = item[this.storageKey];
      if (data && typeof data === 'object') {
        if (data.tasks && Array.isArray(data.tasks)) {
          for (const record of data.tasks) {
            if (record?.descriptor?.taskId && record?.runtime?.status) {
              this.store.setTask(record.descriptor.taskId, record);
              if (record.descriptor.dedupeKey) {
                this.dedupeIndex.set(record.descriptor.dedupeKey, record.descriptor.taskId);
              }
            }
          }
        }
        if (data.completedLabels && Array.isArray(data.completedLabels)) {
          this.completedTaskLabels = new Set(data.completedLabels);
        }
        console.log('[TaskCenter] Restored', this.store.listTasks().length, 'tasks and', this.completedTaskLabels.size, 'completed labels from storage');
      }
      // P2 FIX: 同时恢复 dedupe index
      const dedupeData = item[this.dedupeStorageKey];
      if (dedupeData && typeof dedupeData === 'object') {
        this.dedupeIndex = new Map(Object.entries(dedupeData));
        // S1-C: 用恢复出的 dedupe 初始化基线，避免恢复后立即触发一次冗余 dedupe 重写
        this.lastPersistedDedupeJson = this.dedupeIndex.size > 0
          ? JSON.stringify(Object.fromEntries(this.dedupeIndex.entries()))
          : null;
        console.log('[TaskCenter] Restored dedupe index:', this.dedupeIndex.size, 'entries');
      }
      await this.cancelRestoredTasksForClosedTabs();
      this.isRestored = true;
      // P1 FIX: 恢复后启动定期快照
      this.startPeriodicSnapshot();
    } catch (err) {
      console.warn('[TaskCenter] Failed to restore from storage:', err);
      this.isRestored = true;
    }
  }

  /**
   * Visibility is intentionally in-memory, so a service-worker restart cannot
   * prove that a restored task still owns a live tab. Reconcile persisted work
   * with Chrome before it is allowed to affect a new scheduling cycle.
   */
  private async cancelRestoredTasksForClosedTabs(): Promise<void> {
    if (!chrome.tabs?.query) return;
    try {
      const tabs = await chrome.tabs.query({});
      const openTabIds = new Set(tabs
        .map((tab) => tab.id)
        .filter((tabId): tabId is number => typeof tabId === 'number'));
      let canceled = 0;
      for (const record of this.store.listTasks()) {
        if (['done', 'error', 'canceled'].includes(record.runtime.status)) continue;
        if (openTabIds.has(record.descriptor.tabId)) continue;
        record.runtime.status = 'canceled';
        record.runtime.waitReason = 'page-closed-by-user';
        record.runtime.endedAt = Date.now();
        this.store.setTask(record.descriptor.taskId, record);
        canceled += 1;
      }
      if (canceled > 0) {
        console.log('[TaskCenter] Canceled restored tasks for closed tabs', { canceled });
        this.persistToStorage({ mode: 'full' });
      }
    } catch (error) {
      console.warn('[TaskCenter] Failed to reconcile restored tasks with tabs:', error);
    }
  }

  // P1 FIX: 定期快照到 chrome.storage，防止 Service Worker 重启丢失状态
  // B5 (2026-09-07): snapshot 与 dedupeIndex 合并为单次 storage.set（原两次独立 set → 写次数减半）
  // S1-B (I-4a): 写合并 —— (1) 快照内容与 dedupe 均未变化时跳过写（覆盖 30s 周期兜底与防抖写）；
  // (2) 冷启动首次写后 3s 内的突发写合并为窗口结束时一次写
  // S1-C: mode='hot' 只持久化非终态任务（重启安全面）；'full' 为全量快照（周期兜底/人工操作，保留终态历史）
  private persistToStorage(options: { immediate?: boolean; mode?: 'hot' | 'full' } = {}): Promise<void> {
    const storage = typeof chrome !== 'undefined' ? chrome.storage?.local : undefined;
    if (!storage) return Promise.resolve();
    const mode = options.mode ?? 'hot';
    const { contentJson, payload, dedupeJson } = this.buildPersistContent(mode);
    const baseline = mode === 'hot' ? this.lastHotContentJson : this.lastFullContentJson;
    // I-4a/S1-C: 快照内容与 dedupe 均未变 → 跳过重写
    if (contentJson === baseline && dedupeJson === this.lastPersistedDedupeJson) return Promise.resolve();
    const now = Date.now();
    // 首次写立即落盘并锚定合并窗口；窗口结束后保持立即写；immediate（租约授予等并发边界写）豁免合并
    if (
      this.persistBurstAnchorMs === null
      || now >= this.persistBurstAnchorMs + this.persistBurstWindowMs
      || options.immediate
    ) {
      if (this.persistBurstAnchorMs === null) this.persistBurstAnchorMs = now;
      return this.commitPersistToStorage(storage, mode, contentJson, dedupeJson, payload);
    }
    // I-4a: 冷启动合并窗口内 → 合并为窗口结束时一次写（mode 取最新一次请求）
    this.persistBurstPendingJson = contentJson;
    this.persistBurstPendingPayload = payload;
    this.persistBurstPendingDedupeJson = dedupeJson;
    this.persistBurstPendingMode = mode;
    this.persistBurstPendingSeq = this.persistCommitSeq;
    if (this.persistBurstTimer === null) {
      const delay = Math.max(0, this.persistBurstAnchorMs + this.persistBurstWindowMs - Date.now());
      this.persistBurstTimer = setTimeout(() => this.flushPersistBurst(storage), delay);
    }
    return new Promise<void>((resolve) => {
      this.persistBurstWaiters.push(resolve);
    });
  }

  /** S1-C: hot 快照保留非终态任务 + dedupe-by-action 终态结果（多页去重复用真实执行结果，跨重启必须可见） */
  private isHotRetained(record: GlobalTaskRecord): boolean {
    const { descriptor, runtime } = record;
    if (runtime.status !== 'done' && runtime.status !== 'error' && runtime.status !== 'canceled') return true;
    return descriptor.shareScope === 'dedupe-by-action';
  }

  /** 构建持久化 payload 与内容指纹（savedAt 不进指纹，纯时间戳变化不视为内容变化）
   *  S1-C: dedupe 移出快照指纹、单独变化检测 —— 每次 lease 授予写不再伴随全量 dedupe 重写 */
  private buildPersistContent(mode: 'hot' | 'full' = 'full'): {
    contentJson: string;
    payload: Record<string, unknown>;
    dedupeJson: string | null;
  } {
    const records = mode === 'hot'
      ? this.store.listTasks().filter((record) => this.isHotRetained(record))
      : this.store.listTasks();
    const tasks = records.map(record => ({
      descriptor: record.descriptor,
      runtime: record.runtime,
    }));
    const completedLabels = Array.from(this.completedTaskLabels);
    const contentJson = JSON.stringify({ tasks, completedLabels });
    const dedupeEntries = this.dedupeIndex.size > 0 ? Object.fromEntries(this.dedupeIndex.entries()) : null;
    const dedupeJson = dedupeEntries === null ? null : JSON.stringify(dedupeEntries);
    // P2 FIX: 同批持久化 dedupe index，防止 SW 重启后 dedupe 失效导致重复任务
    const payload: Record<string, unknown> = {
      [this.storageKey]: { tasks, completedLabels, savedAt: Date.now() },
    };
    if (dedupeJson !== null && dedupeJson !== this.lastPersistedDedupeJson) {
      payload[this.dedupeStorageKey] = dedupeEntries;
    }
    return { contentJson, payload, dedupeJson };
  }

  private commitPersistToStorage(
    storage: { set: (items: Record<string, unknown>) => void | Promise<void> },
    mode: 'hot' | 'full',
    contentJson: string,
    dedupeJson: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // storage.set 失败原本即 fire-and-forget（catch 吞掉）；基线同步更新，避免跳过逻辑依赖微任务时序
    if (mode === 'hot') this.lastHotContentJson = contentJson;
    else this.lastFullContentJson = contentJson;
    if (dedupeJson !== null) this.lastPersistedDedupeJson = dedupeJson;
    this.persistCommitSeq += 1;
    return Promise.resolve(storage.set(payload)).catch(() => undefined).then(() => undefined);
  }

  private flushPersistBurst(storage: { set: (items: Record<string, unknown>) => void | Promise<void> } | null): void {
    this.persistBurstTimer = null;
    const pendingJson = this.persistBurstPendingJson;
    const pendingPayload = this.persistBurstPendingPayload;
    const pendingDedupeJson = this.persistBurstPendingDedupeJson;
    const pendingMode = this.persistBurstPendingMode;
    this.persistBurstPendingJson = null;
    this.persistBurstPendingPayload = null;
    this.persistBurstPendingDedupeJson = null;
    const waiters = this.persistBurstWaiters;
    this.persistBurstWaiters = [];
    const done = (): void => {
      for (const resolve of waiters) resolve();
    };
    if (
      pendingJson === null
      || pendingPayload === null
      // S1-A: 已有更新的提交 → pending 过期（快照为全量覆盖，写回旧态会回滚新态）
      || this.persistBurstPendingSeq < this.persistCommitSeq
      || (pendingJson === (pendingMode === 'hot' ? this.lastHotContentJson : this.lastFullContentJson)
        && pendingDedupeJson === this.lastPersistedDedupeJson)
    ) {
      done();
      return;
    }
    if (!storage) {
      done();
      return;
    }
    this.commitPersistToStorage(storage, pendingMode, pendingJson, pendingDedupeJson, pendingPayload).then(done);
  }

  /**
   * S1-A (cycle-6): 租约授予持久化 —— 150ms 合并窗口。
   * 窗口内多次授予请求合并为一次 storage.set（内容在 flush 时构建，天然含窗口内全部状态变化）；
   * waiter 只在 flush 完成后 resolve（调用方在 flush 后 sendResponse，避免响应先行、写入继续堆积）。
   */
  private persistLeaseGrant(): Promise<void> {
    const storage = this.storageRef();
    if (!storage) return Promise.resolve();
    if (this.leaseGrantFlushTimer === null) {
      this.leaseGrantFlushTimer = setTimeout(
        () => this.flushLeaseGrantPersistence(storage),
        this.leaseGrantCoalesceMs,
      );
    }
    return new Promise<void>((resolve) => {
      this.leaseGrantWaiters.push(resolve);
    });
  }

  private flushLeaseGrantPersistence(storage: { set: (items: Record<string, unknown>) => void | Promise<void> } | null): void {
    this.leaseGrantFlushTimer = null;
    const waiters = this.leaseGrantWaiters;
    this.leaseGrantWaiters = [];
    const done = (): void => {
      for (const resolve of waiters) resolve();
    };
    if (!storage) {
      done();
      return;
    }
    // S1-C: 租约授予窗写 hot 快照（仅非终态任务）—— 授予风暴期单次写体积减半，
    // 并发边界语义不变（leased/running 任务始终在 hot 快照内，重启后租约槽位不丢失）
    const { contentJson, payload, dedupeJson } = this.buildPersistContent('hot');
    if (contentJson === this.lastHotContentJson && dedupeJson === this.lastPersistedDedupeJson) {
      done();
      return;
    }
    this.commitPersistToStorage(storage, 'hot', contentJson, dedupeJson, payload).then(done);
  }

  private storageRef(): { set: (items: Record<string, unknown>) => void | Promise<void> } | null {
    return typeof chrome !== 'undefined' ? (chrome.storage?.local ?? null) : null;
  }

  /** S1-A (cycle-6): SW 急停前冲刷全部未提交持久化（150ms 租约窗 + 3s burst 窗），把重启暴露窗口压到 ~0 */
  flushPendingPersistenceForSuspend(): void {
    if (this.leaseGrantFlushTimer !== null) {
      clearTimeout(this.leaseGrantFlushTimer);
      void this.flushLeaseGrantPersistence(this.storageRef());
    }
    if (this.persistBurstTimer !== null) {
      clearTimeout(this.persistBurstTimer);
      void this.flushPersistBurst(this.storageRef());
    }
  }

  /** Collapse bursty task updates into one hot snapshot write (S1-C). */
  private schedulePersistToStorage(): void {
    if (this.persistDebounceTimer !== null) return;
    this.persistDebounceTimer = setTimeout(() => {
      this.persistDebounceTimer = null;
      this.persistToStorage();
    }, this.persistDebounceMs);
  }

  // P1 FIX: 跨页面依赖同步 - 通知任务中心某个 label 的任务已完成
  markTaskLabelCompleted(label: string): void {
    const had = this.completedTaskLabels.has(label);
    this.completedTaskLabels.add(label);
    // S1-C: 仅 label 首次完成才触发防抖写；多页高并发下同一 label 的重复完成不再驱动快照写
    if (!had) this.schedulePersistToStorage();
  }

  // P1 FIX: 查询某个 label 是否已在全局完成（供 content script 调用）
  isTaskLabelCompleted(label: string): boolean {
    return this.completedTaskLabels.has(label);
  }

  private getQueueScore(record: QueueCandidate['record'], now = Date.now()): number {
    const descriptor = record.descriptor;
    const runtime = record.runtime;
    const ageMs = Math.max(0, now - descriptor.createdAt);
    const ageScore = Math.min(600, Math.floor(ageMs / 1000));
    const visibilityScore = this.store.isTabVisible(descriptor.tabId) ? 80 : 0;
    const retryPenalty = runtime.retryCount * 100;
    const starvationScore = this.getStarvationScore(record, now);
    return this.getPhaseWeight(descriptor.phase) + (descriptor.priority * 100) + visibilityScore + ageScore + starvationScore - retryPenalty;
  }

  private isRunnableCandidate(record: QueueCandidate['record'], bucket: string, visible: boolean, now = Date.now()): boolean {
    const recordBucket = resolveTaskBucket(record.descriptor.label);
    if (recordBucket !== bucket) return false;
    if (this.store.isTabVisible(record.descriptor.tabId) !== visible) return false;
    const disposition = computeTaskDisposition({
      status: record.runtime.status,
      heartbeatTs: record.runtime.heartbeatTs,
      timeoutMs: record.descriptor.timeoutMs,
      now,
    });
    if (disposition !== 'active') return false;
    return record.runtime.status === 'queued';
  }

  private getBestQueuedCandidate(bucket: string, visible: boolean): QueueCandidate | null {
    const now = Date.now();
    const candidates = this.store.listTasks().filter((record) => this.isRunnableCandidate(record, bucket, visible, now));
    if (candidates.length === 0) return null;

    candidates.sort((left, right) => {
      const leftCritical = left.descriptor.phase === 'critical';
      const rightCritical = right.descriptor.phase === 'critical';
      if (leftCritical !== rightCritical) return leftCritical ? -1 : 1;

      const phaseRank = (phase: string) => phase === 'high' ? 2 : phase === 'deferred' ? 1 : 0;
      const leftRank = phaseRank(left.descriptor.phase);
      const rightRank = phaseRank(right.descriptor.phase);
      if (leftRank !== rightRank) {
        const higherPhaseCandidate = leftRank > rightRank ? left : right;
        // Fairness boosts may rotate work only after the higher phase has
        // received an execution turn. A never-started high or deferred task
        // must not be blocked by aged lower-phase work in the same bucket.
        if (!higherPhaseCandidate.runtime.startedAt) return leftRank > rightRank ? -1 : 1;
      }

      const scoreDiff = this.getQueueScore(right, now) - this.getQueueScore(left, now);
      if (scoreDiff !== 0) return scoreDiff;

      const ageDiff = left.descriptor.createdAt - right.descriptor.createdAt;
      if (ageDiff !== 0) return ageDiff;

      return left.descriptor.taskId.localeCompare(right.descriptor.taskId);
    });

    return { record: candidates[0], score: this.getQueueScore(candidates[0], now) };
  }

  private getRunningCount(bucket: string, visible: boolean): number {
    const now = Date.now();
    return this.store.listTasks().filter(record => {
      const recordBucket = resolveTaskBucket(record.descriptor.label);
      const recordVisible = this.store.isTabVisible(record.descriptor.tabId);
      const recordDisposition = computeTaskDisposition({
        status: record.runtime.status,
        heartbeatTs: record.runtime.heartbeatTs,
        timeoutMs: record.descriptor.timeoutMs,
        now,
      });
      return recordBucket === bucket
        && recordVisible === visible
        && recordDisposition === 'active'
        && (record.runtime.status === 'leased' || record.runtime.status === 'running');
    }).length;
  }

  private getActiveLeaseCount(
    visible: boolean,
    pageInstanceId?: string,
    visibilityPolicy?: GlobalTaskDescriptor['visibilityPolicy'],
  ): number {
    const now = Date.now();
    return this.store.listTasks().filter(record => {
      const disposition = computeTaskDisposition({
        status: record.runtime.status,
        heartbeatTs: record.runtime.heartbeatTs,
        timeoutMs: record.descriptor.timeoutMs,
        now,
      });
      return this.store.isTabVisible(record.descriptor.tabId) === visible
        && (!pageInstanceId || record.descriptor.pageInstanceId === pageInstanceId)
        && (!visibilityPolicy || record.descriptor.visibilityPolicy === visibilityPolicy)
        && disposition === 'active'
        && (record.runtime.status === 'leased' || record.runtime.status === 'running');
    }).length;
  }

  private getActiveLeaseGroupCount(group: string): number {
    const now = Date.now();
    return this.store.listTasks().filter((record) => {
      const disposition = computeTaskDisposition({
        status: record.runtime.status,
        heartbeatTs: record.runtime.heartbeatTs,
        timeoutMs: record.descriptor.timeoutMs,
        now,
      });
      return resolveTaskLeaseGroup(
        record.descriptor.label,
        record.descriptor.visibilityPolicy,
      ) === group
        && disposition === 'active'
        && (record.runtime.status === 'leased' || record.runtime.status === 'running');
    }).length;
  }

  /**
   * F2 (cycle-7): 是否存在排队中的源页同步链任务（videoStatus:initialSync/fullRefresh）。
   * 排除 tab-hidden 暂缓态（该页不参与前台调度，预热任务同为后台节流，无冲突）。
   *
   * S1-2 (cycle-9): 判定收窄为同页（pageInstanceId）。原全局判定「任意页有 queued sync 就挡所有页预热」
   * 在 16 detail tab 场景形成跨页饿死环（r2 窗口实测：组槽 76% 时间（124/164 快照）空闲但被 F2 挡死，
   * 可见 tab 3 个预热任务 89s 内各重试 ~85 次无一完成 → 真机水印/收藏评分/洞察延迟 90s+）。
   * S2-2 原始语义（cycle-7）按同页保留：同页 sync 排队时同页预热仍不得重入组槽。
   */
  private hasQueuedSourcePageSyncTask(pageInstanceId: string): boolean {
    for (const record of this.store.listTasks()) {
      if (record.runtime.status !== 'queued') continue;
      if (record.runtime.waitReason === 'tab-hidden') continue;
      if (!isSourcePageSyncLabel(record.descriptor.label)) continue;
      if (record.descriptor.pageInstanceId !== pageInstanceId) continue;
      return true;
    }
    return false;
  }

  private cleanupStaleTasks(now = Date.now()): void {
    for (const record of this.store.listTasks()) {
      const { descriptor, runtime } = record;
      const disposition = computeTaskDisposition({
        status: runtime.status,
        heartbeatTs: runtime.heartbeatTs,
        timeoutMs: descriptor.timeoutMs,
        now,
      });

      if (disposition === 'stale') {
        runtime.status = 'canceled';
        runtime.waitReason = 'lease-timeout';
        runtime.endedAt = now;
        this.store.setTask(descriptor.taskId, record);
        console.log('[TaskCenter] Canceled stale active task', {
          taskId: descriptor.taskId,
          label: descriptor.label,
          pageInstanceId: descriptor.pageInstanceId,
          reason: runtime.waitReason,
        });
      }

      const isHidden = !this.store.isTabVisible(descriptor.tabId);
      const isActiveRunningTask = runtime.status === 'leased' || runtime.status === 'running';
      const hiddenBaseTs = runtime.heartbeatTs || runtime.startedAt || descriptor.createdAt;
      const shouldApplyHiddenRunningTimeout = descriptor.visibilityPolicy !== 'background_allowed'
        && descriptor.visibilityPolicy !== 'background_throttled';
      if (
        shouldApplyHiddenRunningTimeout
        && isHidden
        && isActiveRunningTask
        && now - hiddenBaseTs > this.hiddenRunningTaskMaxAgeMs
      ) {
        runtime.status = 'canceled';
        runtime.waitReason = 'hidden-background-timeout';
        runtime.endedAt = now;
        this.store.setTask(descriptor.taskId, record);
        console.log('[TaskCenter] Canceled hidden running task', {
          taskId: descriptor.taskId,
          label: descriptor.label,
          pageInstanceId: descriptor.pageInstanceId,
          tabId: descriptor.tabId,
          hiddenMs: now - hiddenBaseTs,
        });
      }

      const isPendingTask = runtime.status === 'registered' || runtime.status === 'queued';
      const pendingBaseTs = runtime.lastProgressAt || runtime.heartbeatTs || descriptor.createdAt;
      const isKnownTabPendingTask = this.store.hasTabVisibility(descriptor.tabId);
      if (
        isPendingTask
        && !isKnownTabPendingTask
        && now - pendingBaseTs > this.pendingTaskMaxAgeMs
      ) {
        runtime.status = 'canceled';
        runtime.waitReason = 'page-instance-orphaned';
        runtime.endedAt = now;
        this.store.setTask(descriptor.taskId, record);
        console.log('[TaskCenter] Canceled orphan pending task', {
          taskId: descriptor.taskId,
          label: descriptor.label,
          pageInstanceId: descriptor.pageInstanceId,
          ageMs: now - pendingBaseTs,
        });
      }

      const pausedBaseTs = runtime.lastProgressAt || runtime.heartbeatTs || descriptor.createdAt;
      if (runtime.status === 'paused' && now - pausedBaseTs > this.pausedTaskMaxAgeMs) {
        runtime.status = 'canceled';
        runtime.waitReason = 'paused-timeout';
        runtime.endedAt = now;
        this.store.setTask(descriptor.taskId, record);
        console.log('[TaskCenter] Canceled stale paused task', {
          taskId: descriptor.taskId,
          label: descriptor.label,
          pageInstanceId: descriptor.pageInstanceId,
          ageMs: now - pausedBaseTs,
        });
      }

      const terminal = ['done', 'error', 'canceled'].includes(runtime.status);
      const terminalTs = runtime.endedAt || runtime.heartbeatTs || descriptor.createdAt;
      if (terminal && now - terminalTs > this.taskRetentionMs) {
        this.store.deleteTask(descriptor.taskId);
        if (descriptor.dedupeKey && this.dedupeIndex.get(descriptor.dedupeKey) === descriptor.taskId) {
          this.dedupeIndex.delete(descriptor.dedupeKey);
        }
      }
    }

    // S1-B: 终态任务 LRU 上限 —— 保留期只处理「过期」记录，此处再对终态记录条数做硬封顶，
    // 保证多页高并发时快照体积有界（最多保留 terminalTaskMax 条终态记录，按 endedAt 淘汰最旧）
    const terminalRecords = this.store.listTasks().filter(
      (record): record is GlobalTaskRecord => ['done', 'error', 'canceled'].includes(record.runtime.status),
    );
    if (terminalRecords.length > this.terminalTaskMax) {
      const terminalTsOf = (record: GlobalTaskRecord): number =>
        record.runtime.endedAt || record.runtime.heartbeatTs || record.descriptor.createdAt;
      const ordered = [...terminalRecords].sort((a, b) => terminalTsOf(a) - terminalTsOf(b));
      const evictCount = terminalRecords.length - this.terminalTaskMax;
      for (const record of ordered.slice(0, evictCount)) {
        this.store.deleteTask(record.descriptor.taskId);
        if (record.descriptor.dedupeKey && this.dedupeIndex.get(record.descriptor.dedupeKey) === record.descriptor.taskId) {
          this.dedupeIndex.delete(record.descriptor.dedupeKey);
        }
      }
    }
  }

  registerTask(descriptor: GlobalTaskDescriptor, sender?: chrome.runtime.MessageSender): TaskRegistrationResult {
    this.cleanupStaleTasks();
    return this.registerTaskWithoutCleanup(descriptor, sender);
  }

  registerTasks(
    descriptors: readonly GlobalTaskDescriptor[],
    sender?: chrome.runtime.MessageSender,
  ): TaskRegistrationResult[] {
    this.cleanupStaleTasks();
    return descriptors.map((descriptor) => this.registerTaskWithoutCleanup(descriptor, sender));
  }

  private registerTaskWithoutCleanup(descriptor: GlobalTaskDescriptor, sender?: chrome.runtime.MessageSender): TaskRegistrationResult {
    const existing = this.store.getTask(descriptor.taskId);
    if (existing) {
      return {
        ok: true,
        taskId: descriptor.taskId,
        tabId: existing.descriptor.tabId,
        reused: true,
        status: existing.runtime.status,
      };
    }
    const dedupeKey = descriptor.dedupeKey || `${descriptor.label}:${descriptor.pageUrl}`;
    const dedupedTaskId = this.dedupeIndex.get(dedupeKey);
    if (dedupedTaskId) {
      const dedupedTask = this.store.getTask(dedupedTaskId);
      if (dedupedTask) {
        const status = dedupedTask.runtime.status;
        // 共享动作（如 115 推送）复用终态结果，避免多页重复真实执行
        if (['done', 'error'].includes(status) && dedupedTask.descriptor.shareScope === 'dedupe-by-action') {
          return {
            ok: true,
            taskId: dedupedTaskId,
            tabId: dedupedTask.descriptor.tabId,
            reused: true,
            status,
          };
        }
        if (['canceled', 'done', 'error'].includes(status)) {
          this.store.deleteTask(dedupedTaskId);
          if (this.dedupeIndex.get(dedupeKey) === dedupedTaskId) {
            this.dedupeIndex.delete(dedupeKey);
          }
        } else {
          return {
            ok: true,
            taskId: dedupedTaskId,
            tabId: dedupedTask.descriptor.tabId,
            reused: true,
            status,
          };
        }
      }
    }
    const tabId = typeof sender?.tab?.id === 'number' ? sender.tab.id : descriptor.tabId;
    const runtime: GlobalTaskRuntimeState = {
      status: 'registered',
      retryCount: 0,
      pauseCount: 0,
      resumeCount: 0,
    };
    this.store.setTask(descriptor.taskId, { descriptor: { ...descriptor, tabId, dedupeKey }, runtime });
    this.dedupeIndex.set(dedupeKey, descriptor.taskId);
    return { ok: true, taskId: descriptor.taskId, tabId, reused: false, status: 'registered' };
  }

  /**
   * S2-2 (cycle-7): 排队状态可能变化时唤醒等待中的页面。
   * - 仅对存在 queued 任务的 tab 发送；每 tab 在合并窗（500ms）内最多一次；
   * - 唤醒只是提示「尽快再试一次」，租约判定仍以页面侧 request-lease 为准（轮询为兜底）；
   * - 发送失败（tab 已关闭等）静默吞掉，不影响状态机。
   */
  private notifyLeaseWaiters(reason: string, opts?: { bypassCoalesce?: boolean }): void {
    // F4 (cycle-7): prompt 雷群公平化 —— 按「该 tab 排队任务最高相位、最老排队任务 createdAt」排序。
    // 槽位释放后优先唤醒持最紧急排队任务的 tab，后开 tab（持 critical 同步任务）不再
    // 系统性输给先开 tab（持预热任务）—— 旧实现按注册顺序遍历，雷群中先开 tab 的请求总是先被处理
    const tabQueueKey = new Map<number, { topPhase: number; oldest: number }>();
    for (const record of this.store.listTasks()) {
      if (record?.runtime?.status !== 'queued') continue;
      const tabId = record?.descriptor?.tabId;
      if (typeof tabId !== 'number') continue;
      const phaseWeight = this.getPhaseWeight(record?.descriptor?.phase);
      const createdAt = record?.descriptor?.createdAt || 0;
      const entry = tabQueueKey.get(tabId);
      if (!entry) {
        tabQueueKey.set(tabId, { topPhase: phaseWeight, oldest: createdAt });
      } else {
        entry.topPhase = Math.max(entry.topPhase, phaseWeight);
        entry.oldest = Math.min(entry.oldest, createdAt);
      }
    }
    const targetTabs = Array.from(tabQueueKey.entries())
      .sort((a, b) => (b[1].topPhase - a[1].topPhase) || (a[1].oldest - b[1].oldest))
      .map(([tabId]) => tabId);
    if (targetTabs.length === 0) return;
    const coalesceMs = opts?.bypassCoalesce ? this.leasePromptBypassCoalesceMs : this.leasePromptCoalesceMs;
    const now = Date.now();
    for (const tabId of targetTabs) {
      // S1-2 (cycle-8): 跳过 hidden 页 —— 容量型拒绝后 hidden 页已退出内层等待循环（转外层指数退避，
      // 回前台由页面 visibilitychange 立即重跑），向 hidden 页发 prompt 纯浪费
      // （S0-8 实测 16 页场景 15 页 hidden 全量接收广播）；未上报可见性的 tab 按 hidden 处理，
      // 页面侧 2s 兜底轮询保证正确性。
      if (!this.store.isTabVisible(tabId)) continue;
      const last = this.leasePromptLastSentAt.get(tabId);
      if (last !== undefined && now - last < coalesceMs) continue;
      if (last !== undefined && now - last > GlobalTaskCenter.leasePromptStaleMs) {
        this.leasePromptLastSentAt.delete(tabId);
      }
      this.leasePromptLastSentAt.set(tabId, now);
      try {
        (this.sendTabPrompt ?? this.sendLeasePromptToTab)(tabId, {
          type: TASK_CENTER_MESSAGE.LEASE_PROMPT,
          payload: { reason },
        });
      } catch {
        // tab 可能已关闭；页面侧轮询兜底，不影响任务状态
      }
    }
  }

  private sendLeasePromptToTab = (tabId: number, message: { type: string; payload: Record<string, unknown> }): void => {
    try {
      const send = (chrome as { tabs?: { sendMessage?: (t: number, m: unknown) => Promise<unknown> | undefined } })?.tabs?.sendMessage;
      if (typeof send !== 'function') return;
      const result = send.call((chrome as { tabs?: unknown }).tabs, tabId, message);
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch(() => {});
      }
    } catch {
      // tab 可能已关闭
    }
  };

  requestLease(taskId: string): LeaseResponse {
    this.cleanupStaleTasks();
    const task = this.store.getTask(taskId);
    if (!task) return { granted: false, waitReason: 'task-not-found' };
    if (task.runtime.status === 'done' || task.runtime.status === 'error' || task.runtime.status === 'canceled') {
      return { granted: false, waitReason: `task-${task.runtime.status}` };
    }
    const bucket = resolveTaskBucket(task.descriptor.label);
    const baseLimit = TASK_BUCKET_LIMITS[bucket] ?? 1;
    const visible = this.store.isTabVisible(task.descriptor.tabId);
    const limit = getEffectiveBucketLimit({
      baseLimit,
      visible,
      policy: task.descriptor.visibilityPolicy,
    });
    if (limit <= 0) {
      task.runtime.status = 'queued';
      task.runtime.waitReason = visible ? `bucket:${bucket}` : 'tab-hidden';
      this.store.setTask(taskId, task);
      return { granted: false, waitReason: task.runtime.waitReason };
    }
    if (task.runtime.status === 'leased' || task.runtime.status === 'running') {
      return { granted: true };
    }
    if (task.runtime.status === 'registered') {
      task.runtime.status = 'queued';
      task.runtime.waitReason = undefined;
      this.store.setTask(taskId, task);
    }

    const bestCandidate = this.getBestQueuedCandidate(bucket, visible);
    if (!bestCandidate) {
      task.runtime.status = 'queued';
      task.runtime.waitReason = visible ? `bucket:${bucket}` : 'tab-hidden';
      this.store.setTask(taskId, task);
      return { granted: false, waitReason: task.runtime.waitReason };
    }

    const isInteractive115Push = task.descriptor.label === 'drive115:push' && visible;
    const samePageCandidate = bestCandidate.record.descriptor.pageInstanceId === task.descriptor.pageInstanceId;

    if (bestCandidate.record.descriptor.taskId !== taskId) {
      const runningCount = this.getRunningCount(bucket, visible);
      const currentPriority = Number(task.descriptor.priority || 0);
      const bestPriority = Number(bestCandidate.record.descriptor.priority || 0);
      const allowInteractiveSamePageFastLane = isInteractive115Push && samePageCandidate && runningCount < limit;
      const allowBackgroundParallel = !visible
        && task.descriptor.visibilityPolicy === 'background_allowed'
        && limit >= 3                               // P2 NOTE: limit<3 的 bucket（translate=1, drive115=2）永远无法触发此逃生口
        && runningCount < limit
        && (bestPriority - currentPriority) <= 3;   // P2 NOTE: 允许优先级差<=3 的任务绕过，差值太宽松可能导致 deferred 抢 high 的槽
      if (!allowInteractiveSamePageFastLane && !allowBackgroundParallel) {
        task.runtime.status = 'queued';
        task.runtime.waitReason = 'higher-priority-wait';
        this.store.setTask(taskId, task);
        return { granted: false, waitReason: task.runtime.waitReason };
      }
    }

    const runningCount = this.getRunningCount(bucket, visible);
    if (runningCount >= limit) {
      task.runtime.status = 'queued';
      task.runtime.waitReason = visible ? `bucket:${bucket}` : 'tab-hidden';
      this.store.setTask(taskId, task);
      return { granted: false, waitReason: task.runtime.waitReason };
    }
    if (task.descriptor.visibilityPolicy === 'background_throttled') {
      const activePagePrewarmCount = this.getActiveLeaseCount(
        visible,
        task.descriptor.pageInstanceId,
        'background_throttled',
      );
      if (activePagePrewarmCount >= TASK_SMART_BACKGROUND_PREWARM_LIMITS.page) {
        task.runtime.status = 'queued';
        task.runtime.waitReason = 'smart-background-page-budget';
        this.store.setTask(taskId, task);
        return { granted: false, waitReason: task.runtime.waitReason };
      }
      const activePrewarmCount = this.store.listTasks().filter((record) => {
        const disposition = computeTaskDisposition({
          status: record.runtime.status,
          heartbeatTs: record.runtime.heartbeatTs,
          timeoutMs: record.descriptor.timeoutMs,
          now: Date.now(),
        });
        return record.descriptor.visibilityPolicy === 'background_throttled'
          && disposition === 'active'
          && (record.runtime.status === 'leased' || record.runtime.status === 'running');
      }).length;
      if (activePrewarmCount >= TASK_SMART_BACKGROUND_PREWARM_LIMITS.global) {
        task.runtime.status = 'queued';
        task.runtime.waitReason = 'smart-background-global-budget';
        this.store.setTask(taskId, task);
        return { granted: false, waitReason: task.runtime.waitReason };
      }
    }
    const globalLeaseLimit = visible ? TASK_GLOBAL_LEASE_LIMITS.visible : TASK_GLOBAL_LEASE_LIMITS.hidden;
    const activeLeaseCount = this.getActiveLeaseCount(visible);
    const isPriorityPhase = task.descriptor.phase === 'critical' || task.descriptor.phase === 'high';
    const reservedLeaseCount = !isPriorityPhase
      ? (visible ? TASK_GLOBAL_LEASE_LIMITS.visiblePriorityReserve : TASK_GLOBAL_LEASE_LIMITS.hiddenPriorityReserve)
      : 0;
    if (activeLeaseCount >= globalLeaseLimit - reservedLeaseCount) {
      task.runtime.status = 'queued';
      task.runtime.waitReason = reservedLeaseCount > 0 ? 'global-priority-reserve' : (visible ? 'global-budget' : 'background-global-budget');
      this.store.setTask(taskId, task);
      return { granted: false, waitReason: task.runtime.waitReason };
    }
    const pageLeaseLimit = visible ? TASK_PAGE_LEASE_LIMITS.visible : TASK_PAGE_LEASE_LIMITS.hidden;
    if (this.getActiveLeaseCount(visible, task.descriptor.pageInstanceId) >= pageLeaseLimit) {
      task.runtime.status = 'queued';
      task.runtime.waitReason = visible ? 'page-budget' : 'background-page-budget';
      this.store.setTask(taskId, task);
      return { granted: false, waitReason: task.runtime.waitReason };
    }
    const leaseGroup = resolveTaskLeaseGroup(
      task.descriptor.label,
      task.descriptor.visibilityPolicy,
    );
    const leaseGroupLimit = leaseGroup ? TASK_LEASE_GROUP_LIMITS[leaseGroup] : undefined;
    // F2 (cycle-7): 组预算相位序 —— 源页同步链（initialSync→fullRefresh）在排队时，
    // 后台增强预热任务（videoFavoriteRating:init/actorMarks:page/insights:collector）
    // 即使组槽空闲也不得重入 source-page-heavy 槽（S2-2 长尾根因：预热任务在 prompt 雷群中
    // 逐个重入槽位，critical initialSync 被持续以 source-page-heavy-budget 弹回）
    // S1-2 (cycle-9): 仅同页（pageInstanceId）的 queued sync 才挡本页预热 ——
    // 跨页 queued sync（典型：hidden 页 sync 被 higher-priority-wait/hidden 预算卡住）不再挡死
    // 其他页（尤其可见页）的预热，解开 76% 组槽空转的跨页饿死环。
    const blockedBySourceSyncQueue = leaseGroup === 'source-page-heavy'
      && !isSourcePageSyncLabel(task.descriptor.label)
      && this.hasQueuedSourcePageSyncTask(task.descriptor.pageInstanceId);
    if (
      leaseGroup
      && leaseGroupLimit !== undefined
      && (this.getActiveLeaseGroupCount(leaseGroup) >= leaseGroupLimit || blockedBySourceSyncQueue)
    ) {
      task.runtime.status = 'queued';
      task.runtime.waitReason = `${leaseGroup}-budget`;
      this.store.setTask(taskId, task);
      return { granted: false, waitReason: task.runtime.waitReason };
    }
    task.runtime.status = 'leased';
    task.runtime.waitReason = undefined;
    task.runtime.startedAt = task.runtime.startedAt || Date.now();
    task.runtime.heartbeatTs = Date.now();
    this.store.setTask(taskId, task);
    // A granted lease is the cross-page concurrency boundary. Persist it promptly
    // so an MV3 worker restart cannot admit a competing heavy task first.
    // S1-A (cycle-6): 150ms 合并窗口替代立即写 —— 16 页冷启动的突发授予合并为一次写，
    // sendResponse 仍在 flush 之后（见 handleMessage）；重启暴露窗口封顶 150ms 且有急停落盘兜底
    this.lastGrantedLeasePersistence = this.persistLeaseGrant();
    return { granted: true };
  }

  pauseTask(taskId: string, reason: string = 'paused'): { ok: true } {
    this.cleanupStaleTasks();
    const task = this.store.getTask(taskId);
    if (task && task.runtime.status !== 'done' && task.runtime.status !== 'canceled') {
      task.runtime.status = 'paused';
      task.runtime.waitReason = reason;
      task.runtime.pauseCount += 1;
      this.store.setTask(taskId, task);
      this.notifyLeaseWaiters('task-paused', { bypassCoalesce: isSourcePageSyncLabel(task.descriptor.label) });
    }
    return { ok: true };
  }

  resumeTask(taskId: string): { ok: true } {
    this.cleanupStaleTasks();
    const task = this.store.getTask(taskId);
    if (task && task.runtime.status === 'paused') {
      task.runtime.status = 'queued';
      task.runtime.waitReason = undefined;
      task.runtime.resumeCount += 1;
      this.store.setTask(taskId, task);
      this.notifyLeaseWaiters('task-resumed');
    }
    return { ok: true };
  }

  heartbeatTask(taskId: string): { ok: true } {
    this.cleanupStaleTasks();
    const task = this.store.getTask(taskId);
    if (task) {
      task.runtime.heartbeatTs = Date.now();
      if (task.runtime.status === 'leased') task.runtime.status = 'running';
      this.store.setTask(taskId, task);
    }
    return { ok: true };
  }

  completeTask(taskId: string): { ok: true } {
    this.cleanupStaleTasks();
    const task = this.store.getTask(taskId);
    if (task) {
      task.runtime.status = 'done';
      task.runtime.waitReason = undefined;
      task.runtime.endedAt = Date.now();
      this.store.setTask(taskId, task);
      // P1 FIX: 任务完成时同步到全局已完成标签集合（跨页面依赖）
      this.markTaskLabelCompleted(task.descriptor.label);
      // S2-2: 桶容量释放，唤醒仍在排队的页面
      this.notifyLeaseWaiters('task-completed', { bypassCoalesce: isSourcePageSyncLabel(task.descriptor.label) });
    }
    return { ok: true };
  }

  failTask(taskId: string, error: string): {
    ok: true;
    retryable: boolean;
    retryCount: number;
    retryLimit: number;
    status?: string;
    waitReason?: string;
  } {
    this.cleanupStaleTasks();
    const task = this.store.getTask(taskId);
    if (!task) {
      return { ok: true, retryable: false, retryCount: 0, retryLimit: 0, waitReason: 'task-not-found' };
    }

    const retryLimit = Math.max(0, task.descriptor.retryLimit || 0);
    // 终态守卫：过期 FAIL 不得把 done/error/canceled 任务重新排回队列
    if (task.runtime.status === 'done' || task.runtime.status === 'error' || task.runtime.status === 'canceled') {
      return {
        ok: true,
        retryable: false,
        retryCount: task.runtime.retryCount,
        retryLimit,
        status: task.runtime.status,
        waitReason: task.runtime.waitReason,
      };
    }
    task.runtime.retryCount += 1;
    task.runtime.detail = error || undefined;

    if (task.runtime.retryCount <= retryLimit) {
      task.runtime.status = 'queued';
      task.runtime.waitReason = 'retryable-error';
      task.runtime.startedAt = undefined;
      task.runtime.endedAt = undefined;
      task.runtime.heartbeatTs = undefined;
      task.runtime.lastProgressAt = Date.now();
      this.store.setTask(taskId, task);
      this.notifyLeaseWaiters('task-retryable', { bypassCoalesce: isSourcePageSyncLabel(task.descriptor.label) });
      return {
        ok: true,
        retryable: true,
        retryCount: task.runtime.retryCount,
        retryLimit,
        status: task.runtime.status,
        waitReason: task.runtime.waitReason,
      };
    }

    task.runtime.status = 'error';
    task.runtime.waitReason = 'retry-limit-exhausted';
    task.runtime.endedAt = Date.now();
    this.store.setTask(taskId, task);
    this.notifyLeaseWaiters('task-failed', { bypassCoalesce: isSourcePageSyncLabel(task.descriptor.label) });
    return {
      ok: true,
      retryable: false,
      retryCount: task.runtime.retryCount,
      retryLimit,
      status: task.runtime.status,
      waitReason: task.runtime.waitReason,
    };
  }

  deferTask(taskId: string, reason: string): { ok: true; status?: string; waitReason?: string } {
    this.cleanupStaleTasks();
    const task = this.store.getTask(taskId);
    if (!task) return { ok: true, waitReason: 'task-not-found' };

    if (!['done', 'error', 'canceled'].includes(task.runtime.status)) {
      task.runtime.status = 'queued';
      task.runtime.waitReason = reason || 'deferred';
      task.runtime.startedAt = undefined;
      task.runtime.endedAt = undefined;
      task.runtime.heartbeatTs = undefined;
      task.runtime.lastProgressAt = Date.now();
      this.store.setTask(taskId, task);
      this.notifyLeaseWaiters('task-deferred', { bypassCoalesce: isSourcePageSyncLabel(task.descriptor.label) });
    }
    return { ok: true, status: task.runtime.status, waitReason: task.runtime.waitReason };
  }

  cancelTask(taskId: string, reason: string): { ok: true } {
    this.cleanupStaleTasks();
    const task = this.store.getTask(taskId);
    if (task) {
      task.runtime.status = 'canceled';
      task.runtime.waitReason = reason || 'manual-cancel';
      task.runtime.endedAt = Date.now();
      this.store.setTask(taskId, task);
      this.notifyLeaseWaiters('task-canceled', { bypassCoalesce: isSourcePageSyncLabel(task.descriptor.label) });
    }
    return { ok: true };
  }

  cancelTasksByPageInstance(pageInstanceId: string, reason: string): { ok: true; canceled: number } {
    this.cleanupStaleTasks();
    let canceled = 0;
    let syncLabelReleased = false;
    for (const record of this.store.listTasks()) {
      if (record?.descriptor?.pageInstanceId !== pageInstanceId) continue;
      if (['done', 'error', 'canceled'].includes(record.runtime.status)) continue;
      if (isSourcePageSyncLabel(record.descriptor.label)) syncLabelReleased = true;
      record.runtime.status = 'canceled';
      record.runtime.waitReason = reason || 'page-closed-by-user';
      record.runtime.endedAt = Date.now();
      this.store.setTask(record.descriptor.taskId, record);
      canceled += 1;
    }
    if (canceled > 0) this.notifyLeaseWaiters('task-canceled', { bypassCoalesce: syncLabelReleased });
    return { ok: true, canceled };
  }

  cancelTasksByTabId(tabId: number, reason: string): { ok: true; canceled: number } {
    this.cleanupStaleTasks();
    let canceled = 0;
    let syncLabelReleased = false;
    for (const record of this.store.listTasks()) {
      if (record?.descriptor?.tabId !== tabId) continue;
      if (['done', 'error', 'canceled'].includes(record.runtime.status)) continue;
      if (isSourcePageSyncLabel(record.descriptor.label)) syncLabelReleased = true;
      record.runtime.status = 'canceled';
      record.runtime.waitReason = reason || 'page-closed-by-user';
      record.runtime.endedAt = Date.now();
      this.store.setTask(record.descriptor.taskId, record);
      canceled += 1;
    }
    if (canceled > 0) this.notifyLeaseWaiters('task-canceled', { bypassCoalesce: syncLabelReleased });
    return { ok: true, canceled };
  }

  updateVisibility(tabId: number, visible: boolean): { ok: true } {
    this.cleanupStaleTasks();
    this.store.setVisibility(tabId, visible);
    // S2-2: 双向唤醒 —— 变可见：该页排队任务重新有资格；变隐藏：该页任务可能让出槽位
    this.notifyLeaseWaiters(visible ? 'tab-visible' : 'tab-hidden');
    return { ok: true };
  }

  clearAll(): { ok: true } {
    this.store.clear();
    this.dedupeIndex.clear();
    this.completedTaskLabels.clear();
    // S1-C: 存储键已移除，基线同步失效，避免后续写被「内容未变」误跳过
    this.lastHotContentJson = null;
    this.lastFullContentJson = null;
    this.lastPersistedDedupeJson = null;
    chrome.storage.local.remove([this.storageKey, this.dedupeStorageKey]).catch(() => {});
    return { ok: true };
  }

  clearTerminalTasks(): { ok: true; cleared: number } {
    this.cleanupStaleTasks();
    let cleared = 0;
    for (const record of this.store.listTasks()) {
      if (!['done', 'error', 'canceled'].includes(record.runtime.status)) continue;
      this.store.deleteTask(record.descriptor.taskId);
      const dedupeKey = record.descriptor.dedupeKey;
      if (dedupeKey && this.dedupeIndex.get(dedupeKey) === record.descriptor.taskId) {
        this.dedupeIndex.delete(dedupeKey);
      }
      cleared += 1;
    }
    this.persistToStorage({ mode: 'full' });
    return { ok: true, cleared };
  }

  stopAllActiveTasks(reason: string = 'manual-stop-all'): { ok: true; canceled: number } {
    this.cleanupStaleTasks();
    let canceled = 0;
    for (const record of this.store.listTasks()) {
      if (['done', 'error', 'canceled'].includes(record.runtime.status)) continue;
      record.runtime.status = 'canceled';
      record.runtime.waitReason = reason;
      record.runtime.endedAt = Date.now();
      this.store.setTask(record.descriptor.taskId, record);
      canceled += 1;
    }
    // S2-2: stop-all 会把排队任务自身一并取消，不存在「仍排队等待」的目标；
    // 各页面通过自己下一次 request-lease 收到终态（task-canceled）退出等待，无需推送唤醒。
    this.persistToStorage({ mode: 'full' });
    return { ok: true, canceled };
  }

  // P1 FIX: 定期快照定时器（每 30s 持久化一次状态，防止 service worker 重启丢失）
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private startPeriodicSnapshot(): void {
    if (this.persistTimer) return;
    this.persistTimer = setInterval(() => {
      this.cleanupStaleTasks();
      // S1-C: 周期兜底走全量快照 —— 终态历史随周期落盘（展示 + dedupe-by-action 之外记录的保留）
      this.persistToStorage({ mode: 'full' });
    }, 30_000);
  }

  queryState() {
    this.cleanupStaleTasks();
    const tasks = this.store.listTasks().map(record => ({
      taskId: record.descriptor.taskId,
      label: record.descriptor.label,
      parentTaskId: record.descriptor.parentTaskId,
      rootTaskId: record.descriptor.rootTaskId,
      correlationId: record.descriptor.correlationId,
      tabId: record.descriptor.tabId,
      pageUrl: record.descriptor.pageUrl,
      pageType: record.descriptor.pageType,
      mainId: record.descriptor.mainId,
      pageInstanceId: record.descriptor.pageInstanceId,
      phase: record.descriptor.phase,
      priority: record.descriptor.priority,
      cost: record.descriptor.cost,
      visibilityPolicy: record.descriptor.visibilityPolicy,
      timeoutMs: record.descriptor.timeoutMs,
      retryLimit: record.descriptor.retryLimit,
      dedupeKey: record.descriptor.dedupeKey,
      resumePolicy: record.descriptor.resumePolicy,
      executionClass: record.descriptor.executionClass,
      shareScope: record.descriptor.shareScope,
      createdAt: record.descriptor.createdAt,
      status: record.runtime.status,
      waitReason: record.runtime.waitReason,
      startedAt: record.runtime.startedAt,
      endedAt: record.runtime.endedAt,
      lastProgressAt: record.runtime.lastProgressAt,
      progressPct: record.runtime.progressPct,
      stage: record.runtime.stage,
      stageStartedAt: record.runtime.stageStartedAt,
      stageDurationMs: record.runtime.stageDurationMs,
      detail: record.runtime.detail,
      retryCount: record.runtime.retryCount,
      pauseCount: record.runtime.pauseCount,
      resumeCount: record.runtime.resumeCount,
      heartbeatTs: record.runtime.heartbeatTs,
    }));
    return { tasks };
  }

  updateTaskProgress(taskId: string, payload: { stage?: string; progressPct?: number; detail?: string; stageStartedAt?: number; stageDurationMs?: number }) {
    const record = this.store.getTask(taskId);
    if (!record) return { ok: false, error: 'task-not-found' };
    record.runtime.lastProgressAt = Date.now();
    if (typeof payload.progressPct === 'number') record.runtime.progressPct = payload.progressPct;
    if (typeof payload.stage === 'string') record.runtime.stage = payload.stage;
    if (typeof payload.detail === 'string') record.runtime.detail = payload.detail;
    if (typeof payload.stageStartedAt === 'number') record.runtime.stageStartedAt = payload.stageStartedAt;
    if (typeof payload.stageDurationMs === 'number') record.runtime.stageDurationMs = payload.stageDurationMs;
    this.store.setTask(taskId, record);
    // B5 (2026-09-07): 进度是高频软状态，并入 500ms 防抖窗合并写（30s 定期快照仍为兜底）
    this.schedulePersistToStorage();
    return { ok: true };
  }

  handleMessage(message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void): void {
    try {
      switch (message?.type) {
        case TASK_CENTER_MESSAGE.REGISTER:
          sendResponse(this.registerTask(message.payload, sender));
          return;
        case TASK_CENTER_MESSAGE.REGISTER_BATCH:
          sendResponse({ results: this.registerTasks(Array.isArray(message.payload?.descriptors) ? message.payload.descriptors : [], sender) });
          return;
        case TASK_CENTER_MESSAGE.REQUEST_LEASE:
          {
            const leaseResponse = this.requestLease(message.payload.taskId);
            if (!leaseResponse.granted) {
              sendResponse(leaseResponse);
              return;
            }
            void this.lastGrantedLeasePersistence.then(() => sendResponse(leaseResponse));
          }
          return;
        case TASK_CENTER_MESSAGE.HEARTBEAT:
          sendResponse(this.heartbeatTask(message.payload.taskId));
          return;
        case TASK_CENTER_MESSAGE.PROGRESS:
          sendResponse(this.updateTaskProgress(message.payload.taskId, message.payload || {}));
          return;
        case TASK_CENTER_MESSAGE.PAUSE:
          sendResponse(this.pauseTask(message.payload.taskId, String(message.payload.reason || 'paused')));
          return;
        case TASK_CENTER_MESSAGE.RESUME:
          sendResponse(this.resumeTask(message.payload.taskId));
          return;
        case TASK_CENTER_MESSAGE.COMPLETE:
          sendResponse(this.completeTask(message.payload.taskId));
          return;
        case TASK_CENTER_MESSAGE.FAIL:
          sendResponse(this.failTask(message.payload.taskId, String(message.payload.error || '')));
          return;
        case TASK_CENTER_MESSAGE.DEFER:
          sendResponse(this.deferTask(message.payload.taskId, String(message.payload.reason || 'deferred')));
          return;
        case TASK_CENTER_MESSAGE.CANCEL:
          sendResponse(this.cancelTask(message.payload.taskId, String(message.payload.reason || '')));
          return;
        case TASK_CENTER_MESSAGE.VISIBILITY:
          if (typeof sender.tab?.id === 'number') {
            sendResponse(this.updateVisibility(sender.tab.id, !!message.payload?.visible));
            return;
          }
          sendResponse({ ok: false, error: 'missing-tab-id' });
          return;
        case TASK_CENTER_MESSAGE.QUERY:
          sendResponse(this.queryState());
          return;
        case TASK_CENTER_MESSAGE.CLEAR:
          sendResponse(this.clearAll());
          return;
        case 'task-center:stop-all':
          sendResponse(this.stopAllActiveTasks(String(message.payload?.reason || 'manual-stop-all')));
          return;
        // P1 FIX: 跨页面依赖同步消息
        case 'task-center:mark-completed':
          this.markTaskLabelCompleted(String(message.payload?.label || ''));
          sendResponse({ ok: true });
          return;
        case 'task-center:check-completed':
          sendResponse({ ok: true, completed: this.isTaskLabelCompleted(String(message.payload?.label || '')) });
          return;
        case 'task-center:restore':
          this.restoreFromStorage().then(() => { sendResponse({ ok: true }); }).catch((e) => { sendResponse({ ok: false, error: String(e) }); });
          return; // async response via sendResponse
        case TASK_CENTER_MESSAGE.PAGE_LIFECYCLE:
        case TASK_CENTER_MESSAGE.CANCEL_PAGE_INSTANCE: {
          const pageInstanceId = String(message.payload?.pageInstanceId || '');
          const reason = String(message.payload?.reason || 'page-closed-by-user');
          if (!pageInstanceId) {
            sendResponse({ ok: false, error: 'missing-page-instance-id' });
            return;
          }
          sendResponse(this.cancelTasksByPageInstance(pageInstanceId, reason));
          return;
        }
        default:
          sendResponse({ ok: false, error: 'unknown-task-center-message' });
          return;
      }
    } catch (error) {
      sendResponse({ ok: false, error: String(error) });
    }
  }

  isAsyncMessage(messageType: string | undefined): boolean {
    return messageType === 'task-center:restore' || messageType === TASK_CENTER_MESSAGE.REQUEST_LEASE;
  }
}

export const globalTaskCenter = new GlobalTaskCenter();

// S1-A (cycle-6): SW 急停前冲刷未提交持久化（150ms 租约授予窗 + 3s burst 窗）
try {
  if (typeof chrome !== 'undefined' && chrome.runtime?.onSuspend) {
    chrome.runtime.onSuspend.addListener(() => {
      globalTaskCenter.flushPendingPersistenceForSuspend();
    });
  }
} catch {}
