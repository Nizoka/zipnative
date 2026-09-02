/**
 * zipnative — forward, central-directory-less streaming reader
 * ============================================================
 * `iterateZipEntries()` walks LOCAL headers off an async byte stream —
 * pipes, uploads, serverless bodies you cannot seek. Bounded memory:
 * headers are read through capped exact-reads and payloads flow through
 * chunk-by-chunk (deflate via an incremental DecompressionStream pump).
 *
 * ── TRUST CAVEAT (read this) ─────────────────────────────────────────
 * Forward iteration trusts local headers ALONE. There is no central
 * directory to cross-check names, sizes or methods, so a hostile
 * archive can present different content here than `openZip()` would
 * authoritatively report — the classic upload-scanner differential.
 * Use `iterateZipEntries` only for streams you cannot seek; whenever
 * the complete archive is available, `openZip()` is the authoritative
 * path. Names are NOT sanitized (this is a reader, not an extractor) —
 * pass them through `sanitizeEntryPath()` before touching a filesystem.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Data-descriptor entries (flag bit 3 — unknown sizes up front) are
 * readable since 0.6 for PLAIN DEFLATE: the resumable pure-TS inflater
 * (codecs/inflate-stream.ts) reports the exact end of the compressed
 * stream, after which the trailing descriptor is identified by
 * VALIDATION against the measured CRC and sizes (all four spec forms).
 * Their protection is output counting (`maxEntryUncompressedSize`,
 * `maxTotalUncompressedSize`) plus an incremental ratio guard — the
 * up-front declared-size checks don't exist for bit 3, and `skip()`
 * costs a full decompress-and-discard. Still refused: store + bit 3
 * (stored data is not self-delimiting — the descriptor signature is
 * legal inside it), encrypted + bit 3, and custom codecs + bit 3.
 *
 * @module parser/zip-iterate
 */

import {
    type ZipCommonOptions,
    type ZipExtraField,
} from '../types/zip-types.js';
import {
    ZipDataError,
    ZipError,
    ZipFormatError,
    ZipUnsupportedError,
} from '../types/zip-errors.js';
import { crc32 } from '../codecs/crc32.js';
import { getCodec, METHOD_DEFLATE, METHOD_STORE } from '../codecs/codec-registry.js';
import { hasDecompressionStream } from '../codecs/inflate.js';
import { createInflator } from '../codecs/inflate-stream.js';
import {
    FLAG_DATA_DESCRIPTOR,
    FLAG_ENCRYPTED,
    FLAG_STRONG_ENCRYPTION,
    FLAG_UTF8,
    SIG_CENTRAL_FILE_HEADER,
    SIG_EOCD,
    SIG_LOCAL_FILE_HEADER,
    SIG_ZIP64_EOCD,
} from '../core/zip-constants.js';
import { enforceLimit, resolveLimits } from '../core/zip-limits.js';
import { createDiagnosticEmitter, invalidUtf8NameDiagnostic } from '../core/zip-diagnostics.js';
import { decodeCp437, decodeUtf8Strict } from '../core/zip-encoding.js';
import { dosDateTimeToDate } from '../core/zip-dos-time.js';
import { parseExtraFields, resolveUtMtime, resolveZip64 } from '../core/zip-extra-fields.js';
import { matchDataDescriptor, parseLocalFileHeader } from '../core/zip-structs.js';
import { toByteIterable, type ByteSource } from '../core/zip-source.js';
import { createChunkCursor, type ChunkCursor } from './zip-chunk-cursor.js';

/**
 * Options for {@link iterateZipEntries} (the shared strict/diagnostic/
 * limits set). Intentionally identical to `ZipCommonOptions` today — the
 * alias is the reserved extension point for forward-streaming-specific
 * options, so it is part of the frozen surface.
 */
export type IterateZipOptions = ZipCommonOptions;

/**
 * LFH-derived metadata only — a SUBSET of `ZipEntry`. Comments, external
 * attributes and version-made-by live only in the central directory.
 */
