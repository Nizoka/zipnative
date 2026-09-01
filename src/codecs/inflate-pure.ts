/**
 * zipnative — Pure-TS raw DEFLATE decoder (RFC 1951)
 * ==================================================
 * Tier-4 fallback of the inflate facade: guarantees the sync-first promise
 * on every runtime with zero setup. Adapted from pdfnative's pure inflate
 * path, minus the zlib (RFC 1950) wrapper — ZIP entries carry *raw*
 * DEFLATE streams.
 *
 * Output is hard-bounded by `maxOutput` (in ZIP reads, the central
 * directory's declared uncompressed size): producing more than declared
 * means the metadata lies (CWE-409) and throws `ZipDataError`.
 *
 * @module codecs/inflate-pure
 */

import { ZipDataError, ZipFormatError } from '../types/zip-errors.js';
import {
    buildHuffmanTable,
    CL_ORDER,
    DIST_BASE,
    DIST_EXTRA,
    getFixedTables,
    LEN_BASE,
    LEN_EXTRA,
    type HuffmanTable,
} from './inflate-shared.js';

// ── Bit reader ───────────────────────────────────────────────────────

interface BitReader {
    buf: Uint8Array;
    pos: number;
    bitBuf: number;
    bitCnt: number;
}

function readBits(br: BitReader, n: number): number {
    while (br.bitCnt < n) {
        if (br.pos >= br.buf.length) {
            throw new ZipFormatError('ZIP_DEFLATE_TRUNCATED', 'zipnative: deflate stream truncated (unexpected end of data)');
        }
        br.bitBuf |= br.buf[br.pos++] << br.bitCnt;
        br.bitCnt += 8;
    }
    const val = br.bitBuf & ((1 << n) - 1);
    br.bitBuf >>>= n;
    br.bitCnt -= n;
    return val;
}

function decodeSymbol(br: BitReader, table: HuffmanTable): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
        if (br.bitCnt < 1) {
            if (br.pos >= br.buf.length) {
                throw new ZipFormatError('ZIP_DEFLATE_TRUNCATED', 'zipnative: deflate stream truncated (unexpected end of data)');
            }
            br.bitBuf |= br.buf[br.pos++] << br.bitCnt;
            br.bitCnt += 8;
        }
        const bit = br.bitBuf & 1;
        br.bitBuf >>>= 1;
        br.bitCnt--;
        code = (code << 1) | bit;

        const count = table.counts[len];
        if (code - count < first) {
            return table.symbols[index + (code - first)];
        }
        index += count;
        first = (first + count) << 1;
    }
    throw new ZipFormatError('ZIP_DEFLATE_CORRUPT', 'zipnative: invalid Huffman code in deflate stream');
}

// ── Decoder ──────────────────────────────────────────────────────────

/**
 * Decompress a raw DEFLATE stream (RFC 1951, no zlib wrapper).
 *
 * @param data - Buffer containing the compressed stream
 * @param maxOutput - Hard output bound; exceeding it throws `ZipDataError`
 * @returns Decompressed bytes (length ≤ maxOutput)
 */
