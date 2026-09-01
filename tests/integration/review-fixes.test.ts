/**
 * Regression suite for the v0.8.1 multi-agent code review — one test per
 * confirmed finding (A1–A6, B1–B7). Each reproduces the reviewer's failure
 * scenario and asserts the fix. A4's ≥4 GiB path is covered at the helper
 * level (`lfhZip64Fields`, no 4 GiB buffer needed); B7 (dispatch-time
 * slicing) is an allocation-timing change with no observable behavior
 * difference, verified by inspection and exercised structurally by the
 * worker suites.
 */
import { describe, expect, it } from 'vitest';
import {
    createZip,
    createZipModifier,
    openZip,
    sanitizeEntryPath,
    ZipError,
} from 'zipnative';
import { buildHuffmanTable } from '../../src/codecs/inflate-shared.ts';
import { inflateRawJS } from '../../src/codecs/inflate-pure.ts';
import { matchDataDescriptor } from '../../src/core/zip-structs.ts';
import { lfhZip64Fields } from '../../src/parser/zip-modifier.ts';
import { createDeflatePool } from '../../src/worker/worker-pool.ts';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();

describe('review fix A1 — rename preserves name/flag agreement', () => {
    it('renaming a CP437 source to a non-ASCII name sets the UTF-8 flag', () => {
        // Source entry with flags=0 (CP437) and a plain-ASCII name.
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('hi'), flags: 0 }]);
        const mod = createZipModifier(openZip(archive, { onDiagnostic: () => undefined }));
        mod.renameEntry('a.txt', 'café.txt');
        const out = mod.save();
        const reader = openZip(out, { onDiagnostic: () => undefined });
        const entry = reader.getEntry('café.txt');
        expect(entry, 'renamed entry must be found by its UTF-8 name').not.toBeNull();
        expect(new TextDecoder().decode(reader.readEntry(entry as never))).toBe('hi');
    });
});

describe('review fix A2 — sanitizeEntryPath rejects Windows device names', () => {
    it('nulls reserved device names, with and without extension', () => {
        for (const name of ['CON', 'nul', 'aux.txt', 'COM1', 'lpt9.tar.gz', 'sub/PRN']) {
            expect(sanitizeEntryPath(name), name).toBeNull();
        }
    });
    it('keeps non-reserved lookalikes', () => {
        for (const name of ['CONX', 'COM10', 'console.txt', 'aux-data.bin']) {
            expect(sanitizeEntryPath(name), name).not.toBeNull();
        }
    });
});

describe('review fix A3 — validateEntryName rejects names its extractor nulls', () => {
    it('refuses a lone "." at write time', () => {
        const err = grab(() => createZip().add('.', te.encode('x')));
        expect(err.code).toBe('ZIP_INVALID_ENTRY_NAME');
    });
    it('still accepts legitimate dotted paths', () => {
        expect(() => createZip().add('a/./b.txt', te.encode('x'))).not.toThrow();
    });
});

describe('review fix A5 — readExact(0) never leaks a TypeError', () => {
    it('a zero-length read on a fully-drained cursor is a clean empty read', async () => {
        // The exact failure mode: readExact(30) consumes the single chunk
        // whole, leaving the deque EMPTY; readExact(0) then used to touch
        // pending[0] (undefined) and leak a raw TypeError — the state a
        // 30-byte LFH with empty name + empty extra puts the forward
        // reader in at a chunk boundary.
        const raw = buildRawZip([{ name: 'ok.txt', data: te.encode('x') }]);
        const { createChunkCursor } = await import('../../src/parser/zip-chunk-cursor.ts');
        async function* one(): AsyncGenerator<Uint8Array> { yield raw.subarray(0, 30); }
        const cursor = createChunkCursor(one());
        await cursor.readExact(30); // drains the deque completely
        await expect(cursor.readExact(0)).resolves.toEqual(new Uint8Array(0));
    });
});

