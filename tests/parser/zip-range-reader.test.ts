import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    createZip,
    createZipModifier,
    openZip,
    openZipRange,
    rangeSourceFromBytes,
    registerCodec,
    ZipDataError,
    ZipError,
    ZipFormatError,
    ZipLimitError,
    ZipSecurityError,
    ZipUnsupportedError,
    type ByteRangeSource,
    type ZipProgress,
} from 'zipnative';
import { buildRawZip, seededRandom } from '../helpers/raw-zip-builder.ts';

/** Moderately compressible bytes (6 bits of entropy each): deflate keeps ~75 %, enough for several ranged chunks. */
function semiRandom(size: number, seed: number): Uint8Array {
    const rand = seededRandom(seed);
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) out[i] = Math.floor(rand() * 64) + 32;
    return out;
}

/**
 * `openZipRange()` (1.1.0) — the in-memory reader's contract over an
 * injected byte-range source. Held to strict PARITY with `openZip` on
 * entries, bytes, diagnostics and error codes; to O(central directory)
 * reads (a counting source proves what is fetched); and to the same
 * defences against hostile archives and hostile sources.
 */

const te = new TextEncoder();
const td = new TextDecoder();
const FIXTURES = resolve('tests/fixtures/interop');

/** A source that records every read it serves. */
function counting(bytes: Uint8Array): ByteRangeSource & { readonly reads: Array<[number, number]> } {
    const reads: Array<[number, number]> = [];
    return {
        size: bytes.length,
        reads,
        read: (offset, length) => {
            reads.push([offset, length]);
            return Promise.resolve(bytes.subarray(offset, offset + length));
        },
    };
}

function sample(): Uint8Array {
    const zip = createZip();
    zip.add('docs/readme.md', te.encode('# readme\n'.repeat(2000)));
    zip.add('bin/tool', te.encode('#!/bin/sh\necho hi\n'), { externalAttributes: (0o100755 << 16) >>> 0 });
    zip.addDirectory('empty');
    zip.add('raw.bin', new Uint8Array(3000).map((_, i) => i & 0xff), { compression: { method: 'store' } });
    zip.add('é/ünïcödé.txt', te.encode('utf-8 name'), { comment: 'noted' });
    return zip.toBytes();
}

async function collect(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const c of gen) parts.push(c);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
}

async function codeOf(fn: () => Promise<unknown> | unknown): Promise<string> {
    try { await fn(); } catch (err) { return err instanceof ZipError ? err.code : `non-ZipError: ${String(err)}`; }
    return 'no error';
}

