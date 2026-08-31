/**
 * zipnative — CRC-32 (slice-by-8)
 * ===============================
 * ZIP's integrity checksum: polynomial 0xEDB88320 (ISO/IEC 3309),
 * ~1 GB/s in modern JS engines via the slice-by-8 table technique
 * (eight 256-entry Uint32Array tables, 8 KB total).
 *
 * Tables are built lazily on first call and memoized in module scope —
 * computation on demand, never an import side effect.
 *
 * @module codecs/crc32
 */

let _tables: Uint32Array | undefined;

function buildTables(): Uint32Array {
    const t = new Uint32Array(8 * 256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) === 1 ? (0xEDB88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
        }
        t[n] = c;
    }
    for (let n = 0; n < 256; n++) {
        for (let k = 1; k < 8; k++) {
            const prev = t[(k - 1) * 256 + n];
            t[k * 256 + n] = ((prev >>> 8) ^ t[prev & 0xff]) >>> 0;
        }
    }
    return t;
}

/**
 * Compute (or continue) a CRC-32.
 *
 * @param data - Bytes to checksum
 * @param seed - Result of a previous `crc32` call, for incremental
 *               (streaming) computation. Defaults to a fresh CRC.
 * @returns Unsigned 32-bit CRC
 */
export function crc32(data: Uint8Array, seed = 0): number {
    const t = (_tables ??= buildTables());
    let c = ~seed >>> 0;
    let i = 0;
    const len = data.length;

    while (i + 8 <= len) {
        c = (c ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24))) >>> 0;
        const hi = (data[i + 4] | (data[i + 5] << 8) | (data[i + 6] << 16) | (data[i + 7] << 24)) >>> 0;
        c = (t[7 * 256 + (c & 0xff)]
            ^ t[6 * 256 + ((c >>> 8) & 0xff)]
            ^ t[5 * 256 + ((c >>> 16) & 0xff)]
            ^ t[4 * 256 + (c >>> 24)]
            ^ t[3 * 256 + (hi & 0xff)]
            ^ t[2 * 256 + ((hi >>> 8) & 0xff)]
            ^ t[1 * 256 + ((hi >>> 16) & 0xff)]
            ^ t[hi >>> 24]) >>> 0;
        i += 8;
    }
    while (i < len) {
        c = ((c >>> 8) ^ t[(c ^ data[i++]) & 0xff]) >>> 0;
    }
    return ~c >>> 0;
}
