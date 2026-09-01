import { describe, expect, it } from 'vitest';
import { deflateRawSync } from '../../src/codecs/deflate.ts';
import { crc32 } from '../../src/codecs/crc32.ts';
import { createDeflatePool } from '../../src/worker/worker-pool.ts';
import { createFakeSpawn } from '../helpers/fake-worker.ts';

const te = new TextEncoder();
const PAYLOAD = te.encode('compress me through the pool '.repeat(2000));

describe('deflate worker pool', () => {
    it('produces the same bytes as the main-thread facade', async () => {
        const { spawn } = createFakeSpawn();
        const pool = await createDeflatePool({ workers: 3, jobTimeout: 5000, _spawn: spawn });
        try {
            const result = await pool.deflate(PAYLOAD, 6, false);
            expect(result.compressed).toEqual(deflateRawSync(PAYLOAD, 6, false));
            expect(result.crc).toBe(crc32(PAYLOAD));
        } finally {
            pool.close();
        }
    });

    it('never detaches the caller buffer (slice-before-transfer rule)', async () => {
        const { spawn } = createFakeSpawn();
        const pool = await createDeflatePool({ workers: 1, jobTimeout: 5000, _spawn: spawn });
        try {
            const caller = PAYLOAD.slice();
            await pool.deflate(caller, 6, false);
            expect(caller.byteLength).toBe(PAYLOAD.length); // not detached
            expect(caller).toEqual(PAYLOAD);                // not mutated
        } finally {
            pool.close();
        }
    });

    it('queues more jobs than workers and resolves all of them', async () => {
        const { spawn } = createFakeSpawn({ delayMs: 5 });
        const pool = await createDeflatePool({ workers: 2, jobTimeout: 5000, _spawn: spawn });
        try {
            const jobs = Array.from({ length: 9 }, (_, i) =>
                pool.deflate(te.encode(`job ${i} `.repeat(500)), 6, false));
            const results = await Promise.all(jobs);
            for (let i = 0; i < results.length; i++) {
                const expected = deflateRawSync(te.encode(`job ${i} `.repeat(500)), 6, false);
                expect(results[i].compressed, `job ${i}`).toEqual(expected);
            }
        } finally {
            pool.close();
        }
    });

    it('a job-error falls back to the main thread with identical bytes', async () => {
        const { spawn } = createFakeSpawn({ failJobs: [1] });
        const pool = await createDeflatePool({ workers: 1, jobTimeout: 5000, _spawn: spawn });
        try {
            const result = await pool.deflate(PAYLOAD, 6, false);
            expect(result.compressed).toEqual(deflateRawSync(PAYLOAD, 6, false));
        } finally {
            pool.close();
        }
    });

    it('a stalled worker times out and the job completes inline', async () => {
        const { spawn, terminated } = createFakeSpawn({ stallJobs: [1] });
        const pool = await createDeflatePool({ workers: 1, jobTimeout: 50, _spawn: spawn });
        try {
            const result = await pool.deflate(PAYLOAD, 6, false);
            expect(result.compressed).toEqual(deflateRawSync(PAYLOAD, 6, false));
            expect(terminated()).toBe(1); // the stalled worker was retired
        } finally {
            pool.close();
        }
    });

    it('zero surviving workers still serves jobs (main-thread mode)', async () => {
        const pool = await createDeflatePool({
            workers: 2,
            jobTimeout: 5000,
            _spawn: () => Promise.resolve(null), // every spawn fails
        });
        expect(pool.size).toBe(0);
        const result = await pool.deflate(PAYLOAD, 6, false);
        expect(result.compressed).toEqual(deflateRawSync(PAYLOAD, 6, false));
        pool.close();
    });

    it('close() settles queued and in-flight jobs instead of hanging', async () => {
        const { spawn } = createFakeSpawn({ stallJobs: [1, 2, 3] });
        const pool = await createDeflatePool({ workers: 1, jobTimeout: 60_000, _spawn: spawn });
        const jobs = [
            pool.deflate(PAYLOAD, 6, false),
            pool.deflate(PAYLOAD, 1, false),
            pool.deflate(PAYLOAD, 9, false),
        ];
        pool.close();
        const results = await Promise.all(jobs);
        expect(results[0].compressed).toEqual(deflateRawSync(PAYLOAD, 6, false));
        expect(results[2].compressed).toEqual(deflateRawSync(PAYLOAD, 9, false));
    });
});
