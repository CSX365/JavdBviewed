import { describe, expect, it } from 'vitest';
import { isStatusPollingSignatureStoppable } from './statusManager';

describe('isStatusPollingSignatureStoppable', () => {
    it('treats a null-free signature as stoppable', () => {
        expect(isStatusPollingSignatureStoppable('title|favicon|viewed', false)).toBe(true);
    });

    it('treats a null-containing signature as unsettled while no record exists', () => {
        expect(isStatusPollingSignatureStoppable('title|null|viewed', false)).toBe(false);
        expect(isStatusPollingSignatureStoppable('title|favicon|null', false)).toBe(false);
    });

    it('treats a null-containing signature as stoppable once the current video has a settled record', () => {
        expect(isStatusPollingSignatureStoppable('title|null|viewed', true)).toBe(true);
        expect(isStatusPollingSignatureStoppable('title|null|null', true)).toBe(true);
    });
});
