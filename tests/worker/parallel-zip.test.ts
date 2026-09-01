import { describe, expect, it } from 'vitest';
import { createZip, openZip } from 'zipnative';
import { createParallelZip } from '../../src/worker/index.ts';
import { createFakeSpawn } from '../helpers/fake-worker.ts';

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
        const parallel = createParallelZip({ workers: 3, minWorkerJobSize: 1024, _spawn: spawn });
        addCorpus(parallel);
        expect(await parallel.toBytes()).toEqual(sequential.toBytes());
    });

    it('deterministic mode stays pinned and identical through the pool', async () => {
        const options = { compression: { deterministic: true as const } };
        const sequential = createZip(options);
        addCorpus(sequential);
        const { spawn } = createFakeSpawn();
        const parallel = createParallelZip({ ...options, workers: 2, minWorkerJobSize: 1024, _spawn: spawn });
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
        const parallel = build(createParallelZip({ order: 'insertion', workers: 2, _spawn: spawn }));
        expect(await parallel.toBytes()).toEqual(sequential.toBytes());
    });

    it('worker failures degrade to identical bytes (never a different archive)', async () => {
        const sequential = createZip();
        addCorpus(sequential);
        const { spawn } = createFakeSpawn({ failJobs: [1, 2], dieAtBoot: [2] });
        const parallel = createParallelZip({ workers: 2, minWorkerJobSize: 1024, _spawn: spawn });
        addCorpus(parallel);
        expect(await parallel.toBytes()).toEqual(sequential.toBytes());
    });

    it('stream() output is byte-identical to toBytes()', async () => {
        const { spawn } = createFakeSpawn();
        const a = createParallelZip({ workers: 2, minWorkerJobSize: 1024, _spawn: spawn });
        addCorpus(a);
        const buffered = await a.toBytes();

        const { spawn: spawn2 } = createFakeSpawn();
        const b = createParallelZip({ workers: 2, minWorkerJobSize: 1024, _spawn: spawn2 });
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
        const parallel = createParallelZip({ workers: 3, minWorkerJobSize: 1024, _spawn: spawn });
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
