import { describe, expect, it } from 'vitest';
import { dateToDosDateTime, dosDateTimeToDate } from '../../src/core/zip-dos-time.ts';

describe('zip-dos-time', () => {
    it('decodes the DOS epoch (1980-01-01 00:00:00)', () => {
        const date = dosDateTimeToDate(0x0021, 0x0000);
        expect(date.getFullYear()).toBe(1980);
        expect(date.getMonth()).toBe(0);
        expect(date.getDate()).toBe(1);
        expect(date.getHours()).toBe(0);
    });

    it('round-trips a date (2-second resolution)', () => {
        const original = new Date(2026, 7, 31, 14, 30, 42);
        const { dosDate, dosTime } = dateToDosDateTime(original);
        const decoded = dosDateTimeToDate(dosDate, dosTime);
        expect(decoded.getFullYear()).toBe(2026);
        expect(decoded.getMonth()).toBe(7);
        expect(decoded.getDate()).toBe(31);
        expect(decoded.getHours()).toBe(14);
        expect(decoded.getMinutes()).toBe(30);
        expect(decoded.getSeconds()).toBe(42); // even second survives exactly
    });

    it('floors odd seconds to even on encode', () => {
        const { dosTime } = dateToDosDateTime(new Date(2026, 0, 1, 0, 0, 43));
        expect((dosTime & 0x1f) * 2).toBe(42);
    });

    it('clamps day/month zero rather than rolling the month over', () => {
        const date = dosDateTimeToDate(0x0000 | (0 << 5) | 0, 0); // day 0, month 0
        expect(date.getFullYear()).toBe(1980);
        expect(date.getMonth()).toBe(0);
        expect(date.getDate()).toBe(1);
    });

    it('clamps pre-1980 dates on encode', () => {
        const { dosDate } = dateToDosDateTime(new Date(1970, 0, 1));
        expect((dosDate >>> 9) + 1980).toBe(1980);
    });
});
