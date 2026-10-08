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
import { EXTRA_NTFS, EXTRA_UNIX_UIDGID, EXTRA_UT_TIMESTAMP, SENTINEL_U16, SENTINEL_U32 } from './zip-constants.js';
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

/**
 * Build a Zip64 (0x0001) extra field carrying exactly the given fields,
 * in spec order (uncompressed size, compressed size, local-header
 * offset). Pass `undefined` for fields whose classic counterpart is NOT
 * the sentinel — the determinism contract emits only overflowed fields
 * (with the one exception that a LFH zip64 extra always carries both
 * sizes together, which the caller expresses by passing both).
 */
export function buildZip64Extra(
    uncompressedSize: number | undefined,
    compressedSize: number | undefined,
    localHeaderOffset: number | undefined,
): Uint8Array {
    const size = (uncompressedSize !== undefined ? 8 : 0)
        + (compressedSize !== undefined ? 8 : 0)
        + (localHeaderOffset !== undefined ? 8 : 0);
    const out = new Uint8Array(4 + size);
    const dv = new DataView(out.buffer);
    dv.setUint16(0, 0x0001, true);
    dv.setUint16(2, size, true);
    let pos = 4;
    if (uncompressedSize !== undefined) {
        dv.setBigUint64(pos, BigInt(uncompressedSize), true);
        pos += 8;
    }
    if (compressedSize !== undefined) {
        dv.setBigUint64(pos, BigInt(compressedSize), true);
        pos += 8;
    }
    if (localHeaderOffset !== undefined) {
        dv.setBigUint64(pos, BigInt(localHeaderOffset), true);
    }
    return out;
}

/**
 * Zip64 treatment for a LOCAL file header whose sizes are known up front
 * (a raw-copied payload can be ≥ 4 GiB: a slice of an existing archive, not
 * a freshly compressed ≤ 2 GiB buffer). APPNOTE §4.5.3: when a local header
 * carries a Zip64 extra it MUST contain BOTH the original and compressed
 * sizes (the emit-only-overflowed-fields rule applies to the central
 * directory only). So: if either size overflows, sentinel both classic
 * fields and put both u64s in the extra. Exported from this module (not
 * from src/index.ts) so the ≥ 4 GiB path is unit-testable without a 4 GiB
 * buffer; shared by the segment generator and the modifier's save().
 */
export function lfhZip64Fields(uncompressedSize: number, compressedSize: number): {
    readonly classicUncompressed: number;
    readonly classicCompressed: number;
    readonly extra: Uint8Array | null;
    readonly usesZip64: boolean;
} {
    const usesZip64 = uncompressedSize > SENTINEL_U32 - 1 || compressedSize > SENTINEL_U32 - 1;
    if (!usesZip64) {
        return { classicUncompressed: uncompressedSize, classicCompressed: compressedSize, extra: null, usesZip64 };
    }
    return {
        classicUncompressed: SENTINEL_U32,
        classicCompressed: SENTINEL_U32,
        extra: buildZip64Extra(uncompressedSize, compressedSize, undefined),
        usesZip64,
    };
}

