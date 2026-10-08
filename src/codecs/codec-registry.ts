/**
 * zipnative — Codec registry
 * ==========================
 * Maps ZIP compression-method ids to codec implementations. Built-ins
 * (store = 0, deflate = 8) are registered lazily on first access — never
 * as an import side effect. `registerCodec()` is the extension point for
 * additional methods (zstd, bzip2, …) supplied by the caller; zipnative
 * itself ships no other codecs by policy (README: What zipnative will NOT do).
 *
 * Compression members are optional: milestone M1 is read-only, and even in
 * M2+ a decode-only codec is a valid registration.
 *
 * @module codecs/codec-registry
 */

import { inflateRawStream, inflateRawSync } from './inflate.js';
import { createInflator } from './inflate-stream.js';
import { deflateRawSync } from './deflate.js';

/**
 * An incremental decoder a codec hands out for the forward reader
 * (`iterateZipEntries`): compressed bytes are pushed as they arrive off the
 * stream and decoded pieces come back at once, so memory stays O(chunk)
 * whatever the entry's size — the built-in deflate codec is backed by
 * `createInflator`. `maxOutput` was given to the factory; the decoder
 * throws `ZipDataError` (`ZIP_INFLATE_OUTPUT_OVERFLOW`) when the total
 * output would exceed it and `ZipFormatError` when the input is corrupt or
 * truncated at `end()`.
 *
 * @since 1.1.0
 */
export interface ZipDecompressor {
    /** Feed one compressed chunk; returns the decoded pieces it produced (possibly none). */
    push(chunk: Uint8Array): Uint8Array[];
    /** Signal end of input; returns the final pieces. Throws when the stream is incomplete. */
    end(): Uint8Array[];
}

/** One compression codec, keyed by its CFH compression-method id. */
export interface ZipCodec {
    /** ZIP compression-method id (0 = store, 8 = deflate). */
    readonly method: number;
    /** Short name for diagnostics and errors (e.g. `'deflate'`). */
    readonly name: string;
    /** Compress synchronously (M2+; optional). */
    compressSync?(data: Uint8Array, options: CodecCompressOptions): Uint8Array;
    /**
     * Decompress synchronously. `maxOutput` is a hard bound enforced
     * during decompression; exceeding it throws `ZipDataError`.
     */
    decompressSync?(data: Uint8Array, maxOutput: number): Uint8Array;
    /** Decompress as an async chunk iterable, `maxOutput`-bounded. */
    decompressStream?(data: Uint8Array, maxOutput: number): AsyncIterable<Uint8Array>;
    /**
     * Create an incremental decoder (push/end). The ONLY form the forward
     * reader `iterateZipEntries` can drive for a method other than store
     * and deflate: `decompressSync` and `decompressStream` both need the
     * whole compressed payload, which a bounded-memory stream reader never
     * holds. A codec without it is refused there before the first byte
     * (`ZIP_UNSUPPORTED_CODEC_MODE`) and still works with `openZip`.
     *
     * @since 1.1.0
     */
    createDecompressor?(maxOutput: number): ZipDecompressor;
}

/** Options passed to `ZipCodec.compressSync` (M2+). */
export interface CodecCompressOptions {
    /** 0–9 effort hint. */
    readonly level: number;
    /** Pin the deterministic (pure-TS) implementation. */
    readonly deterministic: boolean;
}

/** ZIP compression-method id 0 — stored, no compression. */
export const METHOD_STORE = 0;
/** ZIP compression-method id 8 — raw DEFLATE (RFC 1951). */
export const METHOD_DEFLATE = 8;

let _registry: Map<number, ZipCodec> | undefined;

function registry(): Map<number, ZipCodec> {
    if (_registry === undefined) {
        _registry = new Map<number, ZipCodec>();
        _registry.set(METHOD_STORE, {
            method: METHOD_STORE,
            name: 'store',
            compressSync: (data: Uint8Array): Uint8Array => data,
            decompressSync: (data: Uint8Array): Uint8Array => data,
            decompressStream: async function* (data: Uint8Array): AsyncGenerator<Uint8Array, void, undefined> {
                const chunkSize = 64 * 1024;
                for (let i = 0; i < data.length; i += chunkSize) {
                    yield data.subarray(i, Math.min(i + chunkSize, data.length));
                }
            },
            createDecompressor: (): ZipDecompressor => ({
                push: (chunk: Uint8Array): Uint8Array[] => [chunk],
                end: (): Uint8Array[] => [],
            }),
        });
        _registry.set(METHOD_DEFLATE, {
            method: METHOD_DEFLATE,
            name: 'deflate',
            compressSync: (data: Uint8Array, options: CodecCompressOptions): Uint8Array =>
                deflateRawSync(data, options.level, options.deterministic),
            decompressSync: inflateRawSync,
            decompressStream: inflateRawStream,
            createDecompressor: (maxOutput: number): ZipDecompressor => {
                const inflator = createInflator(maxOutput);
                return {
                    push: (chunk: Uint8Array): Uint8Array[] => inflator.push(chunk),
                    end: (): Uint8Array[] => {
                        inflator.end();
                        return [];
                    },
                };
            },
        });
    }
    return _registry;
}

/**
 * Register (or replace) a codec for a compression-method id. Registering
 * over a built-in id is allowed — the caller owns the trade-off.
 */
export function registerCodec(codec: ZipCodec): void {
    registry().set(codec.method, codec);
}

/** Look up the codec for a compression-method id, or `null` if unregistered. */
export function getCodec(method: number): ZipCodec | null {
    return registry().get(method) ?? null;
}
