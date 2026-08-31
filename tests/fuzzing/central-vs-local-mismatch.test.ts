import { describe, expect, it } from 'vitest';
import {
    openZip,
    ZipDataError,
    ZipSecurityError,
    type ZipDiagnostic,
} from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();

describe('fuzzing: central-vs-local parser differentials', () => {
    it('rejects a compression-method mismatch as a security error', () => {
        const archive = buildRawZip([
            { name: 'a.txt', data: te.encode('payload'), method: 0, lfhMethodOverride: 8 },
        ]);
        expect(() => openZip(archive).readEntry('a.txt')).toThrow(ZipSecurityError);
    });

    it('rejects a local CRC contradicting the central directory', () => {
        const archive = buildRawZip([
            { name: 'a.txt', data: te.encode('payload'), lfhCrcOverride: 0xDEADBEEF },
        ]);
        expect(() => openZip(archive).readEntry('a.txt')).toThrow(ZipDataError);
    });

    it('surfaces a filename divergence as a diagnostic (CD wins) and reads on', () => {
        const diagnostics: ZipDiagnostic[] = [];
        const archive = buildRawZip([
            { name: 'shown.txt', data: te.encode('payload'), lfhNameOverride: te.encode('other.txt') },
        ]);
        const reader = openZip(archive, { onDiagnostic: (d) => diagnostics.push(d) });
        expect(new TextDecoder().decode(reader.readEntry('shown.txt'))).toBe('payload');
        expect(diagnostics.some((d) => d.code === 'ZIP_NAME_MISMATCH')).toBe(true);
    });

    it('strict mode escalates the filename divergence to an error', () => {
        const archive = buildRawZip([
            { name: 'shown.txt', data: te.encode('payload'), lfhNameOverride: te.encode('other.txt') },
        ]);
        expect(() => openZip(archive, { strict: true }).readEntry('shown.txt')).toThrow(/zipnative:/);
    });

    it('rejects a CD offset pointing at bytes that are not a local header', () => {
        const archive = buildRawZip([
            { name: 'a.txt', data: te.encode('0123456789'), localHeaderOffsetOverride: 5 },
        ]);
        expect(() => openZip(archive).readEntry('a.txt')).toThrow(/local file header|overlaps/);
    });

    it('rejects overlapping entries (two entries claiming one payload)', () => {
        const archive = buildRawZip([
            { name: 'a.txt', data: te.encode('shared payload here') },
            { name: 'b.txt', data: te.encode('shared payload here'), localHeaderOffsetOverride: 0 },
        ]);
        expect(() => openZip(archive).readEntry('a.txt')).toThrow(ZipSecurityError);
        expect(() => openZip(archive, { validate: 'eager' })).toThrow(ZipSecurityError);
    });

    it('rejects an entry whose declared data extends past the archive', () => {
        const archive = buildRawZip([
            { name: 'a.txt', data: te.encode('tiny'), compressedSizeOverride: 1_000_000 },
        ]);
        expect(() => openZip(archive).readEntry('a.txt')).toThrow(/past the end|overlaps/);
    });
});
