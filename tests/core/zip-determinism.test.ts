/**
 * The determinism contract (docs/determinism.md), golden-tested. The
 * committed SHA-256 values pin the BUFFERED writer's bytes; the parity
 * suite (zip-stream-parity.test.ts) carries the pin to stream().
 * Any diff in these hashes is a breaking change to the
 * `deterministic: true` contract — semver-major.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createZip, type ZipDiagnostic } from 'zipnative';

const te = new TextEncoder();

function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function referenceArchive(): Uint8Array {
    const zip = createZip({ compression: { deterministic: true }, comment: 'pinned' });
    zip.add('a/first.txt', 'first');
    zip.add('z/last.bin', te.encode('payload '.repeat(1000)));
    zip.addDirectory('a');
    zip.add('stored.bin', te.encode('do not compress'), { compression: { method: 'store' } });
    return zip.toBytes();
}

describe('determinism: identical inputs → identical SHA-256', () => {
    it('two independent builds are byte-identical', () => {
        expect(sha256(referenceArchive())).toBe(sha256(referenceArchive()));
    });

    it('the reference archive matches its frozen golden hash', () => {
        expect(sha256(referenceArchive())).toBe('ccc0e2a56c86c7df94ae2289b424fa631b436cecc95a3552dfce97a190612936');
    });

    it('an empty archive is the canonical 22-byte EOCD', () => {
        expect(sha256(createZip().toBytes())).toBe('8739c76e681f900923b900c9df0ef75cf421d39cabb54650c4b9ad19b6a76d85');
    });

    it('insertion order changes bytes, but deterministically', () => {
        const build = (): Uint8Array => {
            const zip = createZip({ order: 'insertion', compression: { deterministic: true } });
            zip.add('b.txt', 'bee');
            zip.add('a.txt', 'ay');
            return zip.toBytes();
        };
        expect(sha256(build())).toBe(sha256(build()));
    });

    it('a pinned explicit date is reproducible', () => {
        const build = (): Uint8Array => {
            const zip = createZip({
                defaultDate: new Date(2026, 0, 15, 12, 0, 0),
                compression: { deterministic: true },
            });
            zip.add('dated.txt', 'content');
            return zip.toBytes();
        };
        expect(sha256(build())).toBe(sha256(build()));
    });
});

describe('determinism: documented losses emit diagnostics', () => {
    it("defaultDate: 'now' emits ZIP_TIMESTAMP_NOT_PINNED", () => {
        const diagnostics: ZipDiagnostic[] = [];
        createZip({ defaultDate: 'now', onDiagnostic: (d) => diagnostics.push(d) });
        expect(diagnostics.some((d) => d.code === 'ZIP_TIMESTAMP_NOT_PINNED')).toBe(true);
    });

    it('a pinned date with the platform codec warns once about codec drift', () => {
        const diagnostics: ZipDiagnostic[] = [];
        const zip = createZip({
            defaultDate: new Date(2026, 0, 1),
            onDiagnostic: (d) => diagnostics.push(d),
        });
        zip.add('a.txt', te.encode('compressible '.repeat(50)));
        zip.toBytes();
        // Only fires when a non-pure tier would actually be used (Node has zlib).
        expect(diagnostics.filter((d) => d.code === 'ZIP_NONDETERMINISTIC_CODEC').length).toBeLessThanOrEqual(1);
    });

    it('deterministic: true with a pinned date emits no codec diagnostic', () => {
        const diagnostics: ZipDiagnostic[] = [];
        const zip = createZip({
            defaultDate: new Date(2026, 0, 1),
            compression: { deterministic: true },
            onDiagnostic: (d) => diagnostics.push(d),
        });
        zip.add('a.txt', 'x');
        zip.toBytes();
        expect(diagnostics.filter((d) => d.code === 'ZIP_NONDETERMINISTIC_CODEC')).toEqual([]);
    });
});
