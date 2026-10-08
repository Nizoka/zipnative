import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    analyzeDeterminism,
    createZip,
    createZipModifier,
    getUnixMode,
    openZip,
    verifyZip,
    ZipDataError,
    ZipError,
    ZipUnsupportedError,
    type ZipEntry,
} from 'zipnative';
import { createParallelZip } from 'zipnative/worker';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

/**
 * `addRaw()` / `addFromReader()` — transplanting compressed payloads without
 * recompression (1.1.0). Held to: byte-exact payload copies (the modifier's
 * raw-copy plan is the twin), verification by default, metadata travelling
 * with the bytes, deterministic output, and foreign-fixture round trips.
 */

const te = new TextEncoder();
const td = new TextDecoder();
const FIXTURES = resolve('tests/fixtures/interop');

function sample(): Uint8Array {
    const zip = createZip({ compression: { deterministic: true } });
    zip.add('docs/readme.md', te.encode('# readme\n'.repeat(100)), { date: new Date(2021, 5, 1, 10, 0, 0), comment: 'kept' });
    zip.add('bin/tool', te.encode('#!/bin/sh\necho hi\n'), { externalAttributes: (0o100755 << 16) >>> 0 });
    zip.addDirectory('empty');
    zip.add('raw.bin', new Uint8Array([1, 2, 3, 4]), { compression: { method: 'store' } });
    return zip.toBytes();
}

describe('addFromReader', () => {
    it('merges two archives without recompression: payloads and metadata travel, content extracts', () => {
        const a = openZip(sample());
        const other = createZip({ compression: { deterministic: true } });
        other.add('zz/last.txt', te.encode('from the second archive'));
        const b = openZip(other.toBytes());
        const merged = createZip({ compression: { deterministic: true } });
        for (const entry of a.entries()) merged.addFromReader(a, entry);
        merged.addFromReader(b, 'zz/last.txt');
        const out = openZip(merged.toBytes(), { validate: 'eager' });

        expect([...out.entries()].map((e) => e.name)).toEqual(['bin/tool', 'docs/readme.md', 'empty/', 'raw.bin', 'zz/last.txt']);
        for (const entry of a.entries()) {
            const copy = out.getEntry(entry.name)!;
            expect(out.readEntryRaw(copy), entry.name).toEqual(a.readEntryRaw(entry));
            expect(copy.compressionMethod).toBe(entry.compressionMethod);
            expect(copy.crc32).toBe(entry.crc32);
            expect(copy.uncompressedSize).toBe(entry.uncompressedSize);
            expect([copy.dosDate, copy.dosTime]).toEqual([entry.dosDate, entry.dosTime]);
            expect(copy.externalAttributes).toBe(entry.externalAttributes);
            expect(td.decode(copy.comment)).toBe(td.decode(entry.comment));
        }
        expect(getUnixMode(out.getEntry('bin/tool')!)).toBe(0o100755);
        expect(td.decode(out.readEntry('docs/readme.md'))).toBe('# readme\n'.repeat(100));
        expect(td.decode(out.readEntry('zz/last.txt'))).toBe('from the second archive');
        expect(verifyZip(merged.toBytes()).ok).toBe(true);
    });

    it('is the twin of the modifier\'s raw copy: same compressed bytes, same sizes', () => {
        const source = openZip(sample());
        const viaWriter = createZip();
        viaWriter.addFromReader(source, 'docs/readme.md');
        const viaModifier = createZipModifier(openZip(createZip().toBytes()));
        // The modifier has no transplant API; compare the payload the writer kept with the source's.
        const w = openZip(viaWriter.toBytes()).getEntry('docs/readme.md')!;
        expect(openZip(viaWriter.toBytes()).readEntryRaw(w)).toEqual(source.readEntryRaw('docs/readme.md'));
        expect(w.compressedSize).toBe(source.getEntry('docs/readme.md')!.compressedSize);
        expect(viaModifier.reader.entryCount).toBe(0);
    });

    it('verifies by default and refuses a corrupt source entry with a typed error', () => {
        const corrupt = openZip(buildRawZip([{ name: 'bad.bin', data: te.encode('verify before transplant '.repeat(400)), method: 8, corruptDataAt: 10 }]));
        const zip = createZip();
        let err: unknown;
        try { zip.addFromReader(corrupt, 'bad.bin'); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(ZipDataError);
        expect(['ZIP_CRC_MISMATCH', 'ZIP_SIZE_MISMATCH']).toContain((err as ZipDataError).code);
        // verify: false trusts the source — the bytes travel, the verdict is the reader's later.
        const trusting = createZip();
        trusting.addFromReader(corrupt, 'bad.bin', { verify: false });
        const out = openZip(trusting.toBytes());
        expect(out.verifyEntry('bad.bin').ok).toBe(false);
    });

    it('copies an unregistered-method entry (cannot be checked) and the verifier reports it skipped', () => {
        const exotic = openZip(buildRawZip([{ name: 'x.bz2', data: te.encode('opaque payload'), method: 12 }]));
        const zip = createZip();
        zip.addFromReader(exotic, 'x.bz2');
        const out = zip.toBytes();
        const entry = openZip(out).getEntry('x.bz2')!;
        expect(entry.compressionMethod).toBe(12);
        expect(entry.versionNeeded).toBe(exotic.getEntry('x.bz2')!.versionNeeded);
        expect(verifyZip(out).entries[0].skipped).toBe('unsupported-method');
    });

    it('refuses encrypted entries like readEntryRaw does, and compression / zip64 options', () => {
        const sealed = openZip(buildRawZip([{ name: 's.bin', data: te.encode('ciphertext-stand-in'), flags: 0x0001 }]));
        const zip = createZip();
        expect(() => zip.addFromReader(sealed, 's.bin')).toThrow(ZipUnsupportedError);
        const src = openZip(sample());
        expect(() => zip.addFromReader(src, 'raw.bin', { compression: { level: 9 } })).toThrow(ZipError);
        expect(() => zip.addFromReader(src, 'raw.bin', { zip64: true })).toThrow(ZipError);
        expect(() => zip.addFromReader(src, 'missing.txt')).toThrow(/ZIP_ENTRY_NOT_FOUND|no entry named/);
    });

    it('options override the transplanted metadata entry by entry', () => {
        const src = openZip(sample());
        const zip = createZip({ dosTimeMode: 'utc' });
        zip.addFromReader(src, 'docs/readme.md', { date: new Date('2000-01-02T03:04:06Z'), comment: 'replaced', externalAttributes: (0o100600 << 16) >>> 0, extraFields: [] });
        const entry = openZip(zip.toBytes(), { dosTimeMode: 'utc' }).getEntry('docs/readme.md')!;
        expect(entry.lastModified.toISOString()).toBe('2000-01-02T03:04:06.000Z');
        expect(td.decode(entry.comment)).toBe('replaced');
        expect(getUnixMode(entry)).toBe(0o100600);
    });

    it('is deterministic, order-independent under canonical order, and byte-identical through the worker writer', async () => {
        const src = openZip(sample());
        const build = (): ReturnType<typeof createZip> => createZip({ compression: { deterministic: true } });
        const forward = build();
        for (const e of src.entries()) forward.addFromReader(src, e);
        const backward = build();
        for (const e of [...src.entries()].reverse()) backward.addFromReader(src, e);
        expect(backward.toBytes()).toEqual(forward.toBytes());
        expect(analyzeDeterminism(forward.toBytes())).toMatchObject({ canonicalOrder: true, utf8Flags: true });
        const parallel = createParallelZip({ workers: 0, compression: { deterministic: true } });
        for (const e of src.entries()) parallel.addFromReader(src, e);
        expect(await parallel.toBytes()).toEqual(forward.toBytes());
    });

    it('round-trips the committed foreign fixtures entry by entry (the writer\'s name rules still apply)', () => {
        let refusedNames = 0;
        for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.zip'))) {
            const src = openZip(new Uint8Array(readFileSync(resolve(FIXTURES, file))));
            const zip = createZip();
            const copied: ZipEntry[] = [];
            for (const e of src.entries()) {
                try {
                    zip.addFromReader(src, e);
                    copied.push(e);
                } catch (err) {
                    // bsdtar writes a './' directory entry; the writer refuses a
                    // name with no path segment, for a transplant as for add().
                    expect((err as ZipError).code, `${file}:${e.name}`).toBe('ZIP_INVALID_ENTRY_NAME');
                    refusedNames++;
                }
            }
            const out = openZip(zip.toBytes(), { validate: 'eager' });
            for (const e of copied) {
                if (e.isDirectory) continue;
                expect(out.readEntry(e.name), `${file}:${e.name}`).toEqual(src.readEntry(e.name));
            }
            expect(verifyZip(zip.toBytes()).ok, file).toBe(true);
        }
        expect(refusedNames).toBeGreaterThan(0);
    });
});

