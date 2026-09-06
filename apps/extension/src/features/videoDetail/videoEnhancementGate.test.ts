import { describe, expect, it } from 'vitest';
import {
    VIDEO_ENHANCEMENT_SUB_SWITCHES,
    isVideoEnhancementMainOn,
    isVideoEnhancementSubOn,
} from './videoEnhancementGate';

describe('isVideoEnhancementMainOn', () => {
    it('undefined/null/无 videoEnhancement 节 → 默认开', () => {
        expect(isVideoEnhancementMainOn(undefined)).toBe(true);
        expect(isVideoEnhancementMainOn(null)).toBe(true);
        expect(isVideoEnhancementMainOn({})).toBe(true);
        expect(isVideoEnhancementMainOn({ videoEnhancement: {} })).toBe(true);
        expect(isVideoEnhancementMainOn({ videoEnhancement: null })).toBe(true);
    });

    it('enabled 显式值以其为准', () => {
        expect(isVideoEnhancementMainOn({ videoEnhancement: { enabled: true } })).toBe(true);
        expect(isVideoEnhancementMainOn({ videoEnhancement: { enabled: false } })).toBe(false);
    });
});

describe('isVideoEnhancementSubOn', () => {
    it('onByDefault 子开关：默认开，显式 false 关', () => {
        expect(isVideoEnhancementSubOn(undefined, 'enableRelatedLists')).toBe(true);
        expect(isVideoEnhancementSubOn({ videoEnhancement: { enableRelatedLists: true } }, 'enableRelatedLists')).toBe(true);
        expect(isVideoEnhancementSubOn({ videoEnhancement: { enableRelatedLists: false } }, 'enableRelatedLists')).toBe(false);
    });

    it('offByDefault 子开关：默认关，显式 true 开', () => {
        expect(isVideoEnhancementSubOn(undefined, 'enableActorRemarks')).toBe(false);
        expect(isVideoEnhancementSubOn({ videoEnhancement: { enableActorRemarks: true } }, 'enableActorRemarks')).toBe(true);
        expect(isVideoEnhancementSubOn({ videoEnhancement: { enableActorRemarks: false } }, 'enableActorRemarks')).toBe(false);
    });

    it('主开关关闭时所有子开关（含显式开启的）均不生效', () => {
        const mainOff = {
            videoEnhancement: {
                enabled: false,
                enableRelatedLists: true,
                enableActorRemarks: true,
                enableExternalEntryPanel: true,
                enableExternalSearch: true,
            },
        };
        for (const key of Object.keys(VIDEO_ENHANCEMENT_SUB_SWITCHES)) {
            expect(isVideoEnhancementSubOn(mainOff, key as never)).toBe(false);
        }
    });

    it('外部入口面板子开关需面板主开关同时开启', () => {
        // 面板默认开 → 子开关默认开
        expect(isVideoEnhancementSubOn(undefined, 'enableExternalSearch')).toBe(true);
        expect(isVideoEnhancementSubOn(undefined, 'enableOnlineAvailability')).toBe(true);
        expect(isVideoEnhancementSubOn(undefined, 'enableSubtitleSearch')).toBe(true);
        // 面板关 → 子开关即使未显式关也不生效
        const panelOff = { videoEnhancement: { enableExternalEntryPanel: false } };
        expect(isVideoEnhancementSubOn(panelOff, 'enableExternalSearch')).toBe(false);
        expect(isVideoEnhancementSubOn(panelOff, 'enableOnlineAvailability')).toBe(false);
        expect(isVideoEnhancementSubOn(panelOff, 'enableSubtitleSearch')).toBe(false);
        // 面板开 + 单个子开关显式关 → 仅该子开关不生效
        const searchOff = { videoEnhancement: { enableExternalEntryPanel: true, enableExternalSearch: false } };
        expect(isVideoEnhancementSubOn(searchOff, 'enableExternalSearch')).toBe(false);
        expect(isVideoEnhancementSubOn(searchOff, 'enableOnlineAvailability')).toBe(true);
    });
});
