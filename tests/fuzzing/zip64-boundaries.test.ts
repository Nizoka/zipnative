import { describe, expect, it } from 'vitest';
import { openZip, ZipFormatError, ZipSecurityError } from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();

describe('fuzzing: Zip64 boundaries and spoofing', () => {
    it('reads an archive with zip64 EOCD structures (sentinel classic fields)', () => {
        const archive = buildRawZip(
            [{ name: 'a.txt', data: te.encode('zip64 payload') }],
            { forceZip64: true },
        );
        const reader = openZip(archive);
        expect(reader.isZip64).toBe(true);
        expect(reader.entryCount).toBe(1);
        expect(new TextDecoder().decode(reader.readEntry('a.txt'))).toBe('zip64 payload');
    });

    it('rejects sentinels with a missing zip64 locator', () => {
        // Classic EOCD with sentinel fields but no zip64 structures at all.
        const archive = buildRawZip(
            [{ name: 'a.txt', data: te.encode('x') }],
            { forceZip64: true, zip64DropRecord: true },
        );
        // The locator points at where the record should be but is not.
        expect(() => openZip(archive)).toThrow(ZipFormatError);
    });

    it('rejects a zip64 EOCD contradicting a non-sentinel classic field (spoofing)', () => {
        // forceZip64 writes sentinels everywhere; hand-craft the contradiction
        // instead: classic count 1 (non-sentinel), zip64 record says 999.
        const base = buildRawZip(
            [{ name: 'a.txt', data: te.encode('x') }],
            { forceZip64: true, zip64TotalEntriesOverride: 999 },
        );
        // Un-sentinel the classic entry counts (offsets: EOCD starts 22 from
        // the end; counts at EOCD+8 and EOCD+10).
        const eocdPos = base.length - 22;
        const view = new DataView(base.buffer, base.byteOffset);
        view.setUint16(eocdPos + 8, 1, true);
        view.setUint16(eocdPos + 10, 1, true);
        expect(() => openZip(base)).toThrow(ZipSecurityError);
    });

    it('rejects 64-bit values beyond Number.MAX_SAFE_INTEGER', () => {
        const archive = buildRawZip(
            [{ name: 'a.txt', data: te.encode('x') }],
            { forceZip64: true },
        );
        // Corrupt the zip64 EOCD total-entries field to 2^60. Layout from the
        // end: EOCD (22) + locator (20) + zip64 EOCD (56).
        const z64Pos = archive.length - 22 - 20 - 56;
        const view = new DataView(archive.buffer, archive.byteOffset);
        view.setBigUint64(z64Pos + 24, 1n << 60n, true);
        view.setBigUint64(z64Pos + 32, 1n << 60n, true);
        expect(() => openZip(archive)).toThrow(/MAX_SAFE_INTEGER/);
    });

    it('reads per-entry zip64 extras only where sentinels license them', () => {
        // Entry with sentinel sizes in the CFH and a zip64 extra carrying the
        // real values — the raw builder writes real sizes, so craft via
        // overrides + extraCentral.
        const data = te.encode('licensed zip64 sizes');
        const extra = new Uint8Array(4 + 16);
        const ev = new DataView(extra.buffer);
        ev.setUint16(0, 0x0001, true);
        ev.setUint16(2, 16, true);
        ev.setBigUint64(4, BigInt(data.length), true);       // uncompressed
        ev.setBigUint64(12, BigInt(data.length), true);      // compressed (stored)
        const archive = buildRawZip([
            {
                name: 'a.txt',
                data,
                uncompressedSizeOverride: 0xFFFFFFFF,
                compressedSizeOverride: 0xFFFFFFFF,
                extraCentral: extra,
            },
        ]);
        const reader = openZip(archive);
        const entry = reader.getEntry('a.txt');
        expect(entry?.usesZip64).toBe(true);
        expect(entry?.uncompressedSize).toBe(data.length);
        expect(new TextDecoder().decode(reader.readEntry('a.txt'))).toBe('licensed zip64 sizes');
    });
});
