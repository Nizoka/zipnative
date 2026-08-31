/**
 * zipnative — Fixed-layout record I/O
 * ===================================
 * Pure functions decoding ZIP records over a `DataView`. This is the ONLY
 * module that hand-decodes header bytes (zip-core instructions); everything
 * above works with the returned plain objects.
 *
 * All ZIP integers are little-endian unsigned. 64-bit fields are read via
 * `getBigUint64` and rejected above `Number.MAX_SAFE_INTEGER` — the public
 * API carries `number`, never `bigint`.
 *
 * @module core/zip-structs
 */

import { ZipFormatError } from '../types/zip-errors.js';
import {
    CENTRAL_FILE_HEADER_SIZE,
    EOCD_SIZE,
    LOCAL_FILE_HEADER_SIZE,
    SIG_CENTRAL_FILE_HEADER,
    SIG_DATA_DESCRIPTOR,
    SIG_EOCD,
    SIG_LOCAL_FILE_HEADER,
    SIG_ZIP64_EOCD,
    SIG_ZIP64_EOCD_LOCATOR,
    ZIP64_EOCD_LOCATOR_SIZE,
    ZIP64_EOCD_MIN_SIZE,
} from './zip-constants.js';

/** DataView over exactly the bytes of a (possibly offset) Uint8Array view. */
export function viewOf(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Convert a u64 field to a safe JS number, or throw with the field name. */
export function toSafeNumber(value: bigint, field: string): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new ZipFormatError(
            `zipnative: ${field} is ${value}, beyond Number.MAX_SAFE_INTEGER — archives this large are not supported`);
    }
    return Number(value);
}

// ── End of central directory ─────────────────────────────────────────

export interface EocdRecord {
    readonly diskNumber: number;
    readonly cdStartDisk: number;
    readonly entriesOnDisk: number;
    readonly totalEntries: number;
    readonly cdSize: number;
    readonly cdOffset: number;
    readonly commentLength: number;
    /** Zero-copy view of the comment bytes. */
    readonly comment: Uint8Array;
}

/** Parse the classic EOCD record at `pos`. Caller has verified the signature. */
export function parseEocd(bytes: Uint8Array, pos: number): EocdRecord {
    if (pos + EOCD_SIZE > bytes.length) {
        throw new ZipFormatError('zipnative: end-of-central-directory record truncated');
    }
    const dv = viewOf(bytes);
    if (dv.getUint32(pos, true) !== SIG_EOCD) {
        throw new ZipFormatError('zipnative: end-of-central-directory signature missing at expected offset');
    }
    const commentLength = dv.getUint16(pos + 20, true);
    return {
        diskNumber: dv.getUint16(pos + 4, true),
        cdStartDisk: dv.getUint16(pos + 6, true),
        entriesOnDisk: dv.getUint16(pos + 8, true),
        totalEntries: dv.getUint16(pos + 10, true),
        cdSize: dv.getUint32(pos + 12, true),
        cdOffset: dv.getUint32(pos + 16, true),
        commentLength,
        comment: bytes.subarray(pos + EOCD_SIZE, pos + EOCD_SIZE + commentLength),
    };
}

// ── Zip64 EOCD locator + record ──────────────────────────────────────

export interface Zip64Locator {
    readonly eocd64Disk: number;
    readonly eocd64Offset: number;
    readonly totalDisks: number;
}

/** Parse the Zip64 EOCD locator at `pos`, or return null if no signature. */
export function parseZip64Locator(bytes: Uint8Array, pos: number): Zip64Locator | null {
    if (pos < 0 || pos + ZIP64_EOCD_LOCATOR_SIZE > bytes.length) return null;
    const dv = viewOf(bytes);
    if (dv.getUint32(pos, true) !== SIG_ZIP64_EOCD_LOCATOR) return null;
    return {
        eocd64Disk: dv.getUint32(pos + 4, true),
        eocd64Offset: toSafeNumber(dv.getBigUint64(pos + 8, true), 'zip64 EOCD locator offset'),
        totalDisks: dv.getUint32(pos + 16, true),
    };
}

export interface Zip64EocdRecord {
    readonly versionMadeBy: number;
    readonly versionNeeded: number;
    readonly diskNumber: number;
    readonly cdStartDisk: number;
    readonly entriesOnDisk: number;
    readonly totalEntries: number;
    readonly cdSize: number;
    readonly cdOffset: number;
}

