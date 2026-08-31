import { describe, expect, it } from 'vitest';
import { openZip, ZipError } from 'zipnative';
import { buildRawZip, seededRandom } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();

function fullArchive(): Uint8Array {
    return buildRawZip([
        { name: 'a.txt', data: te.encode('alpha content here') },
        { name: 'b.bin', data: te.encode('beta content here '.repeat(50)), method: 8 },
    ]);
}

/** Read everything an archive offers; used to force every code path. */
function readAll(bytes: Uint8Array): void {
    const reader = openZip(bytes, { onDiagnostic: () => undefined });
    for (const entry of reader.entries()) {
        if (!entry.isDirectory && !entry.isEncrypted) {
            reader.readEntry(entry);
        }
    }
}

describe('fuzzing: truncation and corruption never hang or leak foreign errors', () => {
    it('every truncation point yields a clean ZipError subclass', () => {
        const archive = fullArchive();
        // Truncating at every byte is O(n²) on the full archive; sample the
        // structurally interesting region (headers + tails) densely and the
        // data region sparsely.
        const points = new Set<number>();
        for (let i = 0; i < Math.min(80, archive.length); i++) points.add(i);
        for (let i = archive.length - 120; i < archive.length; i++) points.add(Math.max(0, i));
        for (let i = 80; i < archive.length - 120; i += 37) points.add(i);

        for (const cut of points) {
            const truncated = archive.subarray(0, cut);
            try {
                readAll(truncated);
                // Some cuts still parse (e.g. only trailing comment lost is
                // impossible here, but a cut past all data is fine) — OK.
            } catch (err) {
                expect(err, `truncation at ${cut} leaked a non-ZipError: ${String(err)}`)
                    .toBeInstanceOf(ZipError);
            }
        }
    });

    it('seeded random byte flips yield clean ZipError subclasses or valid reads', () => {
        const rand = seededRandom(0xC0FFEE);
        for (let round = 0; round < 300; round++) {
            const archive = fullArchive();
            const flips = 1 + Math.floor(rand() * 4);
            for (let f = 0; f < flips; f++) {
                const pos = Math.floor(rand() * archive.length);
                archive[pos] ^= 1 << Math.floor(rand() * 8);
            }
            try {
                readAll(archive);
            } catch (err) {
                expect(err, `round ${round} leaked a non-ZipError: ${String(err)}`)
                    .toBeInstanceOf(ZipError);
            }
        }
    });

    it('an empty input is rejected cleanly', () => {
        expect(() => openZip(new Uint8Array(0))).toThrow(ZipError);
    });

    it('a lone EOCD signature with garbage fields is rejected cleanly', () => {
        const bytes = new Uint8Array(22);
        new DataView(bytes.buffer).setUint32(0, 0x06054b50, true);
        bytes.fill(0xAB, 4);
        expect(() => openZip(bytes)).toThrow(ZipError);
    });
});
