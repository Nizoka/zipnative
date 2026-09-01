/**
 * Refusal posture: archives zipnative MUST refuse with a typed error even
 * though many foreign tools tolerate them (Info-ZIP and 7-Zip, for
 * instance, open single-file "spanned" archives and archives with
 * trailing garbage without complaint). Tolerating them silently is the
 * parser-differential / smuggling surface this project rejects by
 * design, so the posture gap with foreign tools is deliberate and this
 * suite is its regression pin.
 */
import { describe, expect, it } from 'vitest';
import { openZip, ZipFormatError, ZipUnsupportedError } from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();

/** Patch a little-endian u16 in place and return the same buffer. */
function patchU16(bytes: Uint8Array, pos: number, value: number): Uint8Array {
    new DataView(bytes.buffer, bytes.byteOffset).setUint16(pos, value, true);
    return bytes;
}

describe('integration: refusal posture (foreign tools tolerate, zipnative refuses)', () => {
    // EOCD without a comment sits in the last 22 bytes; disk fields at +4/+6/+8.
    const eocdPos = (bytes: Uint8Array) => bytes.length - 22;

    it('refuses a multi-disk EOCD (this-disk number != 0) with ZipUnsupportedError', () => {
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('x') }]);
        patchU16(archive, eocdPos(archive) + 4, 1);
        try {
            openZip(archive);
            expect.unreachable('multi-disk archive was accepted');
        } catch (err) {
            expect(err).toBeInstanceOf(ZipUnsupportedError);
            expect((err as ZipUnsupportedError).feature).toBe('multi-disk');
            expect((err as Error).message).toMatch(/^zipnative: multi-disk/);
        }
    });

    it('refuses a central directory declared to start on another disk', () => {
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('x') }]);
        patchU16(archive, eocdPos(archive) + 6, 1);
        expect(() => openZip(archive)).toThrow(ZipUnsupportedError);
    });

    it('refuses a zip64 locator claiming more than one disk', () => {
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('x') }], {
            forceZip64: true,
        });
        // Locator: 20 bytes before the EOCD; total-disks u32 at locator+16.
        const totalDisksPos = archive.length - 22 - 20 + 16;
        new DataView(archive.buffer, archive.byteOffset).setUint32(totalDisksPos, 2, true);
        try {
            openZip(archive);
            expect.unreachable('multi-disk zip64 archive was accepted');
        } catch (err) {
            expect(err).toBeInstanceOf(ZipUnsupportedError);
            expect((err as ZipUnsupportedError).feature).toBe('multi-disk');
        }
    });

    it('refuses an EOCD whose entries-on-this-disk contradicts the total', () => {
        const archive = buildRawZip([
            { name: 'a.txt', data: te.encode('x') },
            { name: 'b.txt', data: te.encode('y') },
        ]);
        patchU16(archive, eocdPos(archive) + 8, 1); // total stays 2
        expect(() => openZip(archive)).toThrow(ZipFormatError);
    });

    it('refuses trailing garbage after the EOCD (ambiguity is never guessed at)', () => {
        // Most extractors scan backwards and shrug; zipnative treats an
        // EOCD that is not flush with EOF (and not disambiguated by its
        // own comment length) as hostile ambiguity.
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('x') }], {
            append: te.encode('trailing bytes a foreign tool would ignore'),
        });
        expect(() => openZip(archive)).toThrow(ZipFormatError);
    });
});
