import { describe, expect, it } from 'vitest';
import {
    dateToDosDateTime,
    dosDateTimeToDate,
    DETERMINISTIC_DOS_DATE,
    DETERMINISTIC_DOS_TIME,
    MAX_DOS_DATE,
    MAX_DOS_TIME,
} from '../../src/core/zip-dos-time.ts';

// vitest runs in TZ=UTC (vitest.config.ts); the zone-dependent cases live in
// zip-dos-time-tz.test.ts, which flips process.env.TZ itself.

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
        const { dosDate, dosTime, clamped } = dateToDosDateTime(original);
        expect(clamped).toBeNull();
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

    it('clamps a pre-1980 date to the epoch as a whole — not the year alone', () => {
        // 1.0.0 clamped only the year: 1975-07-15 encoded as 1980-07-15.
        const dos = dateToDosDateTime(new Date(1975, 6, 15, 12, 0, 0));
        expect(dos).toEqual({ dosDate: DETERMINISTIC_DOS_DATE, dosTime: DETERMINISTIC_DOS_TIME, clamped: 'before-1980' });
        expect(dateToDosDateTime(new Date(1970, 0, 1)).clamped).toBe('before-1980');
    });

    it('clamps a post-2107 date to the last representable instant', () => {
        const dos = dateToDosDateTime(new Date(2200, 0, 1));
        expect(dos).toEqual({ dosDate: MAX_DOS_DATE, dosTime: MAX_DOS_TIME, clamped: 'after-2107' });
        const decoded = dosDateTimeToDate(MAX_DOS_DATE, MAX_DOS_TIME);
        expect([decoded.getFullYear(), decoded.getMonth(), decoded.getDate(), decoded.getHours(), decoded.getMinutes(), decoded.getSeconds()])
            .toEqual([2107, 11, 31, 23, 59, 58]);
    });

    it('maps an invalid Date to the epoch instead of garbage fields', () => {
        // 1.0.0 let NaN through the bit operations: year 1980, month 0, day 0.
        const dos = dateToDosDateTime(new Date(NaN));
        expect(dos).toEqual({ dosDate: DETERMINISTIC_DOS_DATE, dosTime: DETERMINISTIC_DOS_TIME, clamped: 'invalid' });
    });

    it("mode 'utc' reads the UTC fields in both directions", () => {
        const instant = new Date('2020-06-01T12:34:56Z');
        const dos = dateToDosDateTime(instant, 'utc');
        expect(dos.dosTime >>> 11).toBe(12);
        expect((dos.dosTime >>> 5) & 0x3f).toBe(34);
        const back = dosDateTimeToDate(dos.dosDate, dos.dosTime, 'utc');
        expect(back.toISOString()).toBe('2020-06-01T12:34:56.000Z');
    });

    it('the default mode is local (the 1.0.0 behaviour, byte-identical in UTC)', () => {
        const instant = new Date('2020-06-01T12:34:56Z');
        expect(dateToDosDateTime(instant)).toEqual(dateToDosDateTime(instant, 'local'));
        // Under TZ=UTC local and utc agree — the tz suite proves they differ elsewhere.
        expect(dateToDosDateTime(instant, 'local').dosTime).toBe(dateToDosDateTime(instant, 'utc').dosTime);
    });
});
