/**
 * Buffered ↔ streaming byte-identity: both writers consume the same
 * segment generator, so parity is structural — these tests keep it that
 * way. Golden fixtures (zip-determinism.test.ts) pin only the buffered
 * path; this suite carries the pin to the streaming path.
 */
import { describe, expect, it } from 'vitest';
import { createZip, ZipError, type ZipWriter } from 'zipnative';

const te = new TextEncoder();

function buildWriter(): ZipWriter {
    // Seeded pseudo-random payload: incompressible, so the archive stays
    // comfortably larger than the minimum 1 KiB chunk size.
    const noise = new Uint8Array(8192);
    let state = 0xBEEF;
    for (let i = 0; i < noise.length; i++) {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        noise[i] = (state >>> 16) & 0xff;
    }
    const zip = createZip({ compression: { deterministic: true } });
    zip.add('alpha.txt', 'first entry');
    zip.add('nested/beta.bin', te.encode('beta '.repeat(5000)));
    zip.add('noise.bin', noise);
    zip.addDirectory('nested');
    zip.add('gamma.txt', te.encode('gamma content here'), { compression: { method: 'store' } });
    zip.setComment('parity');
    return zip;
}

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<{ bytes: Uint8Array; chunks: number }> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of gen) {
        parts.push(chunk);
        total += chunk.length;
    }
    const bytes = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
        bytes.set(part, pos);
        pos += part.length;
    }
    return { bytes, chunks: parts.length };
}

describe('stream() is byte-identical to toBytes()', () => {
    it('at the default chunk size', async () => {
        const buffered = buildWriter().toBytes();
        const { bytes: streamed } = await collect(buildWriter().stream());
        expect(streamed).toEqual(buffered);
    });

    it('at chunkSize 1024 — rechunking is transparent', async () => {
        const buffered = buildWriter().toBytes();
        const { bytes: streamed } = await collect(buildWriter().stream({ chunkSize: 1024 }));
        expect(streamed).toEqual(buffered);
    });

    it('actually chunks at a small chunk size', async () => {
        const { chunks } = await collect(buildWriter().stream({ chunkSize: 1024 }));
        expect(chunks).toBeGreaterThan(1);
    });

    it('a limit violation rejects on the first .next(), before any byte', async () => {
        const zip = createZip({ limits: { maxEntries: 1 } });
        zip.add('a', '1');
        zip.add('b', '2');
        const gen = zip.stream();
        await expect(gen.next()).rejects.toThrow(/maxEntries/);
    });

    it('an invalid chunkSize throws (not clamps)', async () => {
        const zip = createZip();
        zip.add('a', '1');
        const gen = zip.stream({ chunkSize: -1 });
        await expect(gen.next()).rejects.toThrow(ZipError);
    });
});
