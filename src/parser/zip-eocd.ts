/**
 * zipnative — EOCD discovery and Zip64 resolution
 * ===============================================
 * Policy (§3.1–§3.2 of the design):
 *   - scan BACKWARD from EOF, window capped at 65 557 bytes (a spec bound);
 *   - accept only a SELF-CONSISTENT candidate (pos + 22 + commentLength
 *     === fileLength), the one closest to EOF;
 *   - a signature with no self-consistent candidate → ZipFormatError:
 *     ambiguity is a smuggling primitive, we refuse rather than guess;
 *   - an ADDITIONAL earlier signature in the window → ZIP_MULTIPLE_EOCD
 *     diagnostic (nested zip / earlier revision), not an error;
 *   - prepended data (SFX stubs) shifts every offset by `base` and emits
 *     ZIP_PREPENDED_DATA; negative base is fatal;
 *   - Zip64: sentinels license the 64-bit replacements; the Zip64 EOCD is
 *     cross-checked against every NON-sentinel classic value — divergence
 *     is ZipSecurityError (CWE-1288 parser-differential resistance).
 *
 * @module parser/zip-eocd
 */

import { type ZipDiagnosticEmitter, type ZipLimits } from '../types/zip-types.js';
import { ZipFormatError, ZipSecurityError, ZipUnsupportedError } from '../types/zip-errors.js';
import {
    EOCD_SIZE,
    MAX_EOCD_SCAN,
    SENTINEL_U16,
    SENTINEL_U32,
    SIG_EOCD,
    ZIP64_EOCD_LOCATOR_SIZE,
    ZIP64_EOCD_MIN_SIZE,
} from '../core/zip-constants.js';
import { enforceLimit } from '../core/zip-limits.js';
import { multipleEocdDiagnostic, prependedDataDiagnostic } from '../core/zip-diagnostics.js';
import {
    hasZip64EocdSignature,
    parseEocd,
    parseZip64Eocd,
    parseZip64Locator,
    viewOf,
} from '../core/zip-structs.js';

/** Resolved archive layout: every offset absolute (prepend shift applied). */
export interface ArchiveLayout {
    readonly totalEntries: number;
    readonly cdSize: number;
    /** Absolute file offset of the first central-directory record. */
    readonly cdOffset: number;
    /** Bytes preceding the archive proper (0 for a clean archive). */
    readonly base: number;
    readonly isZip64: boolean;
    /** Raw EOCD comment bytes (zero-copy). */
    readonly comment: Uint8Array;
}

