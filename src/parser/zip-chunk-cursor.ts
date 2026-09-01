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
    /** Total bytes consumed so far (for error offsets). */
    readonly bytesRead: number;
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

    return {
        get bytesRead(): number {
            return bytesRead;
        },

        async readExact(n: number): Promise<Uint8Array> {
            await fill(n);
            if (buffered < n) {
                throw new ZipFormatError(
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
                throw new ZipFormatError(
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

        async *take(n: number): AsyncGenerator<Uint8Array, void, undefined> {
            let remaining = n;
            while (remaining > 0) {
                if (buffered === 0) {
                    await fill(1);
                    if (buffered === 0) {
                        throw new ZipFormatError(
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
