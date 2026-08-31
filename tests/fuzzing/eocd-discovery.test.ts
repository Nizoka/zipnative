import { describe, expect, it } from 'vitest';
import { openZip, ZipFormatError, type ZipDiagnostic } from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();

describe('fuzzing: EOCD discovery', () => {
    it('rejects inputs smaller than a minimal EOCD', () => {
        expect(() => openZip(new Uint8Array(10))).toThrow(ZipFormatError);
    });

    it('rejects non-ZIP data with a clear message', () => {
        expect(() => openZip(te.encode('this is not a zip archive at all, just text'.repeat(10))))
            .toThrow(/not a ZIP archive/);
    });

    it('opens an empty archive (0 entries)', () => {
        const reader = openZip(buildRawZip([]));
        expect(reader.entryCount).toBe(0);
        expect([...reader.entries()]).toEqual([]);
    });

    it('refuses trailing garbage after the EOCD (ambiguity is never guessed at)', () => {
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('x') }], {
            append: te.encode('GARBAGE-GARBAGE'),
        });
        expect(() => openZip(archive)).toThrow(/self-consistent|trailing/);
    });

    it('handles prepended data (SFX stub) with an offset shift and a diagnostic', () => {
        const diagnostics: ZipDiagnostic[] = [];
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('payload') }], {
            prepend: te.encode('#!/bin/sh\necho self-extracting stub\n'),
        });
        const reader = openZip(archive, { onDiagnostic: (d) => diagnostics.push(d) });
        expect(new TextDecoder().decode(reader.readEntry('a.txt'))).toBe('payload');
        expect(diagnostics.some((d) => d.code === 'ZIP_PREPENDED_DATA')).toBe(true);
    });

    it('accepts an EOCD signature inside the comment when self-consistency disambiguates', () => {
        // A 30-byte comment starting with the signature bytes: the fake
        // candidate is inside the scan window but not self-consistent.
        const comment = new Uint8Array(30);
        comment.set([0x50, 0x4b, 0x05, 0x06]);
        const diagnostics: ZipDiagnostic[] = [];
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('x') }], { comment });
        const reader = openZip(archive, { onDiagnostic: (d) => diagnostics.push(d) });
        expect(reader.entryCount).toBe(1);
        expect(diagnostics.some((d) => d.code === 'ZIP_MULTIPLE_EOCD')).toBe(true);
    });

    it('rejects an EOCD whose central directory overlaps it', () => {
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('x') }], {
            cdOffsetOverride: 0xFFFF0, // way past the EOCD
        });
        expect(() => openZip(archive)).toThrow(ZipFormatError);
    });

    it('rejects a declared entry count larger than the central directory holds', () => {
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('x') }], {
            totalEntriesOverride: 5,
        });
        const reader = openZip(archive);
        expect(() => [...reader.entries()]).toThrow(ZipFormatError);
    });

    it('rejects a declared entry count smaller than the central directory holds', () => {
        const archive = buildRawZip(
            [
                { name: 'a.txt', data: te.encode('x') },
                { name: 'b.txt', data: te.encode('y') },
            ],
            { totalEntriesOverride: 1 },
        );
        const reader = openZip(archive);
        expect(() => [...reader.entries()]).toThrow(ZipFormatError);
    });

    it('enforces maxEntries before walking the central directory', () => {
        const archive = buildRawZip([
            { name: 'a.txt', data: te.encode('x') },
            { name: 'b.txt', data: te.encode('y') },
            { name: 'c.txt', data: te.encode('z') },
        ]);
        expect(() => openZip(archive, { limits: { maxEntries: 2 } })).toThrow(/maxEntries/);
    });
});
