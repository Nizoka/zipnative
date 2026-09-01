/**
 * zipnative — Error hierarchy
 * ===========================
 * The only classes in the package (AGENTS.md §Conventions). Every message
 * starts with `zipnative: ` and names the remedy. Subclasses exist only
 * where callers must branch with `instanceof`.
 *
 * Every error also carries a stable, machine-readable {@link ZipErrorCode}
 * — the contract agents and wrappers branch on without parsing messages.
 * Codes are frozen from 0.8.0: removing or renaming one is semver-major,
 * adding one is semver-minor. The registry lives in `docs/data/errors.json`
 * and the `error-parity` rule of `scripts/verify-docs.ts` keeps the two in
 * bidirectional sync.
 *
 * @module types/zip-errors
 */

import type { ZipLimits } from './zip-types.js';

/** Codes carried by the base {@link ZipError} (usage and invariant faults). */
export type ZipBaseErrorCode =
    | 'ZIP_INVALID_OPTION'      // an option value fails validation (level, chunkSize, …)
    | 'ZIP_INPUT_TOO_LARGE'     // input exceeds what the pure encoder addresses
    | 'ZIP_ENTRY_NOT_FOUND'     // named entry absent where one is required
    | 'ZIP_ENTRY_EXISTS'        // named entry present where absence is required
    | 'ZIP_API_MISUSE'          // contract violation (drain order, use-after-finish, …)
    | 'ZIP_STRICT_DIAGNOSTIC'   // strict: true escalated a diagnostic
    | 'ZIP_INTERNAL';           // internal invariant broke — a zipnative bug, report it

/** Codes carried by {@link ZipFormatError}. */
export type ZipFormatErrorCode =
    | 'ZIP_EOCD_NOT_FOUND'          // no end-of-central-directory record in the scan window
    | 'ZIP_EOCD_INCONSISTENT'       // EOCD fields contradict the archive layout
    | 'ZIP_ZIP64_LOCATOR_MISSING'   // zip64 sentinels set but no locator
    | 'ZIP_ZIP64_EOCD_MISPLACED'    // zip64 EOCD is not where the locator points
    | 'ZIP_CD_INCONSISTENT'         // central directory walk contradicts declared counts/size
    | 'ZIP_RECORD_TRUNCATED'        // a fixed or variable-length record overruns the input
    | 'ZIP_SIGNATURE_MISMATCH'      // an expected PK signature is absent
    | 'ZIP_STREAM_TRUNCATED'        // forward stream ended mid-record or mid-entry
    | 'ZIP_VALUE_UNREPRESENTABLE'   // a 64-bit field exceeds Number.MAX_SAFE_INTEGER
    | 'ZIP_INVALID_ENTRY_NAME'      // entry name violates the writer's name rules
    | 'ZIP_DUPLICATE_ENTRY_NAME'    // duplicate names where uniqueness is required
    | 'ZIP_DEFLATE_TRUNCATED'       // deflate stream ends mid-block
    | 'ZIP_DEFLATE_CORRUPT';        // deflate stream is structurally invalid

/** Codes carried by {@link ZipSecurityError}. */
export type ZipSecurityErrorCode =
    | 'ZIP_ENTRY_OVERLAP'           // two entries share bytes (CWE-405)
    | 'ZIP_CD_LFH_MISMATCH'         // central vs local metadata divergence (CWE-436)
    | 'ZIP_ZIP64_CONTRADICTION'     // zip64 value contradicts a non-sentinel classic field (CWE-1288)
    | 'ZIP_PATH_TRAVERSAL'          // entry path escapes the extraction root (CWE-22)
    | 'ZIP_SYMLINK_REJECTED'        // symlink entry under rejectSymlinks (CWE-59)
    | 'ZIP_EXTRACT_DUPLICATE_PATH'; // duplicate output path under onDuplicate:'error' (CWE-694)

/** Codes carried by {@link ZipDataError}. */
export type ZipDataErrorCode =
    | 'ZIP_CRC_MISMATCH'            // decompressed bytes fail the declared CRC-32
    | 'ZIP_SIZE_MISMATCH'           // sizes contradict: declared vs measured, or local vs central
    | 'ZIP_INFLATE_OUTPUT_OVERFLOW' // inflate produced more than the declared/allowed output
    | 'ZIP_DESCRIPTOR_MISMATCH'     // no data-descriptor form matches the measured values
    | 'ZIP_DECOMPRESSION_FAILED';   // the codec failed mid-decompression (corrupt payload)

/** Codes carried by {@link ZipLimitError}. */
export type ZipLimitErrorCode =
    | 'ZIP_LIMIT_EXCEEDED'          // a configured ZipLimits bound was exceeded
    | 'ZIP_LIMIT_INVALID';          // the limits override itself is invalid (configured/observed are NaN)

