/**
 * zipnative — Extra-field parsing
 * ===============================
 * Extra fields are a sequence of `{ u16 id, u16 size, bytes }` blocks in
 * both central and local headers. Policy (§3.5 of the design):
 *   - ALL fields are preserved raw on the entry (zero-copy subarrays);
 *   - interpreted on read: 0x0001 (Zip64), 0x5455 (UT timestamps),
 *     0x7075 (Unicode Path — inspected, never acted on);
 *   - a field overrunning its declared length is skipped (the caller
 *     emits ZIP_EXTRA_FIELD_MALFORMED).
 *
 * @module core/zip-extra-fields
 */

import { type ZipExtraField } from '../types/zip-types.js';
import { SENTINEL_U16, SENTINEL_U32 } from './zip-constants.js';
import { toSafeNumber, viewOf } from './zip-structs.js';

/** Parse an extra-field block into raw `{id, data}` pairs. */
export function parseExtraFields(extra: Uint8Array): { fields: ZipExtraField[]; malformed: boolean } {
    const fields: ZipExtraField[] = [];
    const dv = viewOf(extra);
    let pos = 0;
    let malformed = false;
    while (pos + 4 <= extra.length) {
        const id = dv.getUint16(pos, true);
        const size = dv.getUint16(pos + 2, true);
        if (pos + 4 + size > extra.length) {
            malformed = true;
            break;
        }
        fields.push({ id, data: extra.subarray(pos + 4, pos + 4 + size) });
        pos += 4 + size;
    }
    // Leaving the loop without a break means 1–3 trailing bytes — too short
    // for a header. Tolerated as padding (seen in the wild), not flagged.
    return { fields, malformed };
}

/** Zip64-resolved sizes/offset for one central-directory entry. */
export interface Zip64Resolution {
    readonly uncompressedSize: number;
    readonly compressedSize: number;
    readonly localHeaderOffset: number;
    readonly diskNumberStart: number;
    readonly usesZip64: boolean;
    /** True when the extra supplied a value for a NON-sentinel field (spoof attempt). */
    readonly suppliedNonSentinel: boolean;
}

/**
 * Resolve Zip64 (0x0001) values against the classic header fields.
 * Spec order inside the extra: uncompressed size, compressed size, local
 * header offset, disk start — each PRESENT ONLY IF its classic counterpart
 * is the sentinel. A conforming reader must therefore walk the extra in
 * lock-step with the sentinel pattern; extras that supply more than the
 * sentinels license are reported (spoof-resistant reading, CWE-1288).
 */
export function resolveZip64(
    fields: readonly ZipExtraField[],
    classic: {
        readonly uncompressedSize: number;
        readonly compressedSize: number;
        readonly localHeaderOffset: number;
        readonly diskNumberStart: number;
    },
): Zip64Resolution {
    const zip64 = fields.find((f) => f.id === 0x0001);
    let { uncompressedSize, compressedSize, localHeaderOffset, diskNumberStart } = classic;
    let usesZip64 = false;
    let suppliedNonSentinel = false;

    if (zip64 !== undefined) {
        const dv = viewOf(zip64.data);
        let pos = 0;
        const need = (sentinel: boolean, bytes: number): boolean => {
            if (!sentinel) return false;
            return pos + bytes <= zip64.data.length;
        };
        if (classic.uncompressedSize === SENTINEL_U32) {
            if (need(true, 8)) {
                uncompressedSize = toSafeNumber(dv.getBigUint64(pos, true), 'zip64 uncompressed size');
                usesZip64 = true;
            }
            pos += 8;
        }
        if (classic.compressedSize === SENTINEL_U32) {
            if (need(true, 8)) {
                compressedSize = toSafeNumber(dv.getBigUint64(pos, true), 'zip64 compressed size');
                usesZip64 = true;
            }
            pos += 8;
        }
        if (classic.localHeaderOffset === SENTINEL_U32) {
            if (need(true, 8)) {
                localHeaderOffset = toSafeNumber(dv.getBigUint64(pos, true), 'zip64 local-header offset');
                usesZip64 = true;
            }
            pos += 8;
        }
        if (classic.diskNumberStart === SENTINEL_U16) {
            if (pos + 4 <= zip64.data.length) {
                diskNumberStart = dv.getUint32(pos, true);
                usesZip64 = true;
            }
            pos += 4;
        }
        // Data beyond what the sentinel pattern licenses = spoof attempt or
        // a producer writing unconditionally; either way, report it.
        if (zip64.data.length > pos) {
            suppliedNonSentinel = true;
        }
    }

    return { uncompressedSize, compressedSize, localHeaderOffset, diskNumberStart, usesZip64, suppliedNonSentinel };
}

/** Extract the UT (0x5455) modification time, when present, as a Date. */
export function resolveUtMtime(fields: readonly ZipExtraField[]): Date | null {
    const ut = fields.find((f) => f.id === 0x5455);
    if (ut === undefined || ut.data.length < 5) return null;
    const flags = ut.data[0];
    if ((flags & 0x01) === 0) return null; // no mtime present
    const dv = viewOf(ut.data);
    const seconds = dv.getInt32(1, true); // signed Unix time per the UT spec
    return new Date(seconds * 1000);
}

/** Extract the Unicode Path (0x7075) name, when present and well-formed. */
export function resolveUnicodePath(fields: readonly ZipExtraField[]): Uint8Array | null {
    const up = fields.find((f) => f.id === 0x7075);
    if (up === undefined || up.data.length < 6) return null;
    if (up.data[0] !== 1) return null; // unknown version
    return up.data.subarray(5); // skip version (1) + name CRC (4)
}