/** Serialize `{id, data}` extra fields into one block (write-side mirror). */
export function serializeExtraFields(fields: readonly ZipExtraField[]): Uint8Array {
    const total = fields.reduce((sum, f) => sum + 4 + f.data.length, 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    let pos = 0;
    for (const f of fields) {
        dv.setUint16(pos, f.id, true);
        dv.setUint16(pos + 2, f.data.length, true);
        out.set(f.data, pos + 4);
        pos += 4 + f.data.length;
    }
    return out;
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

/** The three Unix timestamps an extra field can carry; absent ones are null. */
export interface ExtraTimestamps {
    readonly mtime: Date | null;
    readonly atime: Date | null;
    readonly ctime: Date | null;
}

/**
 * Every timestamp of the UT (0x5455) extra. The flags byte says which of
 * mtime / atime / ctime follow, each a signed 32-bit Unix time. The
 * central-directory copy usually carries the mtime only (Info-ZIP writes
 * atime/ctime into the local header alone); a truncated block yields what
 * fits and never throws.
 */
export function resolveUtTimestamps(fields: readonly ZipExtraField[]): ExtraTimestamps | null {
    const ut = fields.find((f) => f.id === EXTRA_UT_TIMESTAMP);
    if (ut === undefined || ut.data.length < 1) return null;
    const flags = ut.data[0];
    const dv = viewOf(ut.data);
    let pos = 1;
    const next = (): Date | null => {
        if (pos + 4 > ut.data.length) return null;
        const seconds = dv.getInt32(pos, true);
        pos += 4;
        return new Date(seconds * 1000);
    };
    const mtime = (flags & 0x01) !== 0 ? next() : null;
    const atime = (flags & 0x02) !== 0 ? next() : null;
    const ctime = (flags & 0x04) !== 0 ? next() : null;
    return { mtime, atime, ctime };
}

/** FILETIME (100 ns ticks since 1601-01-01 UTC) → Date; null when out of Date's range. */
function fileTimeToDate(ticks: bigint): Date | null {
    const EPOCH_DIFF_MS = 11644473600000n;
    const ms = ticks / 10000n - EPOCH_DIFF_MS;
    if (ms < -8640000000000000n || ms > 8640000000000000n) return null;
    return new Date(Number(ms));
}

/**
 * The NTFS (0x000a) extra: a reserved u32, then tagged attributes; tag
 * 0x0001 (size 24) carries mtime, atime, ctime as 64-bit FILETIMEs. A
 * malformed or truncated block yields null, never a throw.
 */
export function resolveNtfsTimestamps(fields: readonly ZipExtraField[]): ExtraTimestamps | null {
    const ntfs = fields.find((f) => f.id === EXTRA_NTFS);
    if (ntfs === undefined || ntfs.data.length < 4) return null;
    const dv = viewOf(ntfs.data);
    let pos = 4;
    while (pos + 4 <= ntfs.data.length) {
        const tag = dv.getUint16(pos, true);
        const size = dv.getUint16(pos + 2, true);
        pos += 4;
        if (pos + size > ntfs.data.length) return null;
        if (tag === 0x0001 && size >= 24) {
            return {
                mtime: fileTimeToDate(dv.getBigUint64(pos, true)),
                atime: fileTimeToDate(dv.getBigUint64(pos + 8, true)),
                ctime: fileTimeToDate(dv.getBigUint64(pos + 16, true)),
            };
        }
        pos += size;
    }
    return null;
}

/**
 * The Info-ZIP "ux" (0x7875) extra: version 1, then a sized uid and a
 * sized gid (little-endian, 1–8 bytes each). Values above 2^53 are
 * reported as null; a malformed block yields null, never a throw.
 */
export function resolveUnixIds(fields: readonly ZipExtraField[]): { readonly uid: number; readonly gid: number } | null {
    const ux = fields.find((f) => f.id === EXTRA_UNIX_UIDGID);
    if (ux === undefined || ux.data.length < 3 || ux.data[0] !== 1) return null;
    const readSized = (at: number): { value: number; next: number } | null => {
        if (at >= ux.data.length) return null;
        const size = ux.data[at];
        if (size < 1 || size > 8 || at + 1 + size > ux.data.length) return null;
        let value = 0n;
        for (let i = size - 1; i >= 0; i--) value = (value << 8n) | BigInt(ux.data[at + 1 + i]);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        return { value: Number(value), next: at + 1 + size };
    };
    const uid = readSized(1);
    if (uid === null) return null;
    const gid = readSized(uid.next);
    if (gid === null) return null;
    return { uid: uid.value, gid: gid.value };
}

/** Extract the Unicode Path (0x7075) name, when present and well-formed. */
export function resolveUnicodePath(fields: readonly ZipExtraField[]): Uint8Array | null {
    const up = fields.find((f) => f.id === 0x7075);
    if (up === undefined || up.data.length < 6) return null;
    if (up.data[0] !== 1) return null; // unknown version
    return up.data.subarray(5); // skip version (1) + name CRC (4)
}