/** Check for the Zip64 EOCD signature at `pos`. */
export function hasZip64EocdSignature(bytes: Uint8Array, pos: number): boolean {
    if (pos < 0 || pos + 4 > bytes.length) return false;
    return viewOf(bytes).getUint32(pos, true) === SIG_ZIP64_EOCD;
}

/** Parse the Zip64 EOCD record at `pos`. Caller has verified the signature. */
export function parseZip64Eocd(bytes: Uint8Array, pos: number): Zip64EocdRecord {
    if (pos + ZIP64_EOCD_MIN_SIZE > bytes.length) {
        throw new ZipFormatError('zipnative: zip64 end-of-central-directory record truncated');
    }
    const dv = viewOf(bytes);
    return {
        versionMadeBy: dv.getUint16(pos + 12, true),
        versionNeeded: dv.getUint16(pos + 14, true),
        diskNumber: dv.getUint32(pos + 16, true),
        cdStartDisk: dv.getUint32(pos + 20, true),
        entriesOnDisk: toSafeNumber(dv.getBigUint64(pos + 24, true), 'zip64 entries-on-disk'),
        totalEntries: toSafeNumber(dv.getBigUint64(pos + 32, true), 'zip64 total entries'),
        cdSize: toSafeNumber(dv.getBigUint64(pos + 40, true), 'zip64 central-directory size'),
        cdOffset: toSafeNumber(dv.getBigUint64(pos + 48, true), 'zip64 central-directory offset'),
    };
}

// ── Central file header ──────────────────────────────────────────────

export interface CentralFileHeader {
    readonly versionMadeBy: number;
    readonly versionNeeded: number;
    readonly flags: number;
    readonly compressionMethod: number;
    readonly dosTime: number;
    readonly dosDate: number;
    readonly crc32: number;
    /** May be the 0xFFFFFFFF sentinel — resolved against the zip64 extra by the caller. */
    readonly compressedSize: number;
    readonly uncompressedSize: number;
    readonly diskNumberStart: number;
    readonly internalAttributes: number;
    readonly externalAttributes: number;
    /** May be the 0xFFFFFFFF sentinel. */
    readonly localHeaderOffset: number;
    readonly name: Uint8Array;
    readonly extra: Uint8Array;
    readonly comment: Uint8Array;
    /** Total record length including variable tails — advance by this. */
    readonly recordLength: number;
}

/** Parse one central-directory file header at `pos`. */
export function parseCentralFileHeader(bytes: Uint8Array, pos: number): CentralFileHeader {
    if (pos + CENTRAL_FILE_HEADER_SIZE > bytes.length) {
        throw new ZipFormatError('zipnative: central-directory file header truncated');
    }
    const dv = viewOf(bytes);
    if (dv.getUint32(pos, true) !== SIG_CENTRAL_FILE_HEADER) {
        throw new ZipFormatError('zipnative: central-directory file header signature missing (corrupt central directory)');
    }
    const nameLength = dv.getUint16(pos + 28, true);
    const extraLength = dv.getUint16(pos + 30, true);
    const commentLength = dv.getUint16(pos + 32, true);
    const recordLength = CENTRAL_FILE_HEADER_SIZE + nameLength + extraLength + commentLength;
    if (pos + recordLength > bytes.length) {
        throw new ZipFormatError('zipnative: central-directory file header variable fields truncated');
    }
    const nameStart = pos + CENTRAL_FILE_HEADER_SIZE;
    return {
        versionMadeBy: dv.getUint16(pos + 4, true),
        versionNeeded: dv.getUint16(pos + 6, true),
        flags: dv.getUint16(pos + 8, true),
        compressionMethod: dv.getUint16(pos + 10, true),
        dosTime: dv.getUint16(pos + 12, true),
        dosDate: dv.getUint16(pos + 14, true),
        crc32: dv.getUint32(pos + 16, true),
        compressedSize: dv.getUint32(pos + 20, true),
        uncompressedSize: dv.getUint32(pos + 24, true),
        diskNumberStart: dv.getUint16(pos + 34, true),
        internalAttributes: dv.getUint16(pos + 36, true),
        externalAttributes: dv.getUint32(pos + 38, true),
        localHeaderOffset: dv.getUint32(pos + 42, true),
        name: bytes.subarray(nameStart, nameStart + nameLength),
        extra: bytes.subarray(nameStart + nameLength, nameStart + nameLength + extraLength),
        comment: bytes.subarray(nameStart + nameLength + extraLength, pos + recordLength),
        recordLength,
    };
}

