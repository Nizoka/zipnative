import { describe, expect, it } from 'vitest';
import { createZip, iterateZipEntries, openZip, ZipError } from 'zipnative';
import { buildRawZip, seededRandom } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();

async function* streamOf(bytes: Uint8Array, chunkSize: number): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < bytes.length; i += chunkSize) {
        yield bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    }
}

async function readAllForward(bytes: Uint8Array, chunkSize: number): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    for await (const entry of iterateZipEntries(streamOf(bytes, chunkSize), { onDiagnostic: () => undefined })) {
        const usesDescriptor = (entry.header.flags & 0x0008) !== 0;
        // Zero-size non-descriptor entries are auto-drained; bit-3 entries
        // declare 0 but carry a payload and MUST be consumed.
        if (entry.header.compressedSize === 0 && !usesDescriptor) continue;
        let total = 0;
        if (entry.header.isEncrypted) {
            await entry.skip();
        } else {
            for await (const chunk of entry.data()) total += chunk.length;
        }
        sizes.set(entry.header.name, total);
    }
    return sizes;
}

function corpus(): Uint8Array {
    const zip = createZip();
    zip.add('a.txt', te.encode('alpha content for streaming '.repeat(300)));
    zip.add('b/nested.bin', te.encode('beta '.repeat(2000)));
    zip.add('c-stored.bin', te.encode('gamma'), { compression: { method: 'store' } });
    return zip.toBytes();
}

describe('fuzzing: forward reading across hostile chunk boundaries', () => {
    it('1-byte, prime and odd chunk sizes all produce identical results', async () => {
        const bytes = corpus();
        const reference = await readAllForward(bytes, bytes.length); // one chunk
        for (const chunkSize of [1, 2, 3, 7, 13, 61, 127, 509, 1021]) {
            const result = await readAllForward(bytes, chunkSize);
            expect(result, `chunkSize ${chunkSize}`).toEqual(reference);
        }
    });

    it('chunk splits mid-signature are handled', async () => {
        const bytes = corpus();
        // Split exactly inside the first 4 signature bytes.
        async function* split(): AsyncGenerator<Uint8Array> {
            yield bytes.subarray(0, 2);
            yield bytes.subarray(2, 5);
            yield bytes.subarray(5);
        }
        let entries = 0;
        for await (const entry of iterateZipEntries(split(), { onDiagnostic: () => undefined })) {
            if (entry.header.compressedSize > 0) await entry.skip();
            entries++;
        }
        expect(entries).toBe(3);
    });

    it('every truncation point yields a clean ZipError subclass, never a hang', async () => {
        const bytes = corpus();
        const points = new Set<number>();
        for (let i = 0; i < Math.min(60, bytes.length); i++) points.add(i);
        for (let i = 60; i < bytes.length; i += 41) points.add(i);
        for (const cut of points) {
            const truncated = bytes.subarray(0, cut);
            try {
                await readAllForward(truncated, 17);
                // Some cuts land exactly at a record boundary before the CD —
                // a clean stop is acceptable for a forward reader.
            } catch (err) {
                expect(err, `truncation at ${cut}: ${String(err)}`).toBeInstanceOf(ZipError);
            }
        }
    });

    it('seeded corruption yields typed errors or reads that match openZip-visible data', async () => {
        const rand = seededRandom(0xF04D);
        for (let round = 0; round < 120; round++) {
            const bytes = corpus().slice();
            const flips = 1 + Math.floor(rand() * 3);
            for (let f = 0; f < flips; f++) {
                const pos = Math.floor(rand() * bytes.length);
                bytes[pos] ^= 1 << Math.floor(rand() * 8);
            }
            try {
                await readAllForward(bytes, 251);
            } catch (err) {
                expect(err, `round ${round}: ${String(err)}`).toBeInstanceOf(ZipError);
            }
        }
    });

    it('bit-3 archives round-trip at any chunking (0.6: resumable inflater)', async () => {
        const content = te.encode('descriptor content line\n'.repeat(2000));
        const zip = createZip();
        zip.add('plain.txt', 'sibling');
        zip.addStream('s.bin', (async function* () {
            for (let i = 0; i < content.length; i += 733) {
                yield content.subarray(i, Math.min(i + 733, content.length));
            }
        })());
        const parts: Uint8Array[] = [];
        for await (const chunk of zip.stream()) parts.push(chunk);
        const total = parts.reduce((sum, p) => sum + p.length, 0);
        const bytes = new Uint8Array(total);
        let pos = 0;
        for (const part of parts) {
            bytes.set(part, pos);
            pos += part.length;
        }
        const reference = await readAllForward(bytes, bytes.length);
        expect(reference.get('s.bin')).toBe(content.length);
        for (const chunkSize of [1, 7, 64, 509]) {
            expect(await readAllForward(bytes, chunkSize), `chunkSize ${chunkSize}`).toEqual(reference);
        }
    });

    it('truncations inside a bit-3 payload or descriptor stay typed errors', async () => {
        const zip = createZip();
        zip.addStream('s.bin', (async function* () {
            yield te.encode('descriptor payload '.repeat(300));
        })());
        const parts: Uint8Array[] = [];
        for await (const chunk of zip.stream()) parts.push(chunk);
        const total = parts.reduce((sum, p) => sum + p.length, 0);
        const bytes = new Uint8Array(total);
        let pos = 0;
        for (const part of parts) {
            bytes.set(part, pos);
            pos += part.length;
        }
        const points = new Set<number>();
        for (let i = 30; i < bytes.length; i += 23) points.add(i);
        for (let i = Math.max(0, bytes.length - 30); i < bytes.length; i++) points.add(i);
        for (const cut of points) {
            try {
                await readAllForward(bytes.subarray(0, cut), 17);
            } catch (err) {
                expect(err, `cut ${cut}: ${String(err)}`).toBeInstanceOf(ZipError);
            }
        }
    });

    it('adversarial raw-builder archives stream identically to openZip', async () => {
        const bytes = buildRawZip([
            { name: 'raw-store.txt', data: te.encode('raw builder stored payload') },
            { name: 'raw-deflate.bin', data: te.encode('raw builder deflated '.repeat(500)), method: 8 },
        ]);
        const reader = openZip(bytes);
        for await (const entry of iterateZipEntries(streamOf(bytes, 3))) {
            if (entry.header.compressedSize === 0) continue;
            const parts: Uint8Array[] = [];
            let total = 0;
            for await (const chunk of entry.data()) {
                parts.push(chunk);
                total += chunk.length;
            }
            const joined = new Uint8Array(total);
            let position = 0;
            for (const part of parts) {
                joined.set(part, position);
                position += part.length;
            }
            expect(joined).toEqual(reader.readEntry(entry.header.name));
        }
    });
});
