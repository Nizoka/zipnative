/**
 * zipnative — worker script (self-contained bundle)
 * =================================================
 * Loaded by URL, never imported: tsup bundles this entry with
 * noExternal (match-everything) into `dist/worker/zip-worker.js` so it
 * resolves nothing at runtime. It runs under BOTH Node `worker_threads`
 * and the Web Worker API — the two postMessage shapes agree on
 * `postMessage(message, transferList)`.
 *
 * Boot sequence matters for the byte-identity contract: an ESM bundle
 * has no CJS `require`, so without the explicit `initNodeDeflate()`
 * await the deflate facade would silently fall back to pure TS inside
 * Node workers while the main thread compresses with node:zlib —
 * producing different (valid) bytes. The await resolves the SAME tier
 * as the main thread; it is a no-op in browsers. Only after that does
 * the worker post `ready`, which gates all dispatch.
 *
 * @module worker/zip-worker
 */

import { crc32 } from '../codecs/crc32.js';
import { deflateRawSync, initNodeDeflate } from '../codecs/deflate.js';
import { type WorkerJobRequest, type WorkerResponse } from './worker-protocol.js';

interface PortLike {
    post(message: WorkerResponse, transfer: ArrayBuffer[]): void;
    onMessage(handler: (message: WorkerJobRequest) => void): void;
}

async function resolvePort(): Promise<PortLike | null> {
    const g = globalThis as Record<string, unknown>;
    const proc = g['process'] as { versions?: { node?: string } } | undefined;
    if (proc?.versions?.node) {
        // String indirection defeats bundler static analysis of the import.
        const modName = 'node:worker_threads';
        const wt = await (import(modName) as Promise<Record<string, unknown>>);
        const parentPort = wt['parentPort'] as {
            postMessage(value: unknown, transferList?: ArrayBuffer[]): void;
            on(event: 'message', handler: (value: unknown) => void): void;
        } | null;
        if (parentPort === null || parentPort === undefined) return null; // not running as a worker
        return {
            post: (message, transfer) => parentPort.postMessage(message, transfer),
            onMessage: (handler) => parentPort.on('message', (value) => handler(value as WorkerJobRequest)),
        };
    }
    const postMessage = g['postMessage'] as ((message: unknown, transfer?: ArrayBuffer[]) => void) | undefined;
    if (typeof postMessage !== 'function') return null;
    return {
        post: (message, transfer) => postMessage(message, transfer),
        onMessage: (handler) => {
            (g as { onmessage?: (event: { data: unknown }) => void }).onmessage =
                (event) => handler(event.data as WorkerJobRequest);
        },
    };
}

async function boot(): Promise<void> {
    const port = await resolvePort();
    if (port === null) return;

    // Resolve the same compression tier as the main thread (see header).
    await initNodeDeflate();

    port.onMessage((job) => {
        try {
            const compressed = deflateRawSync(job.data, job.level, job.deterministic);
            const crc = crc32(job.data);
            // Compact before transfer: the pure encoder returns a subarray of
            // a larger growth buffer — transferring that buffer would ship
            // (and detach) the unused tail too.
            const exact = compressed.byteOffset === 0 && compressed.byteLength === compressed.buffer.byteLength
                ? compressed
                : compressed.slice();
            port.post({ type: 'result', id: job.id, compressed: exact, crc }, [exact.buffer as ArrayBuffer]);
        } catch (err) {
            port.post({
                type: 'job-error',
                id: job.id,
                message: err instanceof Error ? err.message : String(err),
            }, []);
        }
    });

    port.post({ type: 'ready' }, []);
}

void boot();
