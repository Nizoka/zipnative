/**
 * zipnative — Error hierarchy
 * ===========================
 * The only classes in the package (AGENTS.md §Conventions). Every message
 * starts with `zipnative: ` and names the remedy. Subclasses exist only
 * where callers must branch with `instanceof`.
 *
 * @module types/zip-errors
 */

/** Base class for every error thrown by zipnative. */
export class ZipError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ZipError';
    }
}

/** The archive (or one of its records) is structurally invalid. */
export class ZipFormatError extends ZipError {
    constructor(message: string) {
        super(message);
        this.name = 'ZipFormatError';
    }
}

/** A configured security bound from {@link ZipLimits} was exceeded. */
export class ZipLimitError extends ZipError {
    /** The `ZipLimits` key that was exceeded (e.g. `'maxEntryUncompressedSize'`). */
    readonly limit: string;
    /** The configured bound. */
    readonly configured: number;
    /** The observed value that exceeded it. */
    readonly observed: number;

    constructor(message: string, limit: string, configured: number, observed: number) {
        super(message);
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
    /** Entry name involved, when the attack is entry-scoped. */
    readonly entryName?: string;

    constructor(message: string, entryName?: string) {
        super(message);
        this.name = 'ZipSecurityError';
        this.entryName = entryName;
    }
}

/** Content integrity failure: CRC or size mismatch against declared metadata. */
export class ZipDataError extends ZipError {
    /** Entry name, when known at throw site. */
    readonly entryName?: string;
    readonly expectedCrc?: number;
    readonly actualCrc?: number;

    constructor(message: string, entryName?: string, expectedCrc?: number, actualCrc?: number) {
        super(message);
        this.name = 'ZipDataError';
        this.entryName = entryName;
        this.expectedCrc = expectedCrc;
        this.actualCrc = actualCrc;
    }
}

/**
 * The archive uses a feature zipnative deliberately does not support
 * (encryption, unknown compression method, multi-disk). The `feature`
 * field is machine-readable: `'zipcrypto'`, `'strong-encryption'`,
 * `'method:14'`, `'multi-disk'`.
 */
export class ZipUnsupportedError extends ZipError {
    readonly feature: string;

    constructor(message: string, feature: string) {
        super(message);
        this.name = 'ZipUnsupportedError';
        this.feature = feature;
    }
}
