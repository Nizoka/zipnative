/**
 * zipnative — Archive reader
 * ==========================
 * `openZip(bytes)` locates and validates the end-of-central-directory
 * structures — and nothing else. Central-directory records parse on first
 * access; the name index builds on first `getEntry()`; entry-range overlap
 * checks build on first read (or eagerly with `validate: 'eager'`).
 *
 * Central-vs-local divergence policy (§3.7 of the design):
 *
 * | Divergence                                  | Policy                    |
 * |---------------------------------------------|---------------------------|
 * | No LFH signature at the CD-declared offset  | fatal ZipFormatError      |
 * | Compression method differs                  | fatal ZipSecurityError    |
 * | Sizes/CRC differ (no bit 3 on the LFH)      | fatal ZipDataError        |
 * | Filename bytes differ                       | diagnostic (CD wins)      |
 * | Flag/extra differences                      | ignored (CD authoritative)|
 * | Entry ranges overlap each other or the CD   | fatal ZipSecurityError    |
 *
 * @module parser/zip-reader
 */

import {
    type EntryVerification,
    type ZipCommonOptions,
    type ZipEntry,
} from '../types/zip-types.js';
import {
    ZipDataError,
    ZipError,
    ZipFormatError,
    ZipSecurityError,
    ZipUnsupportedError,
} from '../types/zip-errors.js';
import { crc32 } from '../codecs/crc32.js';
import { getCodec, METHOD_STORE, type ZipCodec } from '../codecs/codec-registry.js';
import { FLAG_DATA_DESCRIPTOR, FLAG_STRONG_ENCRYPTION } from '../core/zip-constants.js';
import { createDiagnosticEmitter, duplicateNameDiagnostic, nameMismatchDiagnostic } from '../core/zip-diagnostics.js';
import { bytesEqual } from '../core/zip-encoding.js';
import { enforceLimit, resolveLimits } from '../core/zip-limits.js';
import { parseLocalFileHeader } from '../core/zip-structs.js';
import { locateEocd } from './zip-eocd.js';
import { parseCentralDirectory } from './zip-cd.js';

/** Options for {@link openZip}. */
export interface OpenZipOptions extends ZipCommonOptions {
    /**
     * `'eager'` cross-checks every entry's local header and the overlap
     * table up front (O(n)); `'lazy'` (default) defers both to first read.
     */
    readonly validate?: 'lazy' | 'eager';
}

/** Options for the per-entry read methods. */
export interface ReadEntryOptions {
    /** Verify the decompressed CRC-32 against the central directory. Default true. */
    readonly verifyCrc?: boolean;
}

/** Random-access, lazy, secure ZIP reader over an in-memory archive. */
export interface ZipReader {
    /** The original archive bytes — never mutated by any operation. */
    readonly bytes: Uint8Array;
    readonly entryCount: number;
    /** Raw EOCD comment bytes (zero-copy). */
    readonly comment: Uint8Array;
    readonly isZip64: boolean;

    /** Iterate central-directory entries (parsed on first access, then cached). */
    entries(): IterableIterator<ZipEntry>;
    /** Name-indexed lookup; the index builds once on first call. Last duplicate wins. */
    getEntry(name: string): ZipEntry | null;

    /** Decompress one entry fully, synchronously. CRC-verified by default. */
    readEntry(entry: ZipEntry | string, options?: ReadEntryOptions): Uint8Array;
    /** Chunked decompression (prefers DecompressionStream when available). */
    readEntryStream(entry: ZipEntry | string, options?: ReadEntryOptions): AsyncGenerator<Uint8Array, void, undefined>;
    /** Zero-copy view of the entry's COMPRESSED payload. */
    readEntryRaw(entry: ZipEntry | string): Uint8Array;

    /** Non-throwing integrity check: CRC, size, and local-header agreement. */
    verifyEntry(entry: ZipEntry | string): EntryVerification;
}

/**
 * Normalize codec failures: a corrupt compressed stream must always
 * surface as a typed ZipError, never a raw zlib/engine error — the
 * fuzzing suite asserts this invariant for every corruption class.
 */
