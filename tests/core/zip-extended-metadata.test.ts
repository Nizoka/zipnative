import { describe, expect, it } from 'vitest';
import { createZip, getExtendedTimestamps, getUnixIds, openZip } from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

/**
 * `getExtendedTimestamps()` / `getUnixIds()` (1.1.0): the UT (0x5455),
 * NTFS (0x000a) and Info-ZIP ux (0x7875) extras, read from the fields the
 * entry already carries. Malformed blocks yield nulls, never a throw.
 */

const te = new TextEncoder();
const T = Math.floor(Date.parse('2020-09-13T12:26:40Z') / 1000); // 0x5f5e_1000 — distinct bytes
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const ut = (flags: number, ...times: number[]): Uint8Array => new Uint8Array([0x55, 0x54, 1 + 4 * times.length, 0x00, flags, ...times.flatMap(le32)]);
const ux = (uid: number, gid: number): Uint8Array => new Uint8Array([0x75, 0x78, 0x0b, 0x00, 0x01, 0x04, ...le32(uid), 0x04, ...le32(gid)]);
const fileTime = (iso: string): bigint => (BigInt(Date.parse(iso)) + 11644473600000n) * 10000n;
function ntfs(mtime: string, atime: string, ctime: string): Uint8Array {
    const out = new Uint8Array(4 + 4 + 24 + 4 + 24);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, 0x000a, true); dv.setUint16(2, 4 + 4 + 24, true);
    dv.setUint16(8, 0x0001, true); dv.setUint16(10, 24, true);
    dv.setBigUint64(12, fileTime(mtime), true);
    dv.setBigUint64(20, fileTime(atime), true);
    dv.setBigUint64(28, fileTime(ctime), true);
    return out.subarray(0, 4 + 4 + 4 + 24);
}

function entryWith(extra: Uint8Array, versionMadeBy = 0x031e): ReturnType<typeof openZip>['getEntry'] extends (n: string) => infer R ? NonNullable<R> : never {
    const archive = buildRawZip([{ name: 'f', data: te.encode('x'), extraCentral: extra, versionMadeBy }]);
    return openZip(archive).getEntry('f')!;
}

describe('getExtendedTimestamps', () => {
    it('UT with all three fields, source ut', () => {
        const ts = getExtendedTimestamps(entryWith(ut(0x07, T, T + 1, T + 2)));
        expect(ts.source).toBe('ut');
        expect(ts.mtime?.toISOString()).toBe('2020-09-13T12:26:40.000Z');
        expect(ts.atime?.toISOString()).toBe('2020-09-13T12:26:41.000Z');
        expect(ts.ctime?.toISOString()).toBe('2020-09-13T12:26:42.000Z');
    });

    it('UT mtime only (the usual central-directory copy): atime/ctime null', () => {
        const ts = getExtendedTimestamps(entryWith(ut(0x01, T)));
        expect(ts).toEqual({ mtime: new Date(T * 1000), atime: null, ctime: null, source: 'ut' });
    });

    it('NTFS FILETIMEs at 100 ns precision, source ntfs', () => {
        const ts = getExtendedTimestamps(entryWith(ntfs('2021-03-04T05:06:07.123Z', '2021-03-05T00:00:00Z', '2021-03-01T00:00:00Z'), 0x0014));
        expect(ts.source).toBe('ntfs');
        expect(ts.mtime?.toISOString()).toBe('2021-03-04T05:06:07.123Z');
        expect(ts.atime?.toISOString()).toBe('2021-03-05T00:00:00.000Z');
        expect(ts.ctime?.toISOString()).toBe('2021-03-01T00:00:00.000Z');
    });

    it('UT wins over NTFS; the DOS fields are the fallback (atime/ctime null)', () => {
        const both = new Uint8Array([...ntfs('2021-03-04T05:06:07Z', '2021-03-05T00:00:00Z', '2021-03-01T00:00:00Z'), ...ut(0x01, T)]);
        expect(getExtendedTimestamps(entryWith(both)).source).toBe('ut');
        const zip = createZip();
        zip.add('plain.txt', te.encode('x'), { date: new Date(2024, 0, 2, 3, 4, 6) });
        const plain = openZip(zip.toBytes()).getEntry('plain.txt')!;
        expect(getExtendedTimestamps(plain)).toEqual({ mtime: plain.lastModified, atime: null, ctime: null, source: 'dos' });
    });

    it('truncated or malformed blocks yield what fits, never a throw', () => {
        // UT flags claim three times, only one fits.
        const short = getExtendedTimestamps(entryWith(ut(0x07, T)));
        expect(short.source).toBe('ut');
        expect(short.atime).toBeNull();
        // UT with no mtime bit: falls through to DOS.
        expect(getExtendedTimestamps(entryWith(ut(0x02, T))).source).toBe('dos');
        // NTFS block cut inside the attribute.
        const cut = ntfs('2021-03-04T05:06:07Z', '2021-03-05T00:00:00Z', '2021-03-01T00:00:00Z').subarray(0, 20);
        const fixed = new Uint8Array(cut); new DataView(fixed.buffer).setUint16(2, 16, true);
        expect(getExtendedTimestamps(entryWith(fixed)).source).toBe('dos');
    });
});

describe('getUnixIds', () => {
    it('reads uid/gid from the ux extra, null without it', () => {
        expect(getUnixIds(entryWith(ux(1000, 1001)))).toEqual({ uid: 1000, gid: 1001 });
        expect(getUnixIds(entryWith(new Uint8Array(0)))).toBeNull();
        const zip = createZip();
        zip.add('a', te.encode('x'));
        expect(getUnixIds(openZip(zip.toBytes()).getEntry('a')!)).toBeNull();
    });

    it('rejects malformed blocks quietly: wrong version, bad size, truncated', () => {
        expect(getUnixIds(entryWith(new Uint8Array([0x75, 0x78, 0x03, 0x00, 0x02, 0x01, 0x00])))).toBeNull();
        expect(getUnixIds(entryWith(new Uint8Array([0x75, 0x78, 0x03, 0x00, 0x01, 0x09, 0x00])))).toBeNull();
        expect(getUnixIds(entryWith(new Uint8Array([0x75, 0x78, 0x06, 0x00, 0x01, 0x04, 0xe8, 0x03, 0x00, 0x00])))).toBeNull();
        // 2-byte ids are valid too.
        expect(getUnixIds(entryWith(new Uint8Array([0x75, 0x78, 0x07, 0x00, 0x01, 0x02, 0xe8, 0x03, 0x02, 0x64, 0x00])))).toEqual({ uid: 1000, gid: 100 });
    });
});
