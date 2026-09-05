import { describe, expect, it } from 'vitest';
import { isActorEnhancementEnabled } from './actorEnhancementGate';

describe('isActorEnhancementEnabled', () => {
    it('lets userExperience.enableActorEnhancement win when explicitly present', () => {
        expect(isActorEnhancementEnabled({ userExperience: { enableActorEnhancement: false } })).toBe(false);
        expect(
            isActorEnhancementEnabled({
                userExperience: { enableActorEnhancement: false },
                actorEnhancement: { enabled: true },
            }),
        ).toBe(false);
        expect(isActorEnhancementEnabled({ userExperience: { enableActorEnhancement: true } })).toBe(true);
        expect(
            isActorEnhancementEnabled({
                userExperience: { enableActorEnhancement: true },
                actorEnhancement: { enabled: false },
            }),
        ).toBe(true);
    });

    it('falls back to actorEnhancement.enabled !== false when the ux field is absent', () => {
        expect(isActorEnhancementEnabled({})).toBe(true);
        expect(isActorEnhancementEnabled({ actorEnhancement: {} })).toBe(true);
        expect(isActorEnhancementEnabled({ actorEnhancement: { enabled: false } })).toBe(false);
        expect(isActorEnhancementEnabled({ userExperience: {} })).toBe(true);
        expect(isActorEnhancementEnabled({ userExperience: null, actorEnhancement: { enabled: false } })).toBe(false);
    });
});
