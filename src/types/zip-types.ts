/**
 * zipnative — Shared public types
 * ===============================
 * Layer 0 (leaf): imports nothing from other layers, so every layer —
 * including codecs — can reference these types without a reverse edge.
 *
 * @module types/zip-types
 */

// ── Diagnostics ──────────────────────────────────────────────────────

/**
 * Closed union of diagnostic codes. Diagnostics surface non-fatal
 * conformance concerns; structural failures throw instead (never both).
 */
export type ZipDiagnosticCode =
    | 'ZIP_PREPENDED_DATA'          // SFX-style prefix; offsets shifted by base
    | 'ZIP_MULTIPLE_EOCD'           // earlier EOCD signature also present
    | 'ZIP_NAME_MISMATCH'           // CD vs LFH filename bytes differ (CD wins)
    | 'ZIP_UNICODE_PATH_CONFLICT'   // 0x7075 extra disagrees with header name
    | 'ZIP_INVALID_UTF8_NAME'       // EFS bit set but bytes not valid UTF-8
    | 'ZIP_DUPLICATE_NAME'          // duplicate entry name in the central directory
    | 'ZIP_EXTRA_FIELD_MALFORMED'   // extra field overruns its declared length
    | 'ZIP_ZIP64_EXTRA_IGNORED'     // zip64 extra supplied a non-sentinel field
    | 'ZIP_TIMESTAMP_NOT_PINNED'    // writer used wall-clock time (M2+)
    | 'ZIP_NONDETERMINISTIC_CODEC'  // non-pinned codec tier in use (M2+)
    | 'ZIP_DEAD_BYTES_RATIO';       // incremental save: >50% dead bytes (M3+)

/** A single non-fatal conformance diagnostic. */
export interface ZipDiagnostic {
    readonly code: ZipDiagnosticCode;
    readonly severity: 'warning' | 'info';
    /** Human-readable message including the remedy. */
    readonly message: string;
    /** Entry name, when the concern is entry-scoped. */
    readonly entryName?: string;
}

/** Caller-supplied diagnostic sink (receives every diagnostic, no dedup). */
export type ZipDiagnosticHandler = (diagnostic: ZipDiagnostic) => void;

/** Internal emitter shape passed between layers by injection. */
export type ZipDiagnosticEmitter = (diagnostic: ZipDiagnostic) => void;

// ── Security limits ──────────────────────────────────────────────────

/**
 * Named security bounds consulted by every loop over untrusted archive
 * bytes. Each violation throws a `ZipLimitError` naming the limit and the
 * remedy. Defaults live in `core/zip-limits.ts`; raise a limit explicitly
 * via `options.limits` — or pass `Infinity` to disable one (not recommended
 * for untrusted input).
 */
export interface ZipLimits {
    /** Maximum central-directory entry count. CWE-400. */
    readonly maxEntries: number;
    /** Maximum decompressed size of a single entry, bytes. CWE-400. */
    readonly maxEntryUncompressedSize: number;
    /** Maximum total decompressed size across an extraction, bytes. CWE-400. */
    readonly maxTotalUncompressedSize: number;
    /**
     * Maximum declared uncompressed/compressed ratio for entries whose
     * compressed size is ≥ 1 KiB (smaller entries are exempt — tiny inputs
     * legitimately hit extreme ratios). CWE-409.
     */
    readonly maxCompressionRatio: number;
    /** Maximum entry-name length in bytes. CWE-400. */
    readonly maxNameBytes: number;
    /** Maximum extra-field block length in bytes (spec max 65535). CWE-400. */
    readonly maxExtraFieldBytes: number;
    /** Maximum comment length in bytes (spec max 65535). CWE-400. */
    readonly maxCommentBytes: number;
    /** Maximum central-directory size in bytes. CWE-400. */
    readonly maxCentralDirectoryBytes: number;
}

// ── Common option fragment ───────────────────────────────────────────

/** Shared option fragment embedded in every top-level options type. */
export interface ZipCommonOptions {
    /** Escalate the first diagnostic to a thrown `Error` (before any output). */
    readonly strict?: boolean;
    /** Receive every diagnostic (disables the deduplicated console.warn default). */
    readonly onDiagnostic?: ZipDiagnosticHandler;
    /** Override individual security bounds. */
    readonly limits?: Partial<ZipLimits>;
}

// ── Entries ──────────────────────────────────────────────────────────

/** One raw extra field, id + payload (zero-copy subarray of the source). */
export interface ZipExtraField {
    /** Header id, e.g. 0x0001 (Zip64), 0x5455 (UT), 0x7075 (Unicode Path). */
    readonly id: number;
    readonly data: Uint8Array;
}

/**
 * One central-directory entry — a plain readonly data object. All I/O
 * flows through the `ZipReader` that produced it; the entry itself holds
 * no hidden reference to the reader.
 */
export interface ZipEntry {
    /** Decoded name (UTF-8 when flag bit 11 is set, CP437 otherwise). */
    readonly name: string;
    /** Exact central-directory name bytes (zero-copy subarray). */
    readonly rawName: Uint8Array;
    readonly nameEncoding: 'utf-8' | 'cp437';
    /** Trailing `/` or the DOS directory attribute. */
    readonly isDirectory: boolean;
    /** Compression method id: 0 = store, 8 = deflate, others via the codec registry. */
    readonly compressionMethod: number;
    /** Zip64-resolved. Values above 2^53 are rejected at parse time. */
    readonly compressedSize: number;
    readonly uncompressedSize: number;
    /** CRC-32 of the uncompressed data, unsigned. */
    readonly crc32: number;
    /** Absolute local-header offset (prepended-data shift already applied). */
    readonly localHeaderOffset: number;
    /** DOS timestamp (refined by a UT extra field when present). */
    readonly lastModified: Date;
    readonly dosDate: number;
    readonly dosTime: number;
    readonly flags: number;
    readonly versionMadeBy: number;
    readonly versionNeeded: number;
    readonly internalAttributes: number;
    readonly externalAttributes: number;
    /** Raw entry comment bytes (zero-copy subarray). */
    readonly comment: Uint8Array;
    /** ALL extra fields, preserved raw. */
    readonly extraFields: readonly ZipExtraField[];
    /** Flag bit 0 or 6 — reads throw `ZipUnsupportedError`. */
    readonly isEncrypted: boolean;
    readonly usesZip64: boolean;
    /** Flag bit 3 (sizes/CRC in a trailing data descriptor). */
    readonly usesDataDescriptor: boolean;
}

/** Result of `ZipReader.verifyEntry()`. */
export interface EntryVerification {
    readonly ok: boolean;
    readonly crcMatch: boolean;
    readonly sizeMatch: boolean;
    readonly localHeaderMatch: boolean;
}
