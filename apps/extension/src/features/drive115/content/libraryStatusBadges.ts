/**
 * @file libraryStatusBadges.ts
 * @description 115 本地媒体库已存在状态角标
 * @module features/drive115
 *
 * 性能说明：列表页单页约 30 张卡片，若每卡都全量读取 drive115_library_state
 * 并重建全部条目，单页会产生 30 次全量 storage 读 + 30 次 O(N) 规范化。
 * 这里在 content 侧做模块级单飞缓存（同页共享一次读），并监听
 * chrome.storage.onChanged：媒体库索引变化时失效缓存、重查已渲染卡片的角标。
 * 缓存只覆盖 content 侧展示路径，SW 侧 handlers 的读取语义不变。
 */

import { STORAGE_KEYS } from '../../../utils/config';
import {
  loadDrive115LibraryState,
  lookupByCode,
  type Drive115LibraryIndexState,
} from '../mediaLibrary';

export function isDrive115LibraryStatusEnabled(settings: Record<string, unknown>): boolean {
  const libraryMatchStatus = settings.libraryMatchStatus as { enabled?: boolean; sources?: { drive115?: boolean } } | undefined;
  const listEnhancement = settings.listEnhancement as { libraryMatchStatus?: { enabled?: boolean; sources?: { drive115?: boolean } }; drive115LibraryStatus?: { enabled?: boolean } } | undefined;
  const legacyLibraryMatchStatus = listEnhancement?.libraryMatchStatus;
  const effectiveLibraryMatchStatus = libraryMatchStatus ?? legacyLibraryMatchStatus;

  return (effectiveLibraryMatchStatus?.enabled === true
    && effectiveLibraryMatchStatus.sources?.drive115 !== false)
    || listEnhancement?.drive115LibraryStatus?.enabled === true;
}

export function matchesDrive115LibraryCode(code: string, matchedCodes: readonly string[]): boolean {
  const target = String(code).trim().toUpperCase();
  return Boolean(target) && matchedCodes.some((matchedCode) => String(matchedCode).trim().toUpperCase() === target);
}

// ---------------------------------------------------------------------------
// 模块级索引缓存（单飞）：同 tab 内多次渲染共享同一次 storage 读
// ---------------------------------------------------------------------------

let cachedState: Drive115LibraryIndexState | null = null;
let pendingState: Promise<Drive115LibraryIndexState> | null = null;

function getLibraryState(): Promise<Drive115LibraryIndexState> {
  if (cachedState) return Promise.resolve(cachedState);
  if (!pendingState) {
    pendingState = loadDrive115LibraryState()
      .then((state) => {
        cachedState = state;
        pendingState = null;
        return state;
      })
      .catch((error) => {
        pendingState = null;
        throw error;
      });
  }
  return pendingState;
}

// ---------------------------------------------------------------------------
// 已渲染卡片注册表：storage 变化时逐卡重查角标，无需刷新页面
// ---------------------------------------------------------------------------

interface RenderedCardRecord {
  videoId: string;
  settings: Record<string, unknown>;
}

const renderedCards = new Map<HTMLElement, RenderedCardRecord>();
let refreshInFlight: Promise<void> | null = null;

function clearBadge(container: HTMLElement): void {
  container.querySelectorAll('.drive115-library-status-tag').forEach((tag) => tag.remove());
}

function renderBadgeInto(
  container: HTMLElement,
  videoId: string,
  settings: Record<string, unknown>,
  state: Drive115LibraryIndexState,
): void {
  clearBadge(container);
  if (!isDrive115LibraryStatusEnabled(settings)) return;

  const matches = lookupByCode(state, videoId);
  if (!matchesDrive115LibraryCode(videoId, matches.map((entry) => entry.code))) return;

  const badge = document.createElement('span');
  badge.className = 'tag is-info is-light drive115-library-status-tag';
  badge.textContent = '115 已有';
  badge.title = `115 媒体库已匹配 ${matches.length} 个文件`;
  container.appendChild(badge);
}

/** 清理已从 DOM 移除的容器注册，避免注册表随翻页无限增长 */
function pruneDisconnectedCards(): void {
  for (const container of renderedCards.keys()) {
    if (!container.isConnected) renderedCards.delete(container);
  }
}

/** storage 变化后刷新页面上已渲染的角标；并发变化合并为一次刷新 */
function refreshRenderedBadges(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      pruneDisconnectedCards();
      if (!renderedCards.size) return;
      const state = await getLibraryState();
      for (const [container, record] of [...renderedCards]) {
        if (!container.isConnected) {
          renderedCards.delete(container);
          continue;
        }
        renderBadgeInto(container, record.videoId, record.settings, state);
      }
    } catch (error) {
      // 刷新失败保留现有角标，等待下一次变化再试
      console.warn('[115LibraryBadge] 媒体库状态变化后刷新角标失败:', error);
    }
  })();
  void refreshInFlight.finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// ---------------------------------------------------------------------------
// storage 变化监听：仅关注本地媒体库状态 key
// ---------------------------------------------------------------------------

let storageListenerAttached = false;

function attachStorageListener(): void {
  if (storageListenerAttached) return;
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
  storageListenerAttached = true;

  const handler = (changes: { [key: string]: chrome.storage.StorageChange | undefined }, areaName: string): void => {
    if (areaName !== 'local') return;
    if (!changes[STORAGE_KEYS.DRIVE115_LIBRARY_STATE]) return;
    // 失效缓存：后续读取（含本次刷新）都会拿到最新状态
    cachedState = null;
    pendingState = null;
    void refreshRenderedBadges();
  };

  try {
    chrome.storage.onChanged.addListener(handler);
  } catch {
    storageListenerAttached = false;
  }
}

export async function renderDrive115LibraryStatusBadge(
  container: HTMLElement,
  videoId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  if (!isDrive115LibraryStatusEnabled(settings)) {
    clearBadge(container);
    return;
  }

  attachStorageListener();
  pruneDisconnectedCards();
  renderedCards.set(container, { videoId, settings });

  try {
    const state = await getLibraryState();
    // await 期间卡片可能已被翻页移除
    if (!container.isConnected) {
      renderedCards.delete(container);
      return;
    }
    renderBadgeInto(container, videoId, settings, state);
  } catch (error) {
    renderedCards.delete(container);
    throw error;
  }
}
