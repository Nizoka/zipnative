/**
 * zipnative — public API surface
 * ==============================
 * The single entry point: everything public is re-exported here, in the
 * numbered categories below. Anything not exported here is private.
 *
 * @module zipnative
 */

// ── 1. Reading: open, random access, streams ─────────────────────────
export {
    openZip,
    type OpenZipOptions,
    type ReadEntryOptions,
    type ZipReader,
} from './parser/zip-reader.js';

// ── 2. Extraction: secure by default, in memory ──────────────────────
export {
    extractZip,
    extractZipStream,
    sanitizeEntryPath,
    type ExtractedEntry,
    type ExtractedStreamEntry,
    type ExtractOptions,
} from './parser/zip-extract.js';

// ── 3. Entries and shared types ──────────────────────────────────────
export type {
    EntryVerification,
    ZipCommonOptions,
    ZipDiagnostic,
    ZipDiagnosticCode,
    ZipDiagnosticHandler,
    ZipEntry,
    ZipExtraField,
    ZipLimits,
} from './types/zip-types.js';

// ── 4. Errors ────────────────────────────────────────────────────────
export {
    ZipDataError,
    ZipError,
    ZipFormatError,
    ZipLimitError,
    ZipSecurityError,
    ZipUnsupportedError,
} from './types/zip-errors.js';

// ── 5. Security limits ───────────────────────────────────────────────
export { DEFAULT_ZIP_LIMITS } from './core/zip-limits.js';

// ── 6. Codecs: registry, facades, checksums ──────────────────────────
export {
    getCodec,
    METHOD_DEFLATE,
    METHOD_STORE,
    registerCodec,
    type CodecCompressOptions,
    type ZipCodec,
} from './codecs/codec-registry.js';
export {
    initNodeZipCodecs,
    setInflateImpl,
} from './codecs/inflate.js';
export { crc32 } from './codecs/crc32.js';

// ── 7. Package metadata ──────────────────────────────────────────────
/** Library version — kept in sync with package.json by verify:docs. */
export const VERSION = '0.1.0';
