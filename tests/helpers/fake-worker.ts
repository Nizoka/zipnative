/**
 * Fake worker handles for pool tests: run the REAL deflate facade on a
 * macrotask, speaking the real protocol — the pool's plumbing (queueing,
 * transfer rule, timeout, crash fallback) is exercised without spawning
 * OS threads or needing a built dist/.
 */
import { crc32 } from '../../src/codecs/crc32.ts';
import { deflateRawSync } from '../../src/codecs/deflate.ts';
import { type WorkerHandle } from '../../src/worker/worker-adapter.ts';
import { type WorkerJobRequest, type WorkerResponse } from '../../src/worker/worker-protocol.ts';

export interface FakeWorkerBehavior {
    /** Job ids that report a job-error instead of a result. */
    readonly failJobs?: readonly number[];
    /** Job ids the worker never answers (drives the pool's timeout path). */
    readonly stallJobs?: readonly number[];
    /** Fire the error handler on the Nth spawned worker (1-based) at boot. */
    readonly dieAtBoot?: readonly number[];
    /** Artificial per-job latency in ms. */
    readonly delayMs?: number;
}

export function createFakeSpawn(behavior: FakeWorkerBehavior = {}): {
    spawn: (workerUrl?: string | URL) => Promise<WorkerHandle | null>;
    spawned: () => number;
    terminated: () => number;
} {
    let spawnCount = 0;
    let terminatedCount = 0;

    const spawn = (_workerUrl?: string | URL): Promise<WorkerHandle | null> => {
        spawnCount++;
        const index = spawnCount;
        let messageHandler: ((message: WorkerResponse) => void) | null = null;
        let errorHandler: ((error: Error) => void) | null = null;
        let dead = false;

        const handle: WorkerHandle = {
            post(message: WorkerJobRequest): void {
                if (dead) return;
                if (behavior.stallJobs?.includes(message.id)) return; // never answers
                setTimeout(() => {
                    if (dead) return;
                    if (behavior.failJobs?.includes(message.id)) {
                        messageHandler?.({ type: 'job-error', id: message.id, message: 'synthetic failure' });
                        return;
                    }
                    const compressed = deflateRawSync(message.data, message.level, message.deterministic);
                    messageHandler?.({ type: 'result', id: message.id, compressed, crc: crc32(message.data) });
                }, behavior.delayMs ?? 0);
            },
            onMessage(handler): void {
                messageHandler = handler;
            },
            onError(handler): void {
                errorHandler = handler;
                if (behavior.dieAtBoot?.includes(index)) {
                    setTimeout(() => errorHandler?.(new Error('synthetic boot death')), 0);
                }
            },
            terminate(): void {
                dead = true;
                terminatedCount++;
            },
        };
        return Promise.resolve(handle);
    };

    return { spawn, spawned: () => spawnCount, terminated: () => terminatedCount };
}