describe('openZipRange — parity with openZip', () => {
    it('yields the same entries, bytes and verdicts as the in-memory reader', async () => {
        const bytes = sample();
        const mem = openZip(bytes);
        const range = await openZipRange(rangeSourceFromBytes(bytes));
        expect(range.size).toBe(bytes.length);
        expect(range.entryCount).toBe(mem.entryCount);
        expect(range.isZip64).toBe(mem.isZip64);
        expect(range.comment).toEqual(mem.comment);
        const memEntries = [...mem.entries()];
        const rangeEntries = [...range.entries()];
        expect(rangeEntries).toEqual(memEntries);
        for (const entry of memEntries) {
            expect(await range.readEntry(entry), entry.name).toEqual(mem.readEntry(entry));
            expect(await collect(range.readEntryStream(entry.name)), entry.name).toEqual(await collect(mem.readEntryStream(entry.name)));
            expect(await range.readEntryRaw(entry), entry.name).toEqual(mem.readEntryRaw(entry));
            expect(await range.verifyEntry(entry), entry.name).toEqual(mem.verifyEntry(entry));
        }
        expect(range.getEntry('é/ünïcödé.txt')?.name).toBe('é/ünïcödé.txt');
        expect(range.getEntry('missing')).toBeNull();
        expect(await codeOf(() => range.readEntry('missing'))).toBe('ZIP_ENTRY_NOT_FOUND');
    });

    it('agrees on every committed foreign fixture, including the SFX-prefixed and Zip64 shapes', async () => {
        const archives: Array<[string, Uint8Array]> = readdirSync(FIXTURES).filter((f) => f.endsWith('.zip'))
            .map((f) => [f, new Uint8Array(readFileSync(resolve(FIXTURES, f)))]);
        archives.push(['sfx', buildRawZip([{ name: 'a.txt', data: te.encode('stub') }], { prepend: te.encode('#!/bin/sh stub\n'.repeat(3)) })]);
        const big = createZip();
        for (let i = 0; i < 66_000; i++) big.add(`e/${i.toString(36)}`, 'x', { compression: { method: 'store' } });
        archives.push(['zip64', big.toBytes()]);
        for (const [label, bytes] of archives) {
            const memDiag: string[] = [];
            const rangeDiag: string[] = [];
            const mem = openZip(bytes, { onDiagnostic: (d) => memDiag.push(d.code) });
            const range = await openZipRange(rangeSourceFromBytes(bytes), { onDiagnostic: (d) => rangeDiag.push(d.code) });
            expect([...range.entries()], label).toEqual([...mem.entries()]);
            expect(rangeDiag, label).toEqual(memDiag);
            expect(range.isZip64, label).toBe(mem.isZip64);
            for (const entry of [...mem.entries()].slice(0, 5)) {
                if (entry.isDirectory) continue;
                expect(await range.readEntry(entry), `${label}:${entry.name}`).toEqual(mem.readEntry(entry));
            }
        }
    });

    it('honours dosTimeMode, nameDecoder and strict exactly like openZip', async () => {
        const legacy = buildRawZip([{ name: new Uint8Array([0xaf, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2]), data: te.encode('x') }]);
        const cp866 = (b: Uint8Array): string => new TextDecoder('ibm866').decode(b);
        expect([...(await openZipRange(rangeSourceFromBytes(legacy), { nameDecoder: cp866 })).entries()][0].name).toBe('привет');
        const prefixed = buildRawZip([{ name: 'a', data: te.encode('x') }], { prepend: te.encode('junk') });
        expect(await codeOf(() => openZipRange(rangeSourceFromBytes(prefixed), { strict: true }))).toBe('ZIP_STRICT_DIAGNOSTIC');
    });
});

