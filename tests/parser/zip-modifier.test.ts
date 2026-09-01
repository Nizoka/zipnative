import { describe, expect, it } from 'vitest';
import {
    createZip,
    createZipModifier,
    openZip,
    ZipError,
    ZipFormatError,
    type ZipDiagnostic,
} from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();
const td = new TextDecoder();

function baseArchive(): Uint8Array {
    const zip = createZip({ compression: { deterministic: true } });
    zip.add('keep.txt', 'kept content');
    zip.add('docs/replace-me.txt', 'original content '.repeat(50));
    zip.add('old-name.bin', te.encode('payload to rename'));
    zip.add('remove-me.txt', 'SECRET-PAYLOAD-TO-REMOVE');
    zip.addDirectory('docs');
    return zip.toBytes();
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

describe('createZipModifier: edit-sequence semantics', () => {
    const mod = () => createZipModifier(openZip(baseArchive()));

    it('addEntry on an existing name throws with the remedy', () => {
        expect(() => mod().addEntry('keep.txt', 'x')).toThrow(/replaceEntry/);
    });

    it('addEntry after removeEntry of the same name is allowed', () => {
        const m = mod();
        m.removeEntry('keep.txt');
        expect(() => m.addEntry('keep.txt', 'reborn')).not.toThrow();
        const reader = openZip(m.save());
        expect(td.decode(reader.readEntry('keep.txt'))).toBe('reborn');
    });

    it('replaceEntry on a missing (or removed) name throws with the remedy', () => {
        expect(() => mod().replaceEntry('ghost.txt', 'x')).toThrow(/addEntry/);
        const m = mod();
        m.removeEntry('keep.txt');
        expect(() => m.replaceEntry('keep.txt', 'x')).toThrow(/addEntry/);
    });

    it('removeEntry of a session-only name nets to a no-op', () => {
        const m = mod();
        m.addEntry('temp.txt', 'x');
        m.removeEntry('temp.txt');
        expect(m.save()).toBe(m.reader.bytes); // back to zero pending edits
    });

    it('removeEntry of a missing name throws', () => {
        expect(() => mod().removeEntry('ghost.txt')).toThrow(ZipError);
    });

    it('renameEntry never overwrites implicitly', () => {
        expect(() => mod().renameEntry('old-name.bin', 'keep.txt')).toThrow(/removeEntry/);
    });

    it('renameEntry of a removed entry throws', () => {
        const m = mod();
        m.removeEntry('old-name.bin');
        expect(() => m.renameEntry('old-name.bin', 'new.bin')).toThrow(ZipError);
    });

    it('a chained rename A→B→C lands the payload at C only', () => {
        const m = mod();
        m.renameEntry('old-name.bin', 'mid.bin');
        m.renameEntry('mid.bin', 'final.bin');
        const reader = openZip(m.save());
        expect(reader.getEntry('old-name.bin')).toBeNull();
        expect(reader.getEntry('mid.bin')).toBeNull();
        expect(td.decode(reader.readEntry('final.bin'))).toBe('payload to rename');
    });

    it('renaming a directory keeps the trailing slash', () => {
        const m = mod();
        m.renameEntry('docs/', 'archive-docs');
        const reader = openZip(m.save());
        expect(reader.getEntry('archive-docs/')?.isDirectory).toBe(true);
    });

    it('directory names with data are rejected', () => {
        expect(() => mod().addEntry('dir/', 'data')).toThrow(/directory/);
    });

    it('traversal names are rejected at edit time', () => {
        expect(() => mod().addEntry('../evil.txt', 'x')).toThrow(ZipFormatError);
        expect(() => mod().renameEntry('keep.txt', '/abs.txt')).toThrow(ZipFormatError);
    });

    it('duplicate-name source archives are refused at construction', () => {
        const dupes = buildRawZip([
            { name: 'same.txt', data: te.encode('one') },
            { name: 'same.txt', data: te.encode('two') },
        ]);
        expect(() => createZipModifier(openZip(dupes, { onDiagnostic: () => undefined })))
            .toThrow(/duplicate entry name/);
    });
});

describe('createZipModifier: save() — append-only', () => {
    it('no pending edits returns reader.bytes by REFERENCE', () => {
        const reader = openZip(baseArchive());
        const m = createZipModifier(reader);
        expect(m.save()).toBe(reader.bytes);
    });

    it('preserves the original prefix byte-for-byte', () => {
        const original = baseArchive();
        const m = createZipModifier(openZip(original));
        m.addEntry('appended.txt', 'new content');
        const saved = m.save();
        expect(saved.length).toBeGreaterThan(original.length);
        expect(saved.subarray(0, original.length)).toEqual(original);
    });

    it('add + replace + remove + rename round-trip through the eager reader', () => {
        const m = createZipModifier(openZip(baseArchive()));
        m.addEntry('added.txt', 'brand new');
        m.replaceEntry('docs/replace-me.txt', 'replaced content');
        m.removeEntry('remove-me.txt');
        m.renameEntry('old-name.bin', 'renamed.bin');
        const diagnostics: ZipDiagnostic[] = [];
        const reader = openZip(m.save(), { validate: 'eager', onDiagnostic: (d) => diagnostics.push(d) });

        expect(td.decode(reader.readEntry('added.txt'))).toBe('brand new');
        expect(td.decode(reader.readEntry('docs/replace-me.txt'))).toBe('replaced content');
        expect(td.decode(reader.readEntry('keep.txt'))).toBe('kept content');
        expect(td.decode(reader.readEntry('renamed.bin'))).toBe('payload to rename');
        expect(reader.getEntry('remove-me.txt')).toBeNull();
        expect(reader.getEntry('old-name.bin')).toBeNull();
        // No name-mismatch warnings: renames are raw copies, never re-pointed CFHs.
        expect(diagnostics.filter((d) => d.code === 'ZIP_NAME_MISMATCH')).toEqual([]);
    });

    it('a rename preserves crc, sizes and method without recompression', () => {
        const content = te.encode('compressible payload '.repeat(200));
        const zip = createZip();
        zip.add('big.bin', content);
        const sourceReader = openZip(zip.toBytes());
        const sourceEntry = sourceReader.getEntry('big.bin');

        const m = createZipModifier(sourceReader);
        m.renameEntry('big.bin', 'moved.bin');
        const entry = openZip(m.save()).getEntry('moved.bin');
        expect(entry?.crc32).toBe(sourceEntry?.crc32);
        expect(entry?.compressedSize).toBe(sourceEntry?.compressedSize);
        expect(entry?.compressionMethod).toBe(sourceEntry?.compressionMethod);
        expect(entry?.usesDataDescriptor).toBe(false);
    });

    it('comment-only change produces a new archive with the new comment', () => {
        const m = createZipModifier(openZip(baseArchive()));
        m.setComment('release v2');
        const saved = m.save();
        expect(saved).not.toBe(m.reader.bytes);
        expect(td.decode(openZip(saved).comment)).toBe('release v2');
    });

    it('data remanence: removed content REMAINS recoverable after save()', () => {
        const secret = te.encode('SECRET-PAYLOAD-TO-REMOVE');
        const m = createZipModifier(openZip(baseArchive()));
        m.removeEntry('remove-me.txt');
        const saved = m.save();
        expect(openZip(saved).getEntry('remove-me.txt')).toBeNull();
        // The documented behavior this test exists to pin: bytes survive.
        expect(indexOfBytes(saved, secret)).toBeGreaterThanOrEqual(0);
    });

    it('fires ZIP_DEAD_BYTES_RATIO when most of the output is dead', () => {
        const zip = createZip();
        zip.add('huge.bin', te.encode('x'.repeat(50_000)), { compression: { method: 'store' } });
        const diagnostics: ZipDiagnostic[] = [];
        const m = createZipModifier(openZip(zip.toBytes()), { onDiagnostic: (d) => diagnostics.push(d) });
        m.removeEntry('huge.bin');
        m.save();
        expect(diagnostics.some((d) => d.code === 'ZIP_DEAD_BYTES_RATIO')).toBe(true);
    });

    it('stays quiet about dead bytes for small edits', () => {
        const zip = createZip();
        zip.add('huge.bin', te.encode('x'.repeat(50_000)), { compression: { method: 'store' } });
        zip.add('tiny.txt', 'small');
        const diagnostics: ZipDiagnostic[] = [];
        const m = createZipModifier(openZip(zip.toBytes()), { onDiagnostic: (d) => diagnostics.push(d) });
        m.replaceEntry('tiny.txt', 'small v2');
        m.save();
        expect(diagnostics.filter((d) => d.code === 'ZIP_DEAD_BYTES_RATIO')).toEqual([]);
    });

    it('repeated save cycles compose (modifier of a modified archive)', () => {
        const m1 = createZipModifier(openZip(baseArchive()));
        m1.addEntry('gen1.txt', 'first generation');
        const saved1 = m1.save();

        const diagnostics: ZipDiagnostic[] = [];
        const reader2 = openZip(saved1, { onDiagnostic: (d) => diagnostics.push(d) });
        // The buried old EOCD is expected and informational.
        expect(diagnostics.some((d) => d.code === 'ZIP_MULTIPLE_EOCD')).toBe(true);

        const m2 = createZipModifier(reader2);
        m2.addEntry('gen2.txt', 'second generation');
        const reader3 = openZip(m2.save(), { validate: 'eager', onDiagnostic: () => undefined });
        expect(td.decode(reader3.readEntry('gen1.txt'))).toBe('first generation');
        expect(td.decode(reader3.readEntry('gen2.txt'))).toBe('second generation');
        expect(td.decode(reader3.readEntry('keep.txt'))).toBe('kept content');
    });

    it('modifies an SFX-prefixed archive (base > 0) — prefix and entries survive', () => {
        const prefixed = buildRawZip(
            [
                { name: 'app.txt', data: te.encode('application data') },
                { name: 'config.json', data: te.encode('{"v":1}') },
            ],
            { prepend: te.encode('#!/bin/sh\necho self-extracting stub goes here\n') },
        );
        const reader = openZip(prefixed, { onDiagnostic: () => undefined });
        const m = createZipModifier(reader, { onDiagnostic: () => undefined });
        m.replaceEntry('config.json', '{"v":2}');
        const saved = m.save();

        expect(td.decode(saved.subarray(0, 10))).toBe('#!/bin/sh\n'); // stub intact
        const reopened = openZip(saved, { validate: 'eager', onDiagnostic: () => undefined });
        expect(td.decode(reopened.readEntry('config.json'))).toBe('{"v":2}');
        expect(td.decode(reopened.readEntry('app.txt'))).toBe('application data');
    });

    it('modifies a foreign-produced fixture (anti-circularity)', async () => {
        const { readFileSync, readdirSync } = await import('node:fs');
        const fixtures = readdirSync('tests/fixtures/interop').filter((f) => f.endsWith('.zip'));
        expect(fixtures.length).toBeGreaterThan(0);
        for (const name of fixtures) {
            const bytes = new Uint8Array(readFileSync(`tests/fixtures/interop/${name}`));
            const reader = openZip(bytes, { onDiagnostic: () => undefined });
            const m = createZipModifier(reader, { onDiagnostic: () => undefined });
            m.addEntry('zipnative-was-here.txt', `modified ${name}`);
            const reopened = openZip(m.save(), { validate: 'eager', onDiagnostic: () => undefined });
            expect(td.decode(reopened.readEntry('zipnative-was-here.txt'))).toBe(`modified ${name}`);
            expect(reopened.entryCount).toBe(reader.entryCount + 1);
        }
    });

    it('modifies an archive with data-descriptor entries built by our stream writer', async () => {
        const zip = createZip();
        zip.addStream('streamed.bin', (async function* () {
            yield te.encode('descriptor-layout payload '.repeat(100));
        })());
        zip.add('plain.txt', 'plain');
        const chunks: Uint8Array[] = [];
        for await (const chunk of zip.stream()) chunks.push(chunk);
        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        const bytes = new Uint8Array(total);
        let pos = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, pos);
            pos += chunk.length;
        }

        const m = createZipModifier(openZip(bytes));
        m.renameEntry('streamed.bin', 'renamed-streamed.bin'); // raw copy clears bit 3
        const reader = openZip(m.save(), { validate: 'eager' });
        const entry = reader.getEntry('renamed-streamed.bin');
        expect(entry?.usesDataDescriptor).toBe(false);
        expect(reader.readEntry(entry as never).length).toBe('descriptor-layout payload '.repeat(100).length);
    });
});