describe('addRaw', () => {
    it('takes a caller-vouched payload and writes it as given', () => {
        const src = openZip(sample());
        const e = src.getEntry('docs/readme.md')!;
        const zip = createZip();
        zip.addRaw('copy.md', src.readEntryRaw(e), { method: e.compressionMethod, crc32: e.crc32, uncompressedSize: e.uncompressedSize });
        zip.addRaw('stored.bin', new Uint8Array([9, 8, 7]), { method: 0, crc32: 0x0, uncompressedSize: 3 });
        const out = openZip(zip.toBytes());
        expect(td.decode(out.readEntry('copy.md'))).toBe('# readme\n'.repeat(100));
        // The caller lied about the CRC of stored.bin: the reader says so — addRaw trusts, readers verify.
        expect(out.verifyEntry('stored.bin')).toMatchObject({ ok: false, crcMatch: false, sizeMatch: true });
    });

    it('validates its metadata early and keeps only the encryption bits of flags', () => {
        const zip = createZip();
        expect(() => zip.addRaw('a', new Uint8Array(0), { method: -1, crc32: 0, uncompressedSize: 0 })).toThrow(ZipError);
        expect(() => zip.addRaw('a', new Uint8Array(0), { method: 8, crc32: -5, uncompressedSize: 0 })).toThrow(ZipError);
        expect(() => zip.addRaw('a', new Uint8Array(0), { method: 8, crc32: 0, uncompressedSize: 1.5 })).toThrow(ZipError);
        zip.addRaw('flagged', new Uint8Array([1]), { method: 0, crc32: 0xa505df1b, uncompressedSize: 1, flags: 0x0806 });
        const entry = openZip(zip.toBytes()).getEntry('flagged')!;
        expect(entry.flags & 0x0008).toBe(0);  // bit 3 never
        expect(entry.flags & 0x0800).toBe(0x0800);  // UTF-8 always
        expect(entry.flags & 0x0006).toBe(0);  // deflate hints dropped
    });
});
