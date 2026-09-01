/**
 * Raw byte-level ZIP builder — the anti-circularity cornerstone.
 * ==============================================================
 * Writes headers by hand, ENGINE-INDEPENDENT: it never imports zipnative
 * internals, and its deflate/CRC come from node:zlib (a foreign
 * implementation). Attack shapes are crafted via per-entry and per-archive
 * overrides. Deterministic given identical specs — nothing is committed.
 */
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib';

export interface RawEntrySpec {
    readonly name: string | Uint8Array;
    readonly data?: Uint8Array;
    /** 0 = store (default), 8 = deflate (compressed via node:zlib). */
    readonly method?: number;
    readonly flags?: number;
    readonly dosTime?: number;
    readonly dosDate?: number;
    readonly extraLocal?: Uint8Array;
    readonly extraCentral?: Uint8Array;
    readonly comment?: Uint8Array;
    readonly externalAttributes?: number;
    readonly versionMadeBy?: number;
    // ── Attack overrides (central directory) ─────────────────────────
    readonly crcOverride?: number;
    readonly compressedSizeOverride?: number;
    readonly uncompressedSizeOverride?: number;
    readonly localHeaderOffsetOverride?: number;
    // ── Attack overrides (local header) ──────────────────────────────
    readonly lfhMethodOverride?: number;
    readonly lfhCrcOverride?: number;
    readonly lfhNameOverride?: Uint8Array;
    /** Corrupt the stored compressed payload after compression. */
    readonly corruptDataAt?: number;
    /**
     * Append a data descriptor after the payload; sets flag bit 3 and
     * zeroes the LFH crc/size fields. The CD keeps the REAL values
     * (spec-correct), so openZip() remains the differential oracle.
     */
    readonly dataDescriptor?: 'signed' | 'signless' | 'signed64' | 'signless64';
    // ── Attack overrides (descriptor fields) ─────────────────────────
    readonly descriptorCrcOverride?: number;
    readonly descriptorCompressedSizeOverride?: number;
    readonly descriptorUncompressedSizeOverride?: number;
}

export interface RawZipOptions {
    readonly comment?: Uint8Array;
    /** Bytes before the archive (SFX-stub simulation; stored offsets stay inner-relative). */
    readonly prepend?: Uint8Array;
    /** Bytes after the EOCD+comment (trailing-garbage simulation). */
    readonly append?: Uint8Array;
    /** Emit zip64 EOCD + locator with sentinel classic fields. */
    readonly forceZip64?: boolean;
    // ── Attack overrides (EOCD) ──────────────────────────────────────
    readonly totalEntriesOverride?: number;
    readonly cdSizeOverride?: number;
    readonly cdOffsetOverride?: number;
    // ── Attack overrides (zip64 EOCD, applied with forceZip64) ───────
    readonly zip64TotalEntriesOverride?: number;
    /** Omit the zip64 EOCD record while keeping sentinels + locator. */
    readonly zip64DropRecord?: boolean;
}

const te = new TextEncoder();

function nameBytes(name: string | Uint8Array): Uint8Array {
    return typeof name === 'string' ? te.encode(name) : name;
}

function u16(view: DataView, pos: number, value: number): void {
    view.setUint16(pos, value, true);
}
function u32(view: DataView, pos: number, value: number): void {
    view.setUint32(pos, value >>> 0, true);
}

