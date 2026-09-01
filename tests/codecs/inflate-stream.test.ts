import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ZipDataError, ZipFormatError } from 'zipnative';
import { createInflator } from '../../src/codecs/inflate-stream.ts';
import { seededRandom } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();

function randomBytes(size: number, seed: number): Uint8Array {
    const rand = seededRandom(seed);
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) buf[i] = Math.floor(rand() * 256);
    return buf;
}

/** Run the inflator over `compressed` fed at `chunkSize`; join the output. */
function run(compressed: Uint8Array, chunkSize: number, maxOutput = Number.MAX_SAFE_INTEGER): {
    output: Uint8Array;
    consumed: number;
    leftover: Uint8Array;
} {
    const inflator = createInflator(maxOutput);
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < compressed.length && !inflator.finished; i += chunkSize) {
        const chunk = compressed.subarray(i, Math.min(i + chunkSize, compressed.length));
        pieces.push(...inflator.push(chunk));
    }
    inflator.end();
    const total = pieces.reduce((sum, p) => sum + p.length, 0);
    const output = new Uint8Array(total);
    let pos = 0;
    for (const piece of pieces) {
        output.set(piece, pos);
        pos += piece.length;
    }
    return { output, consumed: inflator.bytesConsumed, leftover: inflator.leftover };
}

const CORPORA: ReadonlyArray<{ name: string; data: Uint8Array }> = [
    { name: 'empty', data: new Uint8Array(0) },
    { name: 'tiny', data: te.encode('abc') },
    { name: 'text', data: te.encode('the quick brown fox jumps over the lazy dog. '.repeat(400)) },
    { name: 'zeros-70k', data: new Uint8Array(70_000) },
    { name: 'random-40k', data: randomBytes(40_000, 11) },
    // > 96 KiB repetitive: back-references must survive window slides.
    { name: 'pattern-130k', data: te.encode('windowslide '.repeat(11_000)) },
    // Multiple stored blocks (> 64 KiB of incompressible input at level 0).
    { name: 'random-100k', data: randomBytes(100_000, 77) },
];

const CHUNK_SIZES = [1, 2, 3, 7, 13, 61, 127, 509, Number.MAX_SAFE_INTEGER];

describe('createInflator: differential vs zlib across hostile chunkings', () => {
    for (const { name, data } of CORPORA) {
        it(`${name} (${data.length} B) at levels 0/6/9, every chunking`, () => {
            for (const level of [0, 6, 9]) {
                const compressed = new Uint8Array(deflateRawSync(data, { level }));
                for (const chunkSize of CHUNK_SIZES) {
                    const { output, consumed, leftover } = run(compressed, chunkSize);
                    expect(output, `${name} L${level} chunk ${chunkSize}`).toEqual(data);
                    // The whole buffer IS the stream: consumed must be exact.
                    expect(consumed, `${name} L${level} chunk ${chunkSize} consumed`).toBe(compressed.length);
                    expect(leftover.length).toBe(0);
                }
            }
        }, 60_000);
    }
});

describe('createInflator: consumed-byte boundary (the descriptor prerequisite)', () => {
    it('returns trailing garbage intact as leftover, byte-for-byte', () => {
        const data = te.encode('payload before the descriptor '.repeat(100));
        const compressed = new Uint8Array(deflateRawSync(data));
        const garbage = te.encode('PK\x07\x08-fake-descriptor-and-more-records');
        const joined = new Uint8Array(compressed.length + garbage.length);
        joined.set(compressed, 0);
        joined.set(garbage, compressed.length);

        for (const chunkSize of [1, 64, joined.length]) {
            const inflator = createInflator(Number.MAX_SAFE_INTEGER);
            const collected: Uint8Array[] = [];
            let fed = 0;
            while (!inflator.finished && fed < joined.length) {
                const chunk = joined.subarray(fed, Math.min(fed + chunkSize, joined.length));
                fed += chunk.length;
                collected.push(...inflator.push(chunk));
            }
            inflator.end();
            expect(inflator.bytesConsumed, `chunk ${chunkSize}`).toBe(compressed.length);
            // Leftover is the tail of the LAST pushed chunk; together with the
            // unfed remainder it must reconstruct the garbage exactly.
            const tail = new Uint8Array([...inflator.leftover, ...joined.subarray(fed)]);
            expect(tail, `chunk ${chunkSize}`).toEqual(garbage);
        }
    });

    it('boundary split one byte into the garbage still yields exact accounting', () => {
        const data = te.encode('x'.repeat(500));
        const compressed = new Uint8Array(deflateRawSync(data));
        const joined = new Uint8Array([...compressed, 0xAA, 0xBB]);
        const inflator = createInflator(Number.MAX_SAFE_INTEGER);
        // Feed everything except the last byte, then the last byte.
        inflator.push(joined.subarray(0, compressed.length + 1));
        expect(inflator.finished).toBe(true);
        expect(inflator.bytesConsumed).toBe(compressed.length);
        expect([...inflator.leftover]).toEqual([0xAA]);
    });
});

describe('createInflator: error paths (never a hang)', () => {
    it('truncation at every prefix yields ZipFormatError from end()', () => {
        const data = te.encode('truncate me '.repeat(50));
        const compressed = new Uint8Array(deflateRawSync(data));
        for (let cut = 0; cut < compressed.length; cut++) {
            const inflator = createInflator(Number.MAX_SAFE_INTEGER);
            try {
                inflator.push(compressed.subarray(0, cut));
                expect(inflator.finished, `cut ${cut}`).toBe(false);
                expect(() => inflator.end()).toThrow(ZipFormatError);
            } catch (err) {
                // Some cuts corrupt a header enough to throw during push.
                expect(err, `cut ${cut}`).toBeInstanceOf(ZipFormatError);
            }
        }
    });

    it('enforces the output bound mid-stream', () => {
        const compressed = new Uint8Array(deflateRawSync(new Uint8Array(1_000_000)));
        const inflator = createInflator(1000);
        expect(() => {
            for (let i = 0; i < compressed.length; i += 512) {
                inflator.push(compressed.subarray(i, Math.min(i + 512, compressed.length)));
            }
        }).toThrow(ZipDataError);
    });

    it('rejects the back-reference-before-start stream', () => {
        const hostile = new Uint8Array([0x03, 0x02, 0x00]);
        const inflator = createInflator(100);
        expect(() => inflator.push(hostile)).toThrow(ZipFormatError);
    });

    it('push after finished throws with the remedy', () => {
        const compressed = new Uint8Array(deflateRawSync(te.encode('done')));
        const inflator = createInflator(100);
        inflator.push(compressed);
        expect(inflator.finished).toBe(true);
        expect(() => inflator.push(new Uint8Array(1))).toThrow(/finished/);
    });

    it('zero-length chunks are harmless', () => {
        const data = te.encode('sparse feeding');
        const compressed = new Uint8Array(deflateRawSync(data));
        const inflator = createInflator(1000);
        const pieces: Uint8Array[] = [];
        pieces.push(...inflator.push(new Uint8Array(0)));
        pieces.push(...inflator.push(compressed.subarray(0, 3)));
        pieces.push(...inflator.push(new Uint8Array(0)));
        pieces.push(...inflator.push(compressed.subarray(3)));
        inflator.end();
        const total = pieces.reduce((sum, p) => sum + p.length, 0);
        expect(total).toBe(data.length);
        expect(inflator.bytesConsumed).toBe(compressed.length);
    });
});
