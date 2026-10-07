/**
 * zipnative — Per-entry defences shared by the readers
 * ====================================================
 * The in-memory reader (`openZip`) and the byte-range reader
 * (`openZipRange`, 1.1.0) run the SAME checks on an entry before a byte of
 * its payload is decoded: the declared-size and ratio limits, the overlap
 * defence (CWE-405), the local-header cross-check against the central
 * directory (the divergence table in parser/zip-reader.ts), and the
 * decompressed-output check (size, CRC-32). One implementation here, so
 * the two readers cannot drift apart — a validator with two parsers is two
 * validators.
 *
 * @module parser/zip-entry-checks
 */

import type { ZipDiagnosticEmitter, ZipEntry, ZipLimits } from '../types/zip-types.js';
import { ZipDataError, ZipFormatError, ZipSecurityError } from '../types/zip-errors.js';
import { crc32 } from '../codecs/crc32.js';
import { FLAG_DATA_DESCRIPTOR } from '../core/zip-constants.js';
import { nameMismatchDiagnostic } from '../core/zip-diagnostics.js';
import { bytesEqual } from '../core/zip-encoding.js';
import { enforceLimit } from '../core/zip-limits.js';
import type { LocalFileHeader } from '../core/zip-structs.js';

/** The declared-size bounds (untrusted values — the output is ALSO counted). */
export function enforceDeclaredSizes(limits: ZipLimits, entry: ZipEntry): void {
    enforceLimit(limits, 'maxEntryUncompressedSize', entry.uncompressedSize, `entry '${entry.name}' declared size`);
    if (entry.compressedSize >= 1024 && entry.compressedSize > 0) {
        const ratio = entry.uncompressedSize / entry.compressedSize;
        enforceLimit(limits, 'maxCompressionRatio', ratio, `entry '${entry.name}' compression ratio`);
    }
}

/**
 * Bytes a trailing data descriptor adds to an entry's region: the minimal
 * signless form (12) suffices for the boundary check — crossing the NEXT
 * header start is what matters.
 */
export function descriptorSlack(lfh: LocalFileHeader): number {
    return (lfh.flags & FLAG_DATA_DESCRIPTOR) !== 0 ? 12 : 0;
}

/**
 * Overlap defence (CWE-405, payload-sharing smuggling) at O(log n) per
 * read: the central directory alone yields the sorted start boundaries of
 * every entry region (plus the CD itself). An entry's REAL extent — known
 * once its local header is parsed at read time — must fit entirely before
 * the next boundary. Duplicate header offsets (two entries claiming one
 * region) are rejected outright. Boundaries build on first use.
 */
export function createExtentChecker(
    entries: () => readonly ZipEntry[],
    cdOffset: number,
    fileLength: number,
): (entry: ZipEntry, dataEnd: number) => void {
    let boundaries: number[] | undefined;
    const ensureBoundaries = (): number[] => {
        if (boundaries === undefined) {
            const sorted = entries().map((e) => e.localHeaderOffset);
            sorted.push(cdOffset);
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
    return (entry: ZipEntry, dataEnd: number): void => {
        if (dataEnd > fileLength) {
            throw new ZipFormatError('ZIP_RECORD_TRUNCATED',
                `zipnative: entry '${entry.name}' data extends past the end of the archive (truncated or corrupt)`);
        }
        if (entry.localHeaderOffset >= cdOffset) {
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
        const nextBoundary = lo < sorted.length ? sorted[lo] : fileLength;
        if (dataEnd > nextBoundary) {
            throw new ZipSecurityError('ZIP_ENTRY_OVERLAP',
                `zipnative: entry '${entry.name}' extends into another entry or the central directory — `
                + 'overlapping-entry archives are rejected (decompression-bomb/smuggling shape)',
                entry.name);
        }
    };
}

/**
 * The central-vs-local divergence policy: method divergence is fatal
 * (`ZIP_CD_LFH_MISMATCH`), size/CRC divergence without bit 3 is fatal
 * (`ZIP_SIZE_MISMATCH`, the Zip64 sentinel form tolerated), a name
 * divergence is a diagnostic (the central directory wins).
 */
export function crossCheckLocalHeader(entry: ZipEntry, lfh: LocalFileHeader, emit: ZipDiagnosticEmitter): void {
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
}

/** The decompressed bytes must match the declared size and (unless waived) the CRC-32. */
export function checkDecompressedOutput(entry: ZipEntry, out: Uint8Array, verifyCrc: boolean): void {
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
}
