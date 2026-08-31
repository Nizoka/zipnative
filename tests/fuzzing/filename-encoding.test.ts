import { describe, expect, it } from 'vitest';
import { openZip, type ZipDiagnostic } from 'zipnative';
import { buildExtraField, buildRawZip } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();

describe('fuzzing: filename encoding tricks', () => {
    it('decodes CP437 names when the UTF-8 flag is clear', () => {
        // 0x82 = é in CP437
        const archive = buildRawZip([
            { name: new Uint8Array([0x72, 0x82, 0x73, 0x75, 0x6d, 0x82, 0x2e, 0x74, 0x78, 0x74]), data: te.encode('x') },
        ]);
        const entry = [...openZip(archive).entries()][0];
        expect(entry.name).toBe('résumé.txt');
        expect(entry.nameEncoding).toBe('cp437');
    });

    it('falls back to CP437 with a diagnostic when the UTF-8 flag lies', () => {
        const diagnostics: ZipDiagnostic[] = [];
        const archive = buildRawZip([
            { name: new Uint8Array([0x61, 0xFF, 0x62]), data: te.encode('x'), flags: 0x0800 },
        ]);
        const entry = [...openZip(archive, { onDiagnostic: (d) => diagnostics.push(d) }).entries()][0];
        expect(entry.nameEncoding).toBe('cp437');
        expect(diagnostics.some((d) => d.code === 'ZIP_INVALID_UTF8_NAME')).toBe(true);
    });

    it('diagnoses a Unicode Path extra that contradicts the header name', () => {
        const diagnostics: ZipDiagnostic[] = [];
        // 0x7075: version 1 + 4-byte CRC + name bytes ("evil.txt" ≠ "shown.txt")
        const upData = new Uint8Array(5 + 8);
        upData[0] = 1;
        upData.set(te.encode('evil.txt'), 5);
        const archive = buildRawZip([
            {
                name: 'shown.txt',
                data: te.encode('x'),
                extraCentral: buildExtraField([{ id: 0x7075, data: upData }]),
            },
        ]);
        const reader = openZip(archive, { onDiagnostic: (d) => diagnostics.push(d) });
        // zipnative NEVER acts on 0x7075: the header name is the entry name.
        expect(reader.getEntry('shown.txt')).not.toBeNull();
        expect(reader.getEntry('evil.txt')).toBeNull();
        expect(diagnostics.some((d) => d.code === 'ZIP_UNICODE_PATH_CONFLICT')).toBe(true);
    });

    it('a matching Unicode Path extra raises no diagnostic', () => {
        const diagnostics: ZipDiagnostic[] = [];
        const upData = new Uint8Array(5 + 9);
        upData[0] = 1;
        upData.set(te.encode('match.txt'), 5);
        const archive = buildRawZip([
            {
                name: 'match.txt',
                data: te.encode('x'),
                extraCentral: buildExtraField([{ id: 0x7075, data: upData }]),
            },
        ]);
        openZip(archive, { onDiagnostic: (d) => diagnostics.push(d) }).getEntry('match.txt');
        expect(diagnostics.filter((d) => d.code === 'ZIP_UNICODE_PATH_CONFLICT')).toEqual([]);
    });

    it('enforces maxNameBytes on hostile long names', () => {
        const archive = buildRawZip([
            { name: 'n'.repeat(5000), data: te.encode('x') },
        ]);
        expect(() => [...openZip(archive).entries()]).toThrow(/maxNameBytes/);
    });
});
