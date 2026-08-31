import { describe, expect, it } from 'vitest';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { crc32 } from 'zipnative';
import { seededRandom } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();

describe('crc32 (slice-by-8)', () => {
    it('matches the reference vector for "123456789"', () => {
        expect(crc32(te.encode('123456789'))).toBe(0xCBF43926);
    });

    it('returns 0 for empty input', () => {
        expect(crc32(new Uint8Array(0))).toBe(0);
    });

    it('agrees with node:zlib on random buffers of every alignment', () => {
        const rand = seededRandom(42);
        for (const size of [1, 7, 8, 9, 63, 64, 65, 1000, 65_537]) {
            const buf = new Uint8Array(size);
            for (let i = 0; i < size; i++) buf[i] = Math.floor(rand() * 256);
            expect(crc32(buf)).toBe(zlibCrc32(buf));
        }
    });

    it('supports incremental computation via the seed parameter', () => {
        const buf = te.encode('the quick brown fox jumps over the lazy dog');
        const whole = crc32(buf);
        const first = crc32(buf.subarray(0, 17));
        const incremental = crc32(buf.subarray(17), first);
        expect(incremental).toBe(whole);
    });

    it('is correct on offset subarray views', () => {
        const backing = new Uint8Array(100);
        backing.set(te.encode('123456789'), 50);
        expect(crc32(backing.subarray(50, 59))).toBe(0xCBF43926);
    });
});
