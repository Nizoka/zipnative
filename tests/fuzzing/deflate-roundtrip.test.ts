import { inflateRawSync as zlibInflate } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { deflateRawJS } from '../../src/codecs/deflate-pure.ts';
import { seededRandom } from '../helpers/raw-zip-builder.ts';

/**
 * Seeded differential battery: every archive our encoder emits must be
 * accepted and exactly inverted by zlib's inflate. Generator kinds mix
 * random bytes, runs, periodic patterns and Markov-ish text; sizes and
 * levels vary per round. The seed is in the failure message.
 */
function generate(kind: number, size: number, rand: () => number): Uint8Array {
    const buf = new Uint8Array(size);
    if (kind === 0) {
        for (let i = 0; i < size; i++) buf[i] = Math.floor(rand() * 256);
    } else if (kind === 1) {
        let i = 0;
        while (i < size) {
            const byte = Math.floor(rand() * 4) * 63;
            const run = 1 + Math.floor(rand() * 500);
            for (let k = 0; k < run && i < size; k++) buf[i++] = byte;
        }
    } else if (kind === 2) {
        const period = 1 + Math.floor(rand() * 13);
        for (let i = 0; i < size; i++) buf[i] = 32 + ((i % period) * 7) % 90;
    } else {
        // Markov-ish text: biased transitions over a small alphabet.
        let state = 101;
        for (let i = 0; i < size; i++) {
            state = rand() < 0.7 ? 97 + ((state + 1) % 26) : 97 + Math.floor(rand() * 26);
            buf[i] = rand() < 0.15 ? 32 : state;
        }
    }
    return buf;
}

describe('fuzzing: deflate encoder vs zlib inflate (differential)', () => {
    // Generous timeout: coverage instrumentation slows the encoder ~20-50x.
    it('200 seeded rounds round-trip exactly', { timeout: 300_000 }, () => {
        const rand = seededRandom(0xDEF1A7E);
        for (let round = 0; round < 200; round++) {
            const kind = Math.floor(rand() * 4);
            const size = Math.floor(rand() * 262_144);
            const level = Math.floor(rand() * 10);
            const data = generate(kind, size, rand);
            const label = `round ${round} kind ${kind} size ${size} level ${level}`;

            let restored: Uint8Array;
            try {
                restored = new Uint8Array(zlibInflate(deflateRawJS(data, level)));
            } catch (err) {
                throw new Error(`${label}: zlib rejected our stream: ${String(err)}`);
            }
            expect(restored.length, label).toBe(data.length);
            // Byte-compare without expect() overhead per byte.
            let mismatch = -1;
            for (let i = 0; i < data.length; i++) {
                if (restored[i] !== data[i]) {
                    mismatch = i;
                    break;
                }
            }
            expect(mismatch, `${label}: first mismatch at ${mismatch}`).toBe(-1);
        }
    });
});