describe('review fix A4 — appended LFH Zip64 carries BOTH sizes (APPNOTE §4.5.3)', () => {
    it('either overflowing size sentinels both classic fields and emits a two-u64 extra', () => {
        const big = 5 * 1024 ** 3; // 5 GiB uncompressed
        const small = 123_456;     // compressed < 4 GiB — the aggravating case
        const f = lfhZip64Fields(big, small);
        expect(f.usesZip64).toBe(true);
        expect(f.classicUncompressed).toBe(0xFFFFFFFF);
        expect(f.classicCompressed).toBe(0xFFFFFFFF);
        // 0x0001 extra: 4-byte header + BOTH u64 sizes = 20 bytes.
        expect(f.extra).not.toBeNull();
        const dv = new DataView((f.extra as Uint8Array).buffer);
        expect((f.extra as Uint8Array).length).toBe(20);
        expect(dv.getUint16(0, true)).toBe(0x0001);
        expect(dv.getUint16(2, true)).toBe(16);
        expect(Number(dv.getBigUint64(4, true))).toBe(big);
        expect(Number(dv.getBigUint64(12, true))).toBe(small);
    });
    it('sub-4GiB sizes emit no Zip64 extra at all', () => {
        const f = lfhZip64Fields(1000, 500);
        expect(f).toEqual({ classicUncompressed: 1000, classicCompressed: 500, extra: null, usesZip64: false });
    });
});

describe('review fix A6 — zero-length Zip64 descriptor is not mis-parsed', () => {
    it('prefers the 24-byte form when the 16-byte follower is not a record', () => {
        // Empty entry: crc=0, csize=2 (deflate of empty), usize=0, 24-byte
        // signed descriptor, followed by a central-file-header signature.
        const head = new Uint8Array(28);
        const dv = new DataView(head.buffer);
        dv.setUint32(0, 0x08074b50, true); // descriptor signature
        dv.setUint32(4, 0, true);          // crc = 0
        dv.setBigUint64(8, 2n, true);      // csize (u64) = 2
        dv.setBigUint64(16, 0n, true);     // usize (u64) = 0
        dv.setUint32(24, 0x02014b50, true); // next: central directory
        const match = matchDataDescriptor(head, { crc32: 0, compressedSize: 2, uncompressedSize: 0 });
        expect(match).toEqual({ ok: true, byteLength: 24 });
    });
    it('still reads a real 16-byte descriptor followed by a record', () => {
        const head = new Uint8Array(20);
        const dv = new DataView(head.buffer);
        dv.setUint32(0, 0x08074b50, true);
        dv.setUint32(4, 123, true);        // crc
        dv.setUint32(8, 5, true);          // csize
        dv.setUint32(12, 0, true);         // usize = 0
        dv.setUint32(16, 0x04034b50, true); // next: local file header
        const match = matchDataDescriptor(head, { crc32: 123, compressedSize: 5, uncompressedSize: 0 });
        expect(match).toEqual({ ok: true, byteLength: 16 });
    });
});

describe('review fix B1 — oversized extra fields are refused at write time', () => {
    it('the configurable maxExtraFieldBytes limit fires first', () => {
        const zip = createZip();
        zip.add('a.txt', te.encode('x'), { extraFields: [{ id: 0x9999, data: new Uint8Array(70_000) }] });
        const err = grab(() => zip.toBytes());
        expect(err.code).toBe('ZIP_LIMIT_EXCEEDED');
    });
    it('the hard 65535 structural cap holds even with the limit raised', () => {
        // With the configurable limit lifted, the u16 header field itself is
        // still the ceiling — the wrap that shipped corrupt archives.
        const zip = createZip({ limits: { maxExtraFieldBytes: Infinity } });
        zip.add('a.txt', te.encode('x'), { extraFields: [{ id: 0x9999, data: new Uint8Array(70_000) }] });
        const err = grab(() => zip.toBytes());
        expect(err.code).toBe('ZIP_INVALID_OPTION');
    });
});

describe('review fix B2 — pool main-thread fallback rejects, never hangs', () => {
    it('a failing job whose fallback also throws rejects the promise', async () => {
        // A stub worker that job-errors id 1; the main-thread fallback then
        // runs deflateRawSync with an invalid level and throws — the job must
        // reject (not hang the process).
        let handler: ((m: unknown) => void) | null = null;
        const spawn = (): Promise<never> => Promise.resolve({
            post(msg: { id: number }): void { setTimeout(() => handler?.({ type: 'job-error', id: msg.id, message: 'x' }), 0); },
            onMessage(h: (m: unknown) => void): void { handler = h; },
            onError(): void { /* never dies at boot */ },
            terminate(): void { /* no-op */ },
        } as never);
        const pool = await createDeflatePool({ workers: 1, jobTimeout: 1000, _spawn: spawn });
        // The rejection must be the fallback's own deflate error (a real
        // Error about the invalid level), not an arbitrary sentinel.
        await expect(pool.deflate(te.encode('data'.repeat(100)), 99, false))
            .rejects.toThrowError(/level|0-9|out of range/i);
        pool.close();
    });
});

