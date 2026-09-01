import { describe, expect, it } from 'vitest';
import { createZip, openZip } from 'zipnative';
import { createParallelZip, type ParallelZipOptions, type ParallelZipWriter } from '../../src/worker/index.ts';
import { type WorkerSpawnSeam } from '../../src/worker/worker-pool.ts';
import { createFakeSpawn } from '../helpers/fake-worker.ts';

// The _spawn test seam is deliberately absent from the public options
// type (0.8 surface hygiene) — the intersection restores it for tests.
const createSeamedZip = (options: ParallelZipOptions & WorkerSpawnSeam): ParallelZipWriter =>
    createParallelZip(options);

const te = new TextEncoder();

function addCorpus(writer: { add: (n: string, d: Uint8Array | string, o?: object) => void; addDirectory: (n: string) => void; setComment: (c: string) => void }): void {
    writer.add('docs/readme.md', te.encode('# heading\n' + 'prose line\n'.repeat(8000)));
    writer.add('data/table.csv', te.encode('a,b,c\n'.repeat(20_000)));
    writer.add('assets/blob.bin', (() => {
        const noise = new Uint8Array(90_000);
        let state = 0x5EED;
        for (let i = 0; i < noise.length; i++) {
            state = (Math.imul(state, 1103515245) + 12345) >>> 0;
            noise[i] = (state >>> 16) & 0xff;
        }
        return noise;
    })());
    writer.add('tiny.txt', 'below the worker threshold');
    writer.add('empty.txt', new Uint8Array(0));
    writer.addDirectory('docs');
    writer.setComment('parallel parity corpus');
}

describe('createParallelZip: byte-identity with createZip', () => {
    it('workers: 0 (main-thread mode) is byte-identical', async () => {
        const sequential = createZip();
        addCorpus(sequential);
        const parallel = createParallelZip({ workers: 0 });
        addCorpus(parallel);
        expect(await parallel.toBytes()).toEqual(sequential.toBytes());
    });

    it('through a real pool (fake workers, real deflate) is byte-identical', async () => {
        const sequential = createZip();
        addCorpus(sequential);
        const { spawn } = createFakeSpawn({ delayMs: 2 });
        const parallel = createSeamedZip({ workers: 3, minWorkerJobSize: 1024, _spawn: spawn });
        addCorpus(parallel);
        expect(await parallel.toBytes()).toEqual(sequential.toBytes());
    });

    it('deterministic mode stays pinned and identical through the pool', async () => {
        const options = { compression: { deterministic: true as const } };
        const sequential = createZip(options);
        addCorpus(sequential);
        const { spawn } = createFakeSpawn();
        const parallel = createSeamedZip({ ...options, workers: 2, minWorkerJobSize: 1024, _spawn: spawn });
        addCorpus(parallel);
        expect(await parallel.toBytes()).toEqual(sequential.toBytes());
    });

    it("insertion order and per-entry options survive the parallel path", async () => {
        const build = <W extends { add: (n: string, d: string, o?: object) => void }>(w: W): W => {
            w.add('z-first.txt', 'insertion keeps me first');
            w.add('a-second.txt', 'and me second', { compression: { method: 'store' } });
            return w;
        };
        const sequential = build(createZip({ order: 'insertion' }));
        const { spawn } = createFakeSpawn();
        const parallel = build(createSeamedZip({ order: 'insertion', workers: 2, _spawn: spawn }));
        expect(await parallel.toBytes()).toEqual(sequential.toBytes());
    });

    it('worker failures degrade to identical bytes (never a different archive)', async () => {
        const sequential = createZip();
        addCorpus(sequential);
        const { spawn } = createFakeSpawn({ failJobs: [1, 2], dieAtBoot: [2] });
        const parallel = createSeamedZip({ workers: 2, minWorkerJobSize: 1024, _spawn: spawn });
        addCorpus(parallel);
        expect(await parallel.toBytes()).toEqual(sequential.toBytes());
    });

    it('stream() output is byte-identical to toBytes()', async () => {
        const { spawn } = createFakeSpawn();
        const a = createSeamedZip({ workers: 2, minWorkerJobSize: 1024, _spawn: spawn });
        addCorpus(a);
        const buffered = await a.toBytes();

        const { spawn: spawn2 } = createFakeSpawn();
        const b = createSeamedZip({ workers: 2, minWorkerJobSize: 1024, _spawn: spawn2 });
        addCorpus(b);
        const parts: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of b.stream({ chunkSize: 4096 })) {
            parts.push(chunk);
            total += chunk.length;
        }
        const streamed = new Uint8Array(total);
        let pos = 0;
        for (const part of parts) {
            streamed.set(part, pos);
            pos += part.length;
        }
        expect(streamed).toEqual(buffered);
    });

    it('the archive opens and verifies through the eager reader', async () => {
        const { spawn } = createFakeSpawn();
        const parallel = createSeamedZip({ workers: 3, minWorkerJobSize: 1024, _spawn: spawn });
        addCorpus(parallel);
        const reader = openZip(await parallel.toBytes(), { validate: 'eager' });
        for (const entry of reader.entries()) {
            if (!entry.isDirectory) {
                expect(reader.verifyEntry(entry).ok, entry.name).toBe(true);
            }
        }
    });

    it('toBytes() still rejects addStream entries with the remedy', async () => {
        const parallel = createParallelZip({ workers: 0 });
        parallel.addStream('s.bin', (async function* () {
            yield te.encode('x');
        })());
        await expect(parallel.toBytes()).rejects.toThrow(/stream\(\)/);
    });
});
