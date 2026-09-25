/**
 * @file globalTaskCenter.leasePrompt.test.ts
 * @description S2-2 (cycle-7)：事件驱动的租约唤醒（LEASE_PROMPT）
 *  1) 任务完成 → 对同桶排队任务的 tab 发送一次唤醒
 *  2) 每 tab 500ms 合并窗：窗内重复状态变化不重复发送，窗外恢复
 *  3) 可见性变化双向唤醒（tab-hidden 排队 → tab-visible 提示重试）
 *  4) cancel / stop-all 释放槽位后同样唤醒
 *  5) 发送失败（tab 已关闭）静默吞掉，不影响状态机
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalTaskCenter } from './globalTaskCenter';
import { TASK_CENTER_MESSAGE } from '../../shared/taskCenterProtocol';
import type { GlobalTaskDescriptor } from '../../shared/taskCenterTypes';

const T0 = 1_757_000_000_000;

interface ChromeMockHandle {
  tabsSendMessage: ReturnType<typeof vi.fn>;
  storageSet: ReturnType<typeof vi.fn>;
}

function installChromeMock(): ChromeMockHandle {
  const tabsSendMessage = vi.fn().mockResolvedValue(undefined);
  const storageSet = vi.fn().mockResolvedValue(undefined);
  const storageGet = vi.fn((_keys: unknown, cb: (result: Record<string, unknown>) => void) => {
    cb({});
  });
  (globalThis as Record<string, unknown>).chrome = {
    storage: { local: { set: storageSet, get: storageGet, remove: vi.fn().mockResolvedValue(undefined) } },
    tabs: { sendMessage: tabsSendMessage },
    runtime: { lastError: null },
  };
  return { tabsSendMessage, storageSet };
}

function descriptor(label: string, tabId: number): GlobalTaskDescriptor {
  return {
    taskId: `task-${label}`,
    label,
    tabId,
    pageUrl: `https://javdb.com/v/${label}`,
    pageType: 'detail',
    mainId: label,
    pageInstanceId: `page-${label}`,
    phase: 'high',
    priority: 5,
    cost: 'light',
    visibilityPolicy: 'foreground_first',
    timeoutMs: 10_000,
    retryLimit: 0,
    resumePolicy: 'restart',
    createdAt: Date.now(),
  };
}

function promptCalls(handle: ChromeMockHandle): Array<{ tabId: number; reason: string }> {
  return handle.tabsSendMessage.mock.calls
    .map(([tabId, message]) => ({
      tabId: tabId as number,
      message: message as { type?: string; payload?: { reason?: string } },
    }))
    .filter((entry) => entry.message?.type === TASK_CENTER_MESSAGE.LEASE_PROMPT)
    .map((entry) => ({ tabId: entry.tabId, reason: entry.message?.payload?.reason || '' }));
}

describe('GlobalTaskCenter 事件驱动租约唤醒（S2-2）', () => {
  let handle: ChromeMockHandle;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    handle = installChromeMock();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).chrome;
  });

  it('任务完成后向同桶排队任务的 tab 发送一次唤醒，且不打扰无排队任务的 tab', () => {
    const center = new GlobalTaskCenter();
    center.updateVisibility(1, true);
    center.updateVisibility(2, true);
    const a = center.registerTask(descriptor('translate:a', 1)).taskId;
    const b = center.registerTask(descriptor('translate:b', 2)).taskId;

    expect(center.requestLease(a).granted).toBe(true);
    expect(center.requestLease(b)).toMatchObject({ granted: false, waitReason: 'bucket:translate' });

    center.completeTask(a);

    expect(promptCalls(handle)).toEqual([
      { tabId: 2, reason: 'task-completed' },
    ]);
    // 被唤醒后页面侧重试即可获得租约
    expect(center.requestLease(b).granted).toBe(true);
  });

  it('每 tab 500ms 合并窗：窗内重复状态变化只发一次，窗外恢复发送', () => {
    const center = new GlobalTaskCenter();
    for (let i = 1; i <= 3; i += 1) center.updateVisibility(i, true);
    const a = center.registerTask(descriptor('translate:a', 1)).taskId;
    const b = center.registerTask(descriptor('translate:b', 2)).taskId;
    const c = center.registerTask(descriptor('translate:c', 3)).taskId;

    expect(center.requestLease(a).granted).toBe(true);
    expect(center.requestLease(b).granted).toBe(false);
    expect(center.requestLease(c).granted).toBe(false);

    // 完成 a → 唤醒 tab2 与 tab3（各自首次）
    center.completeTask(a);
    expect(promptCalls(handle).sort((x, y) => x.tabId - y.tabId)).toEqual([
      { tabId: 2, reason: 'task-completed' },
      { tabId: 3, reason: 'task-completed' },
    ]);

    // b 取得租约、c 继续排队；b 完成时 tab3 的唤醒应被合并窗抑制
    expect(center.requestLease(b).granted).toBe(true);
    expect(center.requestLease(c).granted).toBe(false);
    center.completeTask(b);
    expect(promptCalls(handle).filter((c) => c.tabId === 3)).toHaveLength(1);

    // 合并窗外（600ms）再发生状态变化 → 恢复发送
    vi.advanceTimersByTime(600);
    center.deferTask(c, 'page-busy');
    expect(promptCalls(handle).filter((c) => c.tabId === 3)).toHaveLength(2);
  });

  it('可见性变化双向唤醒：隐藏页排队为 tab-hidden，变回可见后收到唤醒并可获租约', () => {
    const center = new GlobalTaskCenter();
    center.updateVisibility(4, false);
    const d = center.registerTask(descriptor('translate:d', 4)).taskId;
    expect(center.requestLease(d)).toMatchObject({ granted: false, waitReason: 'tab-hidden' });
    expect(promptCalls(handle)).toEqual([]);

    center.updateVisibility(4, true);
    expect(promptCalls(handle)).toEqual([
      { tabId: 4, reason: 'tab-visible' },
    ]);
    expect(center.requestLease(d).granted).toBe(true);
  });

  it('cancel 与 stop-all 释放槽位后唤醒等待 tab', () => {
    const center = new GlobalTaskCenter();
    center.updateVisibility(1, true);
    center.updateVisibility(2, true);
    const a = center.registerTask(descriptor('translate:a', 1)).taskId;
    const b = center.registerTask(descriptor('translate:b', 2)).taskId;
    expect(center.requestLease(a).granted).toBe(true);
    expect(center.requestLease(b).granted).toBe(false);

    center.cancelTask(a, 'manual-cancel');
    expect(promptCalls(handle)).toEqual([
      { tabId: 2, reason: 'task-canceled' },
    ]);

    const center2 = new GlobalTaskCenter();
    center2.updateVisibility(11, true);
    center2.updateVisibility(12, true);
    const x = center2.registerTask(descriptor('translate:x', 11)).taskId;
    const y = center2.registerTask(descriptor('translate:y', 12)).taskId;
    expect(center2.requestLease(x).granted).toBe(true);
    expect(center2.requestLease(y).granted).toBe(false);
    expect(center2.stopAllActiveTasks('manual-stop-all').canceled).toBeGreaterThanOrEqual(2);
    // 排队任务自身被一并取消 → 没有「仍排队」的唤醒目标；页面靠自身 request-lease 终态退出
    expect(promptCalls(handle).filter((p) => p.tabId === 12)).toEqual([]);
    expect(center2.requestLease(y)).toMatchObject({ granted: false, waitReason: 'task-canceled' });
  });

  it('F2 (S1-2 同页语义): 同页同步链排队时，同页预热任务即使组槽空闲也不得重入 source-page-heavy 槽', () => {
    // S2-2 (cycle-7) 原始场景按同页保留：同一页的 critical initialSync 排队时，
    // 该页预热任务不得在 prompt 雷群中重入组槽（否则 initialSync 被持续弹回）
    const center = new GlobalTaskCenter();
    center.updateVisibility(1, true);
    const prewarm1 = center.registerTask({
      ...descriptor('actorMarks:page', 1),
      taskId: 'task-prewarm1',
      pageUrl: 'https://javdb.com/v/samepage',
      mainId: 'samepage',
      pageInstanceId: 'page-same',
      visibilityPolicy: 'background_throttled',
      phase: 'idle',
    }).taskId;
    const sync = center.registerTask({
      ...descriptor('videoStatus:initialSync', 1),
      taskId: 'task-sync',
      pageUrl: 'https://javdb.com/v/samepage',
      mainId: 'samepage',
      pageInstanceId: 'page-same',
      phase: 'critical',
    }).taskId;
    const prewarm2 = center.registerTask({
      ...descriptor('videoFavoriteRating:init', 1),
      taskId: 'task-prewarm2',
      pageUrl: 'https://javdb.com/v/samepage',
      mainId: 'samepage',
      pageInstanceId: 'page-same',
      visibilityPolicy: 'background_throttled',
      phase: 'idle',
    }).taskId;

    // prewarm1 先占住组槽；同页同步链任务排队
    expect(center.requestLease(prewarm1).granted).toBe(true);
    expect(center.requestLease(sync)).toMatchObject({ granted: false, waitReason: 'source-page-heavy-budget' });
    // prewarm1 运行中的第二个同页预热：先被同页预热预算（page=1）挡下，到不了组检查
    expect(center.requestLease(prewarm2)).toMatchObject({ granted: false, waitReason: 'smart-background-page-budget' });

    // prewarm1 完成、组槽与同页预热预算都释放 —— F2：同页存在排队中的同步链任务，同页预热仍不得重入
    center.completeTask(prewarm1);
    expect(center.requestLease(prewarm2)).toMatchObject({ granted: false, waitReason: 'source-page-heavy-budget' });

    // 同步链任务随后获得租约（组槽让位）
    expect(center.requestLease(sync).granted).toBe(true);
  });

  it('F2 (S1-2 跨页放行): 他页同步链排队不挡本页预热 —— 解开 16 detail tab 跨页饿死环', () => {
    // r2 窗口根因：hidden 页 sync 被 higher-priority-wait/hidden 预算长期卡住（queued 8624 次观测），
    // 旧全局 F2 判定使组槽 76% 时间（124/164 快照）空闲但预热全被挡死，可见页增强 UI 延迟 90s+
    const center = new GlobalTaskCenter();
    center.updateVisibility(1, true);
    center.updateVisibility(2, true);
    center.updateVisibility(3, true);
    const prewarm1 = center.registerTask({
      ...descriptor('actorMarks:page', 1),
      taskId: 'task-prewarm1',
      pageUrl: 'https://javdb.com/v/page-a',
      mainId: 'page-a',
      pageInstanceId: 'page-a',
      visibilityPolicy: 'background_throttled',
      phase: 'idle',
    }).taskId;
    const sync = center.registerTask({
      ...descriptor('videoStatus:initialSync', 2),
      taskId: 'task-sync',
      pageInstanceId: 'page-b',
      phase: 'critical',
    }).taskId;
    const prewarm2 = center.registerTask({
      ...descriptor('videoFavoriteRating:init', 3),
      taskId: 'task-prewarm2',
      pageUrl: 'https://javdb.com/v/page-c',
      mainId: 'page-c',
      pageInstanceId: 'page-c',
      visibilityPolicy: 'background_throttled',
      phase: 'idle',
    }).taskId;

    // prewarm1（page-a）占住组槽；page-b 的 sync 与 page-c 的 prewarm2 排队
    expect(center.requestLease(prewarm1).granted).toBe(true);
    expect(center.requestLease(sync)).toMatchObject({ granted: false, waitReason: 'source-page-heavy-budget' });
    expect(center.requestLease(prewarm2)).toMatchObject({ granted: false, waitReason: 'source-page-heavy-budget' });

    // 槽位释放后：page-c 无同页 queued sync → prewarm2 放行（旧全局 F2 在此以 source-page-heavy-budget 挡死）
    center.completeTask(prewarm1);
    expect(center.requestLease(prewarm2).granted).toBe(true);

    // 组槽被 prewarm2 正常占用 → sync 按组预算排队（常规组槽竞争，非 F2）
    expect(center.requestLease(sync)).toMatchObject({ granted: false, waitReason: 'source-page-heavy-budget' });

    // prewarm2 完成后 sync 获得租约
    center.completeTask(prewarm2);
    expect(center.requestLease(sync).granted).toBe(true);
  });

  it('F2: 无排队同步链任务时，预热任务可正常重入 source-page-heavy 槽', () => {
    const center = new GlobalTaskCenter();
    center.updateVisibility(1, true);
    center.updateVisibility(3, true);
    const prewarm1 = center.registerTask({
      ...descriptor('actorMarks:page', 1),
      taskId: 'task-prewarm1',
      pageUrl: 'https://javdb.com/v/prewarm-1',
      mainId: 'prewarm-1',
      pageInstanceId: 'page-prewarm1',
      visibilityPolicy: 'background_throttled',
      phase: 'idle',
    }).taskId;
    const prewarm2 = center.registerTask({
      ...descriptor('actorMarks:page', 3),
      taskId: 'task-prewarm2',
      pageUrl: 'https://javdb.com/v/prewarm-2',
      mainId: 'prewarm-2',
      pageInstanceId: 'page-prewarm2',
      visibilityPolicy: 'background_throttled',
      phase: 'idle',
    }).taskId;

    expect(center.requestLease(prewarm1).granted).toBe(true);
    expect(center.requestLease(prewarm2).granted).toBe(false);
    center.completeTask(prewarm1);
    expect(center.requestLease(prewarm2).granted).toBe(true);
  });

  it('F2: tab-hidden 暂缓态的同步链任务不阻塞预热任务（该页不参与前台调度）', () => {
    const center = new GlobalTaskCenter();
    center.updateVisibility(1, true);
    center.updateVisibility(2, false);
    const sync = center.registerTask({
      ...descriptor('videoStatus:initialSync', 2),
      taskId: 'task-sync',
      pageInstanceId: 'page-sync',
      phase: 'critical',
    }).taskId;
    expect(center.requestLease(sync)).toMatchObject({ granted: false, waitReason: 'tab-hidden' });

    const prewarm1 = center.registerTask({
      ...descriptor('actorMarks:page', 1),
      taskId: 'task-prewarm1',
      pageUrl: 'https://javdb.com/v/prewarm-1',
      mainId: 'prewarm-1',
      pageInstanceId: 'page-prewarm1',
      visibilityPolicy: 'background_throttled',
      phase: 'idle',
    }).taskId;
    expect(center.requestLease(prewarm1).granted).toBe(true);
  });

  it('F4: prompt 雷群按排队任务相位优先 —— critical 排队 tab 先于 idle 排队 tab 被唤醒', () => {
    const center = new GlobalTaskCenter();
    center.updateVisibility(1, true);
    center.updateVisibility(2, true);
    center.updateVisibility(3, true);
    // tab1 先注册（旧实现雷群顺序 = 注册顺序，会把 tab1 排前面）
    const a = center.registerTask({
      ...descriptor('translate:a', 1),
      taskId: 'task-a',
      pageInstanceId: 'page-a',
      phase: 'idle',
    }).taskId;
    const b = center.registerTask({
      ...descriptor('translate:b', 2),
      taskId: 'task-b',
      pageInstanceId: 'page-b',
      phase: 'critical',
    }).taskId;
    const c = center.registerTask({
      ...descriptor('translate:c', 3),
      taskId: 'task-c',
      pageInstanceId: 'page-c',
      phase: 'high',
    }).taskId;

    expect(center.requestLease(c).granted).toBe(true);
    expect(center.requestLease(a).granted).toBe(false);
    expect(center.requestLease(b).granted).toBe(false);

    center.completeTask(c);
    expect(promptCalls(handle)).toEqual([
      { tabId: 2, reason: 'task-completed' },
      { tabId: 1, reason: 'task-completed' },
    ]);
  });

  it('唤醒发送失败（tab 已关闭）不抛出、不影响任务状态', () => {
    const center = new GlobalTaskCenter();
    center.updateVisibility(1, true);
    center.updateVisibility(2, true);
    const a = center.registerTask(descriptor('translate:a', 1)).taskId;
    const b = center.registerTask(descriptor('translate:b', 2)).taskId;
    expect(center.requestLease(a).granted).toBe(true);
    expect(center.requestLease(b).granted).toBe(false);

    center.sendTabPrompt = () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    };
    expect(() => center.completeTask(a)).not.toThrow();
    // 状态机正常：a 已完成，b 仍可重试获租
    expect(center.requestLease(b).granted).toBe(true);
  });
  it('S2-2 r3: 同步链任务完成走 100ms 微窗 —— 距上次 prompt 150ms 仍发送（500ms 窗不再吞槽位释放）', () => {
    const center = new GlobalTaskCenter();
    center.updateVisibility(1, true);
    center.updateVisibility(2, true);
    center.updateVisibility(3, true);
    const p = center.registerTask(descriptor('translate:p', 1)).taskId;
    const w = center.registerTask(descriptor('translate:w', 2)).taskId;
    const s = center.registerTask({
      ...descriptor('videoStatus:fullRefresh', 3),
      pageUrl: 'https://javdb.com/v/fullrefresh-3',
      pageInstanceId: 'page-fullrefresh-3',
      phase: 'critical',
    }).taskId;

    expect(center.requestLease(p).granted).toBe(true);
    expect(center.requestLease(s).granted).toBe(true);
    expect(center.requestLease(w)).toMatchObject({ granted: false });

    // T0: 非同步链任务完成 -> tab2 首次 prompt
    center.completeTask(p);
    expect(promptCalls(handle).filter((c) => c.tabId === 2)).toHaveLength(1);

    // T0+150: 同步链主任务完成（r3 场景: 距上次 prompt 不足 500ms 的槽位释放）
    vi.advanceTimersByTime(150);
    center.completeTask(s);
    // 旧 500ms 合并窗会吞掉这条 prompt 令槽位空转; 100ms 微窗豁免下正常送达
    expect(promptCalls(handle).filter((c) => c.tabId === 2)).toHaveLength(2);
  });

  it('S2-2 r3: 非同步链任务完成仍走 500ms 合并窗 —— 距上次 prompt 150ms 被抑制', () => {
    const center = new GlobalTaskCenter();
    center.updateVisibility(1, true);
    center.updateVisibility(2, true);
    center.updateVisibility(3, true);
    const p = center.registerTask(descriptor('translate:p', 1)).taskId;
    const w = center.registerTask(descriptor('translate:w', 2)).taskId;
    const q = center.registerTask({
      ...descriptor('actorMarks:page', 3),
      taskId: 'task-actor-3',
      pageUrl: 'https://javdb.com/v/actor-3',
      mainId: 'actor-3',
      pageInstanceId: 'page-actor-3',
      phase: 'idle',
    }).taskId;

    expect(center.requestLease(p).granted).toBe(true);
    expect(center.requestLease(q).granted).toBe(true);
    expect(center.requestLease(w)).toMatchObject({ granted: false });

    center.completeTask(p);
    expect(promptCalls(handle).filter((c) => c.tabId === 2)).toHaveLength(1);

    vi.advanceTimersByTime(150);
    center.completeTask(q);
    // 非同步链释放仍受 500ms 合并窗约束: 150ms < 500ms -> 抑制
    expect(promptCalls(handle).filter((c) => c.tabId === 2)).toHaveLength(1);
  });

  it('S2-2 r3: 两次同步链完成间隔 50ms —— 100ms 微窗限流, 同 tab 只发 1 条 prompt', () => {
    const center = new GlobalTaskCenter();
    center.updateVisibility(1, true);
    center.updateVisibility(2, true);
    center.updateVisibility(3, true);
    const s1 = center.registerTask({
      ...descriptor('videoStatus:fullRefresh', 1),
      pageUrl: 'https://javdb.com/v/fullrefresh-1',
      pageInstanceId: 'page-fullrefresh-1',
      phase: 'critical',
    }).taskId;
    const w = center.registerTask({
      ...descriptor('actorMarks:page', 2),
      taskId: 'task-actor-2',
      pageUrl: 'https://javdb.com/v/actor-2',
      mainId: 'actor-2',
      pageInstanceId: 'page-actor-2',
      phase: 'idle',
    }).taskId;
    const s2 = center.registerTask({
      ...descriptor('videoStatus:fullRefresh', 3),
      taskId: 'task-fullrefresh-3',
      pageUrl: 'https://javdb.com/v/fullrefresh-3',
      mainId: 'fullrefresh-3',
      pageInstanceId: 'page-fullrefresh-3',
      phase: 'critical',
    }).taskId;

    expect(center.requestLease(s1).granted).toBe(true);
    expect(center.requestLease(w)).toMatchObject({ granted: false, waitReason: 'source-page-heavy-budget' });

    center.completeTask(s1);
    expect(promptCalls(handle).filter((c) => c.tabId === 2)).toHaveLength(1);

    // 组槽释放, 下一个同步链任务重入
    expect(center.requestLease(s2).granted).toBe(true);
    vi.advanceTimersByTime(50);
    center.completeTask(s2);
    // 50ms < 100ms 微窗 -> 同 tab 不重复轰炸
    expect(promptCalls(handle).filter((c) => c.tabId === 2)).toHaveLength(1);
  });


  it('S1-14 A3: 槽位释放同时唤醒 visible 与 hidden 排队 tab（hidden 退避任务由 prompt 提前唤醒）', () => {
    const center = new GlobalTaskCenter();
    center.updateVisibility(1, true);
    center.updateVisibility(2, true);
    center.updateVisibility(3, false);
    const a = center.registerTask(descriptor('translate:a', 1)).taskId;
    const b = center.registerTask(descriptor('translate:b', 2)).taskId;
    // A3 主目标：后台可租约策略（background_throttled）的 hidden tab —— bucket 限额按
    // 可见性分域计数，hidden 域 limit=min(4, base)=1：c1 占用 hidden 槽位，c2 被拒入 queued
    const throttled = { visibilityPolicy: 'background_throttled' as const };
    const c1 = center.registerTask({ ...descriptor('translate:c1', 3), ...throttled }).taskId;
    const c2 = center.registerTask({ ...descriptor('translate:c2', 3), ...throttled }).taskId;

    expect(center.requestLease(a).granted).toBe(true);
    expect(center.requestLease(b)).toMatchObject({ granted: false, waitReason: 'bucket:translate' });
    expect(center.requestLease(c1).granted).toBe(true);
    // hidden 域的拒绝 reason 恒为 tab-hidden（分域计数下的兜底语义），只断言拒绝入 queued
    expect(center.requestLease(c2)).toMatchObject({ granted: false });

    // 释放 visible 槽位 → visible tab2 与 hidden tab3 都收到唤醒（推翻 cycle-8 的 hidden skip）；
    // fairness 同相位按最老排队任务排序（b 注册早于 c2）→ tab2 先、tab3 后
    center.completeTask(a);
    expect(promptCalls(handle)).toEqual([
      { tabId: 2, reason: 'task-completed' },
      { tabId: 3, reason: 'task-completed' },
    ]);

    // tab3 回前台 → 越过 500ms 合并窗后仍收到既有 tab-visible 唤醒（A3 不破坏该路径）；
    // 可见性变化影响全体排队优先级 → 仍持 queued 的 tab2（b）同样收到唤醒
    vi.advanceTimersByTime(600);
    center.updateVisibility(3, true);
    expect(promptCalls(handle).slice(2)).toEqual([
      { tabId: 2, reason: 'tab-visible' },
      { tabId: 3, reason: 'tab-visible' },
    ]);

    // 释放 c1 持有的槽位 → 排队中的 tab2/tab3 都收到 task-completed 唤醒
    // （tab3 已 visible，其 background_throttled 任务 c2 现在真实可竞争 visible 槽位）
    vi.advanceTimersByTime(600);
    const before = promptCalls(handle).length;
    center.completeTask(c1);
    expect(promptCalls(handle).slice(before).filter((p) => p.tabId === 3 && p.reason === 'task-completed')).toEqual([
      { tabId: 3, reason: 'task-completed' },
    ]);
  });

});