export function inflateRawJS(data: Uint8Array, maxOutput: number): Uint8Array {
    const br: BitReader = { buf: data, pos: 0, bitBuf: 0, bitCnt: 0 };

    // Grow toward maxOutput by doubling — never allocate the (attacker-
    // controlled) declared size upfront. A CD claiming a 1 GiB entry with a
    // tiny payload must not force a 1 GiB allocation before a single byte is
    // produced (CWE-789); maxOutput stays the hard ceiling, enforced in
    // ensureCapacity. A huge/non-finite maxOutput therefore costs nothing
    // until the stream actually produces that much (and then trips the bound).
    const bounded = Number.isFinite(maxOutput);
    const initial = Math.max(64, Math.min(bounded ? maxOutput : Number.MAX_SAFE_INTEGER, data.length * 4, 1 << 20));
    let out = new Uint8Array(initial);
    let outPos = 0;

    const ensureCapacity = (needed: number): void => {
        if (outPos + needed > maxOutput) {
            throw new ZipDataError('ZIP_INFLATE_OUTPUT_OVERFLOW',
                `zipnative: deflate output exceeds the declared/permitted size of ${maxOutput} bytes `
                + '(the archive metadata lies about this entry, or raise the relevant limit if intentional)');
        }
        while (outPos + needed > out.length) {
            const grown = new Uint8Array(Math.min(out.length * 2, bounded ? maxOutput : out.length * 2));
            grown.set(out);
            out = grown;
        }
    };

    let bfinal = 0;
    while (bfinal === 0) {
        bfinal = readBits(br, 1);
        const btype = readBits(br, 2);

        if (btype === 0) {
            // Stored block — realign to byte boundary
            br.bitBuf = 0;
            br.bitCnt = 0;
            if (br.pos + 4 > br.buf.length) {
                throw new ZipFormatError('ZIP_DEFLATE_TRUNCATED', 'zipnative: deflate stored-block header truncated');
            }
            const len = br.buf[br.pos] | (br.buf[br.pos + 1] << 8);
            const nlen = br.buf[br.pos + 2] | (br.buf[br.pos + 3] << 8);
            br.pos += 4;
            if ((len ^ 0xFFFF) !== nlen) {
                throw new ZipFormatError('ZIP_DEFLATE_CORRUPT', 'zipnative: deflate stored-block LEN/NLEN mismatch (corrupt stream)');
            }
            if (br.pos + len > br.buf.length) {
                throw new ZipFormatError('ZIP_DEFLATE_TRUNCATED', 'zipnative: deflate stored-block data truncated');
            }
            ensureCapacity(len);
            out.set(br.buf.subarray(br.pos, br.pos + len), outPos);
            outPos += len;
            br.pos += len;
        } else if (btype === 1 || btype === 2) {
            let litLenTable: HuffmanTable;
            let distTable: HuffmanTable;

            if (btype === 1) {
                const fixed = getFixedTables();
                litLenTable = fixed.litLen;
                distTable = fixed.dist;
            } else {
                const hlit = readBits(br, 5) + 257;
                const hdist = readBits(br, 5) + 1;
                const hclen = readBits(br, 4) + 4;

                const clLengths = new Uint8Array(19);
                for (let i = 0; i < hclen; i++) {
                    clLengths[CL_ORDER[i]] = readBits(br, 3);
                }
                const clTable = buildHuffmanTable(clLengths, 19, true);

                const totalCodes = hlit + hdist;
                const codeLengths = new Uint8Array(totalCodes);
                let ci = 0;
                while (ci < totalCodes) {
                    const sym = decodeSymbol(br, clTable);
                    if (sym < 16) {
                        codeLengths[ci++] = sym;
                    } else if (sym === 16) {
                        if (ci === 0) {
                            throw new ZipFormatError('ZIP_DEFLATE_CORRUPT', 'zipnative: deflate dynamic header repeats with no previous code length');
                        }
                        const repeat = readBits(br, 2) + 3;
                        const prev = codeLengths[ci - 1];
                        for (let r = 0; r < repeat && ci < totalCodes; r++) codeLengths[ci++] = prev;
                    } else if (sym === 17) {
                        const repeat = readBits(br, 3) + 3;
                        for (let r = 0; r < repeat && ci < totalCodes; r++) codeLengths[ci++] = 0;
                    } else {
                        const repeat = readBits(br, 7) + 11;
                        for (let r = 0; r < repeat && ci < totalCodes; r++) codeLengths[ci++] = 0;
                    }
                }

                litLenTable = buildHuffmanTable(codeLengths.subarray(0, hlit), hlit);
                distTable = buildHuffmanTable(codeLengths.subarray(hlit), hdist);
            }

            for (;;) {
                const sym = decodeSymbol(br, litLenTable);
                if (sym < 256) {
                    ensureCapacity(1);
                    out[outPos++] = sym;
                } else if (sym === 256) {
                    break;
                } else {
                    const lenIdx = sym - 257;
                    if (lenIdx >= LEN_BASE.length) {
                        throw new ZipFormatError('ZIP_DEFLATE_CORRUPT', 'zipnative: invalid length symbol in deflate stream');
                    }
                    const length = LEN_BASE[lenIdx] + readBits(br, LEN_EXTRA[lenIdx]);

                    const distSym = decodeSymbol(br, distTable);
                    if (distSym >= DIST_BASE.length) {
                        throw new ZipFormatError('ZIP_DEFLATE_CORRUPT', 'zipnative: invalid distance symbol in deflate stream');
                    }
                    const distance = DIST_BASE[distSym] + readBits(br, DIST_EXTRA[distSym]);
                    if (distance > outPos) {
                        throw new ZipFormatError('ZIP_DEFLATE_CORRUPT', 'zipnative: deflate back-reference before start of output (corrupt stream)');
                    }

                    ensureCapacity(length);
                    for (let i = 0; i < length; i++) {
                        out[outPos] = out[outPos - distance];
                        outPos++;
                    }
                }
            }
        } else {
            throw new ZipFormatError('ZIP_DEFLATE_CORRUPT', `zipnative: unsupported deflate block type ${btype} (corrupt stream)`);
        }
    }

    if (outPos === out.length) return out;
    // Copy out (not subarray) when the backing buffer is much larger than
    // the result, so an over-allocated buffer is not retained for the
    // lifetime of the returned view; subarray is fine for a snug fit.
    return out.length - outPos > 65536 && out.length > outPos * 2
        ? out.slice(0, outPos)
        : out.subarray(0, outPos);
}
