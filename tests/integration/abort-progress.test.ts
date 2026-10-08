import { describe, expect, it } from 'vitest';
import {
    createZip,
    extractZip,
    extractZipStream,
    iterateZipEntries,
    openZip,
    openZipRange,
    rangeSourceFromBytes,
    analyzeDeterminism,
    canonicalizeZip,
    createZipModifier,
    type ZipProgress,
} from 'zipnative';
import { createParallelZip } from 'zipnative/worker';
import { createFakeSpawn } from '../helpers/fake-worker.ts';

/**
 * Cancellation (`signal`) and progress (`onProgress`) on every asynchronous
 * entry point (1.1.0). Abort before, during and after; the caller's own
 * reason comes back; what the operation held is released (a ReadableStream
 * reader's lock without cancelling the stream — the 0.9 contract); progress
 * is monotonic and lands on the exact totals.
 */

const te = new TextEncoder();
const BIG = te.encode('abort and progress '.repeat(20_000)); // ~380 KiB, many chunks

function archive(): Uint8Array {
    const zip = createZip();
    zip.add('a.txt', BIG);
    zip.add('b.txt', te.encode('small'));
    zip.add('c.bin', new Uint8Array(70_000), { compression: { method: 'store' } });
    return zip.toBytes();
}

async function* chunked(bytes: Uint8Array, size = 4096): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, Math.min(i + size, bytes.length));
}

async function drain(gen: AsyncIterable<Uint8Array>): Promise<number> {
    let n = 0;
    for await (const c of gen) n += c.length;
    return n;
}

function monotonic(log: ZipProgress[]): void {
    for (let i = 1; i < log.length; i++) {
        expect(log[i].bytesOut).toBeGreaterThanOrEqual(log[i - 1].bytesOut);
        expect(log[i].entriesDone).toBeGreaterThanOrEqual(log[i - 1].entriesDone);
    }
}

async function rejectsWith(fn: () => Promise<unknown>, reason: unknown): Promise<void> {
    let caught: unknown = 'nothing thrown';
    try { await fn(); } catch (e) { caught = e; }
    expect(caught).toBe(reason);
}

describe('signal — an already-aborted signal rejects before the first byte', () => {
    const reason = new Error('caller cancelled');
    const aborted = AbortSignal.abort(reason);

    it('readEntryStream, extractZipStream, iterateZipEntries, stream(), parallel stream(), and the sync paths', async () => {
        const bytes = archive();
        await rejectsWith(() => drain(openZip(bytes, { signal: aborted }).readEntryStream('a.txt')), reason);
        await rejectsWith(async () => { for await (const _e of extractZipStream(bytes, { signal: aborted })) { /* never */ } }, reason);
        await rejectsWith(async () => { for await (const _e of iterateZipEntries(chunked(bytes), { signal: aborted })) { /* never */ } }, reason);
        const zip = createZip({ signal: aborted });
        zip.add('x', BIG);
        await rejectsWith(() => drain(zip.stream()), reason);
        expect(() => zip.toBytes()).toThrow(reason);
        expect(() => extractZip(bytes, { signal: aborted })).toThrow(reason);
        const parallel = createParallelZip({ signal: aborted, workers: 0 });
        parallel.add('x', BIG);
        await rejectsWith(() => parallel.toBytes(), reason);
    });

    it("the platform's default reason (AbortError) is what comes back", async () => {
        const controller = new AbortController();
        controller.abort();
        let err: unknown;
        try { await drain(openZip(archive(), { signal: controller.signal }).readEntryStream('a.txt')); } catch (e) { err = e; }
        expect((err as Error).name).toBe('AbortError');
    });
});

