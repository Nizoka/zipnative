/**
 * zipnative — Cancellation and progress (1.1.0)
 * ============================================
 * The two cross-cutting controls every long operation honours:
 *
 *   - `signal` (an `AbortSignal`): checked before the first byte and
 *     between chunks; an abort rejects with the signal's own `reason` (the
 *     platform's `AbortError` by default — never a zipnative code, since
 *     the caller asked for it) after the operation released what it held
 *     (a ReadableStream reader's lock without cancelling the stream, the
 *     worker pool's jobs). Synchronous entry points check the signal once,
 *     on entry.
 *   - `onProgress`: called with a monotonic {@link ZipProgress} after every
 *     chunk and every completed entry. Cheap enough to leave on: one call
 *     per chunk, no allocation beyond the snapshot.
 *
 * Pure helpers over the option values; no state outside the tracker a
 * caller creates per operation.
 *
 * @module core/zip-control
 */

import type { ZipProgress, ZipProgressHandler } from '../types/zip-types.js';

/** Throw the signal's reason when it is already aborted (no-op without a signal). */
export function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal === undefined) return;
    // The caller's own reason, verbatim — an AbortError by default, or
    // whatever they passed to abort(); never re-wrapped.
    // eslint-disable-next-line no-throw-literal
    if (signal.aborted) throw signal.reason as unknown;
}

/** One operation's progress counters and its reporter. */
export interface ProgressTracker {
    /** Account bytes consumed from the input (compressed archive bytes, or a source's bytes when writing). */
    bytesIn(n: number): void;
    /** Account bytes produced (decompressed content, or archive bytes when writing) and report. */
    bytesOut(n: number): void;
    /** One more entry finished; reports. */
    entryDone(): void;
    /** The current snapshot. */
    snapshot(): ZipProgress;
}

/**
 * Create the tracker for one operation. `entriesTotal` is null when the
 * operation cannot know it up front (the forward reader). Without a
 * handler the tracker still counts but never calls out — the cost of an
 * unused option stays at a few integer additions.
 */
export function createProgressTracker(onProgress: ZipProgressHandler | undefined, entriesTotal: number | null): ProgressTracker {
    let entriesDone = 0;
    let bytesIn = 0;
    let bytesOut = 0;
    const snapshot = (): ZipProgress => ({ entriesDone, entriesTotal, bytesIn, bytesOut });
    const report = (): void => {
        if (onProgress !== undefined) onProgress(snapshot());
    };
    return {
        bytesIn(n: number): void {
            bytesIn += n;
        },
        bytesOut(n: number): void {
            bytesOut += n;
            report();
        },
        entryDone(): void {
            entriesDone++;
            report();
        },
        snapshot,
    };
}
