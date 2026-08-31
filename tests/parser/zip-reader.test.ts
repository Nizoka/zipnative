import { describe, expect, it, vi, afterEach } from 'vitest';
import {
    openZip,
    ZipError,
    ZipUnsupportedError,
    type ZipDiagnostic,
} from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();
const td = new TextDecoder();

const HELLO = te.encode('hello zipnative');
const LOREM = te.encode('lorem ipsum dolor sit amet '.repeat(100));

function basicArchive(): Uint8Array {
    return buildRawZip([
        { name: 'hello.txt', data: HELLO, method: 0 },
        { name: 'docs/lorem.txt', data: LOREM, method: 8 },
        { name: 'dir/', data: new Uint8Array(0), method: 0, externalAttributes: 0x10 },
    ]);
}

describe('openZip', () => {
    afterEach(() => vi.restoreAllMocks());

    it('exposes entryCount without parsing the central directory', () => {
        const reader = openZip(basicArchive());
        expect(reader.entryCount).toBe(3);
    });

    it('iterates entries with correct metadata', () => {
        const reader = openZip(basicArchive());
        const entries = [...reader.entries()];
        expect(entries.map((e) => e.name)).toEqual(['hello.txt', 'docs/lorem.txt', 'dir/']);
        expect(entries[0].uncompressedSize).toBe(HELLO.length);
        expect(entries[0].compressionMethod).toBe(0);
        expect(entries[1].compressionMethod).toBe(8);
        expect(entries[1].compressedSize).toBeLessThan(LOREM.length);
        expect(entries[2].isDirectory).toBe(true);
        expect(entries[0].isDirectory).toBe(false);
    });

    it('getEntry returns null for a missing name', () => {
        const reader = openZip(basicArchive());
        expect(reader.getEntry('nope.txt')).toBeNull();
        expect(reader.getEntry('hello.txt')?.name).toBe('hello.txt');
    });

    it('readEntry decompresses store and deflate entries, CRC-verified', () => {
        const reader = openZip(basicArchive());
        expect(td.decode(reader.readEntry('hello.txt'))).toBe('hello zipnative');
        expect(reader.readEntry('docs/lorem.txt')).toEqual(LOREM);
    });

    it('readEntry on a store entry returns owned bytes (mutation-safe)', () => {
        const bytes = basicArchive();
        const reader = openZip(bytes);
        const out = reader.readEntry('hello.txt');
        out[0] ^= 0xff;
        expect(reader.readEntry('hello.txt')).toEqual(HELLO);
    });

    it('readEntryRaw returns the zero-copy compressed payload', () => {
        const bytes = basicArchive();
        const reader = openZip(bytes);
        const raw = reader.readEntryRaw('hello.txt');
        expect(raw.buffer).toBe(bytes.buffer); // same backing buffer: zero-copy
        expect(td.decode(raw)).toBe('hello zipnative'); // stored → identical bytes
    });

    it('readEntryStream yields chunks that reassemble the entry', async () => {
        const reader = openZip(basicArchive());
        const chunks: Uint8Array[] = [];
        for await (const chunk of reader.readEntryStream('docs/lorem.txt')) {
            chunks.push(chunk);
        }
        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        expect(total).toBe(LOREM.length);
    });

    it('verifyEntry reports ok for intact entries', () => {
        const reader = openZip(basicArchive());
        expect(reader.verifyEntry('docs/lorem.txt')).toEqual({
            ok: true, crcMatch: true, sizeMatch: true, localHeaderMatch: true,
        });
    });

    it('verifyEntry reports failure without throwing for corrupt data', () => {
        const archive = buildRawZip([
            { name: 'bad.bin', data: LOREM, method: 8, corruptDataAt: 10 },
        ]);
        const verification = openZip(archive).verifyEntry('bad.bin');
        expect(verification.ok).toBe(false);
    });

    it('exposes the archive comment', () => {
        const archive = buildRawZip([{ name: 'a.txt', data: HELLO }], { comment: te.encode('release build') });
        expect(td.decode(openZip(archive).comment)).toBe('release build');
    });

    it('decodes UTF-8 names when flag bit 11 is set', () => {
        const archive = buildRawZip([
            { name: te.encode('文档/résumé.txt'), data: HELLO, flags: 0x0800 },
        ]);
        const entry = [...openZip(archive).entries()][0];
        expect(entry.name).toBe('文档/résumé.txt');
        expect(entry.nameEncoding).toBe('utf-8');
    });

    it('reports duplicate names and getEntry returns the last occurrence', () => {
        const diagnostics: ZipDiagnostic[] = [];
        const archive = buildRawZip([
            { name: 'same.txt', data: te.encode('first') },
            { name: 'same.txt', data: te.encode('second') },
        ]);
        const reader = openZip(archive, { onDiagnostic: (d) => diagnostics.push(d) });
        const entry = reader.getEntry('same.txt');
        expect(td.decode(reader.readEntry(entry as never))).toBe('second');
        expect(diagnostics.some((d) => d.code === 'ZIP_DUPLICATE_NAME')).toBe(true);
    });

    it('throws ZipUnsupportedError with the feature name for encrypted entries', () => {
        const archive = buildRawZip([
            { name: 'secret.txt', data: HELLO, flags: 0x0001 },
        ]);
        const reader = openZip(archive);
        expect([...reader.entries()][0].isEncrypted).toBe(true);
        try {
            reader.readEntry('secret.txt');
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ZipUnsupportedError);
            expect((err as ZipUnsupportedError).feature).toBe('zipcrypto');
        }
    });

    it('throws ZipUnsupportedError naming the method for unknown codecs', () => {
        const archive = buildRawZip([
            { name: 'x.lzma', data: HELLO, method: 14, lfhMethodOverride: 14 },
        ]);
        try {
            openZip(archive).readEntry('x.lzma');
            expect.unreachable('should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(ZipUnsupportedError);
            expect((err as ZipUnsupportedError).feature).toBe('method:14');
        }
    });

    it('throws a ZipError naming the entry for unknown names', () => {
        expect(() => openZip(basicArchive()).readEntry('ghost.txt')).toThrow(ZipError);
        expect(() => openZip(basicArchive()).readEntry('ghost.txt')).toThrow(/ghost\.txt/);
    });

    it("validate: 'eager' checks every local header up front", () => {
        expect(() => openZip(basicArchive(), { validate: 'eager' })).not.toThrow();
    });

    it('never mutates the source bytes', () => {
        const bytes = basicArchive();
        const before = bytes.slice();
        const reader = openZip(bytes);
        reader.readEntry('hello.txt');
        reader.readEntry('docs/lorem.txt');
        reader.verifyEntry('hello.txt');
        expect(bytes).toEqual(before);
    });
});