// ── Local file header ────────────────────────────────────────────────

export interface LocalFileHeader {
    readonly versionNeeded: number;
    readonly flags: number;
    readonly compressionMethod: number;
    readonly dosTime: number;
    readonly dosDate: number;
    readonly crc32: number;
    readonly compressedSize: number;
    readonly uncompressedSize: number;
    readonly name: Uint8Array;
    readonly extra: Uint8Array;
    /** Offset of the entry data: header position + fixed size + variable tails. */
    readonly dataStart: number;
}

// ── Record writers (M2) ──────────────────────────────────────────────
// Pure functions, symmetric to the parsers above. Field values may be
// Zip64 sentinels — the BUILDER decides sentinels and extra fields; these
// functions only lay out bytes.

export interface LocalHeaderFields {
    readonly versionNeeded: number;
    readonly flags: number;
    readonly compressionMethod: number;
    readonly dosTime: number;
    readonly dosDate: number;
    readonly crc32: number;
    readonly compressedSize: number;
    readonly uncompressedSize: number;
    readonly name: Uint8Array;
    readonly extra: Uint8Array;
}

/** Serialize a local file header (30 bytes + name + extra). */
export function writeLocalFileHeader(f: LocalHeaderFields): Uint8Array {
    const out = new Uint8Array(LOCAL_FILE_HEADER_SIZE + f.name.length + f.extra.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, SIG_LOCAL_FILE_HEADER, true);
    dv.setUint16(4, f.versionNeeded, true);
    dv.setUint16(6, f.flags, true);
    dv.setUint16(8, f.compressionMethod, true);
    dv.setUint16(10, f.dosTime, true);
    dv.setUint16(12, f.dosDate, true);
    dv.setUint32(14, f.crc32 >>> 0, true);
    dv.setUint32(18, f.compressedSize >>> 0, true);
    dv.setUint32(22, f.uncompressedSize >>> 0, true);
    dv.setUint16(26, f.name.length, true);
    dv.setUint16(28, f.extra.length, true);
    out.set(f.name, LOCAL_FILE_HEADER_SIZE);
    out.set(f.extra, LOCAL_FILE_HEADER_SIZE + f.name.length);
    return out;
}

/**
 * Serialize a data descriptor (with the PK\x07\x08 signature). 8-byte
 * sizes are the Zip64 form — only when the entry's sizes overflowed.
 */
export function writeDataDescriptor(crc: number, compressedSize: number, uncompressedSize: number, zip64: boolean): Uint8Array {
    const out = new Uint8Array(zip64 ? 24 : 16);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, SIG_DATA_DESCRIPTOR, true);
    dv.setUint32(4, crc >>> 0, true);
    if (zip64) {
        dv.setBigUint64(8, BigInt(compressedSize), true);
        dv.setBigUint64(16, BigInt(uncompressedSize), true);
    } else {
        dv.setUint32(8, compressedSize >>> 0, true);
        dv.setUint32(12, uncompressedSize >>> 0, true);
    }
    return out;
}

export interface CentralHeaderFields extends LocalHeaderFields {
    readonly versionMadeBy: number;
    readonly internalAttributes: number;
    readonly externalAttributes: number;
    readonly localHeaderOffset: number;
    readonly comment: Uint8Array;
}

/** Serialize a central-directory file header (46 bytes + variable tails). */
export function writeCentralFileHeader(f: CentralHeaderFields): Uint8Array {
    const out = new Uint8Array(CENTRAL_FILE_HEADER_SIZE + f.name.length + f.extra.length + f.comment.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, SIG_CENTRAL_FILE_HEADER, true);
    dv.setUint16(4, f.versionMadeBy, true);
    dv.setUint16(6, f.versionNeeded, true);
    dv.setUint16(8, f.flags, true);
    dv.setUint16(10, f.compressionMethod, true);
    dv.setUint16(12, f.dosTime, true);
    dv.setUint16(14, f.dosDate, true);
    dv.setUint32(16, f.crc32 >>> 0, true);
    dv.setUint32(20, f.compressedSize >>> 0, true);
    dv.setUint32(24, f.uncompressedSize >>> 0, true);
    dv.setUint16(28, f.name.length, true);
    dv.setUint16(30, f.extra.length, true);
    dv.setUint16(32, f.comment.length, true);
    dv.setUint16(34, 0, true); // disk number start
    dv.setUint16(36, f.internalAttributes, true);
    dv.setUint32(38, f.externalAttributes >>> 0, true);
    dv.setUint32(42, f.localHeaderOffset >>> 0, true);
    let pos = CENTRAL_FILE_HEADER_SIZE;
    out.set(f.name, pos);
    pos += f.name.length;
    out.set(f.extra, pos);
    pos += f.extra.length;
    out.set(f.comment, pos);
    return out;
}

