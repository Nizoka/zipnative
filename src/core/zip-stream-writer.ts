/**
 * zipnative — Streaming archive writer
 * ====================================
 * The async half of the write path: consumes the SAME segment generator
 * as `toBytes()` (byte-identical by construction for buffer-only
 * content) and additionally expands `stream-entry` segments — pumping
 * the caller's async source through the compressor chunk-wise, tracking
 * CRC and sizes on the fly, emitting the trailing data descriptor, and
 * reporting the bytes written back into the generator so offsets stay
 * exact.
 *
 * Memory: one chunk buffer plus the segment currently being copied.
 * Stream-entry compression prefers `CompressionStream('deflate-raw')`
 * (incremental, bounded); without it the source is buffered and
 * compressed in one shot — a documented fallback caveat.
 *
 * @module core/zip-stream-writer
 */

import { ZipError } from '../types/zip-errors.js';
import { crc32 } from '../codecs/crc32.js';
import { deflateRawSync } from '../codecs/deflate.js';
import { hasDecompressionStream } from '../codecs/inflate.js';
import { writeDataDescriptor } from './zip-structs.js';
import { METHOD_STORE } from '../codecs/codec-registry.js';
import { archiveSegments, assertStreamSizesInRange, type PlannedEntry, type ZipCtx } from './zip-segments.js';

/** Options for `ZipWriter.stream()`. */
export interface StreamOptions {
    /** Output chunk size in bytes. Default 64 KiB, clamped to 1 KiB – 16 MiB. */
    readonly chunkSize?: number;
}

const DEFAULT_CHUNK = 65_536;
const MIN_CHUNK = 1024;
const MAX_CHUNK = 16_777_216;

/** Throws on non-finite/non-positive input, clamps valid values. */
function resolveChunkSize(value: number | undefined): number {
    if (value === undefined) return DEFAULT_CHUNK;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new ZipError(`zipnative: chunkSize must be a positive number (got ${String(value)})`);
    }
    return Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, Math.floor(value)));
}

function hasCompressionStream(): boolean {
    try {
        return typeof (globalThis as { CompressionStream?: unknown }).CompressionStream === 'function';
    } catch {
        return false;
    }
}

/**
 * Emit the archive as fixed-size chunks. `planCtx` is a thunk — the
 * context is planned inside the generator so validation throws on the
 * first `.next()`, never at call time with bytes already emitted.
 */
export async function* streamArchive(
    planCtx: () => ZipCtx,
    options?: StreamOptions,
): AsyncGenerator<Uint8Array, void, undefined> {
    const chunkSize = resolveChunkSize(options?.chunkSize);
    const ctx = planCtx(); // validation completes before the first byte

    // Re-chunker: one buffer held at a time; a full chunk is yielded and
    // REALLOCATED (consumers may retain it); the tail is a subarray view.
    let buf = new Uint8Array(chunkSize);
    let filled = 0;
    function* push(bytes: Uint8Array): Generator<Uint8Array, void, undefined> {
        let i = 0;
        while (i < bytes.length) {
            const take = Math.min(chunkSize - filled, bytes.length - i);
            buf.set(bytes.subarray(i, i + take), filled);
            filled += take;
            i += take;
            if (filled === chunkSize) {
                yield buf;
                buf = new Uint8Array(chunkSize);
                filled = 0;
            }
        }
    }

    const generator = archiveSegments(ctx);
    let res = generator.next();
    while (!res.done) {
        const segment = res.value;
        if (segment.kind === 'bytes') {
            yield* push(segment.bytes);
            res = generator.next();
        } else {
            let consumed = 0;
            for await (const piece of compressStreamEntry(segment.plan)) {
                consumed += piece.length;
                yield* push(piece);
            }
            res = generator.next(consumed);
        }
    }

    if (filled > 0) {
        yield buf.subarray(0, filled);
    }
}

/**
 * Consume a stream entry's source: compress chunk-wise, fill the plan's
 * crc/sizes, and finish with the data descriptor. Yields exactly the
 * bytes that follow the entry's local header.
 */
async function* compressStreamEntry(plan: PlannedEntry): AsyncGenerator<Uint8Array, void, undefined> {
    const source = plan.source as AsyncIterable<Uint8Array>;
    const entryName = new TextDecoder().decode(plan.nameBytes);
    let crc = 0;
    let uncompressed = 0;
    let compressed = 0;

    if (plan.method === METHOD_STORE) {
        for await (const chunk of source) {
            crc = crc32(chunk, crc);
            uncompressed += chunk.length;
            compressed += chunk.length;
            plan.uncompressedSize = uncompressed;
            plan.compressedSize = compressed;
            assertStreamSizesInRange(plan, entryName);
            yield chunk;
        }
    } else if (!plan.deterministic && hasCompressionStream() && hasDecompressionStream()) {
        // Incremental tier: CompressionStream('deflate-raw') — bounded memory.
        const cs = new CompressionStream('deflate-raw');
        const writer = cs.writable.getWriter();
        const reader = cs.readable.getReader();
        const writeAll = (async (): Promise<void> => {
            for await (const chunk of source) {
                crc = crc32(chunk, crc);
                uncompressed += chunk.length;
                // Copy: engines may detach transferred chunks.
                await writer.write(chunk.slice());
            }
            await writer.close();
        })();
        writeAll.catch(() => { /* surfaced by the read loop / final await */ });

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            compressed += value.length;
            plan.uncompressedSize = uncompressed;
            plan.compressedSize = compressed;
            assertStreamSizesInRange(plan, entryName);
            yield value;
        }
        await writeAll;
    } else {
        // Fallback: buffer the source, one-shot compress with the sync
        // facade (deterministic pinning included). Documented caveat:
        // peak memory is the full entry on runtimes without
        // CompressionStream — or whenever determinism is requested.
        const pieces: Uint8Array[] = [];
        for await (const chunk of source) {
            crc = crc32(chunk, crc);
            uncompressed += chunk.length;
            pieces.push(chunk.slice());
        }
        const whole = new Uint8Array(uncompressed);
        let pos = 0;
        for (const piece of pieces) {
            whole.set(piece, pos);
            pos += piece.length;
        }
        const out = deflateRawSync(whole, plan.level, plan.deterministic);
        compressed = out.length;
        plan.uncompressedSize = uncompressed;
        plan.compressedSize = compressed;
        assertStreamSizesInRange(plan, entryName);
        const chunkSize = DEFAULT_CHUNK;
        for (let i = 0; i < out.length; i += chunkSize) {
            yield out.subarray(i, Math.min(i + chunkSize, out.length));
        }
    }

    plan.crc32 = crc;
    plan.uncompressedSize = uncompressed;
    plan.compressedSize = compressed;
    assertStreamSizesInRange(plan, entryName);
    yield writeDataDescriptor(crc, compressed, uncompressed, false);
}
