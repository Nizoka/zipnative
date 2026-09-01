/**
 * REAL worker integration: spawns actual node:worker_threads running the
 * built dist/worker/zip-worker.js bundle. Requires a prior `npm run build`
 * — skipped when dist is absent (CI runs this suite in a dedicated step
 * AFTER the build; see ci.yml).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createZip, initNodeZipCodecs, openZip } from 'zipnative';
import { createParallelZip } from '../../src/worker/index.ts';

// Align the main thread's compression tier with the workers' (node:zlib):
// byte-identity is promised per resolved tier — see the worker module docs.
beforeAll(() => initNodeZipCodecs());

const WORKER_SCRIPT = resolve('dist/worker/zip-worker.js');
const hasDist = existsSync(WORKER_SCRIPT);
const workerUrl = pathToFileURL(WORKER_SCRIPT);

const te = new TextEncoder();

describe.skipIf(!hasDist)('real worker integration (dist-gated)', () => {
    function addCorpus(writer: { add: (n: string, d: Uint8Array) => void }): void {
        for (let i = 0; i < 6; i++) {
            writer.add(`part-${i}.txt`, te.encode(`payload ${i} `.repeat(20_000)));
        }
    }

    it('parallel output through REAL workers is byte-identical to createZip', async () => {
        const sequential = createZip();
        addCorpus(sequential);
        const parallel = createParallelZip({ workers: 3, minWorkerJobSize: 1024, workerUrl });
        addCorpus(parallel);
        const bytes = await parallel.toBytes();
        expect(bytes).toEqual(sequential.toBytes());
        expect(openZip(bytes, { validate: 'eager' }).entryCount).toBe(6);
    }, 60_000);

    it('deterministic mode through REAL workers matches the pinned encoder', async () => {
        const options = { compression: { deterministic: true as const } };
        const sequential = createZip(options);
        addCorpus(sequential);
        const parallel = createParallelZip({ ...options, workers: 2, minWorkerJobSize: 1024, workerUrl });
        addCorpus(parallel);
        expect(await parallel.toBytes()).toEqual(sequential.toBytes());
    }, 60_000);

    it('a bogus workerUrl degrades silently to identical main-thread bytes', async () => {
        const sequential = createZip();
        addCorpus(sequential);
        const parallel = createParallelZip({
            workers: 2,
            minWorkerJobSize: 1024,
            workerUrl: pathToFileURL(resolve('dist/worker/does-not-exist.js')),
        });
        addCorpus(parallel);
        expect(await parallel.toBytes()).toEqual(sequential.toBytes());
    }, 60_000);
});
