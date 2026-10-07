/**
 * zipnative — Random access over a byte-range source (1.1.0)
 * =========================================================
 * `openZipRange(source)` reads an archive the caller serves by ranges —
 * HTTP `Range` requests, `Blob.slice()`, a file handle, an object store —
 * holding only the central directory and one entry chunk in memory,
 * whatever the archive's size. Nothing is fetched that the format does not
 * need: the end-of-central-directory tail, the central directory, then per
 * entry its local header and its payload (chunk by chunk when streaming).
 *
 * The engine performs no I/O: the source is injected, like a codec. It
 * runs the same defences as the in-memory reader (parser/zip-entry-checks.ts
 * — limits before allocation, the overlap defence, the local-header
 * cross-check, the output check) through the same code, so the two
 * readers cannot disagree on what is safe.
 *
 * Refused by design: a Zip64 end-of-central-directory record that does not
 * sit next to its locator (APPNOTE 4.3.15 places it there; the tail window
 * this reader fetches is sized for that) — `ZIP_ZIP64_EOCD_MISPLACED`
 * names the remedy (open the complete archive).
 *
 * @module parser/zip-range-reader
 */

import type { EntrySkipReason, EntryVerification, ZipEntry } from '../types/zip-types.js';
import { ZipDataError, ZipError, ZipFormatError, ZipUnsupportedError } from '../types/zip-errors.js';
import { crc32 } from '../codecs/crc32.js';
import { getCodec, METHOD_STORE, type ZipCodec } from '../codecs/codec-registry.js';
import {
    LOCAL_FILE_HEADER_SIZE,
    MAX_EOCD_SCAN,
    ZIP64_EOCD_LOCATOR_SIZE,
    ZIP64_EOCD_MIN_SIZE,
} from '../core/zip-constants.js';
import { createProgressTracker, throwIfAborted } from '../core/zip-control.js';
import { createDiagnosticEmitter, duplicateNameDiagnostic } from '../core/zip-diagnostics.js';
import { encryptionScheme } from '../core/zip-encryption.js';
import { enforceLimit, resolveLimits } from '../core/zip-limits.js';
import { parseLocalFileHeader, type LocalFileHeader } from '../core/zip-structs.js';
import { locateEocd } from './zip-eocd.js';
import { parseCentralDirectory } from './zip-cd.js';
import {
    checkDecompressedOutput,
    createExtentChecker,
    crossCheckLocalHeader,
    descriptorSlack,
    enforceDeclaredSizes,
} from './zip-entry-checks.js';
import type { OpenZipOptions, ReadEntryOptions } from './zip-reader.js';

/**
 * An archive served by ranges. `read(offset, length)` resolves to exactly
 * `length` bytes starting at `offset` (fewer only at the end of the
 * source, which the reader never asks for); a short read is reported as
 * `ZIP_RECORD_TRUNCATED`. Implement it over `fetch` with a `Range` header,
 * `Blob.slice(offset, offset + length).arrayBuffer()`, `FileHandle.read`,
 * or an object store's ranged GET — the engine never performs I/O itself.
 *
 * @since 1.1.0
 */
export interface ByteRangeSource {
    /** Total size of the archive in bytes. */
    readonly size: number;
    read(offset: number, length: number): Promise<Uint8Array>;
}

/**
 * A {@link ByteRangeSource} over bytes already in memory — for tests, for
 * parity with `openZip`, and for callers that mix the two readers.
 *
 * @since 1.1.0
 */
export function rangeSourceFromBytes(bytes: Uint8Array): ByteRangeSource {
    return {
        size: bytes.length,
        read: (offset: number, length: number): Promise<Uint8Array> =>
            Promise.resolve(bytes.subarray(offset, offset + length)),
    };
}

/**
 * Random-access reader over a {@link ByteRangeSource}: the `ZipReader`
 * surface with asynchronous reads and no `bytes` (there is no buffer to
 * expose). The central directory is parsed when the reader opens, so
 * `entries()` and `getEntry()` are synchronous.
 *
 * @since 1.1.0
 */
export interface ZipRangeReader {
    /** The source's size — the archive's length in bytes. */
    readonly size: number;
    readonly entryCount: number;
    /** Raw EOCD comment bytes. */
    readonly comment: Uint8Array;
    readonly isZip64: boolean;

    /** Every central-directory entry, in directory order. */
    entries(): IterableIterator<ZipEntry>;
    /** Name-indexed lookup; the index builds once on first call. Last duplicate wins. */
    getEntry(name: string): ZipEntry | null;