/** Build a complete ZIP archive from raw specs. */
export function buildRawZip(entries: readonly RawEntrySpec[], options: RawZipOptions = {}): Uint8Array {
    const parts: Uint8Array[] = [];
    let offset = 0;
    const centralRecords: Uint8Array[] = [];

    for (const spec of entries) {
        const name = nameBytes(spec.name);
        const data = spec.data ?? new Uint8Array(0);
        const method = spec.method ?? 0;
        const stored = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
        if (spec.corruptDataAt !== undefined && stored.length > spec.corruptDataAt) {
            stored[spec.corruptDataAt] ^= 0xff;
        }
        const crc = spec.crcOverride ?? zlibCrc32(data);
        const descriptorForm = spec.dataDescriptor;
        const flags = (spec.flags ?? 0) | (descriptorForm !== undefined ? 0x0008 : 0);
        const dosTime = spec.dosTime ?? 0;
        const dosDate = spec.dosDate ?? 0x0021;
        const extraLocal = spec.extraLocal ?? new Uint8Array(0);
        const extraCentral = spec.extraCentral ?? new Uint8Array(0);
        const comment = spec.comment ?? new Uint8Array(0);

        const lfhName = spec.lfhNameOverride ?? name;
        const lfh = new Uint8Array(30 + lfhName.length + extraLocal.length);
        const lv = new DataView(lfh.buffer);
        u32(lv, 0, 0x04034b50);
        u16(lv, 4, 20);
        u16(lv, 6, flags);
        u16(lv, 8, spec.lfhMethodOverride ?? method);
        u16(lv, 10, dosTime);
        u16(lv, 12, dosDate);
        u32(lv, 14, descriptorForm !== undefined ? 0 : (spec.lfhCrcOverride ?? crc));
        u32(lv, 18, descriptorForm !== undefined ? 0 : stored.length);
        u32(lv, 22, descriptorForm !== undefined ? 0 : data.length);
        u16(lv, 26, lfhName.length);
        u16(lv, 28, extraLocal.length);
        lfh.set(lfhName, 30);
        lfh.set(extraLocal, 30 + lfhName.length);

        const cfh = new Uint8Array(46 + name.length + extraCentral.length + comment.length);
        const cv = new DataView(cfh.buffer);
        u32(cv, 0, 0x02014b50);
        u16(cv, 4, spec.versionMadeBy ?? 0x031e);
        u16(cv, 6, 20);
        u16(cv, 8, flags);
        u16(cv, 10, method);
        u16(cv, 12, dosTime);
        u16(cv, 14, dosDate);
        u32(cv, 16, crc);
        u32(cv, 20, spec.compressedSizeOverride ?? stored.length);
        u32(cv, 24, spec.uncompressedSizeOverride ?? data.length);
        u16(cv, 28, name.length);
        u16(cv, 30, extraCentral.length);
        u16(cv, 32, comment.length);
        u16(cv, 34, 0);
        u16(cv, 36, 0);
        u32(cv, 38, spec.externalAttributes ?? 0);
        u32(cv, 42, spec.localHeaderOffsetOverride ?? offset);
        cfh.set(name, 46);
        cfh.set(extraCentral, 46 + name.length);
        cfh.set(comment, 46 + name.length + extraCentral.length);
        centralRecords.push(cfh);

        parts.push(lfh, stored);
        offset += lfh.length + stored.length;

        if (descriptorForm !== undefined) {
            const dCrc = spec.descriptorCrcOverride ?? crc;
            const dCsize = spec.descriptorCompressedSizeOverride ?? stored.length;
            const dUsize = spec.descriptorUncompressedSizeOverride ?? data.length;
            const signed = descriptorForm.startsWith('signed');
            const wide = descriptorForm.endsWith('64');
            const descriptor = new Uint8Array((signed ? 4 : 0) + 4 + (wide ? 16 : 8));
            const dvd = new DataView(descriptor.buffer);
            let pos = 0;
            if (signed) {
                u32(dvd, 0, 0x08074b50);
                pos = 4;
            }
            u32(dvd, pos, dCrc);
            if (wide) {
                dvd.setBigUint64(pos + 4, BigInt(dCsize), true);
                dvd.setBigUint64(pos + 12, BigInt(dUsize), true);
            } else {
                u32(dvd, pos + 4, dCsize);
                u32(dvd, pos + 8, dUsize);
            }
            parts.push(descriptor);
            offset += descriptor.length;
        }
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const record of centralRecords) {
        parts.push(record);
        cdSize += record.length;
        offset += record.length;
    }

    const comment = options.comment ?? new Uint8Array(0);
    const totalEntries = options.totalEntriesOverride ?? entries.length;
    const cdSizeField = options.cdSizeOverride ?? cdSize;
    const cdOffsetField = options.cdOffsetOverride ?? cdOffset;

    if (options.forceZip64 === true) {
        const z64Pos = offset;
        if (options.zip64DropRecord !== true) {
            const z64 = new Uint8Array(56);
            const zv = new DataView(z64.buffer);
            u32(zv, 0, 0x06064b50);
            zv.setBigUint64(4, 44n, true);            // size of remainder
            u16(zv, 12, 0x032d);
            u16(zv, 14, 45);
            u32(zv, 16, 0);
            u32(zv, 20, 0);
            zv.setBigUint64(24, BigInt(options.zip64TotalEntriesOverride ?? totalEntries), true);
            zv.setBigUint64(32, BigInt(options.zip64TotalEntriesOverride ?? totalEntries), true);
            zv.setBigUint64(40, BigInt(cdSizeField), true);
            zv.setBigUint64(48, BigInt(cdOffsetField), true);
            parts.push(z64);
            offset += 56;
        }
        const locator = new Uint8Array(20);
        const lv2 = new DataView(locator.buffer);
        u32(lv2, 0, 0x07064b50);
        u32(lv2, 4, 0);
        lv2.setBigUint64(8, BigInt(z64Pos), true);
        u32(lv2, 16, 1);
        parts.push(locator);
        offset += 20;
    }

    const eocd = new Uint8Array(22 + comment.length);
    const ev = new DataView(eocd.buffer);
    u32(ev, 0, 0x06054b50);
    u16(ev, 4, 0);
    u16(ev, 6, 0);
    const sentinel = options.forceZip64 === true;
    u16(ev, 8, sentinel ? 0xFFFF : totalEntries);
    u16(ev, 10, sentinel ? 0xFFFF : totalEntries);
    u32(ev, 12, sentinel ? 0xFFFFFFFF : cdSizeField);
    u32(ev, 16, sentinel ? 0xFFFFFFFF : cdOffsetField);
    u16(ev, 20, comment.length);
    eocd.set(comment, 22);
    parts.push(eocd);

    // Assemble: prepend + inner archive (inner-relative offsets) + append.
    const prepend = options.prepend ?? new Uint8Array(0);
    const append = options.append ?? new Uint8Array(0);
    const innerLength = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(prepend.length + innerLength + append.length);
    out.set(prepend, 0);
    let pos = prepend.length;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    out.set(append, pos);
    return out;
}

/** Build an extra-field block from `{id, data}` pairs. */
export function buildExtraField(fields: ReadonlyArray<{ id: number; data: Uint8Array }>): Uint8Array {
    const total = fields.reduce((sum, f) => sum + 4 + f.data.length, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let pos = 0;
    for (const f of fields) {
        view.setUint16(pos, f.id, true);
        view.setUint16(pos + 2, f.data.length, true);
        out.set(f.data, pos + 4);
        pos += 4 + f.data.length;
    }
    return out;
}

/** Deterministic PRNG for seeded corruption tests (mulberry32). */
export function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
