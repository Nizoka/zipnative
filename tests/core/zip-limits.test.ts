import { describe, expect, it } from 'vitest';
import { ZipLimitError } from 'zipnative';
import { DEFAULT_ZIP_LIMITS, enforceLimit, resolveLimits } from '../../src/core/zip-limits.ts';

describe('zip-limits', () => {
    it('returns defaults when no overrides are given', () => {
        expect(resolveLimits()).toBe(DEFAULT_ZIP_LIMITS);
    });

    it('merges overrides over defaults', () => {
        const limits = resolveLimits({ maxEntries: 5 });
        expect(limits.maxEntries).toBe(5);
        expect(limits.maxNameBytes).toBe(DEFAULT_ZIP_LIMITS.maxNameBytes);
    });

    it('accepts Infinity as an explicit opt-out', () => {
        expect(resolveLimits({ maxEntryUncompressedSize: Infinity }).maxEntryUncompressedSize).toBe(Infinity);
    });

    it('rejects unknown limit keys (validate early)', () => {
        expect(() => resolveLimits({ maxFoo: 1 } as never)).toThrow(ZipLimitError);
    });

    it('rejects non-positive and NaN values', () => {
        expect(() => resolveLimits({ maxEntries: 0 })).toThrow(ZipLimitError);
        expect(() => resolveLimits({ maxEntries: -1 })).toThrow(ZipLimitError);
        expect(() => resolveLimits({ maxEntries: NaN })).toThrow(ZipLimitError);
    });

    it('enforceLimit throws a ZipLimitError carrying limit/configured/observed', () => {
        const limits = resolveLimits({ maxEntries: 10 });
        try {
            enforceLimit(limits, 'maxEntries', 11, 'entry count');
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ZipLimitError);
            const limitError = err as ZipLimitError;
            expect(limitError.limit).toBe('maxEntries');
            expect(limitError.configured).toBe(10);
            expect(limitError.observed).toBe(11);
            expect(limitError.message).toContain('limits.maxEntries');
        }
    });

    it('enforceLimit passes at exactly the bound', () => {
        expect(() => enforceLimit(DEFAULT_ZIP_LIMITS, 'maxEntries', DEFAULT_ZIP_LIMITS.maxEntries, 'entry count')).not.toThrow();
    });
});