/** Codes carried by {@link ZipUnsupportedError}. */
export type ZipUnsupportedErrorCode =
    | 'ZIP_UNSUPPORTED_ENCRYPTION'
    | 'ZIP_UNSUPPORTED_METHOD'
    | 'ZIP_UNSUPPORTED_MULTI_DISK'
    | 'ZIP_UNSUPPORTED_ZIP64_STREAMING'
    | 'ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR'
    | 'ZIP_UNSUPPORTED_CODEC_MODE';

/**
 * Every stable error code zipnative can throw. Frozen from 0.8.0:
 * removal or renaming is semver-major; additions are semver-minor.
 */
export type ZipErrorCode =
    | ZipBaseErrorCode
    | ZipFormatErrorCode
    | ZipSecurityErrorCode
    | ZipDataErrorCode
    | ZipLimitErrorCode
    | ZipUnsupportedErrorCode;

/**
 * The closed vocabulary of {@link ZipUnsupportedError.feature} values:
 * `'zipcrypto'`, `'strong-encryption'`, `'multi-disk'`, `'zip64-streaming'`,
 * `'cd-less-descriptor'`, or `` `method:${n}` `` for an unregistered
 * compression method.
 */
export type ZipUnsupportedFeature =
    | 'zipcrypto'
    | 'strong-encryption'
    | 'multi-disk'
    | 'zip64-streaming'
    | 'cd-less-descriptor'
    | `method:${number}`;

/** Base class for every error thrown by zipnative. */
export class ZipError extends Error {
    /** Stable machine-readable code — frozen from 0.8.0 (see module header). */
    readonly code: ZipErrorCode;

    constructor(code: ZipErrorCode, message: string) {
        super(message);
        this.name = 'ZipError';
        this.code = code;
    }
}

/** The archive (or one of its records) is structurally invalid. */
export class ZipFormatError extends ZipError {
    declare readonly code: ZipFormatErrorCode;

    constructor(code: ZipFormatErrorCode, message: string) {
        super(code, message);
        this.name = 'ZipFormatError';
    }
}

/** A configured security bound from {@link ZipLimits} was exceeded. */
export class ZipLimitError extends ZipError {
    declare readonly code: ZipLimitErrorCode;
    /** The `ZipLimits` key that was exceeded (e.g. `'maxEntryUncompressedSize'`). */
    readonly limit: keyof ZipLimits | (string & {});
    /** The configured bound (`NaN` under `ZIP_LIMIT_INVALID`). */
    readonly configured: number;
    /** The observed value that exceeded it (`NaN` under `ZIP_LIMIT_INVALID`). */
    readonly observed: number;

    constructor(
        code: ZipLimitErrorCode,
        message: string,
        limit: keyof ZipLimits | (string & {}),
        configured: number,
        observed: number,
    ) {
        super(code, message);
        this.name = 'ZipLimitError';
        this.limit = limit;
        this.configured = configured;
        this.observed = observed;
    }
}

/**
 * The archive has an active-attack shape: path traversal, overlapping
 * entries, central-directory/local-header divergence, Zip64 spoofing.
 */
export class ZipSecurityError extends ZipError {
    declare readonly code: ZipSecurityErrorCode;
    /** Entry name involved, when the attack is entry-scoped. */
    readonly entryName?: string;

    constructor(code: ZipSecurityErrorCode, message: string, entryName?: string) {
        super(code, message);
        this.name = 'ZipSecurityError';
        this.entryName = entryName;
    }
}

/** Content integrity failure: CRC or size mismatch against declared metadata. */
export class ZipDataError extends ZipError {
    declare readonly code: ZipDataErrorCode;
    /** Entry name, when known at throw site. */
    readonly entryName?: string;
    readonly expectedCrc?: number;
    readonly actualCrc?: number;

    constructor(
        code: ZipDataErrorCode,
        message: string,
        entryName?: string,
        expectedCrc?: number,
        actualCrc?: number,
    ) {
        super(code, message);
        this.name = 'ZipDataError';
        this.entryName = entryName;
        this.expectedCrc = expectedCrc;
        this.actualCrc = actualCrc;
    }
}

/**
 * The archive uses a feature zipnative deliberately does not support
 * (encryption, unknown compression method, multi-disk, Zip64 streaming,
 * CD-less descriptors in unsupported shapes). The `feature` field carries
 * the closed {@link ZipUnsupportedFeature} vocabulary.
 */
export class ZipUnsupportedError extends ZipError {
    declare readonly code: ZipUnsupportedErrorCode;
    readonly feature: ZipUnsupportedFeature;

    constructor(code: ZipUnsupportedErrorCode, message: string, feature: ZipUnsupportedFeature) {
        super(code, message);
        this.name = 'ZipUnsupportedError';
        this.feature = feature;
    }
}
