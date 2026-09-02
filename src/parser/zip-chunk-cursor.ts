/**
 * zipnative — pull cursor over an async chunk stream
 * ==================================================
 * Internal plumbing for the forward reader: exact reads that span chunk
 * boundaries, 4-byte signature peeks, and zero-copy pass-through of
 * payload ranges. Buffering is bounded by the largest `readExact` the
 * caller performs (the forward reader caps every variable length BEFORE
 * reading it).
 *
 * @module parser/zip-chunk-cursor
 */

import { ZipFormatError } from '../types/zip-errors.js';

export interface ChunkCursor {
    /** Exactly `n` bytes (joined across chunks); throws `ZipFormatError` on EOF. */
    readExact(n: number): Promise<Uint8Array>;
    /**
     * Peek 4 bytes without consuming. `null` on clean EOF at a boundary;
     * a 1–3 byte tail is truncation and throws.
     */
    peek4(): Promise<Uint8Array | null>;
    /** Consume exactly `n` bytes, yielding source-sized zero-copy pieces. */
    take(n: number): AsyncGenerator<Uint8Array, void, undefined>;
    /** Pull the next raw source-sized piece (zero-copy). `null` on EOF. */
    nextChunk(): Promise<Uint8Array | null>;
    /**
     * Push back the unconsumed tail of a piece previously returned by this
     * cursor; it is served first by all subsequent reads and `bytesRead`
     * is rewound accordingly. Only bytes that came OUT of this cursor may
     * be unread (keeps the offset meaningful).
     */
    unread(bytes: Uint8Array): void;
    /** Peek up to `n` bytes without consuming (fewer only at EOF). */
    peekUpTo(n: number): Promise<Uint8Array>;
    /** Total bytes consumed so far (for error offsets). */
    readonly bytesRead: number;
    /**
     * Close the underlying source iterator (runs its cleanup — e.g. a
     * ReadableStream reader's lock release). Idempotent; close errors are
     * swallowed so they never mask the error that ended the iteration.
     */
    close(): Promise<void>;
}

export function createChunkCursor(source: AsyncIterable<Uint8Array>): ChunkCursor {
    const iterator = source[Symbol.asyncIterator]();
    const pending: Uint8Array[] = [];
    let buffered = 0;
    let sourceDone = false;
    let bytesRead = 0;

    const fill = async (min: number): Promise<void> => {
        while (buffered < min && !sourceDone) {
            const { done, value } = await iterator.next();
            if (done) {
                sourceDone = true;
                break;
            }
            if (value.length > 0) {
                pending.push(value);
                buffered += value.length;
            }
        }
    };

    /** Consume up to `n` bytes from the head of the pending deque. */
    const consume = (n: number): Uint8Array => {
        const head = pending[0];
        const takeLen = Math.min(n, head.length);
        const piece = head.subarray(0, takeLen);
        if (takeLen === head.length) {
            pending.shift();
        } else {
            pending[0] = head.subarray(takeLen);
        }
        buffered -= takeLen;
        bytesRead += takeLen;
        return piece;
    };

    let closed = false;

    return {
        get bytesRead(): number {
            return bytesRead;
        },

        async close(): Promise<void> {
            if (closed) return;
            closed = true;
            try {
                await iterator.return?.();
            } catch {
                // Cleanup must never mask the error that ended the iteration.
            }
        },

        async readExact(n: number): Promise<Uint8Array> {
            // A zero-length read (e.g. a local header with an empty name and
            // no extra field) must not touch the deque — pending[0] may be
            // undefined at a chunk boundary, which would leak a raw TypeError.
            if (n === 0) return new Uint8Array(0);
            await fill(n);
            if (buffered < n) {
                throw new ZipFormatError('ZIP_STREAM_TRUNCATED',
                    `zipnative: stream truncated at byte ${bytesRead + buffered} — expected ${n} more bytes`);
            }
            const first = pending[0];
            if (first.length >= n) {
                return consume(n); // zero-copy fast path
            }
            const out = new Uint8Array(n);
            let pos = 0;
            while (pos < n) {
                const piece = consume(n - pos);
                out.set(piece, pos);
                pos += piece.length;
            }
            return out;
        },

        async peek4(): Promise<Uint8Array | null> {
            await fill(4);
            if (buffered === 0) return null;
            if (buffered < 4) {
                throw new ZipFormatError('ZIP_STREAM_TRUNCATED',
                    `zipnative: stream truncated at byte ${bytesRead + buffered} — a ${buffered}-byte tail `
                    + 'is too short for any ZIP record');
            }
            if (pending[0].length >= 4) return pending[0].subarray(0, 4);
            const out = new Uint8Array(4);
            let pos = 0;
            for (const piece of pending) {
                const takeLen = Math.min(4 - pos, piece.length);
                out.set(piece.subarray(0, takeLen), pos);
                pos += takeLen;
                if (pos === 4) break;
            }
            return out;
        },

        async nextChunk(): Promise<Uint8Array | null> {
            if (buffered === 0) {
                await fill(1);
                if (buffered === 0) return null;
            }
            return consume(pending[0].length);
        },

        unread(bytes: Uint8Array): void {
            if (bytes.length === 0) return;
            pending.unshift(bytes);
            buffered += bytes.length;
            bytesRead -= bytes.length;
        },

        async peekUpTo(n: number): Promise<Uint8Array> {
            await fill(n);
            const available = Math.min(n, buffered);
            const out = new Uint8Array(available);
            let pos = 0;
            for (const piece of pending) {
                const takeLen = Math.min(available - pos, piece.length);
                out.set(piece.subarray(0, takeLen), pos);
                pos += takeLen;
                if (pos === available) break;
            }
            return out;
        },

        async *take(n: number): AsyncGenerator<Uint8Array, void, undefined> {
            let remaining = n;
            while (remaining > 0) {
                if (buffered === 0) {
                    await fill(1);
                    if (buffered === 0) {
                        throw new ZipFormatError('ZIP_STREAM_TRUNCATED',
                            `zipnative: stream truncated at byte ${bytesRead} — ${remaining} payload bytes missing`);
                    }
                }
                const piece = consume(remaining);
                remaining -= piece.length;
                yield piece;
            }
        },
    };
}
