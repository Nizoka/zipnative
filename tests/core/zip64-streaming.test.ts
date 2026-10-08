import { describe, expect, it } from 'vitest';
import { createZip, createZipModifier, iterateZipEntries, openZip, verifyZip, ZipError, ZipUnsupportedError } from 'zipnative';
import { createParallelZip } from 'zipnative/worker';
import { assertStreamSizesInRange, type PlannedEntry } from '../../src/core/zip-segments.ts';

/**
 * The Zip64 streaming opt-in (ROADMAP 0.9 decision record, shipped 1.1.0):
 * `addStream(name, source, { zip64: true })` writes the speculative layout
 * APPNOTE §4.5.3 / §4.3.9.2 prescribe for a stream whose size is unknown
 * up front and may exceed 4 GiB. Structure is asserted byte by byte on a
 * small entry; the real 4 GiB + 1 crossing runs behind ZIPNATIVE_BIG_TESTS
 * (conformance.yml) because it moves four gigabytes through the re-chunker.
 */

const te = new TextEncoder();
const TEXT = te.encode('zip64 streaming opt-in '.repeat(200));
const SIG_LFH = 0x04034b50;
const SIG_CFH = 0x02014b50;
const SIG_DESC = 0x08074b50;
const SIG_Z64_EOCD = 0x06064b50;

async function* chunks(bytes: Uint8Array, size = 777): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, Math.min(i + size, bytes.length));
}

async function collect(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const c of gen) parts.push(c);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
}