export interface StreamedZipHeader {
    readonly name: string;
    readonly rawName: Uint8Array;
    readonly nameEncoding: 'utf-8' | 'cp437';
    readonly isDirectory: boolean;
    readonly compressionMethod: number;
    readonly compressedSize: number;
    readonly uncompressedSize: number;
    readonly crc32: number;
    readonly flags: number;
    readonly versionNeeded: number;
    readonly dosDate: number;
    readonly dosTime: number;
    readonly lastModified: Date;
    readonly isEncrypted: boolean;
    readonly extraFields: readonly ZipExtraField[];
}

/** One forward-streamed entry. Consume `data()` fully (or `skip()`) before advancing. */
export interface StreamedZipEntry {
    readonly header: StreamedZipHeader;
    /** Decompressed content, single-shot, CRC-verified at the end. */
    data(): AsyncGenerator<Uint8Array, void, undefined>;
    /** Discard this entry's payload without decompressing. */
    skip(): Promise<void>;
}

const DRAIN_REMEDY = "consume the previous entry's data() fully or call skip() before advancing — "
    + 'forward iteration cannot seek backwards';

/**
 * Iterate an archive's local entries off an async byte stream — an
 * `AsyncIterable<Uint8Array>` or a Web `ReadableStream<Uint8Array>`
 * (a `fetch` body, `File.stream()`, …) since 0.9. See the module header
 * for the trust caveat and the v0.5 data-descriptor scope. When the
 * iteration stops at the central directory, a ReadableStream source is
 * left unread with its lock released — cancelling it stays the owner's
 * decision.
 */
