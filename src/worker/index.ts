/**
 * zipnative/worker — parallel archive creation
 * ============================================
 * `createParallelZip()` is `createZip()` with per-entry deflate fanned
 * out across a worker pool (Node `worker_threads` or Web Workers). Same
 * name rules, same defaults, same ordering, same compression decisions —
 * ONE implementation shared with the core builder — so for identical
 * inputs the output is BYTE-IDENTICAL to `createZip()` *per resolved
 * compression tier*. Parallelism changes scheduling, never bytes.
 *
 * Tier note: `createParallelZip` resolves node:zlib on the main thread
 * (workers do the same at boot). A `createZip` call that ran BEFORE any
 * parallel call in a Node ESM process may still be on the pure-TS tier —
 * call `initNodeZipCodecs()` at startup to align everything, or pin
 * `compression: { deterministic: true }` for unconditional identity.
 *
 * Progressive enhancement: on runtimes without workers (or with
 * `workers: 0`) every job compresses on the calling thread and the API
 * shape is unchanged. Worker failures and per-job timeouts recompress
 * the affected job inline — an archive never fails for infra reasons.
 *
 * Known limitation: this subpath is a separate bundle — `setDeflateImpl`
 * / `registerCodec` calls on the main `zipnative` entry do NOT affect
 * it. Byte-identity is promised for the built-in tiers (node:zlib /
 * pure TS / the `deterministic: true` pin), not for injected codecs.
 *
 * Bundlers: the worker script is resolved as
 * `new URL('./zip-worker.js', import.meta.url)` — Vite and webpack 5
 * detect this statically. If yours cannot, pass `workerUrl` explicitly
 * (see the README's bundler notes).
 *
 * @module worker
 */

import { ZipError } from '../types/zip-errors.js';
import { crc32 } from '../codecs/crc32.js';
import { deflateRawSync, initNodeDeflate } from '../codecs/deflate.js';
import {
    createSpecCollector,
    type AddEntryOptions,
    type CreateZipOptions,
} from '../core/zip-builder.js';
import {
    assembleArchive,
    planArchiveAsync,
    type AsyncDeflate,
    type ZipCtx,
} from '../core/zip-segments.js';
import { streamArchive, type StreamOptions } from '../core/zip-stream-writer.js';

// Re-exported so subpath consumers can name the types `stream()` and
// `addStream()` accept without importing from the main entry.
export { type StreamOptions } from '../core/zip-stream-writer.js';
export { type ByteSource } from '../core/zip-source.js';
import { type ByteSource } from '../core/zip-source.js';
import { detectConcurrency } from './worker-adapter.js';
import { createDeflatePool, type WorkerSpawnSeam } from './worker-pool.js';

/** Options for {@link createParallelZip} — a superset of CreateZipOptions. */
export interface ParallelZipOptions extends CreateZipOptions {
    /**
     * Worker count. Default: `max(1, min(cores − 1, 8))`. `0` disables
     * workers entirely (all compression on the calling thread — the
     * deterministic test target; the API shape is unchanged).
     */
    readonly workers?: number;
    /**
     * Jobs below this byte size compress on the calling thread — worker
     * dispatch (copy + round trip) costs more than it saves on small
     * payloads. Default 32 KiB.
     */
    readonly minWorkerJobSize?: number;
    /** Per-job wall-clock cap before inline fallback, ms. Default 60 000. */
    readonly jobTimeout?: number;
    /** Explicit worker-script URL for bundlers that can't resolve `new URL(...)`. */
    readonly workerUrl?: string | URL;
}

/**
 * Same surface as `ZipWriter`, with the one honest signature change:
 * worker compression is asynchronous, so `toBytes()` returns a Promise.
 */
export interface ParallelZipWriter {
    add(name: string, data: Uint8Array | string, options?: AddEntryOptions): void;
    addDirectory(name: string, options?: AddEntryOptions): void;
    addStream(name: string, source: ByteSource, options?: AddEntryOptions): void;
    setComment(comment: string | Uint8Array): void;

    /** Assemble the archive (async — workers). Throws if addStream() was used. */
    toBytes(): Promise<Uint8Array>;
    /** Fixed-size chunks, byte-identical to `toBytes()` for buffer-only content. */
    stream(options?: StreamOptions): AsyncGenerator<Uint8Array, void, undefined>;
}

const DEFAULT_MIN_JOB_SIZE = 32 * 1024;
const DEFAULT_JOB_TIMEOUT = 60_000;

/** Create a parallel archive writer (see the module header for the contract). */
export function createParallelZip(options?: ParallelZipOptions): ParallelZipWriter {
    const collector = createSpecCollector(options);
    const minJobSize = options?.minWorkerJobSize ?? DEFAULT_MIN_JOB_SIZE;
    const jobTimeout = options?.jobTimeout ?? DEFAULT_JOB_TIMEOUT;

    const planParallel = async (): Promise<ZipCtx> => {
        // Resolve the SAME compression tier on the main thread as the worker
        // script resolves at boot (memoized no-op after the first call, and
        // a no-op outside Node): main-thread jobs — small entries, worker
        // fallbacks — must produce the same bytes as dispatched ones.
        await initNodeDeflate();
        collector.emitPlanDiagnostics();
        const specs = collector.orderedSpecs();

        // Only buffered deflate jobs at or above the threshold are worth
        // dispatching; below two such jobs a pool cannot win.
        const dispatchable = specs.filter((spec) =>
            spec.source === null
            && spec.method === 'deflate'
            && (spec.data?.length ?? 0) >= minJobSize).length;
        const workerCount = options?.workers ?? await detectConcurrency();
        const pool = workerCount > 0 && dispatchable >= 2
            ? await createDeflatePool({
                workers: Math.min(workerCount, dispatchable),
                jobTimeout,
                workerUrl: options?.workerUrl,
                _spawn: (options as (ParallelZipOptions & WorkerSpawnSeam) | undefined)?._spawn,
            })
            : null;

        try {
            const deflate: AsyncDeflate = (data, level, deterministic) => {
                if (pool === null || pool.size === 0 || data.length < minJobSize) {
                    return Promise.resolve({ compressed: deflateRawSync(data, level, deterministic), crc: crc32(data) });
                }
                return pool.deflate(data, level, deterministic);
            };
            return await planArchiveAsync(specs, collector.comment(), collector.limits, collector.emit, deflate);
        } finally {
            pool?.close();
        }
    };

    return {
        add: collector.add,
        addDirectory: collector.addDirectory,
        addStream: collector.addStream,
        setComment: collector.setComment,

        async toBytes(): Promise<Uint8Array> {
            if (collector.hasStreamEntries()) {
                throw new ZipError('ZIP_API_MISUSE',
                    'zipnative: toBytes() is incompatible with addStream() entries (their sizes are only '
                    + 'known after the source is consumed). Use stream(), or buffer the content via add().');
            }
            return assembleArchive(await planParallel());
        },

        stream(streamOptions?: StreamOptions): AsyncGenerator<Uint8Array, void, undefined> {
            return (async function* (): AsyncGenerator<Uint8Array, void, undefined> {
                // Plan (and validate) fully before the first chunk.
                const ctx = await planParallel();
                yield* streamArchive(() => ctx, streamOptions);
            })();
        },
    };
}