    /** Fetch and decompress one entry. CRC-verified by default. */
    readEntry(entry: ZipEntry | string, options?: ReadEntryOptions): Promise<Uint8Array>;
    /**
     * Decompress one entry chunk by chunk — the payload is fetched in
     * ranges and fed to the codec's incremental decoder, O(chunk) memory
     * for store and deflate (a registered codec without
     * `createDecompressor` is fetched whole, bounded by
     * `limits.maxEntryCompressedSize`).
     */
    readEntryStream(entry: ZipEntry | string, options?: ReadEntryOptions): AsyncGenerator<Uint8Array, void, undefined>;
    /** Fetch the entry's COMPRESSED payload (bounded by `limits.maxEntryCompressedSize`). */
    readEntryRaw(entry: ZipEntry | string): Promise<Uint8Array>;
    /** Non-throwing integrity check: CRC, size, and local-header agreement, with the skip reason. */
    verifyEntry(entry: ZipEntry | string): Promise<EntryVerification>;
}

/** Range reads of this size feed the incremental decoder when streaming. */
const STREAM_CHUNK = 256 * 1024;

/**
 * Open an archive served by ranges. Fetches the end-of-central-directory
 * tail and the central directory (bounded by `limits.maxCentralDirectoryBytes`
 * BEFORE the read), then returns a reader whose entry reads fetch exactly
 * what they decode.
 *
 * @since 1.1.0
 */
