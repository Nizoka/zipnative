/**
 * zipnative — Byte-source normalisation
 * =====================================
 * Every streaming entry point (`iterateZipEntries`, `addStream`) accepts
 * either an `AsyncIterable<Uint8Array>` or a Web `ReadableStream<Uint8Array>`
 * — the shape a `fetch` body or `File.stream()` hands you. This module
 * normalises the union to an async iterable exactly once.
 *
 * A `ReadableStream` is ALWAYS driven through `getReader()` — even on
 * runtimes where `ReadableStream[Symbol.asyncIterator]` exists — because
 * the native async iterator CANCELS the stream when the consumer stops
 * early, while zipnative's documented contract is release-without-cancel:
 * the forward reader deliberately leaves the central directory unread,
 * and cancelling the rest stays the stream owner's decision. The lock is
 * released in `finally`, which runs when the consumer closes the iterable
 * (the forward reader does so on every exit path).
 *
 * @module core/zip-source
 */

/** Any byte producer zipnative's streaming entry points accept. */
export type ByteSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

/** Normalise a {@link ByteSource} to an async iterable (no copying). */
export function toByteIterable(source: ByteSource): AsyncIterable<Uint8Array> {
    if (typeof (source as ReadableStream<Uint8Array>).getReader !== 'function') {
        return source as AsyncIterable<Uint8Array>;
    }
    const stream = source as ReadableStream<Uint8Array>;
    return {
        async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array, void, undefined> {
            const reader = stream.getReader();
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) return;
                    yield value;
                }
            } finally {
                // Release, never cancel: the owner keeps the stream.
                reader.releaseLock();
            }
        },
    };
}