describe('signal — aborting mid-stream stops the operation and releases the source', () => {
    it('readEntryStream stops after the chunk during which the abort arrived', async () => {
        const controller = new AbortController();
        const reader = openZip(archive(), { signal: controller.signal });
        let seen = 0;
        let err: unknown;
        try {
            for await (const chunk of reader.readEntryStream('a.txt')) {
                seen += chunk.length;
                if (seen > 0) controller.abort();
            }
        } catch (e) { err = e; }
        expect((err as Error).name).toBe('AbortError');
        expect(seen).toBeLessThan(BIG.length);
    });

    it('iterateZipEntries releases a ReadableStream reader lock without cancelling the stream', async () => {
        const bytes = archive();
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                controller.enqueue(bytes);
                controller.close();
            },
            cancel() { cancelled = true; },
        });
        const controller = new AbortController();
        let err: unknown;
        try {
            for await (const entry of iterateZipEntries(stream, { signal: controller.signal })) {
                controller.abort();
                await drain(entry.data());
            }
        } catch (e) { err = e; }
        expect((err as Error).name).toBe('AbortError');
        expect(stream.locked).toBe(false);
        expect(cancelled).toBe(false);
    });

    it('stream() stops emitting and the source iterator is closed', async () => {
        const controller = new AbortController();
        let returned = false;
        const source = (async function* (): AsyncGenerator<Uint8Array> {
            try {
                for (let i = 0; i < 100; i++) yield BIG.subarray(0, 8192);
            } finally {
                returned = true;
            }
        })();
        const zip = createZip({ signal: controller.signal, compression: { method: 'store' } });
        zip.addStream('big.bin', source);
        let emitted = 0;
        let err: unknown;
        try {
            for await (const chunk of zip.stream({ chunkSize: 1024 })) {
                emitted += chunk.length;
                if (emitted > 16_000) controller.abort();
            }
        } catch (e) { err = e; }
        expect((err as Error).name).toBe('AbortError');
        expect(returned).toBe(true);
    });

    it('the parallel writer: an abort while jobs are in flight rejects and leaves no pool behind', async () => {
        const controller = new AbortController();
        const parallel = createParallelZip({ signal: controller.signal, workers: 0 });
        for (let i = 0; i < 20; i++) parallel.add(`e${i}.txt`, BIG);
        queueMicrotask(() => controller.abort());
        let err: unknown;
        try { await parallel.toBytes(); } catch (e) { err = e; }
        expect((err as Error).name).toBe('AbortError');
    });
});

describe('onProgress — monotonic counters and exact totals', () => {
    it('extractZipStream reports the planned entry count and the decompressed total', async () => {
        const log: ZipProgress[] = [];
        let total = 0;
        for await (const e of extractZipStream(archive(), { onProgress: (p) => log.push(p) })) total += await drain(e.stream());
        monotonic(log);
        expect(log.at(-1)).toEqual({ entriesDone: 3, entriesTotal: 3, bytesIn: expect.any(Number), bytesOut: total });
        expect(total).toBe(BIG.length + 5 + 70_000);
        expect(log.length).toBeGreaterThan(3);
    });

    it('iterateZipEntries cannot know the total: entriesTotal is null, bytesIn is the compressed total', async () => {
        const bytes = archive();
        const log: ZipProgress[] = [];
        let total = 0;
        for await (const e of iterateZipEntries(chunked(bytes), { onProgress: (p) => log.push(p) })) total += await drain(e.data());
        monotonic(log);
        const last = log.at(-1)!;
        expect(last.entriesTotal).toBeNull();
        expect(last.entriesDone).toBe(3);
        expect(last.bytesOut).toBe(total);
        const reader = openZip(bytes);
        expect(last.bytesIn).toBe([...reader.entries()].reduce((n, e) => n + e.compressedSize, 0));
    });

    it('readEntryStream reports one entry; stream() reports every entry and the archive length', async () => {
        const bytes = archive();
        const single: ZipProgress[] = [];
        await drain(openZip(bytes, { onProgress: (p) => single.push(p) }).readEntryStream('a.txt'));
        expect(single.at(-1)).toMatchObject({ entriesDone: 1, entriesTotal: 1, bytesOut: BIG.length });

        const log: ZipProgress[] = [];
        const zip = createZip({ onProgress: (p) => log.push(p) });
        zip.add('a.txt', BIG);
        zip.addDirectory('d');
        zip.addStream('s.txt', chunked(te.encode('streamed '.repeat(5000))));
        zip.add('z.bin', new Uint8Array(0));
        const emitted = await drain(zip.stream({ chunkSize: 1024 }));
        monotonic(log);
        expect(log.at(-1)).toEqual({ entriesDone: 4, entriesTotal: 4, bytesIn: BIG.length + 'streamed '.repeat(5000).length, bytesOut: emitted });
    });

    it('the parallel writer reports through stream() identically', async () => {
        const log: ZipProgress[] = [];
        const parallel = createParallelZip({ workers: 0, onProgress: (p) => log.push(p) });
        parallel.add('a.txt', BIG);
        parallel.add('b.txt', te.encode('small'));
        const emitted = await drain(parallel.stream());
        expect(log.at(-1)).toEqual({ entriesDone: 2, entriesTotal: 2, bytesIn: BIG.length + 5, bytesOut: emitted });
    });

    it('without a handler nothing is called and the bytes are unchanged', () => {
        const zip = createZip();
        zip.add('a.txt', BIG);
        const plain = zip.toBytes();
        const tracked = createZip({ onProgress: () => undefined });
        tracked.add('a.txt', BIG);
        expect(tracked.toBytes()).toEqual(plain);
    });
});

