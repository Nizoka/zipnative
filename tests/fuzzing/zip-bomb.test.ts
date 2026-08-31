import { describe, expect, it } from 'vitest';
import { openZip, ZipDataError, ZipLimitError } from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

describe('fuzzing: decompression bombs (CWE-400/409)', () => {
    it('rejects entries whose declared size exceeds maxEntryUncompressedSize', () => {
        const archive = buildRawZip([
            { name: 'big.bin', data: new Uint8Array(10_000), method: 8 },
        ]);
        expect(() => openZip(archive, { limits: { maxEntryUncompressedSize: 1000 } }).readEntry('big.bin'))
            .toThrow(ZipLimitError);
    });

    it('rejects entries whose declared compression ratio exceeds the bound', () => {
        // 4 MB of zeros deflates to ~4 KB: ratio ≈ 1000.
        const archive = buildRawZip([
            { name: 'zeros.bin', data: new Uint8Array(4_000_000), method: 8 },
        ]);
        expect(() => openZip(archive, { limits: { maxCompressionRatio: 100 } }).readEntry('zeros.bin'))
            .toThrow(/maxCompressionRatio/);
    });

    it('exempts tiny compressed entries from the ratio bound', () => {
        // A few hundred zeros compress to a handful of bytes — extreme ratio,
        // harmless size; must NOT trip the ratio check (< 1 KiB compressed).
        const archive = buildRawZip([
            { name: 'small.bin', data: new Uint8Array(500), method: 8 },
        ]);
        const out = openZip(archive, { limits: { maxCompressionRatio: 2 } }).readEntry('small.bin');
        expect(out.length).toBe(500);
    });

    it('caps output during inflation when the archive under-declares the size', () => {
        // CD says 100 bytes; the stream actually inflates to 100 000.
        const archive = buildRawZip([
            { name: 'liar.bin', data: new Uint8Array(100_000), method: 8, uncompressedSizeOverride: 100 },
        ]);
        expect(() => openZip(archive).readEntry('liar.bin')).toThrow(ZipDataError);
    });

    it('rejects an over-declared size whose stream inflates short', () => {
        const archive = buildRawZip([
            { name: 'short.bin', data: new Uint8Array(100), method: 8, uncompressedSizeOverride: 5000 },
        ]);
        expect(() => openZip(archive).readEntry('short.bin')).toThrow(ZipDataError);
    });

    it('bounds memory for the streaming path too', async () => {
        const archive = buildRawZip([
            { name: 'liar.bin', data: new Uint8Array(1_000_000), method: 8, uncompressedSizeOverride: 100 },
        ]);
        const reader = openZip(archive);
        await expect(async () => {
            for await (const _chunk of reader.readEntryStream('liar.bin')) { /* drain */ }
        }).rejects.toThrow(ZipDataError);
    });

    it('entry-count floods are stopped by maxEntries before any decompression', () => {
        const entries = Array.from({ length: 200 }, (_, i) => ({
            name: `flood/${i}.txt`,
            data: new Uint8Array(1),
        }));
        expect(() => openZip(buildRawZip(entries), { limits: { maxEntries: 100 } }))
            .toThrow(/maxEntries/);
    });
});