describe('review fix B3 — per-entry compression level is validated', () => {
    it('throws a typed ZIP_INVALID_OPTION, not a raw RangeError', () => {
        const zip = createZip();
        const err = grab(() => zip.add('a.txt', te.encode('x'), { compression: { level: 99 } }));
        expect(err.code).toBe('ZIP_INVALID_OPTION');
    });
    it('validates per-entry level in the modifier too', () => {
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('x') }]);
        const mod = createZipModifier(openZip(archive));
        mod.addEntry('b.txt', te.encode('y'), { compression: { level: -1 } });
        const err = grab(() => mod.save()); // validated during the write plan
        expect(err.code).toBe('ZIP_INVALID_OPTION');
    });
});

describe('review fix B4 — over-subscribed Huffman tables are rejected', () => {
    it('throws ZIP_DEFLATE_CORRUPT on an over-subscribed table', () => {
        // Three codes of length 1 — Kraft sum 1.5, over-subscribed.
        const lengths = new Uint8Array([1, 1, 1]);
        const err = grab(() => buildHuffmanTable(lengths, 3));
        expect(err.code).toBe('ZIP_DEFLATE_CORRUPT');
    });
    it('still accepts a lone one-bit code (zlib-tolerated incomplete set)', () => {
        expect(() => buildHuffmanTable(new Uint8Array([1, 0, 0]), 3)).not.toThrow();
    });
    it('still accepts an empty table (no codes)', () => {
        expect(() => buildHuffmanTable(new Uint8Array([0, 0, 0]), 3)).not.toThrow();
    });
    it('the code-length alphabet rejects even a single-code incomplete set (zlib CODES strictness)', () => {
        const err = grab(() => buildHuffmanTable(new Uint8Array([1, 0, 0]), 3, true));
        expect(err.code).toBe('ZIP_DEFLATE_CORRUPT');
    });
});

describe('review fix B5 — bounded inflate does not allocate maxOutput upfront', () => {
    it('a tiny stream with a 1 GiB bound returns a snugly-backed result', () => {
        const empty = new Uint8Array([0x03, 0x00]); // deflate of empty input
        const out = inflateRawJS(empty, 1 << 30);
        expect(out.length).toBe(0);
        // The result must not retain a gigabyte-sized backing buffer.
        expect(out.buffer.byteLength).toBeLessThan(1 << 20);
    });
});

describe('review fix B6 — abandoning a stream entry releases the source', () => {
    it('calls the source iterator return() on early break', async () => {
        let returned = false;
        const source: AsyncIterable<Uint8Array> = {
            [Symbol.asyncIterator]() {
                let n = 0;
                return {
                    next() {
                        return Promise.resolve(n++ < 50
                            ? { value: new Uint8Array(4096).fill(65), done: false }
                            : { value: undefined as never, done: true });
                    },
                    return() { returned = true; return Promise.resolve({ value: undefined as never, done: true }); },
                };
            },
        };
        const zip = createZip();
        zip.addStream('big.bin', source);
        const gen = zip.stream({ chunkSize: 1024 });
        await gen.next();            // start producing
        await gen.return(undefined); // abandon early
        // The detached writer loop unwinds asynchronously — poll with a
        // bounded deadline instead of a fixed sleep (CI-load resilient).
        const deadline = Date.now() + 2000;
        while (!returned && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 10));
        }
        expect(returned).toBe(true);
    });
});

/** Grab a thrown ZipError for code assertions. */
function grab(fn: () => unknown): ZipError {
    try {
        fn();
    } catch (err) {
        expect(err).toBeInstanceOf(ZipError);
        return err as ZipError;
    }
    throw new Error('expected the call to throw');
}