// ── Audit fix loop, 1.1.0 (D-06, D-07, D-08, D-05): the options also travel
// per call, and every asynchronous completion reports progress ──────────
describe('per-call signal / onProgress — stream(options) and readEntryStream(entry, options)', () => {
    it('stream({ signal }) rejects before the first chunk, stream({ onProgress }) reports — without touching createZip()', async () => {
        const zip = createZip();
        zip.add('a.txt', BIG);
        zip.add('b.txt', te.encode('small'));
        const aborted = new AbortController();
        aborted.abort(new Error('per-call deadline'));
        await expect(drain(zip.stream({ signal: aborted.signal }))).rejects.toThrow('per-call deadline');
        const snaps: ZipProgress[] = [];
        const length = await drain(zip.stream({ onProgress: (p) => snaps.push(p) }));
        expect(snaps.length).toBeGreaterThan(0);
        expect(snaps[snaps.length - 1].entriesDone).toBe(2);
        expect(snaps[snaps.length - 1].bytesOut).toBe(length);
    });

    it('the per-call options win over the factory ones for that call only', async () => {
        const factory: ZipProgress[] = [];
        const zip = createZip({ onProgress: (p) => factory.push(p) });
        zip.add('a.txt', BIG);
        const perCall: ZipProgress[] = [];
        await drain(zip.stream({ onProgress: (p) => perCall.push(p) }));
        expect(perCall.length).toBeGreaterThan(0);
        expect(factory).toHaveLength(0);
        await drain(zip.stream());
        expect(factory.length).toBeGreaterThan(0);
    });

    it('readEntryStream(entry, { signal, onProgress }) on the in-memory reader', async () => {
        const reader = openZip(archive());
        const aborted = new AbortController();
        aborted.abort(new Error('read deadline'));
        await expect(drain(reader.readEntryStream('a.txt', { signal: aborted.signal }))).rejects.toThrow('read deadline');
        const snaps: ZipProgress[] = [];
        const n = await drain(reader.readEntryStream('a.txt', { onProgress: (p) => snaps.push(p) }));
        expect(n).toBe(BIG.length);
        expect(snaps[snaps.length - 1]).toMatchObject({ entriesDone: 1, entriesTotal: 1, bytesOut: BIG.length });
    });

    it('readEntryStream(entry, { signal, onProgress }) on the byte-range reader', async () => {
        const reader = await openZipRange(rangeSourceFromBytes(archive()));
        const aborted = new AbortController();
        aborted.abort(new Error('range read deadline'));
        await expect(drain(reader.readEntryStream('a.txt', { signal: aborted.signal }))).rejects.toThrow('range read deadline');
        const snaps: ZipProgress[] = [];
        const n = await drain(reader.readEntryStream('a.txt', { onProgress: (p) => snaps.push(p) }));
        expect(n).toBe(BIG.length);
        expect(snaps[snaps.length - 1].entriesDone).toBe(1);
    });

    it('the parallel writer reports progress on toBytes(): one step per settled entry, then the archive length', async () => {
        const snaps: ZipProgress[] = [];
        const zip = createParallelZip({ workers: 0, onProgress: (p) => snaps.push(p) });
        zip.add('a.txt', BIG);
        zip.add('b.txt', te.encode('small'));
        zip.add('c.bin', new Uint8Array(70_000), { compression: { method: 'store' } });
        const bytes = await zip.toBytes();
        expect(snaps.length).toBeGreaterThanOrEqual(4);
        const perEntry = snaps.filter((p) => p.entriesTotal === 3);
        expect(perEntry[perEntry.length - 1]).toMatchObject({ entriesDone: 3, bytesIn: BIG.length + 5 + 70_000 });
        expect(snaps[snaps.length - 1].bytesOut).toBe(bytes.length);
    });

    it('the forward reader counts a skipped entry as completed', async () => {
        const snaps: ZipProgress[] = [];
        let n = 0;
        for await (const entry of iterateZipEntries(chunked(archive()), { onProgress: (p) => snaps.push(p) })) {
            n++;
            await entry.skip();
        }
        expect(n).toBe(3);
        expect(snaps[snaps.length - 1].entriesDone).toBe(3);
        expect(snaps[snaps.length - 1].entriesTotal).toBeNull();
    });
});

