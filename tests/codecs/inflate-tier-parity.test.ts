import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import {
    createZip,
    initNodeZipCodecs,
    iterateZipEntries,
    openZip,
    setInflateImpl,
    ZipDataError,
    ZipError,
    ZipFormatError,
} from 'zipnative';
import { inflateRawJS } from '../../src/codecs/inflate-pure.ts';
import {
    _resetInflateCache,
    inflateRawStream,
    inflateRawSync,
    normalizeInflateError,
} from '../../src/codecs/inflate.ts';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

/**
 * Issue #10 — the same hostile input must raise the same `err.code` AND the
 * same class whichever tier decodes it: the pure-TS inflater, node:zlib
 * (`inflateRawSync`), `DecompressionStream('deflate-raw')` and, through the
 * parser, every entry point. The node tier is never active in the ESM test
 * suite on its own (no `require` to probe), so this file initialises it
 * explicitly and is the one place that exercises it.
 */

const te = new TextEncoder();

// Fixed-Huffman block that starts with a back-reference before any
// literal — structurally invalid (same vector as tests/codecs/inflate.test.ts).
const CORRUPT = new Uint8Array([0x03, 0x02, 0x00]);
const PLAIN = te.encode('tier parity '.repeat(500));
const TRUNCATED = new Uint8Array(deflateRawSync(PLAIN)).subarray(0, 5);

async function collect(gen: AsyncIterable<Uint8Array>): Promise<number> {
    let n = 0;
    for await (const chunk of gen) n += chunk.length;
    return n;
}

