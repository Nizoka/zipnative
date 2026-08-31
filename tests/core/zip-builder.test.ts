import { inflateRawSync as zlibInflate } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createZip, openZip, ZipError, ZipFormatError } from 'zipnative';
import { parseLocalFileHeader, parseEocd } from '../../src/core/zip-structs.ts';

const te = new TextEncoder();
const td = new TextDecoder();

describe('createZip: round-trip through our validated reader', () => {
    it('writes store and deflate entries our reader restores exactly', () => {
        const zip = createZip();
        const lorem = te.encode('lorem ipsum dolor sit amet '.repeat(200));
        zip.add('hello.txt', 'hello zipnative');
        zip.add('docs/lorem.txt', lorem);
        zip.addDirectory('docs');
        const bytes = zip.toBytes();

        const reader = openZip(bytes, { validate: 'eager' });
        expect(reader.entryCount).toBe(3);
        expect(td.decode(reader.readEntry('hello.txt'))).toBe('hello zipnative');
        expect(reader.readEntry('docs/lorem.txt')).toEqual(lorem);
        expect(reader.getEntry('docs/')?.isDirectory).toBe(true);
        expect(reader.getEntry('docs/lorem.txt')?.compressionMethod).toBe(8);
    });

    it('canonical order sorts entries by raw name bytes', () => {
        const zip = createZip();
        zip.add('zebra.txt', 'z');
        zip.add('alpha.txt', 'a');
        zip.add('beta/x.txt', 'b');
        const names = [...openZip(zip.toBytes()).entries()].map((e) => e.name);
        expect(names).toEqual(['alpha.txt', 'beta/x.txt', 'zebra.txt']);
    });

    it("order: 'insertion' preserves call order (the EPUB mimetype case)", () => {
        const zip = createZip({ order: 'insertion' });
        zip.add('mimetype', 'application/epub+zip', { compression: { method: 'store' } });
        zip.add('META-INF/container.xml', '<container/>');
        const entries = [...openZip(zip.toBytes()).entries()];
        expect(entries[0].name).toBe('mimetype');
        expect(entries[0].compressionMethod).toBe(0);
    });

    it('deflate falls back to store when it does not shrink the payload', () => {
        // Seeded pseudo-random bytes: genuinely incompressible.
        const incompressible = new Uint8Array(1000);
        let state = 0x12345678;
        for (let i = 0; i < 1000; i++) {
            state = (Math.imul(state, 1103515245) + 12345) >>> 0;
            incompressible[i] = (state >>> 16) & 0xff;
        }
        const zip = createZip();
        zip.add('rand.bin', incompressible);
        const entry = openZip(zip.toBytes()).getEntry('rand.bin');
        expect(entry?.compressionMethod).toBe(0);
        expect(entry?.compressedSize).toBe(1000);
    });

    it('empty content is always stored', () => {
        const zip = createZip();
        zip.add('empty.txt', new Uint8Array(0));
        const entry = openZip(zip.toBytes()).getEntry('empty.txt');
        expect(entry?.compressionMethod).toBe(0);
        expect(entry?.uncompressedSize).toBe(0);
    });

    it('UTF-8 names round-trip with flag bit 11', () => {
        const zip = createZip();
        zip.add('文档/résumé.txt', 'unicode');
        const entry = openZip(zip.toBytes()).getEntry('文档/résumé.txt');
        expect(entry?.nameEncoding).toBe('utf-8');
        expect((entry?.flags ?? 0) & 0x0800).toBe(0x0800);
    });

    it('archive and entry comments round-trip', () => {
        const zip = createZip({ comment: 'release build' });
        zip.add('a.txt', 'x', { comment: 'entry note' });
        const reader = openZip(zip.toBytes());
        expect(td.decode(reader.comment)).toBe('release build');
        expect(td.decode(reader.getEntry('a.txt')?.comment as Uint8Array)).toBe('entry note');
    });

    it('validates zlib can inflate our deflate payloads (foreign check)', () => {
        const zip = createZip({ compression: { deterministic: true } });
        const content = te.encode('deterministic deflate content '.repeat(100));
        zip.add('data.bin', content);
        const bytes = zip.toBytes();
        const reader = openZip(bytes);
        const raw = reader.readEntryRaw('data.bin');
        expect(new Uint8Array(zlibInflate(raw))).toEqual(content);
    });

    it('local headers agree with the central directory (our reader eager-validates)', () => {
        const zip = createZip();
        zip.add('a.txt', 'alpha');
        zip.add('b.txt', te.encode('beta '.repeat(100)));
        const bytes = zip.toBytes();
        const reader = openZip(bytes, { validate: 'eager' });
        for (const entry of reader.entries()) {
            expect(reader.verifyEntry(entry).ok).toBe(true);
            const lfh = parseLocalFileHeader(bytes, entry.localHeaderOffset);
            expect(lfh.crc32).toBe(entry.crc32);
            expect(lfh.compressedSize).toBe(entry.compressedSize);
        }
    });

    it('an empty archive is a bare EOCD our reader opens', () => {
        const bytes = createZip().toBytes();
        expect(bytes.length).toBe(22);
        expect(parseEocd(bytes, 0).totalEntries).toBe(0);
        expect(openZip(bytes).entryCount).toBe(0);
    });
});

