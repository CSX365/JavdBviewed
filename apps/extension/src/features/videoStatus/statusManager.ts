/**
 * @file statusManager.ts
 * @description statusManager
 * @module features/videoStatus
 */
// src/features/videoStatus/statusManager.ts

import { VIDEO_STATUS } from '../../utils/config';
import { STATE, log, currentFaviconState, currentTitleStatus, setCurrentFaviconState, setCurrentTitleStatus, suspendEarlyFaviconSync } from '../contentState';
import { extractVideoIdFromPage } from '../../platform/browser';
import { setFavicon } from '../../platform/browser/domUtils';

// 缓存视频ID，避免重复提取
let cachedVideoId: string | null = null;
let lastPathname: string = '';

// --- Status Check and Visual Feedback ---

export function checkAndUpdateVideoStatus(): void {
    // 只在视频详情页执行
    if (!window.location.pathname.startsWith('/v/')) {
        return;
    }

    // 如果路径改变了，清除缓存
    if (window.location.pathname !== lastPathname) {
        cachedVideoId = null;
        lastPathname = window.location.pathname;
    }

    // 使用缓存的视频ID，避免重复提取
    if (!cachedVideoId) {
        cachedVideoId = extractVideoIdFromPage();
        if (!cachedVideoId) {
            return;
        }
    }

    const videoId = cachedVideoId;

    const record = STATE.records[videoId];
    const isRecorded = !!record;

    // 初始状态同步完成前，跳过 favicon 的早期回显，避免在最终确认前提前切换图标
    if (!suspendEarlyFaviconSync) {
        updateFaviconForStatus(isRecorded ? record.status : null);
    }

    // 更新页面标题（只在需要时）
    if (isRecorded) {
        updatePageTitleWithStatus(videoId, record.status);
    } else {
        // 如果没有记录，确保标题没有状态标记
        if (currentTitleStatus !== null) {
            const currentTitle = document.title;
            if (currentTitle.includes('[已观看]') || currentTitle.includes('[我想看]') || currentTitle.includes('[已浏览]')) {
                const cleanTitle = currentTitle.replace(/ \[.*?\]$/, '');
                if (cleanTitle !== currentTitle) {
                    log(`Removing status from title: "${currentTitle}" -> "${cleanTitle}"`);
                    document.title = cleanTitle;
                    setCurrentTitleStatus(null);
                }
            }
        }
    }
}

export function updateFaviconForStatus(status: string | null): void {
    // 计算目标状态键：original / viewed / want / browsed
    let targetState: 'original' | 'viewed' | 'want' | 'browsed';
    if (!status) {
        targetState = 'original';
    } else if (status === VIDEO_STATUS.UNTRACKED) {
        targetState = 'original';
    } else if (status === VIDEO_STATUS.VIEWED) {
        targetState = 'viewed';
    } else if (status === VIDEO_STATUS.WANT) {
        targetState = 'want';
    } else {
        targetState = 'browsed';
    }

    // 如果状态没有改变，跳过设置
    if (currentFaviconState === targetState) {
        return;
    }

    if (targetState === 'original') {
        // 恢复原始favicon
        if (STATE.originalFaviconUrl) {
            log(`Restoring original favicon: ${STATE.originalFaviconUrl}`);
            setFavicon(STATE.originalFaviconUrl);
            setCurrentFaviconState('original');
        } else {
            log('No original favicon URL to restore');
        }
        return;
    }

    // 基于状态选择不同图标
    const iconMap: Record<'viewed' | 'want' | 'browsed', string> = {
        viewed: 'assets/switch-viewed.png', // 绿色 - 已观看
        want: 'assets/switch-want.png',     // 蓝色 - 想看
        browsed: 'assets/switch-browsed.png'// 黄色 - 已浏览
    };

    const url = chrome.runtime.getURL(iconMap[targetState]);
    log(`Setting favicon for status '${targetState}': ${url}`);
    setFavicon(url);
    setCurrentFaviconState(targetState);
}

export function updatePageTitleWithStatus(_videoId: string, status: string): void {
    // 如果状态没有改变，跳过设置
    if (currentTitleStatus === status) {
        return;
    }

    const originalTitle = document.title.replace(/ \[.*?\]$/, ''); // 移除之前的状态标记
    let statusText = '';

    switch (status) {
        case VIDEO_STATUS.VIEWED:
            statusText = '[已观看]';
            break;
        case VIDEO_STATUS.WANT:
            statusText = '[我想看]';
            break;
        case VIDEO_STATUS.BROWSED:
            statusText = '[已浏览]';
            break;
        case VIDEO_STATUS.UNTRACKED:
            statusText = '';
            break;
    }

    if (statusText) {
        const newTitle = `${originalTitle} ${statusText}`;
        log(`Updating page title from "${document.title}" to "${newTitle}"`);
        document.title = newTitle;
        setCurrentTitleStatus(status);

        // 确保标题真的被设置了
        setTimeout(() => {
            if (document.title !== newTitle) {
                log(`Title not set correctly, retrying...`);
                document.title = newTitle;
            }
        }, 100);
    }
}

/**
 * 判断详情页状态轮询的签名是否处于"可停止的稳定态"。
 *
 * 背景：轮询停止条件为"签名连续 3 次稳定且签名不含 'null'"。但当影片记录为
 * untracked（或页面标题无状态标记）时，currentTitleStatus 恒为 null，签名会
 * 永远包含 'null'，导致 interval 永不 clearInterval。当当前视频已有记录
 * （initialSync 已提交）时，记录查询已是权威结果，此时签名中的 'null'
 * 属于"最终无标记"的稳定状态，同样允许在连续稳定后停止轮询。
 */
export function isStatusPollingSignatureStoppable(signature: string, hasSettledRecord: boolean): boolean {
    return signature.includes('null') === false || hasSettledRecord;
}