describe('openZipRange — what it reads', () => {
    it('opens with the tail and the central directory only, then fetches per entry exactly its header and payload', async () => {
        // Larger than the tail window, so the reads are measurably partial.
        const bytes = buildRawZip([
            { name: 'docs/readme.md', data: te.encode('# readme\n'.repeat(2000)), method: 8 },
            { name: 'big.bin', data: semiRandom(400_000, 11), method: 0 },
            { name: 'raw.bin', data: new Uint8Array(3000).map((_, i) => i & 0xff), method: 0 },
        ]);
        const source = counting(bytes);
        const reader = await openZipRange(source);
        expect(source.reads).toHaveLength(2);
        const [tail, cd] = source.reads;
        expect(tail[0] + tail[1]).toBe(bytes.length);
        const mem = openZip(bytes);
        const cdOffset = [...mem.entries()].reduce((max, e) => Math.max(max, e.localHeaderOffset), 0);
        expect(cd[0]).toBeGreaterThan(cdOffset);
        expect(cd[1]).toBeLessThan(bytes.length - cd[0]);
        const total = source.reads.reduce((n, [, l]) => n + l, 0);
        expect(total).toBeLessThan(bytes.length);

        source.reads.length = 0;
        const entry = reader.getEntry('raw.bin')!;
        await reader.readEntry(entry);
        // Fixed header, full header, payload — nothing else.
        expect(source.reads.map(([, l]) => l)).toEqual([30, 30 + entry.rawName.length + 0, entry.compressedSize]);
        expect(source.reads[0][0]).toBe(entry.localHeaderOffset);
    });

    it('streams a deflated entry through ranged reads and the incremental decoder — never the whole payload at once', async () => {
        // node:zlib-deflated by the raw builder (the pure encoder would take a minute on 2 MB).
        const big = semiRandom(2_000_000, 7);
        const bytes = buildRawZip([{ name: 'big.txt', data: big, method: 8 }]);
        const source = counting(bytes);
        const reader = await openZipRange(source, { limits: { maxEntryCompressedSize: 1 } });
        source.reads.length = 0;
        const out = await collect(reader.readEntryStream('big.txt'));
        // Buffer.compare: a deep equality over two million elements costs twenty seconds in the matcher.
        expect(Buffer.compare(out, big)).toBe(0);
        // The compressed-size limit was never consulted: streaming fetched ranges, never the payload whole.
        const entry = reader.getEntry('big.txt')!;
        const payloadReads = source.reads.slice(2);
        expect(payloadReads.reduce((n, [, l]) => n + l, 0)).toBe(entry.compressedSize);
        expect(payloadReads.every(([, l]) => l <= 256 * 1024)).toBe(true);
    });

    it('a codec without an incremental decoder is fetched whole, bounded by maxEntryCompressedSize', async () => {
        registerCodec({ method: 87, name: 'whole-only', decompressSync: (d) => d, decompressStream: async function* (d) { yield d; } });
        const archive = buildRawZip([{ name: 'x.bin', data: te.encode('payload'), method: 87 }]);
        const reader = await openZipRange(rangeSourceFromBytes(archive));
        expect(td.decode(await collect(reader.readEntryStream('x.bin')))).toBe('payload');
        const tight = await openZipRange(rangeSourceFromBytes(archive), { limits: { maxEntryCompressedSize: 3 } });
        expect(await codeOf(() => collect(tight.readEntryStream('x.bin')))).toBe('ZIP_LIMIT_EXCEEDED');
        expect(await codeOf(() => tight.readEntry('x.bin'))).toBe('ZIP_LIMIT_EXCEEDED');
        // The in-memory reader does not consult the limit: its payloads are views.
        expect(td.decode(openZip(archive, { limits: { maxEntryCompressedSize: 3 } }).readEntry('x.bin'))).toBe('payload');
    });

    it('reports progress and honours an abort between ranged reads', async () => {
        const zip = createZip({ compression: { method: 'store' } });
        zip.add('big.bin', new Uint8Array(1_000_000));
        const bytes = zip.toBytes();
        const log: ZipProgress[] = [];
        const reader = await openZipRange(rangeSourceFromBytes(bytes), { onProgress: (p) => log.push(p) });
        await collect(reader.readEntryStream('big.bin'));
        expect(log.at(-1)).toEqual({ entriesDone: 1, entriesTotal: 1, bytesIn: 1_000_000, bytesOut: 1_000_000 });

        const controller = new AbortController();
        const aborting = await openZipRange(rangeSourceFromBytes(bytes), { signal: controller.signal });
        let seen = 0;
        let err: unknown;
        try {
            for await (const chunk of aborting.readEntryStream('big.bin')) {
                seen += chunk.length;
                controller.abort();
            }
        } catch (e) { err = e; }
        expect((err as Error).name).toBe('AbortError');
        expect(seen).toBeLessThan(1_000_000);
        expect(await codeOf(() => openZipRange(rangeSourceFromBytes(bytes), { signal: AbortSignal.abort(new ZipError('ZIP_INTERNAL', 'x')) }))).toBe('ZIP_INTERNAL');
    });
});