function u16(b: Uint8Array, p: number): number { return b[p] | (b[p + 1] << 8); }
function u32(b: Uint8Array, p: number): number { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
function u64(b: Uint8Array, p: number): number { return Number(new DataView(b.buffer, b.byteOffset + p, 8).getBigUint64(0, true)); }
/** Offset of the first occurrence of a 4-byte little-endian signature at or after `from`. */
function findSig(b: Uint8Array, sig: number, from: number): number {
    for (let p = from; p + 4 <= b.length; p++) if (u32(b, p) === sig) return p;
    return -1;
}

/** Parse the first local header: returns the fields and the extra block. */
function lfhAt(b: Uint8Array, p: number): { version: number; flags: number; crc: number; csize: number; usize: number; nameLen: number; extra: Uint8Array; dataStart: number } {
    expect(u32(b, p)).toBe(SIG_LFH);
    const nameLen = u16(b, p + 26);
    const extraLen = u16(b, p + 28);
    return {
        version: u16(b, p + 4), flags: u16(b, p + 6), crc: u32(b, p + 14), csize: u32(b, p + 18), usize: u32(b, p + 22),
        nameLen, extra: b.subarray(p + 30 + nameLen, p + 30 + nameLen + extraLen), dataStart: p + 30 + nameLen + extraLen,
    };
}

async function buildOptIn(method: 'store' | 'deflate'): Promise<Uint8Array> {
    const zip = createZip({ compression: { method, deterministic: true } });
    zip.addStream('big.txt', chunks(TEXT), { zip64: true });
    zip.add('small.txt', te.encode('buffered neighbour'));
    return collect(zip.stream());
}

describe('Zip64 streaming opt-in — structure on a small entry', () => {
    for (const method of ['store', 'deflate'] as const) {
        it(`${method}: local header in the speculative form, 24-byte descriptor, both sizes in the central extra`, async () => {
            const bytes = await buildOptIn(method);
            const lfh = lfhAt(bytes, 0);
            expect(lfh.version).toBe(45);
            expect(lfh.flags & 0x0008).toBe(0x0008);
            expect(lfh.crc).toBe(0);
            expect(lfh.csize).toBe(0xffffffff);
            expect(lfh.usize).toBe(0xffffffff);
            // Zip64 extra (0x0001, 16 bytes of zero placeholders).
            expect(u16(lfh.extra, 0)).toBe(0x0001);
            expect(u16(lfh.extra, 2)).toBe(16);
            expect(u64(lfh.extra, 4)).toBe(0);
            expect(u64(lfh.extra, 12)).toBe(0);

            const reader = openZip(bytes, { validate: 'eager' });
            const entry = reader.getEntry('big.txt');
            expect(entry).not.toBeNull();
            expect(entry!.usesZip64).toBe(true);
            expect(entry!.usesDataDescriptor).toBe(true);
            expect(entry!.uncompressedSize).toBe(TEXT.length);
            // The 24-byte descriptor sits right after the payload.
            const descAt = lfh.dataStart + entry!.compressedSize;
            expect(u32(bytes, descAt)).toBe(SIG_DESC);
            expect(u32(bytes, descAt + 4)).toBe(entry!.crc32);
            expect(u64(bytes, descAt + 8)).toBe(entry!.compressedSize);
            expect(u64(bytes, descAt + 16)).toBe(entry!.uncompressedSize);
            // Central record: both classic sizes sentinelled, extra carries both sizes, no offset (it did not overflow).
            const cdPos = findSig(bytes, SIG_CFH, descAt + 24);
            expect(cdPos).toBeGreaterThan(0);
            expect(u16(bytes, cdPos + 6)).toBe(45);
            expect(u32(bytes, cdPos + 20)).toBe(0xffffffff);
            expect(u32(bytes, cdPos + 24)).toBe(0xffffffff);
            expect(u32(bytes, cdPos + 42)).toBe(0); // offset of the first entry, classic field
            const cdNameLen = u16(bytes, cdPos + 28);
            const cdExtra = bytes.subarray(cdPos + 46 + cdNameLen, cdPos + 46 + cdNameLen + u16(bytes, cdPos + 30));
            expect(u16(cdExtra, 0)).toBe(0x0001);
            expect(u16(cdExtra, 2)).toBe(16);
            expect(u64(cdExtra, 4)).toBe(entry!.uncompressedSize);
            expect(u64(cdExtra, 12)).toBe(entry!.compressedSize);
            // No archive-level Zip64 records: nothing at that level overflowed.
            expect(findSig(bytes, SIG_Z64_EOCD, cdPos)).toBe(-1);

            // Readers: random access, the verifier, and (deflate only) the forward reader.
            expect(reader.readEntry('big.txt')).toEqual(TEXT);
            expect(reader.verifyEntry('big.txt').ok).toBe(true);
            expect(verifyZip(bytes).ok).toBe(true);
            if (method === 'deflate') {
                for await (const e of iterateZipEntries(chunks(bytes, 1000))) {
                    if (e.header.name === 'big.txt') expect(await collect(e.data())).toEqual(TEXT);
                    else await e.skip();
                }
            }
        });
    }

    it('the neighbouring buffered entry keeps the classic layout: the opt-in is per entry', async () => {
        const bytes = await buildOptIn('deflate');
        const reader = openZip(bytes);
        const small = reader.getEntry('small.txt')!;
        expect(small.usesZip64).toBe(false);
        expect(small.usesDataDescriptor).toBe(false);
        expect(small.versionNeeded).toBe(20);
    });

    it('without the opt-in the stream layout is byte-identical to 1.0.0 (16-byte descriptor, version 20)', async () => {
        const zip = createZip({ compression: { deterministic: true } });
        zip.addStream('big.txt', chunks(TEXT));
        const bytes = await collect(zip.stream());
        const lfh = lfhAt(bytes, 0);
        expect(lfh.version).toBe(20);
        expect(lfh.csize).toBe(0);
        expect(lfh.extra.length).toBe(0);
        const entry = openZip(bytes).getEntry('big.txt')!;
        expect(entry.usesZip64).toBe(false);
        expect(u32(bytes, lfh.dataStart + entry.compressedSize + 8)).toBe(entry.compressedSize);
    });

    it('the opt-in is deterministic and byte-identical through the worker writer', async () => {
        const a = await buildOptIn('deflate');
        const b = await buildOptIn('deflate');
        expect(b).toEqual(a);
        const parallel = createParallelZip({ workers: 0, compression: { deterministic: true } });
        parallel.addStream('big.txt', chunks(TEXT), { zip64: true });
        parallel.add('small.txt', te.encode('buffered neighbour'));
        expect(await collect(parallel.stream())).toEqual(a);
    });
});

describe('Zip64 streaming opt-in — refusals and the classic guard', () => {
    it('add(), addDirectory() and the modifier reject zip64 at the call site', () => {
        const zip = createZip();
        expect(() => zip.add('a.txt', te.encode('x'), { zip64: true })).toThrow(ZipError);
        expect(() => zip.add('a.txt', te.encode('x'), { zip64: false })).toThrow(/zip64 applies to addStream\(\) only/);
        expect(() => zip.addDirectory('d/', { zip64: true })).toThrow(ZipError);
        const base = createZip();
        base.add('a.txt', te.encode('x'));
        const mod = createZipModifier(openZip(base.toBytes()));
        expect(() => mod.addEntry('b.txt', te.encode('y'), { zip64: true })).toThrow(ZipError);
    });

    it('a classic stream crossing 4 GiB is still refused, and the message names the opt-in', () => {
        const plan = { uncompressedSize: 5 * 1024 ** 3, compressedSize: 1024, zip64: false } as PlannedEntry;
        let err: unknown;
        try { assertStreamSizesInRange(plan, 'huge.bin'); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(ZipUnsupportedError);
        expect((err as ZipUnsupportedError).code).toBe('ZIP_UNSUPPORTED_ZIP64_STREAMING');
        expect((err as Error).message).toContain('{ zip64: true }');
        // An opted-in plan is never refused by the guard.
        expect(() => assertStreamSizesInRange({ ...plan, zip64: true } as PlannedEntry, 'huge.bin')).not.toThrow();
    });
});

// ── The real crossing: 4 GiB + 1 bytes of zeros through the re-chunker ──
//
// Four gigabytes of memcpy and CRC: 5–15 s on a laptop, more under
// coverage, so it runs in conformance.yml (ZIPNATIVE_BIG_TESTS=1) and is
// skipped elsewhere. A sink keeps only the first KiB and the last 512 bytes.
describe.runIf(process.env.ZIPNATIVE_BIG_TESTS === '1')('Zip64 streaming opt-in — 4 GiB + 1 (ZIPNATIVE_BIG_TESTS)', () => {
    it('writes the 24-byte descriptor past 2^32 and the central extra carries the real sizes', async () => {
        const CHUNK = 16 * 1024 * 1024;
        const zero = new Uint8Array(CHUNK);
        const TOTAL = 4 * 1024 ** 3 + 1;
        async function* zeros(): AsyncGenerator<Uint8Array> {
            let left = TOTAL;
            while (left > 0) {
                const n = Math.min(CHUNK, left);
                yield n === CHUNK ? zero : zero.subarray(0, n);
                left -= n;
            }
        }
        // Insertion order: the big entry must be the FIRST local header (the
        // canonical sort would put 'tail.txt' before 'zeros.bin').
        const zip = createZip({ order: 'insertion', compression: { method: 'store' } });
        zip.addStream('zeros.bin', zeros(), { zip64: true });
        zip.add('tail.txt', te.encode('after the big one'));

        let length = 0;
        const head = new Uint8Array(1024);
        let tail = new Uint8Array(0);
        for await (const chunk of zip.stream({ chunkSize: CHUNK })) {
            if (length < head.length) head.set(chunk.subarray(0, Math.min(chunk.length, head.length - length)), length);
            const keep = 512;
            if (chunk.length >= keep) tail = chunk.slice(chunk.length - keep);
            else {
                const joined = new Uint8Array(tail.length + chunk.length);
                joined.set(tail); joined.set(chunk, tail.length);
                tail = joined.slice(Math.max(0, joined.length - keep));
            }
            length += chunk.length;
        }

        const lfh = lfhAt(head, 0);
        expect(lfh.version).toBe(45);
        expect(lfh.csize).toBe(0xffffffff);
        const descAt = lfh.dataStart + TOTAL; // store: compressed == uncompressed
        expect(descAt).toBeGreaterThan(2 ** 32);
        // The tail window holds: descriptor(24) + second LFH + payload + 2 CFH + Zip64 EOCD + locator + EOCD.
        const descInTail = tail.length - (length - descAt);
        expect(u32(tail, descInTail)).toBe(SIG_DESC);
        expect(u64(tail, descInTail + 8)).toBe(TOTAL);
        expect(u64(tail, descInTail + 16)).toBe(TOTAL);
        // Second entry's offset overflowed 2^32: its central record carries the offset in its extra.
        const firstCfh = findSig(tail, SIG_CFH, descInTail + 24);
        expect(firstCfh).toBeGreaterThan(0);
        expect(u32(tail, firstCfh + 20)).toBe(0xffffffff);
        const n1 = u16(tail, firstCfh + 28), x1 = u16(tail, firstCfh + 30), c1 = u16(tail, firstCfh + 32);
        const extra1 = tail.subarray(firstCfh + 46 + n1, firstCfh + 46 + n1 + x1);
        expect(u64(extra1, 4)).toBe(TOTAL);
        expect(u64(extra1, 12)).toBe(TOTAL);
        const secondCfh = firstCfh + 46 + n1 + x1 + c1;
        expect(u32(tail, secondCfh)).toBe(SIG_CFH);
        expect(u32(tail, secondCfh + 42)).toBe(0xffffffff); // offset sentinel
        const n2 = u16(tail, secondCfh + 28), x2 = u16(tail, secondCfh + 30);
        const extra2 = tail.subarray(secondCfh + 46 + n2, secondCfh + 46 + n2 + x2);
        expect(u16(extra2, 2)).toBe(8); // offset only
        expect(u64(extra2, 4)).toBe(descAt + 24);
        // Zip64 EOCD present (cdOffset > 2^32).
        expect(findSig(tail, SIG_Z64_EOCD, secondCfh)).toBeGreaterThan(0);
    }, 600_000);
});