function codeOf(fn: () => unknown): { code: string; name: string } {
    try {
        fn();
    } catch (err) {
        if (err instanceof ZipError) return { code: err.code, name: err.name };
        throw new Error(`expected a ZipError, got ${String(err)}`);
    }
    throw new Error('expected a throw');
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<{ code: string; name: string }> {
    try {
        await fn();
    } catch (err) {
        if (err instanceof ZipError) return { code: err.code, name: err.name };
        throw new Error(`expected a ZipError, got ${String(err)}`);
    }
    throw new Error('expected a rejection');
}

describe('normalizeInflateError (the table)', () => {
    const coded = (code: string): Error => Object.assign(new Error(`zlib: ${code}`), { code });

    it('maps the zlib codes to the pure tier vocabulary and keeps ZipErrors', () => {
        expect(normalizeInflateError(coded('ERR_BUFFER_TOO_LARGE'), 7)).toMatchObject({ code: 'ZIP_INFLATE_OUTPUT_OVERFLOW', name: 'ZipDataError' });
        expect(normalizeInflateError(coded('Z_BUF_ERROR'), 7)).toMatchObject({ code: 'ZIP_DEFLATE_TRUNCATED', name: 'ZipFormatError' });
        expect(normalizeInflateError(coded('Z_DATA_ERROR'), 7)).toMatchObject({ code: 'ZIP_DEFLATE_CORRUPT', name: 'ZipFormatError' });
        expect(normalizeInflateError(coded('Z_NEED_DICT'), 7)).toMatchObject({ code: 'ZIP_DEFLATE_CORRUPT', name: 'ZipFormatError' });
        expect(normalizeInflateError(new TypeError('The compressed data was not valid.'), 7)).toMatchObject({ code: 'ZIP_DEFLATE_CORRUPT' });
        expect(normalizeInflateError('boom', 7).message).toContain('boom');
        const own = new ZipDataError('ZIP_CRC_MISMATCH', 'zipnative: x');
        expect(normalizeInflateError(own, 7)).toBe(own);
    });
});

describe('tier parity: pure, node:zlib, DecompressionStream', () => {
    beforeAll(async () => {
        setInflateImpl(null);
        _resetInflateCache();
        await initNodeZipCodecs();
    });
    afterAll(() => {
        setInflateImpl(null);
        _resetInflateCache();
    });

    it('the node tier is active for this file', () => {
        // Node's inflateRawSync reports an unexpected end as Z_BUF_ERROR; the
        // pure tier has no notion of zlib codes. Both land on the same code,
        // which is the point — the message is the only tell, and it names the
        // platform detail on the node tier.
        const viaFacade = (() => { try { inflateRawSync(TRUNCATED, PLAIN.length); } catch (err) { return (err as Error).message; } return ''; })();
        expect(viaFacade).toMatch(/unexpected end|mid-block/);
    });

    it('sync: corrupt and truncated input raise identical codes and classes on the pure and node tiers', () => {
        expect(codeOf(() => inflateRawJS(CORRUPT, 100))).toEqual({ code: 'ZIP_DEFLATE_CORRUPT', name: 'ZipFormatError' });
        expect(codeOf(() => inflateRawSync(CORRUPT, 100))).toEqual({ code: 'ZIP_DEFLATE_CORRUPT', name: 'ZipFormatError' });
        expect(codeOf(() => inflateRawJS(TRUNCATED, PLAIN.length))).toEqual({ code: 'ZIP_DEFLATE_TRUNCATED', name: 'ZipFormatError' });
        expect(codeOf(() => inflateRawSync(TRUNCATED, PLAIN.length))).toEqual({ code: 'ZIP_DEFLATE_TRUNCATED', name: 'ZipFormatError' });
        expect(() => inflateRawSync(CORRUPT, 100)).toThrow(ZipFormatError);
    });

    it('sync: the output cap is the same ZipDataError on both tiers', () => {
        const bomb = new Uint8Array(deflateRawSync(new Uint8Array(1_000_000)));
        expect(codeOf(() => inflateRawJS(bomb, 1000))).toEqual({ code: 'ZIP_INFLATE_OUTPUT_OVERFLOW', name: 'ZipDataError' });
        expect(codeOf(() => inflateRawSync(bomb, 1000))).toEqual({ code: 'ZIP_INFLATE_OUTPUT_OVERFLOW', name: 'ZipDataError' });
    });

    it('stream: DecompressionStream failures carry the same codes', async () => {
        expect(typeof DecompressionStream).toBe('function');
        const corrupt = await codeOfAsync(() => collect(inflateRawStream(CORRUPT, 100)));
        expect(corrupt).toEqual({ code: 'ZIP_DEFLATE_CORRUPT', name: 'ZipFormatError' });
        // Node's DecompressionStream surfaces zlib's Z_BUF_ERROR for a
        // truncated stream; a browser's TypeError would land on CORRUPT —
        // either way a ZipFormatError, never a platform error.
        const truncated = await codeOfAsync(() => collect(inflateRawStream(TRUNCATED, PLAIN.length)));
        expect(truncated.name).toBe('ZipFormatError');
        expect(['ZIP_DEFLATE_TRUNCATED', 'ZIP_DEFLATE_CORRUPT']).toContain(truncated.code);
    });

    it('parser: readEntry, readEntryStream and iterateZipEntries agree with the codecs', async () => {
        const archive = buildRawZip([{ name: 'bad.bin', data: PLAIN, method: 8, corruptDataAt: 10 }]);
        const reader = openZip(archive);
        const sync = codeOf(() => reader.readEntry('bad.bin'));
        const stream = await codeOfAsync(() => collect(reader.readEntryStream('bad.bin')));
        const forward = await codeOfAsync(async () => {
            for await (const entry of iterateZipEntries((async function* () { yield archive; })())) {
                await collect(entry.data());
            }
        });
        // A corruption inside the deflate stream is either a structural
        // deflate error or, when the damaged stream still decodes, a CRC
        // mismatch — but it is the SAME verdict on every path and never
        // ZIP_DECOMPRESSION_FAILED (reserved for injected codecs).
        for (const v of [sync, stream, forward]) {
            expect(['ZIP_DEFLATE_CORRUPT', 'ZIP_DEFLATE_TRUNCATED', 'ZIP_CRC_MISMATCH', 'ZIP_SIZE_MISMATCH']).toContain(v.code);
            expect(v.code).not.toBe('ZIP_DECOMPRESSION_FAILED');
        }
        expect(stream.code).toBe(sync.code);
    });

    it('parser: an injected implementation that throws a plain Error stays ZIP_DECOMPRESSION_FAILED', async () => {
        const zip = createZip();
        zip.add('a.txt', PLAIN);
        const bytes = zip.toBytes();
        setInflateImpl(() => { throw new Error('injected codec exploded'); });
        try {
            const reader = openZip(bytes);
            expect(codeOf(() => reader.readEntry('a.txt'))).toEqual({ code: 'ZIP_DECOMPRESSION_FAILED', name: 'ZipDataError' });
            expect(await codeOfAsync(() => collect(reader.readEntryStream('a.txt')))).toEqual({ code: 'ZIP_DECOMPRESSION_FAILED', name: 'ZipDataError' });
        } finally {
            setInflateImpl(null);
        }
    });

    it('_resetInflateCache restores the probe so the pure tier can be forced', () => {
        _resetInflateCache();
        // Without initNodeZipCodecs() the ESM probe finds no `require` and the
        // pure tier answers — same code, same class.
        expect(codeOf(() => inflateRawSync(CORRUPT, 100))).toEqual({ code: 'ZIP_DEFLATE_CORRUPT', name: 'ZipFormatError' });
    });
});