/** Serialize the classic EOCD record. Fields may carry Zip64 sentinels. */
export function writeEocd(totalEntries: number, cdSize: number, cdOffset: number, comment: Uint8Array): Uint8Array {
    const out = new Uint8Array(EOCD_SIZE + comment.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, SIG_EOCD, true);
    dv.setUint16(4, 0, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, totalEntries, true);
    dv.setUint16(10, totalEntries, true);
    dv.setUint32(12, cdSize >>> 0, true);
    dv.setUint32(16, cdOffset >>> 0, true);
    dv.setUint16(20, comment.length, true);
    out.set(comment, EOCD_SIZE);
    return out;
}

/** Serialize the Zip64 EOCD record (fixed 56-byte form, no extensible data). */
export function writeZip64Eocd(totalEntries: number, cdSize: number, cdOffset: number): Uint8Array {
    const out = new Uint8Array(ZIP64_EOCD_MIN_SIZE);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, SIG_ZIP64_EOCD, true);
    dv.setBigUint64(4, 44n, true); // size of the remainder of this record
    dv.setUint16(12, 0x032D, true); // version made by: Unix, spec 4.5
    dv.setUint16(14, 45, true);     // version needed
    dv.setUint32(16, 0, true);
    dv.setUint32(20, 0, true);
    dv.setBigUint64(24, BigInt(totalEntries), true);
    dv.setBigUint64(32, BigInt(totalEntries), true);
    dv.setBigUint64(40, BigInt(cdSize), true);
    dv.setBigUint64(48, BigInt(cdOffset), true);
    return out;
}

/** Serialize the Zip64 EOCD locator. */
export function writeZip64Locator(zip64EocdOffset: number): Uint8Array {
    const out = new Uint8Array(ZIP64_EOCD_LOCATOR_SIZE);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, SIG_ZIP64_EOCD_LOCATOR, true);
    dv.setUint32(4, 0, true);
    dv.setBigUint64(8, BigInt(zip64EocdOffset), true);
    dv.setUint32(16, 1, true);
    return out;
}

/** Parse the local file header at `pos`. */
export function parseLocalFileHeader(bytes: Uint8Array, pos: number): LocalFileHeader {
    if (pos + LOCAL_FILE_HEADER_SIZE > bytes.length) {
        throw new ZipFormatError('zipnative: local file header truncated');
    }
    const dv = viewOf(bytes);
    if (dv.getUint32(pos, true) !== SIG_LOCAL_FILE_HEADER) {
        throw new ZipFormatError(
            'zipnative: no local file header at the offset the central directory declares '
            + '(corrupt or hostile archive)');
    }
    const nameLength = dv.getUint16(pos + 26, true);
    const extraLength = dv.getUint16(pos + 28, true);
    const nameStart = pos + LOCAL_FILE_HEADER_SIZE;
    const dataStart = nameStart + nameLength + extraLength;
    if (dataStart > bytes.length) {
        throw new ZipFormatError('zipnative: local file header variable fields truncated');
    }
    return {
        versionNeeded: dv.getUint16(pos + 4, true),
        flags: dv.getUint16(pos + 6, true),
        compressionMethod: dv.getUint16(pos + 8, true),
        dosTime: dv.getUint16(pos + 10, true),
        dosDate: dv.getUint16(pos + 12, true),
        crc32: dv.getUint32(pos + 14, true),
        compressedSize: dv.getUint32(pos + 18, true),
        uncompressedSize: dv.getUint32(pos + 22, true),
        name: bytes.subarray(nameStart, nameStart + nameLength),
        extra: bytes.subarray(nameStart + nameLength, dataStart),
        dataStart,
    };
}
