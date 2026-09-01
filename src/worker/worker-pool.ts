/**
 * zipnative — deflate worker pool
 * ===============================
 * N workers, one in-flight job each, round-robin queue. Failure policy:
 * the archive NEVER fails for infrastructure reasons — a worker error,
 * exit or per-job timeout recompresses that job on the main thread
 * (same facade, same tier, same bytes) and retires the worker.
 *
 * Transfer rule: job inputs are ALWAYS `slice()`d before transfer —
 * `EntrySpec.data` may be a view of a caller-owned buffer (possibly
 * shared by several entries), and transferring it would detach the
 * caller's data. Results come back zero-copy (worker-allocated buffers).
 *
 * @module worker/worker-pool
 */

import { crc32 } from '../codecs/crc32.js';
import { deflateRawSync } from '../codecs/deflate.js';
import { spawnWorker, type WorkerHandle } from './worker-adapter.js';
import { type WorkerJobRequest, type WorkerResponse } from './worker-protocol.js';

export interface DeflatePoolOptions {
    readonly workers: number;
    readonly jobTimeout: number;
    readonly workerUrl?: string | URL;
    /** @internal Test seam: replaces real worker spawning. */
    readonly _spawn?: (workerUrl?: string | URL) => Promise<WorkerHandle | null>;
}

export interface DeflatePool {
    /** Compress one job through the pool (main-thread fallback on any infra failure). */
    deflate(data: Uint8Array, level: number, deterministic: boolean): Promise<{ compressed: Uint8Array; crc: number }>;
    /** Terminate every worker. Safe to call more than once. */
    close(): void;
    /** How many workers actually came up (0 = pure main-thread mode). */
    readonly size: number;
}

interface PendingJob {
    readonly request: WorkerJobRequest;
    readonly original: Uint8Array;
    readonly level: number;
    readonly deterministic: boolean;
    resolve(result: { compressed: Uint8Array; crc: number }): void;
    timer?: ReturnType<typeof setTimeout>;
}

function mainThreadJob(data: Uint8Array, level: number, deterministic: boolean): { compressed: Uint8Array; crc: number } {
    return { compressed: deflateRawSync(data, level, deterministic), crc: crc32(data) };
}

/**
 * Spawn up to `workers` workers. Workers that fail to come up are simply
 * absent; with zero survivors the pool still works (all main-thread).
 */
export async function createDeflatePool(options: DeflatePoolOptions): Promise<DeflatePool> {
    const spawn = options._spawn ?? spawnWorker;
    const handles = (await Promise.all(
        Array.from({ length: Math.max(0, options.workers) }, () => spawn(options.workerUrl)),
    )).filter((h): h is WorkerHandle => h !== null);

    let nextId = 1;
    let closed = false;
    const queue: PendingJob[] = [];

    interface Slot {
        readonly handle: WorkerHandle;
        current: PendingJob | null;
        dead: boolean;
    }
    const slots: Slot[] = handles.map((handle) => ({ handle, current: null, dead: false }));

    const settleOnMainThread = (job: PendingJob): void => {
        if (job.timer !== undefined) clearTimeout(job.timer);
        job.resolve(mainThreadJob(job.original, job.level, job.deterministic));
    };

    /** Retire a slot; its in-flight and re-queued work moves to the main thread. */
    const retire = (slot: Slot): void => {
        if (slot.dead) return;
        slot.dead = true;
        slot.handle.terminate();
        const current = slot.current;
        slot.current = null;
        if (current !== null) settleOnMainThread(current);
        if (slots.every((s) => s.dead)) {
            // No workers left: drain the whole queue inline.
            for (const job of queue.splice(0)) settleOnMainThread(job);
        }
    };

    const dispatch = (slot: Slot, job: PendingJob): void => {
        slot.current = job;
        job.timer = setTimeout(() => retire(slot), options.jobTimeout);
        try {
            slot.handle.post(job.request, [job.request.data.buffer as ArrayBuffer]);
        } catch {
            retire(slot);
        }
    };

    const pump = (slot: Slot): void => {
        if (slot.dead || slot.current !== null) return;
        const job = queue.shift();
        if (job !== undefined) dispatch(slot, job);
    };

    for (const slot of slots) {
        slot.handle.onMessage((message: WorkerResponse) => {
            if (message.type === 'ready') return;
            const job = slot.current;
            if (job === null || message.id !== job.request.id) return;
            slot.current = null;
            if (job.timer !== undefined) clearTimeout(job.timer);
            if (message.type === 'result') {
                job.resolve({ compressed: message.compressed, crc: message.crc });
            } else {
                // A job-level error from deflate of valid input should not
                // happen; recover on the main thread regardless.
                settleOnMainThread(job);
            }
            pump(slot);
        });
        slot.handle.onError(() => retire(slot));
    }

    return {
        size: slots.length,

        deflate(data: Uint8Array, level: number, deterministic: boolean): Promise<{ compressed: Uint8Array; crc: number }> {
            const live = slots.some((s) => !s.dead);
            if (closed || !live) {
                return Promise.resolve(mainThreadJob(data, level, deterministic));
            }
            return new Promise((resolve) => {
                // Copy before transfer — never detach the caller's buffer.
                const payload = data.slice();
                const job: PendingJob = {
                    request: { id: nextId++, data: payload, level, deterministic },
                    original: data,
                    level,
                    deterministic,
                    resolve,
                };
                const idle = slots.find((s) => !s.dead && s.current === null);
                if (idle !== undefined) {
                    dispatch(idle, job);
                } else {
                    queue.push(job);
                }
            });
        },

        close(): void {
            if (closed) return;
            closed = true;
            // retire() settles each slot's in-flight job on the main thread
            // and drains the queue when the last slot dies — no job hangs.
            for (const slot of slots) retire(slot);
            for (const job of queue.splice(0)) settleOnMainThread(job);
        },
    };
}