export async function* iterateZipEntries(
    source: ByteSource,
    options?: IterateZipOptions,
): AsyncGenerator<StreamedZipEntry, void, undefined> {
    // Validate early, before any read.
    const limits = resolveLimits(options?.limits);
    const emit = createDiagnosticEmitter(options?.strict, options?.onDiagnostic);
    const cursor = createChunkCursor(toByteIterable(source));

    let entryCount = 0;
    let totalProduced = 0;
    let previous: { done: boolean } | null = null;

    // The walk itself, delegated so every exit path — the clean stop at the
    // central directory, EOF, a thrown refusal, or the caller abandoning the
    // iteration — funnels through one finally that closes the source
    // (releasing a ReadableStream reader's lock without cancelling the
    // stream — the owner keeps it).
    async function* walk(): AsyncGenerator<StreamedZipEntry, void, undefined> {
        for (;;) {
            if (previous !== null && !previous.done) {
                throw new ZipError('ZIP_API_MISUSE', `zipnative: ${DRAIN_REMEDY}`);
            }

            const sig = await cursor.peek4();
            if (sig === null) return; // clean EOF at a record boundary
            const sigValue = sig[0] | (sig[1] << 8) | (sig[2] << 16) | (sig[3] << 24);
            const sigU32 = sigValue >>> 0;
            if (sigU32 === SIG_CENTRAL_FILE_HEADER || sigU32 === SIG_EOCD || sigU32 === SIG_ZIP64_EOCD) {
                // The central directory (or an empty archive's trailer) begins:
                // no local entries remain. The rest of the stream is left
                // unconsumed for the caller.
                return;
            }
            if (sigU32 !== SIG_LOCAL_FILE_HEADER) {
                throw new ZipFormatError('ZIP_SIGNATURE_MISMATCH',
                    `zipnative: expected a local file header at byte ${cursor.bytesRead} — `
                    + 'not a ZIP stream, or corrupt');
            }

            entryCount++;
            enforceLimit(limits, 'maxEntries', entryCount, 'streamed entry count');

            // Fixed region first; variable lengths are capped BEFORE reading.
            const fixed = await cursor.readExact(30);
            const view = new DataView(fixed.buffer, fixed.byteOffset, fixed.byteLength);
            const nameLength = view.getUint16(26, true);
            const extraLength = view.getUint16(28, true);
            enforceLimit(limits, 'maxNameBytes', nameLength, 'entry name length');
            enforceLimit(limits, 'maxExtraFieldBytes', extraLength, 'entry extra-field length');
            const tail = await cursor.readExact(nameLength + extraLength);
            const window = new Uint8Array(30 + tail.length);
            window.set(fixed, 0);
            window.set(tail, 30);
            const lfh = parseLocalFileHeader(window, 0);

            // ── Header interpretation (reusing the reader's building blocks) ─
            const { fields } = parseExtraFields(lfh.extra);
            const z64 = resolveZip64(fields, {
                uncompressedSize: lfh.uncompressedSize,
                compressedSize: lfh.compressedSize,
                localHeaderOffset: 0,
                diskNumberStart: 0,
            });

            const utf8Flagged = (lfh.flags & FLAG_UTF8) !== 0;
            let name: string;
            let nameEncoding: 'utf-8' | 'cp437';
            if (utf8Flagged) {
                const decoded = decodeUtf8Strict(lfh.name);
                if (decoded === null) {
                    name = decodeCp437(lfh.name);
                    nameEncoding = 'cp437';
                    emit(invalidUtf8NameDiagnostic(name));
                } else {
                    name = decoded;
                    nameEncoding = 'utf-8';
                }
            } else {
                name = decodeCp437(lfh.name);
                nameEncoding = 'cp437';
            }

            const usesDescriptor = (lfh.flags & FLAG_DATA_DESCRIPTOR) !== 0;
            const isEncrypted = (lfh.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0;
            // Bit-3 entries are readable since 0.6 via the resumable inflater —
            // but ONLY for plain deflate: stored data is not self-delimiting
            // (the descriptor signature is legal inside it), encrypted payloads
            // are undelimitable AND unreadable, and registered custom codecs
            // cannot report a consumed-byte position.
            if (usesDescriptor && (isEncrypted || lfh.compressionMethod !== METHOD_DEFLATE)) {
                throw new ZipUnsupportedError('ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR',
                    `zipnative: entry '${name}' combines a data descriptor (flag bit 3) with `
                    + `${isEncrypted ? 'encryption' : `method ${lfh.compressionMethod}`} — its payload cannot be `
                    + 'delimited without the central directory; use openZip() on the complete archive instead',
                    'cd-less-descriptor');
            }

            const compressedSize = z64.compressedSize;
            const uncompressedSize = z64.uncompressedSize;

            if (!usesDescriptor) {
                // Declared-size bounds (untrusted values — output is ALSO counted).
                // Bit-3 entries declare zeros; their protection is the output
                // counting plus the incremental ratio guard in the reader below.
                enforceLimit(limits, 'maxEntryUncompressedSize', uncompressedSize, `entry '${name}' declared size`);
                if (compressedSize >= 1024 && compressedSize > 0) {
                    enforceLimit(limits, 'maxCompressionRatio', uncompressedSize / compressedSize,
                        `entry '${name}' compression ratio`);
                }
            }

            const header: StreamedZipHeader = {
                name,
                rawName: lfh.name,
                nameEncoding,
                isDirectory: name.endsWith('/'),
                compressionMethod: lfh.compressionMethod,
                compressedSize,
                uncompressedSize,
                crc32: lfh.crc32,
                flags: lfh.flags,
                versionNeeded: lfh.versionNeeded,
                dosDate: lfh.dosDate,
                dosTime: lfh.dosTime,
                lastModified: resolveUtMtime(fields) ?? dosDateTimeToDate(lfh.dosDate, lfh.dosTime),
                isEncrypted,
                extraFields: fields,
            };

            // Zero-payload entries (directories, empty files) are auto-drained:
            // there is nothing to consume, so the outer iterator may advance
            // immediately — data()/skip() remain callable once regardless.
            // Bit-3 entries declare 0 but DO carry a payload — never auto-drain.
            const state = { done: compressedSize === 0 && !usesDescriptor, consumed: false };
            previous = state;

            const guardConsume = (): void => {
                if (state.consumed) {
                    throw new ZipError('ZIP_API_MISUSE', `zipnative: data()/skip() for entry '${name}' was already used — it is single-shot`);
                }
                state.consumed = true;
            };

            const entry: StreamedZipEntry = {
                header,

                data: (): AsyncGenerator<Uint8Array, void, undefined> => {
                    if (isEncrypted) {
                        const feature = (lfh.flags & FLAG_STRONG_ENCRYPTION) !== 0 ? 'strong-encryption' : 'zipcrypto';
                        throw new ZipUnsupportedError('ZIP_UNSUPPORTED_ENCRYPTION',
                            `zipnative: entry '${name}' is encrypted (${feature}) — encryption is not supported; `
                            + 'skip() it to continue',
                            feature);
                    }
                    const codec = getCodec(lfh.compressionMethod);
                    if (codec === null) {
                        throw new ZipUnsupportedError('ZIP_UNSUPPORTED_METHOD',
                            `zipnative: entry '${name}' uses compression method ${lfh.compressionMethod}, which has no `
                            + 'registered codec — skip() it, or registerCodec() one',
                            `method:${lfh.compressionMethod}`);
                    }
                    guardConsume();
                    return usesDescriptor ? streamDescriptorEntry() : streamEntryData(entry);
                },

                skip: async (): Promise<void> => {
                    guardConsume();
                    if (usesDescriptor) {
                        // A bit-3 payload has no known length: skipping requires
                        // finding the deflate stream's end — a full
                        // decompress-and-discard (documented cost; the limits
                        // still apply, so a bomb cannot hide behind skip()).
                        const drain = streamDescriptorEntry();
                        for (let res = await drain.next(); !res.done; res = await drain.next()) { /* discard */ }
                        return;
                    }
                    const discard = cursor.take(compressedSize);
                    for (let res = await discard.next(); !res.done; res = await discard.next()) { /* discard */ }
                    state.done = true;
                },
            };

            /** Bit-3 path: resumable inflater + validated data descriptor. */
            async function* streamDescriptorEntry(): AsyncGenerator<Uint8Array, void, undefined> {
                const inflator = createInflator(limits.maxEntryUncompressedSize);
                let crc = 0;
                let fed = 0;
                while (!inflator.finished) {
                    const chunk = await cursor.nextChunk();
                    if (chunk === null) {
                        throw new ZipFormatError('ZIP_STREAM_TRUNCATED',
                            `zipnative: stream truncated inside entry '${name}' — the deflate stream never completed`);
                    }
                    fed += chunk.length;
                    let pieces: Uint8Array[];
                    try {
                        pieces = inflator.push(chunk);
                    } catch (err) {
                        throw err instanceof ZipError ? err : new ZipDataError('ZIP_DECOMPRESSION_FAILED',
                            `zipnative: entry '${name}' failed to decompress (${err instanceof Error ? err.message : String(err)})`,
                            name);
                    }
                    for (const piece of pieces) {
                        totalProduced += piece.length;
                        enforceLimit(limits, 'maxTotalUncompressedSize', totalProduced, 'total streamed output');
                        crc = crc32(piece, crc);
                        yield piece;
                    }
                    // Incremental ratio guard: fed ≥ consumed, so produced/fed
                    // under-reports the true ratio — the safe direction.
                    if (fed >= 1024) {
                        enforceLimit(limits, 'maxCompressionRatio', inflator.bytesProduced / fed,
                            `entry '${name}' compression ratio`);
                    }
                }
                inflator.end();
                if (inflator.leftover.length > 0) {
                    cursor.unread(inflator.leftover);
                }

                const measured = {
                    crc32: crc,
                    compressedSize: inflator.bytesConsumed,
                    uncompressedSize: inflator.bytesProduced,
                };
                if (measured.compressedSize >= 1024) {
                    enforceLimit(limits, 'maxCompressionRatio', measured.uncompressedSize / measured.compressedSize,
                        `entry '${name}' compression ratio`);
                }
                const head = await cursor.peekUpTo(24);
                const match = matchDataDescriptor(head, measured);
                if (!match.ok) {
                    throw match.crcMismatch !== null
                        ? new ZipDataError('ZIP_CRC_MISMATCH',
                            `zipnative: entry '${name}' data-descriptor CRC-32 mismatch — the data is corrupt`,
                            name, match.crcMismatch.expected, match.crcMismatch.actual)
                        : new ZipDataError('ZIP_DESCRIPTOR_MISMATCH',
                            `zipnative: entry '${name}' has no data descriptor matching the decompressed payload `
                            + '(corrupt or hostile stream)',
                            name);
                }
                await cursor.readExact(match.byteLength);
                state.done = true;
            }

            async function* streamEntryData(_self: StreamedZipEntry): AsyncGenerator<Uint8Array, void, undefined> {
                let produced = 0;
                let crc = 0;
                const outputCap = Math.min(uncompressedSize, limits.maxEntryUncompressedSize);

                const account = (chunk: Uint8Array): void => {
                    produced += chunk.length;
                    totalProduced += chunk.length;
                    if (produced > outputCap) {
                        throw new ZipDataError('ZIP_SIZE_MISMATCH',
                            `zipnative: entry '${name}' produced more than its declared ${uncompressedSize} bytes `
                            + '(the local header lies — corrupt or hostile stream)',
                            name);
                    }
                    enforceLimit(limits, 'maxTotalUncompressedSize', totalProduced, 'total streamed output');
                    crc = crc32(chunk, crc);
                };

                if (lfh.compressionMethod === METHOD_STORE) {
                    for await (const piece of cursor.take(compressedSize)) {
                        account(piece);
                        yield piece;
                    }
                } else {
                    yield* pumpInflate(cursor, compressedSize, account);
                }

                if (produced !== uncompressedSize) {
                    throw new ZipDataError('ZIP_SIZE_MISMATCH',
                        `zipnative: entry '${name}' produced ${produced} bytes but its header declares `
                        + `${uncompressedSize} (corrupt or hostile stream)`,
                        name);
                }
                if (crc !== lfh.crc32) {
                    throw new ZipDataError('ZIP_CRC_MISMATCH',
                        `zipnative: entry '${name}' CRC-32 mismatch — the data is corrupt`,
                        name, lfh.crc32, crc);
                }
                state.done = true;
            }

            yield entry;
        }
    }

    try {
        yield* walk();
    } finally {
        await cursor.close();
    }
}

/**
 * Incremental deflate pump: feeds exactly `compressedSize` bytes from the
 * cursor into a DecompressionStream as they arrive — O(chunk) memory.
 * Fallback without the platform API: buffer the compressed payload and
 * decompress in one shot (memory O(compressedSize), bounded by the
 * declared-size and ratio guards the caller already enforced).
 */
/** Corrupt streams must surface as typed ZipErrors, never platform errors. */
function wrapInflateError(err: unknown): Error {
    if (err instanceof ZipError) return err;
    const detail = err instanceof Error ? err.message : String(err);
    return new ZipDataError('ZIP_DECOMPRESSION_FAILED',
        `zipnative: streamed entry failed to decompress (${detail}) — the data is corrupt or hostile`);
}

async function* pumpInflate(
    cursor: ChunkCursor,
    compressedSize: number,
    account: (chunk: Uint8Array) => void,
): AsyncGenerator<Uint8Array, void, undefined> {
    if (hasDecompressionStream()) {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        // A write-side failure (truncated source, corrupt stream) MUST
        // abort the writable — otherwise reader.read() waits forever for
        // input that will never come (the fuzzing suite pins this).
        let writeError: unknown = null;
        const writeAll = (async (): Promise<void> => {
            try {
                for await (const piece of cursor.take(compressedSize)) {
                    // Copy: engines may detach written chunks, and pieces are
                    // zero-copy views of the source's buffers.
                    await writer.write(piece.slice());
                }
                await writer.close();
            } catch (err) {
                writeError = err;
                try {
                    await writer.abort(err);
                } catch { /* already errored */ }
            }
        })();

        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                account(value);
                yield value;
            }
        } catch (err) {
            await writeAll;
            throw wrapInflateError(writeError ?? err);
        }
        await writeAll;
        if (writeError !== null) {
            throw wrapInflateError(writeError);
        }
        return;
    }

    // Fallback without the platform API: the resumable pure-TS inflater —
    // O(chunk) memory on every runtime (0.6 removed the old
    // buffer-the-whole-entry caveat). Trailing slack inside the declared
    // span after the stream's final block is drained and ignored, matching
    // the one-shot tier's semantics; CRC/size verification still gates.
    const inflator = createInflator(Number.MAX_SAFE_INTEGER);
    try {
        for await (const piece of cursor.take(compressedSize)) {
            if (inflator.finished) continue; // drain the declared span
            for (const chunk of inflator.push(piece)) {
                account(chunk);
                yield chunk;
            }
        }
        inflator.end();
    } catch (err) {
        throw wrapInflateError(err);
    }
}
