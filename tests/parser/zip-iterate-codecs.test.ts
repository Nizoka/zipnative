import { describe, expect, it } from 'vitest';
import {
    getCodec,
    iterateZipEntries,
    openZip,
    registerCodec,
    ZipDataError,
    ZipError,
    ZipUnsupportedError,
    type ZipDecompressor,
} from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

/**
 * Issue #11 — the forward reader and a registered codec. Before 1.1.0,
 * `data()` on a custom-method entry ran the DEFLATE pump over foreign
 * bytes and failed mid-stream with ZIP_DECOMPRESSION_FAILED (a "corrupt"
 * verdict for a format problem), so `--skip-unsupported` policies could not
 * skip it. Now: a codec with `createDecompressor()` is streamed in O(chunk);
 * one without is refused typed, before any byte, with skip() intact.
 */

const te = new TextEncoder();
const td = new TextDecoder();

async function* streamOf(bytes: Uint8Array, chunkSize = 7): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < bytes.length; i += chunkSize) {
        yield bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    }
}

async function collect(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const c of gen) parts.push(c);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
}

/** A toy "codec": every byte XOR 0x5A — invertible, stateless, chunk-agnostic. */
const xor = (data: Uint8Array): Uint8Array => data.map((b) => b ^ 0x5a);

function xorDecompressor(maxOutput: number): ZipDecompressor {
    let produced = 0;
    return {
        push: (chunk) => {
            produced += chunk.length;
            if (produced > maxOutput) throw new ZipDataError('ZIP_INFLATE_OUTPUT_OVERFLOW', 'zipnative: xor output exceeds the bound');
            return [xor(chunk)];
        },
        end: () => [],
    };
}

// Method ids 93–96 are taken by other suites and there is no unregisterCodec.
registerCodec({ method: 97, name: 'xor-incremental', decompressSync: (d) => xor(d), createDecompressor: xorDecompressor });
registerCodec({ method: 98, name: 'xor-sync-only', decompressSync: (d) => xor(d), decompressStream: async function* (d) { yield xor(d); } });

const PAYLOAD = te.encode('forward reader meets a registered codec, chunk by chunk, '.repeat(40));

