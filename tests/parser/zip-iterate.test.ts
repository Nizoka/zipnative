import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    createZip,
    iterateZipEntries,
    openZip,
    ZipDataError,
    ZipError,
    ZipUnsupportedError,
} from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();
const td = new TextDecoder();

async function* streamOf(bytes: Uint8Array, chunkSize = 1024): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < bytes.length; i += chunkSize) {
        yield bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    }
}

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of gen) {
        parts.push(chunk);
        total += chunk.length;
    }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    return out;
}

function corpusArchive(): Uint8Array {
    const zip = createZip();
    zip.add('first.txt', 'plain stored-or-deflated text');
    zip.add('big/deflated.txt', te.encode('the same compressible line\n'.repeat(4000)));
    zip.addDirectory('big');
    zip.add('last.bin', (() => {
        const noise = new Uint8Array(3000);
        let state = 7;
        for (let i = 0; i < noise.length; i++) {
            state = (Math.imul(state, 1103515245) + 12345) >>> 0;
            noise[i] = (state >>> 16) & 0xff;
        }
        return noise;
    })());
    return zip.toBytes();
}

describe('iterateZipEntries: forward CD-less reading', () => {
    it('streams every entry with content matching the authoritative reader', async () => {
        const bytes = corpusArchive();
        const reader = openZip(bytes);
        const seen = new Map<string, Uint8Array>();
        for await (const entry of iterateZipEntries(streamOf(bytes, 777))) {
            if (entry.header.isDirectory) continue;
            seen.set(entry.header.name, await collect(entry.data()));
        }
        expect([...seen.keys()].sort()).toEqual(
            [...reader.entries()].filter((e) => !e.isDirectory).map((e) => e.name).sort());
        for (const [name, data] of seen) {
            expect(data, name).toEqual(reader.readEntry(name));
        }
    });

    it('stops cleanly at the central directory, leaving the rest unconsumed', async () => {
        const bytes = corpusArchive();
        let count = 0;
        for await (const entry of iterateZipEntries(streamOf(bytes))) {
            await entry.skip();
            count++;
        }
        expect(count).toBe(4); // 3 files + 1 directory
    });

    it('an empty archive yields nothing', async () => {
        const bytes = createZip().toBytes();
        let count = 0;
        for await (const _entry of iterateZipEntries(streamOf(bytes))) count++;
        expect(count).toBe(0);
    });

    it('skip() fast-forwards without decompressing', async () => {
        const bytes = corpusArchive();
        const names: string[] = [];
        for await (const entry of iterateZipEntries(streamOf(bytes))) {
            names.push(entry.header.name);
            if (entry.header.name === 'big/deflated.txt') {
                const data = await collect(entry.data());
                expect(td.decode(data)).toContain('compressible line');
            } else {
                await entry.skip();
            }
        }
        expect(names).toContain('big/deflated.txt');
    });

    it('advancing without draining throws with the remedy', async () => {
        const zip = createZip({ order: 'insertion' });
        zip.add('first-with-content.txt', 'must be drained before advancing');
        zip.add('second.txt', 'never reached');
        const iterator = iterateZipEntries(streamOf(zip.toBytes()));
        const first = await iterator.next();
        expect(first.done).toBe(false);
        expect((first.value as { header: { name: string } }).header.name).toBe('first-with-content.txt');
        await expect(iterator.next()).rejects.toThrow(/skip\(\)/);
    });

    it('data() is single-shot', async () => {
        const bytes = corpusArchive();
        for await (const entry of iterateZipEntries(streamOf(bytes))) {
            await collect(entry.data());
            expect(() => entry.data()).toThrow(ZipError);
            break;
        }
    });

    it('data-descriptor entries (bit 3) are refused with the openZip remedy', async () => {
        const zip = createZip();
        zip.addStream('streamed.bin', (async function* () {
            yield te.encode('descriptor payload');
        })());
        const bytes = await collect(zip.stream());
        await expect(async () => {
            for await (const entry of iterateZipEntries(streamOf(bytes))) {
                await entry.skip();
            }
        }).rejects.toThrow(ZipUnsupportedError);
        await expect(async () => {
            for await (const entry of iterateZipEntries(streamOf(bytes))) {
                await entry.skip();
            }
        }).rejects.toThrow(/openZip/);
    });

    it('encrypted entries yield a header; data() throws typed; skip() advances', async () => {
        const bytes = buildRawZip([
            { name: 'secret.bin', data: te.encode('ciphertext-stand-in'), flags: 0x0001 },
            { name: 'open.txt', data: te.encode('cleartext') },
        ]);
        const names: string[] = [];
        for await (const entry of iterateZipEntries(streamOf(bytes))) {
            names.push(entry.header.name);
            if (entry.header.isEncrypted) {
                expect(() => entry.data()).toThrow(ZipUnsupportedError);
                await entry.skip();
            } else {
                expect(td.decode(await collect(entry.data()))).toBe('cleartext');
            }
        }
        expect(names).toEqual(['secret.bin', 'open.txt']);
    });

    it('a lying CRC surfaces as ZipDataError at the end of data()', async () => {
        const bytes = buildRawZip([
            { name: 'bad.txt', data: te.encode('content'), crcOverride: 0xDEADBEEF },
        ]);
        await expect(async () => {
            for await (const entry of iterateZipEntries(streamOf(bytes))) {
                await collect(entry.data());
            }
        }).rejects.toThrow(ZipDataError);
    });

    it('garbage instead of a header is a format error naming the offset', async () => {
        const garbage = te.encode('this is definitely not a zip stream at all');
        await expect(async () => {
            for await (const _entry of iterateZipEntries(streamOf(garbage))) { /* never */ }
        }).rejects.toThrow(/byte 0/);
    });

    it('enforces maxEntries on streamed floods', async () => {
        const zip = createZip();
        for (let i = 0; i < 20; i++) zip.add(`f/${i}`, 'x');
        const bytes = zip.toBytes();
        await expect(async () => {
            for await (const entry of iterateZipEntries(streamOf(bytes), { limits: { maxEntries: 10 } })) {
                await entry.skip();
            }
        }).rejects.toThrow(/maxEntries/);
    });

    it('reads the committed foreign fixtures identically to openZip (bit-3 producers noted)', async () => {
        const fixtures = readdirSync('tests/fixtures/interop').filter((f) => f.endsWith('.zip'));
        expect(fixtures.length).toBeGreaterThan(0);
        let comparedFixtures = 0;
        for (const name of fixtures) {
            const bytes = new Uint8Array(readFileSync(`tests/fixtures/interop/${name}`));
            const reader = openZip(bytes, { onDiagnostic: () => undefined });
            try {
                for await (const entry of iterateZipEntries(streamOf(bytes, 511), { onDiagnostic: () => undefined })) {
                    if (entry.header.isDirectory) continue; // auto-drained
                    const authoritative = reader.getEntry(entry.header.name);
                    if (authoritative === null) {
                        await entry.skip(); // producer name-normalization differences
                        continue;
                    }
                    expect(await collect(entry.data()), `${name}:${entry.header.name}`)
                        .toEqual(reader.readEntry(authoritative));
                }
                comparedFixtures++;
            } catch (err) {
                // Real-world confirmation of the documented v0.5 limitation:
                // some producers (bsdtar among them) write data-descriptor
                // entries, which forward reading refuses by design.
                expect(err).toBeInstanceOf(ZipUnsupportedError);
                expect((err as ZipUnsupportedError).feature).toBe('cd-less-descriptor');
            }
        }
        expect(comparedFixtures).toBeGreaterThan(0); // at least one non-bit-3 producer
    });
});