export async function openZipRange(source: ByteRangeSource, options?: OpenZipOptions): Promise<ZipRangeReader> {
    // Validate early, before any read.
    const limits = resolveLimits(options?.limits);
    const emit = createDiagnosticEmitter(options?.strict, options?.onDiagnostic);
    const signal = options?.signal;
    throwIfAborted(signal);
    if (!Number.isInteger(source.size) || source.size < 0 || source.size > Number.MAX_SAFE_INTEGER) {
        throw new ZipError('ZIP_INVALID_OPTION', `zipnative: a ByteRangeSource needs an integer size (got ${String(source.size)})`);
    }
    const size = source.size;

    /** Exactly `length` bytes at `offset`, or a typed refusal. */
    const readExact = async (offset: number, length: number, what: string): Promise<Uint8Array> => {
        throwIfAborted(signal);
        if (offset < 0 || length < 0 || offset + length > size) {
            throw new ZipFormatError('ZIP_RECORD_TRUNCATED',
                `zipnative: ${what} lies at bytes ${offset}..${offset + length} of a ${size}-byte source (truncated or corrupt)`);
        }
        const bytes = await source.read(offset, length);
        if (bytes.length !== length) {
            throw new ZipFormatError('ZIP_RECORD_TRUNCATED',
                `zipnative: the byte-range source returned ${bytes.length} bytes for ${what} (${length} requested at ${offset}) — `
                + 'a short read means a truncated archive or a source that lies about its size');
        }
        return bytes;
    };

    // ── The tail: EOCD, its comment, and the Zip64 records next to it ──
    // Sized for the spec-bound comment plus the Zip64 locator and record
    // (plus room for the record's extensible data) so a conformant Zip64
    // archive resolves in one read.
    const tailLength = Math.min(size, MAX_EOCD_SCAN + ZIP64_EOCD_LOCATOR_SIZE + ZIP64_EOCD_MIN_SIZE + 64 * 1024);
    const tailStart = size - tailLength;
    const tail = await readExact(tailStart, tailLength, 'the end-of-central-directory tail');
    const layout = locateEocd(tail, limits, emit, tailStart);

    // ── The central directory (its size was bounded by locateEocd) ────
    const cd = await readExact(layout.cdOffset, layout.cdSize, 'the central directory');
    const entryList = parseCentralDirectory(cd, { ...layout, cdOffset: 0 }, limits, emit, {
        dosTimeMode: options?.dosTimeMode,
        nameDecoder: options?.nameDecoder,
    });
    let nameIndex: Map<string, ZipEntry> | undefined;
    const ensureIndex = (): Map<string, ZipEntry> => {
        if (nameIndex === undefined) {
            nameIndex = new Map();
            for (const entry of entryList) {
                if (nameIndex.has(entry.name)) emit(duplicateNameDiagnostic(entry.name));
                nameIndex.set(entry.name, entry);
            }
        }
        return nameIndex;
    };
    const checkExtent = createExtentChecker(() => entryList, layout.cdOffset, size);

    const resolveEntry = (entryOrName: ZipEntry | string): ZipEntry => {
        if (typeof entryOrName !== 'string') return entryOrName;
        const entry = ensureIndex().get(entryOrName);
        if (entry === undefined) {
            throw new ZipError('ZIP_ENTRY_NOT_FOUND', `zipnative: no entry named '${entryOrName}' in this archive`);
        }
        return entry;
    };

    const guardEncryption = (entry: ZipEntry): void => {
        if (!entry.isEncrypted) return;
        const feature = encryptionScheme(entry.flags, entry.compressionMethod, entry.extraFields);
        throw new ZipUnsupportedError('ZIP_UNSUPPORTED_ENCRYPTION',
            `zipnative: entry '${entry.name}' is encrypted (${feature}) — encryption is not supported `
            + '(see README: What zipnative will NOT do); check entry.isEncrypted to route around such entries',
            feature);
    };

    /**
     * Fetch the local header (fixed part first, then exactly the variable
     * tail the lengths declare, both capped), cross-check it, and return
     * the absolute offset of the payload.
     */
    const locateData = async (entry: ZipEntry): Promise<{ lfh: LocalFileHeader; dataStart: number }> => {
        enforceDeclaredSizes(limits, entry);
        const fixed = await readExact(entry.localHeaderOffset, LOCAL_FILE_HEADER_SIZE, `entry '${entry.name}' local header`);
        const nameLength = fixed[26] | (fixed[27] << 8);
        const extraLength = fixed[28] | (fixed[29] << 8);
        enforceLimit(limits, 'maxNameBytes', nameLength, `entry '${entry.name}' local name length`);
        enforceLimit(limits, 'maxExtraFieldBytes', extraLength, `entry '${entry.name}' local extra-field length`);
        const window = await readExact(entry.localHeaderOffset, LOCAL_FILE_HEADER_SIZE + nameLength + extraLength,
            `entry '${entry.name}' local header`);
        const lfh = parseLocalFileHeader(window, 0);
        const dataStart = entry.localHeaderOffset + lfh.dataStart;
        checkExtent(entry, dataStart + entry.compressedSize + descriptorSlack(lfh));
        crossCheckLocalHeader(entry, lfh, emit);
        return { lfh, dataStart };
    };

    const codecFor = (entry: ZipEntry): ZipCodec => {
        const codec = getCodec(entry.compressionMethod);
        if (codec === null) {
            throw new ZipUnsupportedError('ZIP_UNSUPPORTED_METHOD',
                `zipnative: entry '${entry.name}' uses compression method ${entry.compressionMethod}, which has no `
                + 'registered codec — registerCodec() one, or re-save the archive with store/deflate',
                `method:${entry.compressionMethod}`);
        }
        return codec;
    };

    /** The whole compressed payload — the one allocation a range read cannot avoid, bounded first. */
    const fetchPayload = async (entry: ZipEntry, dataStart: number): Promise<Uint8Array> => {
        enforceLimit(limits, 'maxEntryCompressedSize', entry.compressedSize, `entry '${entry.name}' compressed size`);
        return readExact(dataStart, entry.compressedSize, `entry '${entry.name}' payload`);
    };

    const reader: ZipRangeReader = {
        size,
        entryCount: layout.totalEntries,
        comment: layout.comment,
        isZip64: layout.isZip64,

        entries(): IterableIterator<ZipEntry> {
            return entryList[Symbol.iterator]();
        },

        getEntry(name: string): ZipEntry | null {
            return ensureIndex().get(name) ?? null;
        },

        async readEntry(entryOrName: ZipEntry | string, readOptions?: ReadEntryOptions): Promise<Uint8Array> {
            const entry = resolveEntry(entryOrName);
            guardEncryption(entry);
            const { dataStart } = await locateData(entry);
            const codec = codecFor(entry);
            if (codec.decompressSync === undefined) {
                throw new ZipUnsupportedError('ZIP_UNSUPPORTED_CODEC_MODE',
                    `zipnative: the codec for method ${entry.compressionMethod} is stream-only — use readEntryStream()`,
                    `method:${entry.compressionMethod}`);
            }
            const compressed = await fetchPayload(entry, dataStart);
            let raw: Uint8Array;
            try {
                raw = codec.decompressSync(compressed, entry.uncompressedSize);
            } catch (err) {
                throw wrapDecompressError(err, entry.name);
            }
            const out = entry.compressionMethod === METHOD_STORE ? raw.slice() : raw;
            checkDecompressedOutput(entry, out, readOptions?.verifyCrc !== false);
            return out;
        },

        async *readEntryStream(
            entryOrName: ZipEntry | string,
            readOptions?: ReadEntryOptions,
        ): AsyncGenerator<Uint8Array, void, undefined> {
            const entry = resolveEntry(entryOrName);
            guardEncryption(entry);
            const { dataStart } = await locateData(entry);
            const codec = codecFor(entry);
            const verifyCrc = readOptions?.verifyCrc !== false;
            const progress = createProgressTracker(options?.onProgress, 1);
            let produced = 0;
            let crc = 0;
            const account = (chunk: Uint8Array): void => {
                produced += chunk.length;
                if (verifyCrc) crc = crc32(chunk, crc);
                progress.bytesOut(chunk.length);
            };

            const factory = codec.createDecompressor;
            if (factory !== undefined) {
                // The incremental path: ranges of the payload in, decoded
                // pieces out, nothing held beyond one chunk.
                const decoder = factory.call(codec, entry.uncompressedSize);
                try {
                    for (let pos = 0; pos < entry.compressedSize; pos += STREAM_CHUNK) {
                        const length = Math.min(STREAM_CHUNK, entry.compressedSize - pos);
                        const piece = await readExact(dataStart + pos, length, `entry '${entry.name}' payload`);
                        progress.bytesIn(length);
                        for (const chunk of decoder.push(piece)) {
                            account(chunk);
                            yield chunk;
                        }
                    }
                    for (const chunk of decoder.end()) {
                        account(chunk);
                        yield chunk;
                    }
                } catch (err) {
                    throw wrapDecompressError(err, entry.name);
                }
            } else {
                if (codec.decompressStream === undefined) {
                    throw new ZipUnsupportedError('ZIP_UNSUPPORTED_CODEC_MODE',
                        `zipnative: the codec for method ${entry.compressionMethod} has no streaming decompressor — `
                        + 'use readEntry()',
                        `method:${entry.compressionMethod}`);
                }
                const compressed = await fetchPayload(entry, dataStart);
                progress.bytesIn(compressed.length);
                try {
                    for await (const chunk of codec.decompressStream(compressed, entry.uncompressedSize)) {
                        throwIfAborted(signal);
                        account(chunk);
                        yield chunk;
                    }
                } catch (err) {
                    throw wrapDecompressError(err, entry.name);
                }
            }
            if (produced !== entry.uncompressedSize) {
                throw new ZipDataError('ZIP_SIZE_MISMATCH',
                    `zipnative: entry '${entry.name}' streamed ${produced} bytes but the central directory `
                    + `declares ${entry.uncompressedSize} (corrupt or hostile archive)`,
                    entry.name);
            }
            if (verifyCrc && crc !== entry.crc32) {
                throw new ZipDataError('ZIP_CRC_MISMATCH',
                    `zipnative: entry '${entry.name}' CRC-32 mismatch — the data is corrupt`,
                    entry.name, entry.crc32, crc);
            }
            progress.entryDone();
        },

        async readEntryRaw(entryOrName: ZipEntry | string): Promise<Uint8Array> {
            const entry = resolveEntry(entryOrName);
            guardEncryption(entry);
            const { dataStart } = await locateData(entry);
            return fetchPayload(entry, dataStart);
        },

        async verifyEntry(entryOrName: ZipEntry | string): Promise<EntryVerification> {
            const entry = resolveEntry(entryOrName);
            let localHeaderMatch = false;
            let dataStart: number | null = null;
            try {
                dataStart = (await locateData(entry)).dataStart;
                localHeaderMatch = true;
            } catch (err) {
                if (err instanceof Error && err.name === 'AbortError') throw err;
            }
            const skip = (skipped: EntrySkipReason): EntryVerification =>
                ({ ok: false, crcMatch: false, sizeMatch: false, localHeaderMatch, skipped });
            if (entry.isEncrypted) return skip('encrypted');
            const codec = getCodec(entry.compressionMethod);
            if (codec === null) return skip('unsupported-method');
            if (codec.decompressSync === undefined) return skip('stream-only-codec');

            let crcMatch = false;
            let sizeMatch = false;
            if (dataStart !== null) {
                try {
                    const raw = codec.decompressSync(await fetchPayload(entry, dataStart), entry.uncompressedSize);
                    sizeMatch = raw.length === entry.uncompressedSize;
                    crcMatch = crc32(raw) === entry.crc32;
                } catch (err) {
                    if (err instanceof Error && err.name === 'AbortError') throw err;
                }
            }
            return { ok: localHeaderMatch && crcMatch && sizeMatch, crcMatch, sizeMatch, localHeaderMatch };
        },
    };

    if (options?.validate === 'eager') {
        // Full pass: every entry's local header fetched and its real extent verified up front.
        for (const entry of entryList) await locateData(entry);
    }

    return reader;
}

/**
 * Normalize codec failures the way the in-memory reader does: a ZipError
 * (the tiers' own vocabulary) and the caller's abort pass through; any
 * other failure is a registered codec's, ZIP_DECOMPRESSION_FAILED.
 */
function wrapDecompressError(err: unknown, entryName: string): Error {
    if (err instanceof ZipError) return err;
    if (err instanceof Error && err.name === 'AbortError') return err;
    const detail = err instanceof Error ? err.message : String(err);
    return new ZipDataError('ZIP_DECOMPRESSION_FAILED',
        `zipnative: entry '${entryName}' failed to decompress (${detail}) — the data is corrupt or hostile`,
        entryName);
}
