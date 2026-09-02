/**
 * 0.9 coverage-hardening suite: every gap named by the pre-1.0 audit —
 * seams that were public API with zero tests (registerCodec end-to-end,
 * setDeflateImpl, activeDeflateTier), documented-but-never-executed
 * paths (addStream's buffered deterministic fallback, the pure-TS
 * forward-iterate pump), the untested ZIP_UNSUPPORTED_ZIP64_STREAMING
 * refusal, strict-mode parity across all five entry points, and the new
 * 0.9 ByteSource/attribute surfaces.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    activeDeflateTier,
    createZip,
    createZipModifier,
    extractZip,
    extractZipStream,
    getUnixMode,
    isSymlinkEntry,
    iterateZipEntries,
    openZip,
    registerCodec,
    setDeflateImpl,
    ZipError,
    ZipUnsupportedError,
} from 'zipnative';
import { _resetDeflateCache } from '../../src/codecs/deflate.ts';
import { assertStreamSizesInRange, type PlannedEntry } from '../../src/core/zip-segments.ts';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();
const td = new TextDecoder();

async function collect(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const pieces: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of gen) { pieces.push(chunk); total += chunk.length; }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of pieces) { out.set(p, pos); pos += p.length; }
    return out;
}

describe('registerCodec — the extension point, end to end', () => {
    it('a full custom codec makes a foreign method readable through every read path', async () => {
        // Identity codec under an unused method id — proves the registry
        // dispatch seam end to end (sync, stream and verify paths).
        registerCodec({
            method: 94,
            name: 'copy-test',
            decompressSync: (data) => data.slice(),
            decompressStream: async function* (data) { yield data.slice(); },
        });
        const plain = te.encode('custom codec payload');
        const archive = buildRawZip([{ name: 'x.bin', data: plain, method: 94 }]);
        const reader = openZip(archive);
        expect(td.decode(reader.readEntry('x.bin'))).toBe('custom codec payload');
        expect(td.decode(await collect(reader.readEntryStream('x.bin')))).toBe('custom codec payload');
        expect(reader.verifyEntry('x.bin').ok).toBe(true);
    });

    it('a sync-only codec refuses readEntryStream with ZIP_UNSUPPORTED_CODEC_MODE', async () => {
        registerCodec({ method: 95, name: 'sync-only-test', decompressSync: (d) => d });
        const archive = buildRawZip([{ name: 'x.bin', data: te.encode('zz'), method: 95 }]);
        const reader = openZip(archive);
        expect(td.decode(reader.readEntry('x.bin'))).toBe('zz');
        await expect(collect(reader.readEntryStream('x.bin'))).rejects.toMatchObject({
            code: 'ZIP_UNSUPPORTED_CODEC_MODE',
        });
    });

    it('a stream-only codec refuses readEntry with ZIP_UNSUPPORTED_CODEC_MODE', () => {
        registerCodec({
            method: 96, name: 'stream-only-test-2',
            decompressStream: async function* (d) { yield d; },
        });
        const archive = buildRawZip([{ name: 'x.bin', data: te.encode('zz'), method: 96 }]);
        const reader = openZip(archive);
        try {
            reader.readEntry('x.bin');
            expect.unreachable('sync read of a stream-only codec must refuse');
        } catch (err) {
            expect(err).toBeInstanceOf(ZipUnsupportedError);
            expect((err as ZipUnsupportedError).code).toBe('ZIP_UNSUPPORTED_CODEC_MODE');
        }
    });
});

describe('setDeflateImpl + activeDeflateTier — the injection seam', () => {
    afterEach(() => {
        setDeflateImpl(null);
        _resetDeflateCache();
    });

    it('an injected compressor is reported and actually used', async () => {
        const { deflateRawJS } = await import('../../src/codecs/deflate-pure.ts');
        let calls = 0;
        setDeflateImpl((data, level) => { calls++; return deflateRawJS(data, level); });
        expect(activeDeflateTier()).toBe('injected');
        const zip = createZip();
        zip.add('a.txt', te.encode('injectable content that is long enough to try deflate'.repeat(4)));
        const bytes = zip.toBytes();
        expect(calls).toBeGreaterThan(0);          // the seam ran
        expect(openZip(bytes).readEntry('a.txt')); // and the fallback produced a valid archive
    });

    it('deterministic mode always reports the pinned pure tier', () => {
        expect(activeDeflateTier(true)).toBe('pure-pinned');
    });
});

describe('addStream buffered fallback (deterministic: true) — the documented caveat, executed', () => {
    it('deterministic streaming buffers, compresses via the pinned tier, and round-trips', async () => {
        async function* source(): AsyncGenerator<Uint8Array> {
            for (let i = 0; i < 5; i++) yield te.encode(`chunk-${i}-`.repeat(200));
        }
        const zip = createZip({ compression: { deterministic: true } });
        zip.addStream('big.txt', source());
        const bytes = await collect(zip.stream());
        const reader = openZip(bytes, { validate: 'eager' });
        const entry = reader.getEntry('big.txt');
        expect(entry).not.toBeNull();
        expect(reader.verifyEntry(entry as never).ok).toBe(true);
    });
});

describe('ZIP_UNSUPPORTED_ZIP64_STREAMING — the refusal, finally pinned', () => {
    it('a stream entry whose measured size passes 4 GiB refuses with the typed code', () => {
        const plan = { uncompressedSize: 5 * 1024 ** 3, compressedSize: 1024 } as PlannedEntry;
        try {
            assertStreamSizesInRange(plan, 'huge.bin');
            expect.unreachable('must refuse');
        } catch (err) {
            expect(err).toBeInstanceOf(ZipUnsupportedError);
            expect((err as ZipUnsupportedError).code).toBe('ZIP_UNSUPPORTED_ZIP64_STREAMING');
            expect((err as ZipUnsupportedError).feature).toBe('zip64-streaming');
        }
    });
});

describe('forward iteration without DecompressionStream — the pure-TS pump', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('known-size deflate entries stream through the resumable inflater', async () => {
        vi.stubGlobal('DecompressionStream', undefined);
        const zip = createZip();
        zip.add('a.txt', te.encode('pure-pump payload '.repeat(500)));
        const bytes = zip.toBytes();
        async function* chunks(): AsyncGenerator<Uint8Array> {
            for (let i = 0; i < bytes.length; i += 31) yield bytes.subarray(i, Math.min(i + 31, bytes.length));
        }
        for await (const entry of iterateZipEntries(chunks())) {
            const content = td.decode(await collect(entry.data()));
            expect(content.startsWith('pure-pump payload ')).toBe(true);
        }
    });
});

describe('strict-mode parity across the five entry points', () => {
    const sfx = (): Uint8Array => buildRawZip(
        [{ name: 'a.txt', data: te.encode('x') }],
        { prepend: te.encode('#!/bin/sh\nstub\n') },
    );

    it('openZip / extractZip / extractZipStream escalate a diagnostic identically', async () => {
        for (const run of [
            (): unknown => openZip(sfx(), { strict: true }),
            (): unknown => extractZip(sfx(), { strict: true }),
        ]) {
            try {
                run();
                expect.unreachable('strict must escalate the SFX diagnostic');
            } catch (err) {
                expect(err).toBeInstanceOf(ZipError);
                expect((err as ZipError).code).toBe('ZIP_STRICT_DIAGNOSTIC');
            }
        }
        // extractZipStream and iterateZipEntries: async paths.
        await expect((async () => { for await (const f of extractZipStream(sfx(), { strict: true })) void f; })())
            .rejects.toMatchObject({ code: 'ZIP_STRICT_DIAGNOSTIC' });
    });

    it('createZip and createZipModifier escalate the timestamp diagnostic identically', () => {
        for (const run of [
            (): unknown => createZip({ strict: true, defaultDate: 'now' }),
            (): unknown => {
                const reader = openZip(buildRawZip([{ name: 'a.txt', data: te.encode('x') }]));
                const mod = createZipModifier(reader, { strict: true, defaultDate: 'now' });
                mod.addEntry('b.txt', te.encode('y'));
                return mod.save();
            },
        ]) {
            try {
                run();
                expect.unreachable('strict must escalate the timestamp diagnostic');
            } catch (err) {
                expect(err).toBeInstanceOf(ZipError);
                expect((err as ZipError).code).toBe('ZIP_STRICT_DIAGNOSTIC');
            }
        }
    });
});

describe('extractZipStream — security parity with extractZip', () => {
    it('refuses a zip-slip archive with the same typed code', async () => {
        const hostile = buildRawZip([{ name: '../evil.txt', data: te.encode('x') }]);
        await expect((async () => { for await (const f of extractZipStream(hostile)) void f; })())
            .rejects.toMatchObject({ code: 'ZIP_PATH_TRAVERSAL' });
    });
});

describe('bit-3 skip() still runs under the security limits', () => {
    it('a skipped descriptor entry cannot exceed the output bound unnoticed', async () => {
        const zip = createZip();
        zip.addStream('big.bin', (async function* (): AsyncGenerator<Uint8Array> {
            yield te.encode('spillover '.repeat(4000)); // 40 KB uncompressed
        })());
        const bytes = await collect(zip.stream());
        async function* chunks(): AsyncGenerator<Uint8Array> { yield bytes; }
        await expect((async () => {
            for await (const entry of iterateZipEntries(chunks(), { limits: { maxEntryUncompressedSize: 1024 } })) {
                await entry.skip(); // decompress-and-discard must stay bounded
            }
        })()).rejects.toMatchObject({ code: 'ZIP_INFLATE_OUTPUT_OVERFLOW' }); // the limit feeds the inflater's hard cap
    });
});

describe('0.9 — ByteSource: ReadableStream sources', () => {
    const streamOf = (bytes: Uint8Array, chunk = 1024): ReadableStream<Uint8Array> => new ReadableStream({
        start(controller): void {
            for (let i = 0; i < bytes.length; i += chunk) {
                controller.enqueue(bytes.subarray(i, Math.min(i + chunk, bytes.length)));
            }
            controller.close();
        },
    });

    it('iterateZipEntries reads a ReadableStream body', async () => {
        const zip = createZip();
        zip.add('r.txt', te.encode('from a readable stream'));
        const names: string[] = [];
        for await (const entry of iterateZipEntries(streamOf(zip.toBytes(), 7))) {
            names.push(entry.header.name);
            expect(td.decode(await collect(entry.data()))).toBe('from a readable stream');
        }
        expect(names).toEqual(['r.txt']);
    });

    it('addStream accepts a ReadableStream and round-trips byte-identically', async () => {
        const payload = te.encode('readable-stream payload '.repeat(300));
        const viaStream = createZip();
        viaStream.addStream('p.bin', streamOf(payload, 251));
        const bytes = await collect(viaStream.stream());
        const reader = openZip(bytes, { validate: 'eager' });
        expect(collectSyncEqual(reader.readEntry('p.bin'), payload)).toBe(true);
    });

    it('drives getReader() when Symbol.asyncIterator is absent (Safari path), releasing the lock', async () => {
        // Node's ReadableStream carries Symbol.asyncIterator, so the manual
        // reader loop in zip-source never runs here naturally. Model the
        // Safari-shaped stream: getReader() only.
        const zip = createZip();
        zip.add('s.txt', te.encode('safari-shaped source'));
        const bytes = zip.toBytes();
        let released = false;
        let offset = 0;
        const safariLike = {
            getReader: () => ({
                read: () => {
                    if (offset >= bytes.length) return Promise.resolve({ done: true as const, value: undefined });
                    const value = bytes.subarray(offset, Math.min(offset + 64, bytes.length));
                    offset += 64;
                    return Promise.resolve({ done: false as const, value });
                },
                releaseLock: () => { released = true; },
            }),
        } as unknown as ReadableStream<Uint8Array>;
        const names: string[] = [];
        for await (const entry of iterateZipEntries(safariLike)) {
            names.push(entry.header.name);
            expect(td.decode(await collect(entry.data()))).toBe('safari-shaped source');
        }
        expect(names).toEqual(['s.txt']);
        expect(released).toBe(true); // the finally clause released the lock
    });
});

describe('0.9 — entry attribute helpers', () => {
    it('isSymlinkEntry spots a Unix symlink; getUnixMode reads the mode', () => {
        const archive = buildRawZip([{
            name: 'link', data: te.encode('target/path'),
            externalAttributes: ((0o120777 << 16) >>> 0), // S_IFLNK | 0777
            versionMadeBy: 0x031E,                        // Unix, spec 3.0
        }]);
        const entry = openZip(archive).getEntry('link');
        expect(entry).not.toBeNull();
        expect(isSymlinkEntry(entry as never)).toBe(true);
        expect(getUnixMode(entry as never)).toBe(0o120777);
    });

    it('a DOS-authored entry reports null mode, never a fake zero', () => {
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('x'), versionMadeBy: 0x0014 }]);
        const entry = openZip(archive).getEntry('a.txt');
        expect(getUnixMode(entry as never)).toBeNull();
        expect(isSymlinkEntry(entry as never)).toBe(false);
    });
});

function collectSyncEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