/** Locate and fully resolve the end-of-central-directory structures. */
export function locateEocd(
    bytes: Uint8Array,
    limits: ZipLimits,
    emit: ZipDiagnosticEmitter,
): ArchiveLayout {
    if (bytes.length < EOCD_SIZE) {
        throw new ZipFormatError('ZIP_EOCD_NOT_FOUND', 'zipnative: input too small to be a ZIP archive (< 22 bytes)');
    }
    const dv = viewOf(bytes);
    const scanFloor = Math.max(0, bytes.length - MAX_EOCD_SCAN);

    let eocdPos = -1;
    let sawOtherSignature = false;
    for (let pos = bytes.length - EOCD_SIZE; pos >= scanFloor; pos--) {
        if (dv.getUint32(pos, true) !== SIG_EOCD) continue;
        if (eocdPos === -1) {
            const commentLength = dv.getUint16(pos + 20, true);
            if (pos + EOCD_SIZE + commentLength === bytes.length) {
                eocdPos = pos;
                continue; // keep scanning to detect additional signatures
            }
            // Signature that is not self-consistent: keep looking, but if
            // nothing self-consistent exists at all we refuse (below).
            sawOtherSignature = true;
        } else {
            sawOtherSignature = true;
        }
    }
    if (eocdPos === -1) {
        throw new ZipFormatError('ZIP_EOCD_NOT_FOUND', sawOtherSignature
            ? 'zipnative: an end-of-central-directory signature exists but no candidate is self-consistent '
            + '(trailing garbage after the archive, or a hostile ambiguous file) — refusing to guess; '
            + 'remove the trailing bytes if this archive is trusted'
            : 'zipnative: no end-of-central-directory record found — not a ZIP archive, or truncated');
    }
    if (sawOtherSignature) {
        emit(multipleEocdDiagnostic());
    }

    const eocd = parseEocd(bytes, eocdPos);
    enforceLimit(limits, 'maxCommentBytes', eocd.commentLength, 'archive comment length');

    // ── Zip64 resolution ─────────────────────────────────────────────
    const needsZip64 = eocd.totalEntries === SENTINEL_U16
        || eocd.entriesOnDisk === SENTINEL_U16
        || eocd.cdSize === SENTINEL_U32
        || eocd.cdOffset === SENTINEL_U32
        || eocd.diskNumber === SENTINEL_U16
        || eocd.cdStartDisk === SENTINEL_U16;

    let totalEntries = eocd.totalEntries;
    let entriesOnDisk = eocd.entriesOnDisk;
    let cdSize = eocd.cdSize;
    let cdOffset = eocd.cdOffset;
    let diskNumber = eocd.diskNumber;
    let cdStartDisk = eocd.cdStartDisk;
    let cdEnd = eocdPos;
    let isZip64 = false;

    if (needsZip64) {
        const locatorPos = eocdPos - ZIP64_EOCD_LOCATOR_SIZE;
        const locator = parseZip64Locator(bytes, locatorPos);
        if (locator === null) {
            throw new ZipFormatError('ZIP_ZIP64_LOCATOR_MISSING',
                'zipnative: a zip64 sentinel is set but the zip64 end-of-central-directory locator is missing '
                + '(truncated or corrupt archive)');
        }
        if (locator.totalDisks > 1) {
            throw new ZipUnsupportedError('ZIP_UNSUPPORTED_MULTI_DISK',
                'zipnative: multi-disk (spanned) archives are not supported', 'multi-disk');
        }
        // The locator offset is relative to the original layout; with
        // prepended data it is stale. Try it first, then the position a
        // minimal zip64 EOCD would occupy immediately before the locator.
        let z64Pos = -1;
        if (hasZip64EocdSignature(bytes, locator.eocd64Offset)) {
            z64Pos = locator.eocd64Offset;
        } else if (hasZip64EocdSignature(bytes, locatorPos - ZIP64_EOCD_MIN_SIZE)) {
            z64Pos = locatorPos - ZIP64_EOCD_MIN_SIZE;
        }
        if (z64Pos === -1) {
            throw new ZipFormatError('ZIP_ZIP64_EOCD_MISPLACED',
                'zipnative: the zip64 end-of-central-directory record is not where the locator points '
                + '(corrupt archive, or an unsupported prepended-data layout)');
        }
        const z64 = parseZip64Eocd(bytes, z64Pos);

        // Anti-spoofing cross-check: zip64 may only REPLACE sentinel fields.
        const crossCheck = (classic: number, sentinel: number, z64Value: number, field: string): number => {
            if (classic !== sentinel && classic !== z64Value) {
                throw new ZipSecurityError('ZIP_ZIP64_CONTRADICTION',
                    `zipnative: zip64 ${field} (${z64Value}) contradicts the non-sentinel classic value `
                    + `(${classic}) — parser-differential archives are rejected`);
            }
            return z64Value;
        };
        totalEntries = crossCheck(eocd.totalEntries, SENTINEL_U16, z64.totalEntries, 'total entry count');
        entriesOnDisk = crossCheck(eocd.entriesOnDisk, SENTINEL_U16, z64.entriesOnDisk, 'entries-on-disk count');
        cdSize = crossCheck(eocd.cdSize, SENTINEL_U32, z64.cdSize, 'central-directory size');
        cdOffset = crossCheck(eocd.cdOffset, SENTINEL_U32, z64.cdOffset, 'central-directory offset');
        diskNumber = crossCheck(eocd.diskNumber, SENTINEL_U16, z64.diskNumber, 'disk number');
        cdStartDisk = crossCheck(eocd.cdStartDisk, SENTINEL_U16, z64.cdStartDisk, 'central-directory start disk');
        cdEnd = z64Pos;
        isZip64 = true;
    }

    if (diskNumber !== 0 || cdStartDisk !== 0) {
        throw new ZipUnsupportedError('ZIP_UNSUPPORTED_MULTI_DISK',
            'zipnative: multi-disk (spanned) archives are not supported', 'multi-disk');
    }
    if (entriesOnDisk !== totalEntries) {
        throw new ZipFormatError('ZIP_EOCD_INCONSISTENT',
            'zipnative: entries-on-this-disk differs from total entries on a single-disk archive '
            + '(corrupt or hostile end-of-central-directory record)');
    }

    enforceLimit(limits, 'maxEntries', totalEntries, 'central-directory entry count');
    enforceLimit(limits, 'maxCentralDirectoryBytes', cdSize, 'central-directory size');

    // ── Prepended-data shift ─────────────────────────────────────────
    const base = cdEnd - (cdOffset + cdSize);
    if (base < 0) {
        throw new ZipFormatError('ZIP_EOCD_INCONSISTENT',
            'zipnative: the central directory overlaps the end-of-central-directory record '
            + '(corrupt or hostile archive)');
    }
    if (base > 0) {
        emit(prependedDataDiagnostic(base));
    }

    return {
        totalEntries,
        cdSize,
        cdOffset: cdOffset + base,
        base,
        isZip64,
        comment: eocd.comment,
    };
}