describe('createZipModifier: saveCompact()', () => {
    it('truly deletes removed content', () => {
        const secret = te.encode('SECRET-PAYLOAD-TO-REMOVE');
        const m = createZipModifier(openZip(baseArchive()));
        m.removeEntry('remove-me.txt');
        const compacted = m.saveCompact();
        expect(openZip(compacted).getEntry('remove-me.txt')).toBeNull();
        expect(indexOfBytes(compacted, secret)).toBe(-1);
    });

    it('zero-edit compact of a deterministic createZip archive is byte-identical', () => {
        const original = baseArchive(); // deterministic: true, canonical order
        const compacted = createZipModifier(openZip(original)).saveCompact();
        expect(compacted).toEqual(original);
    });

    it('is deterministic across runs with identical edits', () => {
        const run = (): Uint8Array => {
            const m = createZipModifier(openZip(baseArchive()), { compression: { deterministic: true } });
            m.replaceEntry('docs/replace-me.txt', 'compact v2');
            m.removeEntry('remove-me.txt');
            m.renameEntry('old-name.bin', 'renamed.bin');
            return m.saveCompact();
        };
        expect(run()).toEqual(run());
    });

    it('drops an SFX prefix (canonical rewrite, documented)', () => {
        const prefixed = buildRawZip(
            [{ name: 'a.txt', data: te.encode('data') }],
            { prepend: te.encode('STUB') },
        );
        const m = createZipModifier(openZip(prefixed, { onDiagnostic: () => undefined }), { onDiagnostic: () => undefined });
        m.addEntry('b.txt', 'more');
        const compacted = m.saveCompact();
        expect(td.decode(compacted.subarray(0, 2))).toBe('PK'); // no stub
        const reader = openZip(compacted, { validate: 'eager' });
        expect(td.decode(reader.readEntry('a.txt'))).toBe('data');
    });

    it('preserves source metadata (dates, attributes, comments) on copied entries', () => {
        const zip = createZip({ defaultDate: new Date(2024, 5, 15, 10, 30, 0) });
        zip.add('dated.txt', 'content', { comment: 'entry note', externalAttributes: (0o100755 << 16) >>> 0 });
        const source = openZip(zip.toBytes());
        const sourceEntry = source.getEntry('dated.txt');

        const m = createZipModifier(source);
        m.addEntry('other.txt', 'x');
        const entry = openZip(m.saveCompact()).getEntry('dated.txt');
        expect(entry?.dosDate).toBe(sourceEntry?.dosDate);
        expect(entry?.dosTime).toBe(sourceEntry?.dosTime);
        expect(entry?.externalAttributes).toBe(sourceEntry?.externalAttributes);
        expect(td.decode(entry?.comment as Uint8Array)).toBe('entry note');
    });
});

