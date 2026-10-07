import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createZip, createZipModifier, extractZip, iterateZipEntries, openZip, type ZipDiagnostic } from 'zipnative';
import { dateToDosDateTime } from '../../src/core/zip-dos-time.ts';

/**
 * Issue #9 — one `Date` encoded in three time zones. Node honours a
 * runtime change of `process.env.TZ`; this file runs in its own fork
 * (vitest pool: forks) so flipping the zone leaks into no other suite.
 */

const INSTANT = new Date('2020-06-01T12:00:00Z');
const ZONES = ['UTC', 'Europe/Paris', 'Asia/Tokyo'] as const;
const te = new TextEncoder();
const originalTz = process.env.TZ;

function withZone<T>(zone: string, fn: () => T): T {
    process.env.TZ = zone;
    try {
        return fn();
    } finally {
        process.env.TZ = originalTz;
    }
}

async function withZoneAsync<T>(zone: string, fn: () => Promise<T>): Promise<T> {
    process.env.TZ = zone;
    try {
        return await fn();
    } finally {
        process.env.TZ = originalTz;
    }
}

async function* streamOf(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
    yield bytes;
}

describe('dosTimeMode across time zones (#9)', () => {
    beforeAll(() => { process.env.TZ = originalTz; });
    afterAll(() => { process.env.TZ = originalTz; });

    it("'local' (the default) encodes the host wall-clock: three zones, three dosTime values", () => {
        const times = ZONES.map((zone) => withZone(zone, () => dateToDosDateTime(INSTANT, 'local').dosTime));
        expect(times[0]).toBe(12 << 11);  // UTC noon
        expect(times[1]).toBe(14 << 11);  // CEST
        expect(times[2]).toBe(21 << 11);  // JST
        expect(new Set(times).size).toBe(3);
    });

    it("'utc' encodes the same fields in every zone", () => {
        const times = ZONES.map((zone) => withZone(zone, () => dateToDosDateTime(INSTANT, 'utc').dosTime));
        expect(times).toEqual([12 << 11, 12 << 11, 12 << 11]);
    });

    it('createZip({ dosTimeMode: "utc" }) is byte-identical across zones; the default is not', () => {
        const build = (mode: 'utc' | 'local'): Uint8Array => {
            const zip = createZip({ dosTimeMode: mode, compression: { deterministic: true } });
            zip.add('a.txt', te.encode('hello'), { date: INSTANT });
            return zip.toBytes();
        };
        const utc = ZONES.map((zone) => withZone(zone, () => build('utc')));
        expect(utc[1]).toEqual(utc[0]);
        expect(utc[2]).toEqual(utc[0]);
        const local = ZONES.map((zone) => withZone(zone, () => build('local')));
        expect(local[1]).not.toEqual(local[0]);
        // And the reader decodes the instant back with the same mode.
        const entry = [...openZip(utc[2], { dosTimeMode: 'utc' }).entries()][0];
        expect(entry.lastModified.toISOString()).toBe(INSTANT.toISOString());
    });

    it('openZip, iterateZipEntries and extractZip decode lastModified with the mode', async () => {
        const zip = createZip({ dosTimeMode: 'utc' });
        zip.add('a.txt', te.encode('x'), { date: INSTANT });
        const bytes = zip.toBytes();
        await withZoneAsync('Asia/Tokyo', async () => {
            expect([...openZip(bytes, { dosTimeMode: 'utc' }).entries()][0].lastModified.toISOString()).toBe(INSTANT.toISOString());
            // Local decoding in Tokyo of UTC-written fields: shifted by nine hours — the 1.0.0 behaviour, kept by default.
            expect([...openZip(bytes).entries()][0].lastModified.getTime()).toBe(INSTANT.getTime() - 9 * 3600 * 1000);
            for await (const entry of iterateZipEntries(streamOf(bytes), { dosTimeMode: 'utc' })) {
                expect(entry.header.lastModified.toISOString()).toBe(INSTANT.toISOString());
                await entry.skip();
            }
            expect(extractZip(bytes, { dosTimeMode: 'utc' })[0].entry.lastModified.toISOString()).toBe(INSTANT.toISOString());
        });
    });

    it('the modifier honours dosTimeMode for written entries', () => {
        const zip = createZip();
        zip.add('a.txt', te.encode('x'));
        const base = openZip(zip.toBytes());
        const saved = ZONES.map((zone) => withZone(zone, () => {
            const mod = createZipModifier(base, { dosTimeMode: 'utc' });
            mod.addEntry('b.txt', te.encode('y'), { date: INSTANT });
            return mod.save();
        }));
        expect(saved[1]).toEqual(saved[0]);
        expect(saved[2]).toEqual(saved[0]);
    });

    it('a clamped or invalid Date is diagnosed, never refused, and writes the epoch (strict mode throws)', () => {
        const seen: ZipDiagnostic[] = [];
        const zip = createZip({ defaultDate: new Date(NaN), onDiagnostic: (d) => seen.push(d) });
        zip.add('old.txt', te.encode('x'), { date: new Date(1975, 6, 15) });
        zip.add('future.txt', te.encode('y'), { date: new Date(2200, 0, 1) });
        const bytes = zip.toBytes();
        expect(seen.map((d) => d.code)).toEqual(['ZIP_TIMESTAMP_CLAMPED', 'ZIP_TIMESTAMP_CLAMPED', 'ZIP_TIMESTAMP_CLAMPED']);
        expect(seen[0].message).toContain('defaultDate');
        expect(seen[1].entryName).toBe('old.txt');
        const reader = openZip(bytes);
        expect(reader.getEntry('old.txt')?.dosDate).toBe(0x0021);
        expect(reader.getEntry('future.txt')?.dosDate).toBe(0xff9f);
        expect(() => createZip({ defaultDate: new Date(1970, 0, 1), strict: true })).toThrow(/ZIP_TIMESTAMP_CLAMPED/);
        const mod = createZipModifier(reader, { onDiagnostic: (d) => seen.push(d) });
        mod.addEntry('c.txt', te.encode('z'), { date: new Date(NaN) });
        mod.save();
        expect(seen.at(-1)?.entryName).toBe('c.txt');
    });

    it('an in-range Date produces no diagnostic (the default epoch never does)', () => {
        const seen: ZipDiagnostic[] = [];
        const zip = createZip({ onDiagnostic: (d) => seen.push(d), compression: { deterministic: true } });
        zip.add('a.txt', te.encode('x'), { date: new Date(2024, 0, 1) });
        zip.add('b.txt', te.encode('y'));
        zip.toBytes();
        expect(seen).toEqual([]);
    });
});
