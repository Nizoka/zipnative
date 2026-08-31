/**
 * zipnative — ZIP format constants
 * ================================
 * Record signatures, flag bits and structural sizes from the PKWARE
 * APPNOTE (.ZIP File Format Specification).
 *
 * @module core/zip-constants
 */

// ── Record signatures (little-endian on disk; compared as u32) ───────

export const SIG_LOCAL_FILE_HEADER = 0x04034b50;         // "PK\x03\x04"
export const SIG_CENTRAL_FILE_HEADER = 0x02014b50;       // "PK\x01\x02"
export const SIG_EOCD = 0x06054b50;                      // "PK\x05\x06"
export const SIG_ZIP64_EOCD = 0x06064b50;                // "PK\x06\x06"
export const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50;        // "PK\x06\x07"
export const SIG_DATA_DESCRIPTOR = 0x08074b50;           // "PK\x07\x08"

// ── Fixed record sizes (bytes, excluding variable-length tails) ──────

export const LOCAL_FILE_HEADER_SIZE = 30;
export const CENTRAL_FILE_HEADER_SIZE = 46;
export const EOCD_SIZE = 22;
export const ZIP64_EOCD_MIN_SIZE = 56;
export const ZIP64_EOCD_LOCATOR_SIZE = 20;

/** EOCD scan window: EOCD_SIZE + max comment (65535). A spec bound, not configurable. */
export const MAX_EOCD_SCAN = EOCD_SIZE + 0xFFFF;

// ── General-purpose flag bits ────────────────────────────────────────

export const FLAG_ENCRYPTED = 0x0001;          // bit 0 — ZipCrypto/AES marker
export const FLAG_DATA_DESCRIPTOR = 0x0008;    // bit 3 — sizes/CRC trail the data
export const FLAG_STRONG_ENCRYPTION = 0x0040;  // bit 6
export const FLAG_UTF8 = 0x0800;               // bit 11 — EFS: name/comment are UTF-8

// ── Zip64 sentinels ──────────────────────────────────────────────────

export const SENTINEL_U16 = 0xFFFF;
export const SENTINEL_U32 = 0xFFFFFFFF;

// ── Extra-field header ids ───────────────────────────────────────────

export const EXTRA_ZIP64 = 0x0001;
export const EXTRA_UT_TIMESTAMP = 0x5455;      // "UT" extended timestamp
export const EXTRA_UNICODE_PATH = 0x7075;      // "up" Info-ZIP Unicode Path
export const EXTRA_UNIX_UIDGID = 0x7875;       // "ux" Info-ZIP Unix uid/gid

// ── External-attribute bits ──────────────────────────────────────────

export const DOS_ATTR_DIRECTORY = 0x10;
/** Unix file-type mask/values in the high 16 bits of external attributes. */
export const UNIX_TYPE_MASK = 0xF000;
export const UNIX_TYPE_SYMLINK = 0xA000;