// ── Final audit (C1, C2, C4): no worker left behind on a pre-aborted signal,
// one monotonic series per parallel call, every synchronous entry point ──
describe('final audit — pool lifetime, one series per call, synchronous entry points', () => {
    it('an already-aborted signal spawns no worker and closes nothing it did not open', async () => {
        const fake = createFakeSpawn();
        const aborted = AbortSignal.abort(new Error('before the pool'));
        const zip = createParallelZip({ signal: aborted, workers: 2, _spawn: fake.spawn } as never);
        zip.add('a.bin', BIG);
        zip.add('b.bin', new Uint8Array(BIG.length).map((_, i) => i & 0xff));
        await rejectsWith(() => zip.toBytes(), aborted.reason as Error);
        expect(fake.spawned()).toBe(0);
        expect(fake.terminated()).toBe(0);
    });

    it('an abort while jobs are in flight terminates every spawned worker', async () => {
        const fake = createFakeSpawn({ delayMs: 30 });
        const controller = new AbortController();
        const zip = createParallelZip({ signal: controller.signal, workers: 2, _spawn: fake.spawn } as never);
        zip.add('a.bin', BIG);
        zip.add('b.bin', new Uint8Array(BIG.length).map((_, i) => (i * 7) & 0xff));
        const pending = zip.toBytes();
        const reason = new Error('mid-flight');
        setTimeout(() => controller.abort(reason), 5);
        await rejectsWith(() => pending, reason);
        expect(fake.spawned()).toBeGreaterThan(0);
        expect(fake.terminated()).toBe(fake.spawned());
    });

    it('parallel toBytes() and stream() each report one monotonic series with the exact totals', async () => {
        const build = (): ReturnType<typeof createParallelZip> => {
            const zip = createParallelZip({ workers: 0, onProgress: (p) => snaps.push(p) });
            zip.add('a.txt', BIG);
            zip.add('b.txt', te.encode('small'));
            zip.add('c.bin', new Uint8Array(70_000), { compression: { method: 'store' } });
            return zip;
        };
        let snaps: ZipProgress[] = [];
        const bytes = await build().toBytes();
        monotonic(snaps);
        expect(snaps.every((p) => p.entriesTotal === 3)).toBe(true);
        expect(snaps[snaps.length - 1]).toMatchObject({ entriesDone: 3, entriesTotal: 3, bytesIn: BIG.length + 5 + 70_000, bytesOut: bytes.length });

        snaps = [];
        const streamed = await drain(build().stream());
        monotonic(snaps);
        expect(snaps.every((p) => p.entriesTotal === 3)).toBe(true);
        expect(snaps[snaps.length - 1]).toMatchObject({ entriesDone: 3, bytesIn: BIG.length + 5 + 70_000, bytesOut: streamed });
    });

    it('every synchronous entry point throws the reason on entry when already aborted', () => {
        const reason = new Error('sync entry');
        const aborted = AbortSignal.abort(reason);
        const bytes = archive();
        expect(() => openZip(bytes, { signal: aborted })).toThrow(reason);
        expect(() => canonicalizeZip(bytes, { signal: aborted })).toThrow(reason);
        expect(() => analyzeDeterminism(bytes, { signal: aborted })).toThrow(reason);
        // readEntry: the per-call signal, then the reader-wide one.
        const reader = openZip(bytes);
        const first = [...reader.entries()][0];
        expect(() => reader.readEntry(first, { signal: aborted })).toThrow(reason);
        expect(() => openZip(bytes, { signal: aborted })).toThrow(reason);
        // The modifier: the factory, then each synchronous save.
        expect(() => createZipModifier(reader, { signal: aborted })).toThrow(reason);
        const controller = new AbortController();
        const modifier = createZipModifier(reader, { signal: controller.signal });
        modifier.addEntry('late.txt', new TextEncoder().encode('late'));
        controller.abort(reason);
        expect(() => modifier.save()).toThrow(reason);
        expect(() => modifier.saveCompact()).toThrow(reason);
    });
});