function wrapDecompressError(err: unknown, entryName: string): Error {
    if (err instanceof ZipError) return err;
    const detail = err instanceof Error ? err.message : String(err);
    return new ZipDataError('ZIP_DECOMPRESSION_FAILED',
        `zipnative: entry '${entryName}' failed to decompress (${detail}) — the data is corrupt or hostile`,
        entryName);
}

/**
 * Open a ZIP archive held in memory.
 *
 * Cheap by design: only the end-of-central-directory structures are
 * located and validated here. Throws `ZipFormatError` when the input is
 * not a (whole, unambiguous) ZIP archive.
 */
export function openZip(bytes: Uint8Array, options?: OpenZipOptions): ZipReader {
    // Validate early, before any parsing.
    const limits = resolveLimits(options?.limits);
    const emit = createDiagnosticEmitter(options?.strict, options?.onDiagnostic);

    const layout = locateEocd(bytes, limits, emit);

    // ── Lazy state (closure-held, never on the returned object) ──────
    let entryList: ZipEntry[] | undefined;
    let nameIndex: Map<string, ZipEntry> | undefined;
    /** Sorted start offsets of every entry region + the CD (overlap defence). */
    let boundaries: number[] | undefined;

    const ensureEntries = (): ZipEntry[] => {
        entryList ??= parseCentralDirectory(bytes, layout, limits, emit);
        return entryList;
    };

    const ensureIndex = (): Map<string, ZipEntry> => {
        if (nameIndex === undefined) {
            nameIndex = new Map();
            for (const entry of ensureEntries()) {
                if (nameIndex.has(entry.name)) {
                    emit(duplicateNameDiagnostic(entry.name));
                }
                nameIndex.set(entry.name, entry);
            }
        }
        return nameIndex;
    };

    /**
     * Overlap defence (CWE-405, payload-sharing smuggling) at O(log n)
     * per read: the central directory alone yields the sorted start
     * boundaries of every entry region (plus the CD itself). An entry's
     * REAL extent — known once its local header is parsed at read time —
     * must fit entirely before the next boundary. Duplicate header
     * offsets (two entries claiming one region) are rejected outright.
     * `validate: 'eager'` runs the per-entry check for every entry.
     */
    const ensureBoundaries = (): number[] => {
        if (boundaries === undefined) {
            const list = ensureEntries();
            const sorted = list.map((e) => e.localHeaderOffset);
            sorted.push(layout.cdOffset);
            sorted.sort((a, b) => a - b);
            for (let i = 1; i < sorted.length; i++) {
                if (sorted[i] === sorted[i - 1]) {
                    throw new ZipSecurityError('ZIP_ENTRY_OVERLAP',
                        'zipnative: two entries share one local-header offset — overlapping-entry archives are '
                        + 'rejected (decompression-bomb/smuggling shape)');
                }
            }
            boundaries = sorted;
        }
        return boundaries;
    };

    /** Enforce that [entry start, dataEnd) crosses no other entry or the CD. */
    const checkEntryExtent = (entry: ZipEntry, dataEnd: number): void => {
        if (dataEnd > bytes.length) {
            throw new ZipFormatError('ZIP_RECORD_TRUNCATED',
                `zipnative: entry '${entry.name}' data extends past the end of the archive (truncated or corrupt)`);
        }
        if (entry.localHeaderOffset >= layout.cdOffset) {
            throw new ZipSecurityError('ZIP_ENTRY_OVERLAP',
                `zipnative: entry '${entry.name}' claims to start inside the central directory — `
                + 'overlapping-entry archives are rejected',
                entry.name);
        }
        const sorted = ensureBoundaries();
        // Binary search: smallest boundary strictly greater than this start.
        let lo = 0;
        let hi = sorted.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (sorted[mid] <= entry.localHeaderOffset) lo = mid + 1;
            else hi = mid;
        }
        const nextBoundary = lo < sorted.length ? sorted[lo] : bytes.length;
        if (dataEnd > nextBoundary) {
            throw new ZipSecurityError('ZIP_ENTRY_OVERLAP',
                `zipnative: entry '${entry.name}' extends into another entry or the central directory — `
                + 'overlapping-entry archives are rejected (decompression-bomb/smuggling shape)',
                entry.name);
        }
    };

    const resolveEntry = (entryOrName: ZipEntry | string): ZipEntry => {
        if (typeof entryOrName !== 'string') return entryOrName;
        const entry = ensureIndex().get(entryOrName);
        if (entry === undefined) {
            throw new ZipError('ZIP_ENTRY_NOT_FOUND',
                `zipnative: no entry named '${entryOrName}' in this archive (names are case-sensitive; `
                + 'iterate reader.entries() to list them)');
        }
        return entry;
    };

    /** Shared pre-read validation; returns the compressed payload view. */
    const prepareRead = (entry: ZipEntry): Uint8Array => {
        if (entry.isEncrypted) {
            const feature = (entry.flags & FLAG_STRONG_ENCRYPTION) !== 0 ? 'strong-encryption' : 'zipcrypto';
            throw new ZipUnsupportedError('ZIP_UNSUPPORTED_ENCRYPTION',
                `zipnative: entry '${entry.name}' is encrypted (${feature}) — encryption is not supported `
                + '(see README: What zipnative will NOT do); check entry.isEncrypted to route around such entries',
                feature);
        }
        enforceLimit(limits, 'maxEntryUncompressedSize', entry.uncompressedSize, `entry '${entry.name}' declared size`);
        if (entry.compressedSize >= 1024 && entry.compressedSize > 0) {
            const ratio = entry.uncompressedSize / entry.compressedSize;
            enforceLimit(limits, 'maxCompressionRatio', ratio, `entry '${entry.name}' compression ratio`);
        }

        const lfh = parseLocalFileHeader(bytes, entry.localHeaderOffset);
        let dataEnd = lfh.dataStart + entry.compressedSize;
        if ((lfh.flags & FLAG_DATA_DESCRIPTOR) !== 0) {
            // A trailing descriptor (12–24 bytes) belongs to this entry's
            // region; the minimal signless size suffices for the boundary
            // check — crossing the NEXT header start is what matters.
            dataEnd += 12;
        }
        checkEntryExtent(entry, dataEnd);
        if (lfh.compressionMethod !== entry.compressionMethod) {
            throw new ZipSecurityError('ZIP_CD_LFH_MISMATCH',
                `zipnative: entry '${entry.name}' local header declares method ${lfh.compressionMethod} but the `
                + `central directory says ${entry.compressionMethod} — parser-differential archives are rejected`,
                entry.name);
        }
        if ((lfh.flags & FLAG_DATA_DESCRIPTOR) === 0) {
            if (lfh.crc32 !== entry.crc32
                || lfh.compressedSize !== entry.compressedSize
                || lfh.uncompressedSize !== entry.uncompressedSize) {
                // Zip64 LFHs may carry 0xFFFFFFFF sentinels with a zip64 extra;
                // tolerate the sentinel form, reject a contradicting value.
                const sizesSentinel = lfh.compressedSize === 0xFFFFFFFF && lfh.uncompressedSize === 0xFFFFFFFF;
                if (!(sizesSentinel && lfh.crc32 === entry.crc32)) {
                    throw new ZipDataError('ZIP_SIZE_MISMATCH',
                        `zipnative: entry '${entry.name}' local header sizes/CRC contradict the central directory `
                        + '(corrupt or hostile archive)',
                        entry.name, entry.crc32, lfh.crc32);
                }
            }
        }
        if (!bytesEqual(lfh.name, entry.rawName)) {
            emit(nameMismatchDiagnostic(entry.name));
        }
        return bytes.subarray(lfh.dataStart, lfh.dataStart + entry.compressedSize);
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

    const checkOutput = (entry: ZipEntry, out: Uint8Array, verifyCrc: boolean): void => {
        if (out.length !== entry.uncompressedSize) {
            throw new ZipDataError('ZIP_SIZE_MISMATCH',
                `zipnative: entry '${entry.name}' decompressed to ${out.length} bytes but the central directory `
                + `declares ${entry.uncompressedSize} (corrupt or hostile archive)`,
                entry.name);
        }
        if (verifyCrc) {
            const actual = crc32(out);
            if (actual !== entry.crc32) {
                throw new ZipDataError('ZIP_CRC_MISMATCH',
                    `zipnative: entry '${entry.name}' CRC-32 mismatch — the data is corrupt `
                    + '(pass { verifyCrc: false } only if you accept corrupt output)',
                    entry.name, entry.crc32, actual);
            }
        }
    };

    // ── The reader object ────────────────────────────────────────────
    const reader: ZipReader = {
        bytes,
        entryCount: layout.totalEntries,
        comment: layout.comment,
        isZip64: layout.isZip64,

        entries(): IterableIterator<ZipEntry> {
            return ensureEntries()[Symbol.iterator]();
        },

        getEntry(name: string): ZipEntry | null {
            return ensureIndex().get(name) ?? null;
        },

        readEntry(entryOrName: ZipEntry | string, readOptions?: ReadEntryOptions): Uint8Array {
            const entry = resolveEntry(entryOrName);
            const compressed = prepareRead(entry);
            const codec = codecFor(entry);
            if (codec.decompressSync === undefined) {
                throw new ZipUnsupportedError('ZIP_UNSUPPORTED_CODEC_MODE',
                    `zipnative: the codec for method ${entry.compressionMethod} is stream-only — use readEntryStream()`,
                    `method:${entry.compressionMethod}`);
            }
            let raw: Uint8Array;
            try {
                raw = codec.decompressSync(compressed, entry.uncompressedSize);
            } catch (err) {
                throw wrapDecompressError(err, entry.name);
            }
            // Store returns a zero-copy view; readEntry promises owned bytes.
            const out = entry.compressionMethod === METHOD_STORE ? raw.slice() : raw;
            checkOutput(entry, out, readOptions?.verifyCrc !== false);
            return out;
        },

        async *readEntryStream(
            entryOrName: ZipEntry | string,
            readOptions?: ReadEntryOptions,
        ): AsyncGenerator<Uint8Array, void, undefined> {
            const entry = resolveEntry(entryOrName);
            const compressed = prepareRead(entry);
            const codec = codecFor(entry);
            if (codec.decompressStream === undefined) {
                throw new ZipUnsupportedError('ZIP_UNSUPPORTED_CODEC_MODE',
                    `zipnative: the codec for method ${entry.compressionMethod} has no streaming decompressor — `
                    + 'use readEntry()',
                    `method:${entry.compressionMethod}`);
            }
            const verifyCrc = readOptions?.verifyCrc !== false;
            let produced = 0;
            let crc = 0;
            try {
                for await (const chunk of codec.decompressStream(compressed, entry.uncompressedSize)) {
                    produced += chunk.length;
                    if (verifyCrc) crc = crc32(chunk, crc);
                    yield chunk;
                }
            } catch (err) {
                throw wrapDecompressError(err, entry.name);
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
        },

        readEntryRaw(entryOrName: ZipEntry | string): Uint8Array {
            const entry = resolveEntry(entryOrName);
            return prepareRead(entry);
        },

        verifyEntry(entryOrName: ZipEntry | string): EntryVerification {
            const entry = resolveEntry(entryOrName);
            let localHeaderMatch = false;
            let crcMatch = false;
            let sizeMatch = false;
            try {
                const compressed = prepareRead(entry);
                localHeaderMatch = true;
                const codec = codecFor(entry);
                if (codec.decompressSync !== undefined) {
                    const raw = codec.decompressSync(compressed, entry.uncompressedSize);
                    sizeMatch = raw.length === entry.uncompressedSize;
                    crcMatch = crc32(raw) === entry.crc32;
                }
            } catch {
                // Any failure leaves the corresponding flags false.
            }
            return { ok: localHeaderMatch && crcMatch && sizeMatch, crcMatch, sizeMatch, localHeaderMatch };
        },
    };

    if (options?.validate === 'eager') {
        // Full pass: every entry's real extent verified up front.
        for (const entry of ensureEntries()) {
            const lfh = parseLocalFileHeader(bytes, entry.localHeaderOffset);
            let dataEnd = lfh.dataStart + entry.compressedSize;
            if ((lfh.flags & FLAG_DATA_DESCRIPTOR) !== 0) dataEnd += 12;
            checkEntryExtent(entry, dataEnd);
        }
    }

    return reader;
}
