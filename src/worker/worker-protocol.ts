/**
 * zipnative — worker message protocol
 * ===================================
 * Shared by the pool (main thread) and the worker script. Kept in its
 * own module so both bundles agree on one definition.
 *
 * @module worker/worker-protocol
 */

/** Main thread → worker: one deflate job. `data.buffer` is transferred. */
export interface WorkerJobRequest {
    readonly id: number;
    readonly data: Uint8Array;
    readonly level: number;
    readonly deterministic: boolean;
}

/** Worker → main thread. */
export type WorkerResponse =
    /** Boot handshake — the pool dispatches nothing before this arrives. */
    | { readonly type: 'ready' }
    /** Job done. `compressed.buffer` is transferred back zero-copy. */
    | { readonly type: 'result'; readonly id: number; readonly compressed: Uint8Array; readonly crc: number }
    | { readonly type: 'job-error'; readonly id: number; readonly message: string };
