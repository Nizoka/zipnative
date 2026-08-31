import { describe, expect, it, afterEach } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { setInflateImpl, ZipDataError, ZipFormatError } from 'zipnative';
import { inflateRawJS } from '../../src/codecs/inflate-pure.ts';
import { inflateRawStream, inflateRawSync } from '../../src/codecs/inflate.ts';
import { seededRandom } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();

function randomBytes(size: number, seed: number): Uint8Array {
    const rand = seededRandom(seed);
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) buf[i] = Math.floor(rand() * 256);
    return buf;
}

describe('inflateRawJS (pure-TS tier)', () => {
    it('round-trips zlib output at every compression level', () => {
        const data = te.encode('hello hello hello zipnative '.repeat(200));
        for (const level of [0, 1, 6, 9]) {
            const compressed = new Uint8Array(deflateRawSync(data, { level }));
            expect(inflateRawJS(compressed, data.length)).toEqual(data);
        }
    });

    it('round-trips incompressible random data (stored blocks)', () => {
        const data = randomBytes(70_000, 7);
        const compressed = new Uint8Array(deflateRawSync(data));
        expect(inflateRawJS(compressed, data.length)).toEqual(data);
    });

    it('enforces the output bound during inflation (zip-bomb cap)', () => {
        const data = new Uint8Array(1_000_000); // 1 MB of zeros: extreme ratio
        const compressed = new Uint8Array(deflateRawSync(data));
        expect(() => inflateRawJS(compressed, 1000)).toThrow(ZipDataError);
    });

    it('throws ZipFormatError on truncated streams', () => {
        const compressed = new Uint8Array(deflateRawSync(te.encode('x'.repeat(1000))));
        expect(() => inflateRawJS(compressed.subarray(0, 5), 1000)).toThrow(ZipFormatError);
    });

    it('throws ZipFormatError on a back-reference before the start of output', () => {
        // Fixed-Huffman block starting directly with a length/distance pair.
        // BFINAL=1, BTYPE=01, then symbol 257 (len 3) + distance code 0 (dist 1)
        // with no prior literal → invalid.
        const hostile = new Uint8Array([0x03, 0x02, 0x00]);
        expect(() => inflateRawJS(hostile, 100)).toThrow(ZipFormatError);
    });
});

describe('inflateRawSync facade', () => {
    afterEach(() => setInflateImpl(null));

    it('decompresses through the platform tier', () => {
        const data = te.encode('facade test '.repeat(100));
        const compressed = new Uint8Array(deflateRawSync(data));
        expect(inflateRawSync(compressed, data.length)).toEqual(data);
    });

    it('honors an injected implementation (tier 1)', () => {
        const marker = te.encode('injected!');
        setInflateImpl(() => marker);
        expect(inflateRawSync(new Uint8Array([1, 2, 3]), 100)).toBe(marker);
    });

    it('maps the native output cap to ZipDataError', () => {
        const data = new Uint8Array(1_000_000);
        const compressed = new Uint8Array(deflateRawSync(data));
        expect(() => inflateRawSync(compressed, 1000)).toThrow(ZipDataError);
    });
});

describe('inflateRawStream facade', () => {
    it('streams chunks that concatenate to the full output', async () => {
        const data = te.encode('stream me '.repeat(50_000));
        const compressed = new Uint8Array(deflateRawSync(data));
        const chunks: Uint8Array[] = [];
        for await (const chunk of inflateRawStream(compressed, data.length)) {
            chunks.push(chunk);
        }
        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        expect(total).toBe(data.length);
        const joined = new Uint8Array(total);
        let pos = 0;
        for (const chunk of chunks) {
            joined.set(chunk, pos);
            pos += chunk.length;
        }
        expect(joined).toEqual(data);
    });

    it('enforces the output bound while streaming', async () => {
        const data = new Uint8Array(1_000_000);
        const compressed = new Uint8Array(deflateRawSync(data));
        await expect(async () => {
            for await (const _chunk of inflateRawStream(compressed, 1000)) { /* drain */ }
        }).rejects.toThrow(ZipDataError);
    });
});