describe('createZip: writer-side validation', () => {
    it('rejects duplicate names at add() time', () => {
        const zip = createZip();
        zip.add('same.txt', 'one');
        expect(() => zip.add('same.txt', 'two')).toThrow(ZipFormatError);
    });

    it('a file and a directory of the same stem are distinct names', () => {
        const zip = createZip();
        zip.add('docs', 'file named docs');
        expect(() => zip.addDirectory('docs')).not.toThrow();
    });

    it('never writes traversal-capable or absolute names', () => {
        const zip = createZip();
        expect(() => zip.add('../evil.txt', 'x')).toThrow(/'\.\.' segment/);
        expect(() => zip.add('/etc/passwd', 'x')).toThrow(/absolute/);
        expect(() => zip.add('C:/evil.txt', 'x')).toThrow(/absolute/);
        expect(() => zip.add('dir\\file.txt', 'x')).toThrow(/forward slashes/);
        expect(() => zip.add('', 'x')).toThrow(/empty/);
        expect(() => zip.add('a\0b', 'x')).toThrow(/NUL/);
    });

    it('rejects invalid compression levels early', () => {
        expect(() => createZip({ compression: { level: 42 } })).toThrow(ZipError);
    });

    it('toBytes() names the alternative when addStream was used', async () => {
        const zip = createZip();
        zip.addStream('s.bin', (async function* () {
            yield te.encode('chunk');
        })());
        expect(() => zip.toBytes()).toThrow(/stream\(\)/);
        // The archive is still writable through stream().
        const chunks: Uint8Array[] = [];
        for await (const chunk of zip.stream()) chunks.push(chunk);
        expect(chunks.length).toBeGreaterThan(0);
    });

    it('enforces limits.maxEntries at plan time', () => {
        const zip = createZip({ limits: { maxEntries: 2 } });
        zip.add('a', '1');
        zip.add('b', '2');
        zip.add('c', '3');
        expect(() => zip.toBytes()).toThrow(/maxEntries/);
    });
});

describe('createZip: streaming entries (data descriptors)', () => {
    async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Uint8Array> {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of gen) {
            chunks.push(chunk);
            total += chunk.length;
        }
        const out = new Uint8Array(total);
        let pos = 0;
        for (const chunk of chunks) {
            out.set(chunk, pos);
            pos += chunk.length;
        }
        return out;
    }

    it('a stream-sourced entry round-trips through our reader', async () => {
        const content = te.encode('streamed payload '.repeat(10_000));
        const zip = createZip();
        zip.add('static.txt', 'buffered sibling');
        zip.addStream('big/streamed.bin', (async function* () {
            for (let i = 0; i < content.length; i += 1013) {
                yield content.subarray(i, Math.min(i + 1013, content.length));
            }
        })());
        const bytes = await collect(zip.stream());

        const reader = openZip(bytes, { validate: 'eager' });
        const entry = reader.getEntry('big/streamed.bin');
        expect(entry?.usesDataDescriptor).toBe(true);
        expect(reader.readEntry(entry as never)).toEqual(content);
        expect(td.decode(reader.readEntry('static.txt'))).toBe('buffered sibling');
    });

    it('store-method stream entries round-trip too', async () => {
        const content = te.encode('stored stream');
        const zip = createZip();
        zip.addStream('s.txt', (async function* () {
            yield content;
        })(), { compression: { method: 'store' } });
        const bytes = await collect(zip.stream());
        expect(openZip(bytes).readEntry('s.txt')).toEqual(content);
    });
});

describe('createZip: Zip64 write (real 70k-entry archive)', () => {
    it('promotes to zip64 EOCD past 65535 entries and reads back', () => {
        const zip = createZip();
        for (let i = 0; i < 70_000; i++) {
            zip.add(`e/${i.toString(36).padStart(4, '0')}`, 'x', { compression: { method: 'store' } });
        }
        const bytes = zip.toBytes();
        const reader = openZip(bytes);
        expect(reader.isZip64).toBe(true);
        expect(reader.entryCount).toBe(70_000);
        expect(td.decode(reader.readEntry('e/0000'))).toBe('x');
        expect(td.decode(reader.readEntry(`e/${(69_999).toString(36).padStart(4, '0')}`))).toBe('x');
    }, 120_000);
});
