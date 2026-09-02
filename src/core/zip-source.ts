/**
 * zipnative — Byte-source normalisation
 * =====================================
 * Every streaming entry point (`iterateZipEntries`, `addStream`) accepts
 * either an `AsyncIterable<Uint8Array>` or a Web `ReadableStream<Uint8Array>`
 * — the shape a `fetch` body or `File.stream()` hands you. This module
 * normalises the union to an async iterable exactly once.
 *
 * Feature-detected: `ReadableStream[Symbol.asyncIterator]` is present in
 * Node ≥ 18 and current Chromium/Firefox, but Safari lagged — when it is
 * absent the stream is driven through `getReader()` with the lock
 * released in `finally`, which also gives correct cancellation semantics
 * when a consumer stops early (the forward reader deliberately leaves
 * the central directory unconsumed).
 *
 * @module core/zip-source
 */

/** Any byte producer zipnative's streaming entry points accept. */
export type ByteSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

/** Normalise a {@link ByteSource} to an async iterable (no copying). */
export function toByteIterable(source: ByteSource): AsyncIterable<Uint8Array> {
    if (Symbol.asyncIterator in source) {
        return source as AsyncIterable<Uint8Array>;
    }
    // A ReadableStream on a runtime without Symbol.asyncIterator support:
    // drive the reader manually and always release the lock, so an early
    // consumer exit leaves the stream cancellable by its owner.
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
                reader.releaseLock();
            }
        },
    };
}