describe('openZipRange — hostile archives and hostile sources', () => {
    it('the same refusals as openZip: overlap, method mismatch, size contradiction, encryption, CRC', async () => {
        const overlap = buildRawZip([
            { name: 'a.txt', data: te.encode('aaaaaaaaaa') },
            { name: 'b.txt', data: te.encode('b'), localHeaderOffsetOverride: 0 },
        ]);
        const r1 = await openZipRange(rangeSourceFromBytes(overlap));
        expect(await codeOf(() => r1.readEntry('b.txt'))).toBe('ZIP_ENTRY_OVERLAP');
        expect(await codeOf(() => openZipRange(rangeSourceFromBytes(overlap), { validate: 'eager' }))).toBe('ZIP_ENTRY_OVERLAP');

        const method = buildRawZip([{ name: 'm.txt', data: te.encode('x'), method: 8, lfhMethodOverride: 0 }]);
        expect(await codeOf(async () => (await openZipRange(rangeSourceFromBytes(method))).readEntry('m.txt'))).toBe('ZIP_CD_LFH_MISMATCH');

        const crc = buildRawZip([{ name: 'c.txt', data: te.encode('x'), lfhCrcOverride: 0xdeadbeef }]);
        expect(await codeOf(async () => (await openZipRange(rangeSourceFromBytes(crc))).readEntry('c.txt'))).toBe('ZIP_SIZE_MISMATCH');

        const sealed = buildRawZip([{ name: 's.bin', data: te.encode('x'), flags: 0x0001 }]);
        const r4 = await openZipRange(rangeSourceFromBytes(sealed));
        expect(await codeOf(() => r4.readEntryRaw('s.bin'))).toBe('ZIP_UNSUPPORTED_ENCRYPTION');
        expect((await r4.verifyEntry('s.bin')).skipped).toBe('encrypted');

        const bad = buildRawZip([{ name: 'bad.bin', data: te.encode('verify me '.repeat(300)), method: 8, corruptDataAt: 10 }]);
        const r5 = await openZipRange(rangeSourceFromBytes(bad));
        expect(['ZIP_DEFLATE_CORRUPT', 'ZIP_DEFLATE_TRUNCATED', 'ZIP_CRC_MISMATCH', 'ZIP_SIZE_MISMATCH']).toContain(await codeOf(() => r5.readEntry('bad.bin')));
        expect((await r5.verifyEntry('bad.bin')).ok).toBe(false);
    });

    it('a source that lies about its size, returns short reads, or rejects', async () => {
        const bytes = sample();
        const lying: ByteRangeSource = { size: bytes.length + 1000, read: (o, l) => Promise.resolve(bytes.subarray(o, o + l)) };
        expect(await codeOf(() => openZipRange(lying))).toBe('ZIP_RECORD_TRUNCATED');
        const short: ByteRangeSource = { size: bytes.length, read: (o, l) => Promise.resolve(bytes.subarray(o, o + Math.floor(l / 2))) };
        expect(await codeOf(() => openZipRange(short))).toBe('ZIP_RECORD_TRUNCATED');
        const failing: ByteRangeSource = { size: bytes.length, read: () => Promise.reject(new Error('network down')) };
        let err: unknown;
        try { await openZipRange(failing); } catch (e) { err = e; }
        expect((err as Error).message).toBe('network down'); // the caller's own error, untouched
        expect(await codeOf(() => openZipRange({ size: 1.5, read: () => Promise.resolve(new Uint8Array(0)) }))).toBe('ZIP_INVALID_OPTION');
        expect(await codeOf(() => openZipRange(rangeSourceFromBytes(new Uint8Array(10))))).toBe('ZIP_EOCD_NOT_FOUND');
    });

    it('limits apply before the central directory is fetched', async () => {
        const bytes = sample();
        const source = counting(bytes);
        expect(await codeOf(() => openZipRange(source, { limits: { maxEntries: 2 } }))).toBe('ZIP_LIMIT_EXCEEDED');
        expect(source.reads).toHaveLength(1); // the tail only — the directory was never requested
        expect(() => openZip(bytes, { limits: { maxEntries: 2 } })).toThrow(ZipLimitError);
    });

    it('a Zip64 record away from its locator is refused by this reader, not guessed', async () => {
        // An archive with the sentinels set and a locator whose record is NOT adjacent: the tail
        // window sees the locator but not the record → ZIP_ZIP64_EOCD_MISPLACED, as documented.
        const bytes = buildRawZip([{ name: 'a', data: te.encode('x') }], { forceZip64: true, zip64DropRecord: true });
        expect(await codeOf(() => openZipRange(rangeSourceFromBytes(bytes)))).toBe('ZIP_ZIP64_EOCD_MISPLACED');
        expect(() => openZip(bytes)).toThrow(ZipFormatError);
    });

    it('the writer transplants from a range reader through readEntryRaw', async () => {
        const bytes = sample();
        const range = await openZipRange(rangeSourceFromBytes(bytes));
        const entry = range.getEntry('docs/readme.md')!;
        const zip = createZip();
        zip.addRaw('copy.md', await range.readEntryRaw(entry), { method: entry.compressionMethod, crc32: entry.crc32, uncompressedSize: entry.uncompressedSize });
        expect(openZip(zip.toBytes()).readEntry('copy.md')).toEqual(openZip(bytes).readEntry('docs/readme.md'));
        // And the modifier is in-memory only: a range reader is not a ZipReader (no bytes).
        expect(() => createZipModifier(openZip(bytes))).not.toThrow();
        expect(ZipSecurityError).toBeDefined();
        expect(ZipDataError).toBeDefined();
        expect(ZipUnsupportedError).toBeDefined();
    });
});