describe('createZipModifier: encrypted entries are copyable, never readable', () => {
    function withEncryptedEntry(): Uint8Array {
        return buildRawZip([
            { name: 'secret.bin', data: te.encode('ciphertext-stand-in'), flags: 0x0001 },
            { name: 'open.txt', data: te.encode('cleartext') },
        ]);
    }

    it('untouched encrypted entries survive save() verbatim', () => {
        const m = createZipModifier(openZip(withEncryptedEntry()));
        m.addEntry('note.txt', 'added');
        const reader = openZip(m.save());
        expect(reader.getEntry('secret.bin')?.isEncrypted).toBe(true);
        expect(td.decode(reader.readEntry('open.txt'))).toBe('cleartext');
    });

    it('encrypted entries can be renamed and compacted without decompression', () => {
        const m = createZipModifier(openZip(withEncryptedEntry()));
        m.renameEntry('secret.bin', 'moved-secret.bin');
        const compacted = m.saveCompact();
        const entry = openZip(compacted).getEntry('moved-secret.bin');
        expect(entry?.isEncrypted).toBe(true);
        expect(entry?.crc32).toBe(openZip(withEncryptedEntry()).getEntry('secret.bin')?.crc32);
    });
});

describe('createZipModifier: zip64 promotion', () => {
    it('appending past 65535 entries promotes the trailer to zip64', () => {
        const zip = createZip();
        for (let i = 0; i < 65_530; i++) {
            zip.add(`e/${i.toString(36)}`, 'x', { compression: { method: 'store' } });
        }
        const m = createZipModifier(openZip(zip.toBytes()));
        for (let i = 0; i < 10; i++) {
            m.addEntry(`extra/${i}`, 'y');
        }
        const reader = openZip(m.save());
        expect(reader.isZip64).toBe(true);
        expect(reader.entryCount).toBe(65_540);
        expect(td.decode(reader.readEntry('extra/9'))).toBe('y');
        expect(td.decode(reader.readEntry('e/0'))).toBe('x');
    }, 180_000);
});