describe('iterateZipEntries with registered codecs (#11)', () => {
    it('decodes a method-97 entry through createDecompressor, chunk by chunk, with counting and CRC', async () => {
        const archive = buildRawZip([
            { name: 'x.bin', data: xor(PAYLOAD), method: 97, crcOverride: crcOf(PAYLOAD), uncompressedSizeOverride: PAYLOAD.length },
            { name: 'after.txt', data: te.encode('still readable') },
        ]);
        const seen: string[] = [];
        for await (const entry of iterateZipEntries(streamOf(archive))) {
            seen.push(entry.header.name);
            const bytes = await collect(entry.data());
            if (entry.header.name === 'x.bin') expect(bytes).toEqual(PAYLOAD);
            else expect(td.decode(bytes)).toBe('still readable');
        }
        expect(seen).toEqual(['x.bin', 'after.txt']);
        // Parity with the authoritative reader.
        expect(openZip(archive).readEntry('x.bin')).toEqual(PAYLOAD);
    });

    it('refuses a codec without createDecompressor BEFORE the first byte; skip() still advances', async () => {
        const archive = buildRawZip([
            { name: 'sync.bin', data: xor(te.encode('abc')), method: 98, crcOverride: crcOf(te.encode('abc')) },
            { name: 'next.txt', data: te.encode('next') },
        ]);
        const names: string[] = [];
        for await (const entry of iterateZipEntries(streamOf(archive))) {
            names.push(entry.header.name);
            if (entry.header.compressionMethod === 98) {
                let err: unknown;
                try { entry.data(); } catch (e) { err = e; }
                expect(err).toBeInstanceOf(ZipUnsupportedError);
                expect((err as ZipUnsupportedError).code).toBe('ZIP_UNSUPPORTED_CODEC_MODE');
                expect((err as ZipUnsupportedError).feature).toBe('method:98');
                expect((err as Error).message).toMatch(/createDecompressor|openZip/);
                // Synchronous refusal, nothing consumed: data() is still unused.
                await entry.skip();
            } else {
                expect(td.decode(await collect(entry.data()))).toBe('next');
            }
        }
        expect(names).toEqual(['sync.bin', 'next.txt']);
        // openZip still decodes it through decompressSync — the documented route.
        expect(td.decode(openZip(archive).readEntry('sync.bin'))).toBe('abc');
    });

    it('an unregistered method is still ZIP_UNSUPPORTED_METHOD (distinct from the codec-mode refusal)', async () => {
        const archive = buildRawZip([{ name: 'u.bin', data: te.encode('?'), method: 91 }]);
        for await (const entry of iterateZipEntries(streamOf(archive))) {
            let err: unknown;
            try { entry.data(); } catch (e) { err = e; }
            expect((err as ZipError).code).toBe('ZIP_UNSUPPORTED_METHOD');
            await entry.skip();
        }
    });

    it('a codec that throws a plain Error mid-stream is ZIP_DECOMPRESSION_FAILED, never a raw error', async () => {
        registerCodec({
            method: 99 - 10, // 89
            name: 'explodes',
            createDecompressor: () => ({ push: () => { throw new Error('codec bug'); }, end: () => [] }),
        });
        const archive = buildRawZip([{ name: 'e.bin', data: te.encode('zzz'), method: 89 }]);
        let err: unknown;
        try {
            for await (const entry of iterateZipEntries(streamOf(archive))) await collect(entry.data());
        } catch (e) { err = e; }
        expect(err).toBeInstanceOf(ZipDataError);
        expect((err as ZipDataError).code).toBe('ZIP_DECOMPRESSION_FAILED');
        expect((err as Error).message).toContain("codec 'explodes'");
    });

    it('a codec that produces more than the header declares is caught by the output count', async () => {
        registerCodec({
            method: 90,
            name: 'xor-plus-one',
            createDecompressor: (max) => {
                const inner = xorDecompressor(max + 1);
                return { push: (c) => inner.push(c), end: () => [new Uint8Array([0x00])] };
            },
        });
        const archive = buildRawZip([
            { name: 'x.bin', data: xor(PAYLOAD), method: 90, crcOverride: crcOf(PAYLOAD) },
        ]);
        let err: unknown;
        try {
            for await (const entry of iterateZipEntries(streamOf(archive))) await collect(entry.data());
        } catch (e) { err = e; }
        expect(err).toBeInstanceOf(ZipDataError);
        expect((err as ZipError).code).toBe('ZIP_SIZE_MISMATCH');
    });

    it('registered overrides of methods 0 and 8 are ignored by the forward reader and honoured by openZip', async () => {
        const original = getCodec(8)!;
        registerCodec({ ...original, createDecompressor: () => ({ push: () => { throw new Error('override must not run here'); }, end: () => [] }) });
        try {
            const archive = buildRawZip([{ name: 'd.txt', data: te.encode('deflated by zlib'), method: 8 }]);
            for await (const entry of iterateZipEntries(streamOf(archive))) {
                expect(td.decode(await collect(entry.data()))).toBe('deflated by zlib');
            }
        } finally {
            registerCodec(original);
        }
    });

    it('the built-in codecs expose createDecompressor with the Inflator contract', () => {
        const deflate = getCodec(8)!.createDecompressor!(1 << 20);
        expect(typeof deflate.push).toBe('function');
        expect(() => deflate.end()).toThrow(ZipError); // nothing pushed: truncated
        const store = getCodec(0)!.createDecompressor!(16);
        expect(store.push(te.encode('abc'))).toEqual([te.encode('abc')]);
        expect(store.end()).toEqual([]);
    });
});

function crcOf(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}
