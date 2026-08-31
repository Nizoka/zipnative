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

// ── Huffman tables ───────────────────────────────────────────────────

interface HuffmanTable {
    readonly counts: Uint16Array;  // count of codes per bit length
    readonly symbols: Uint16Array; // symbols sorted by code
}

/** Build a canonical Huffman decode table from code lengths (RFC 1951 §3.2.2). */
function buildHuffmanTable(lengths: Uint8Array, maxSymbol: number): HuffmanTable {
    const MAX_BITS = 15;
    const counts = new Uint16Array(MAX_BITS + 1);
    const symbols = new Uint16Array(maxSymbol);

    for (let i = 0; i < maxSymbol; i++) {
        if (lengths[i] > 0) counts[lengths[i]]++;
    }
    const offsets = new Uint16Array(MAX_BITS + 1);
    for (let i = 1; i < MAX_BITS; i++) {
        offsets[i + 1] = offsets[i] + counts[i];
    }
    for (let i = 0; i < maxSymbol; i++) {
        if (lengths[i] > 0) symbols[offsets[lengths[i]]++] = i;
    }
    return { counts, symbols };
}

function buildFixedLitLenLengths(): Uint8Array {
    const lengths = new Uint8Array(288);
    for (let i = 0; i <= 143; i++) lengths[i] = 8;
    for (let i = 144; i <= 255; i++) lengths[i] = 9;
    for (let i = 256; i <= 279; i++) lengths[i] = 7;
    for (let i = 280; i <= 287; i++) lengths[i] = 8;
    return lengths;
}

let _fixedLitLen: HuffmanTable | undefined;
let _fixedDist: HuffmanTable | undefined;

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
            throw new ZipFormatError('zipnative: deflate stream truncated (unexpected end of data)');
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
                throw new ZipFormatError('zipnative: deflate stream truncated (unexpected end of data)');
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
    throw new ZipFormatError('zipnative: invalid Huffman code in deflate stream');
}

// ── Length/distance tables (RFC 1951 §3.2.5) ─────────────────────────

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** Code-length alphabet transmission order (RFC 1951 §3.2.7). */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

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

    // When the caller knows the exact output size (the CD-declared size),
    // allocate once; a growing buffer only serves unbounded callers.
    const bounded = Number.isFinite(maxOutput);
    let out = new Uint8Array(bounded ? maxOutput : Math.min(data.length * 4, 1 << 20));
    let outPos = 0;

    const ensureCapacity = (needed: number): void => {
        if (outPos + needed > maxOutput) {
            throw new ZipDataError(
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
                throw new ZipFormatError('zipnative: deflate stored-block header truncated');
            }
            const len = br.buf[br.pos] | (br.buf[br.pos + 1] << 8);
            const nlen = br.buf[br.pos + 2] | (br.buf[br.pos + 3] << 8);
            br.pos += 4;
            if ((len ^ 0xFFFF) !== nlen) {
                throw new ZipFormatError('zipnative: deflate stored-block LEN/NLEN mismatch (corrupt stream)');
            }
            if (br.pos + len > br.buf.length) {
                throw new ZipFormatError('zipnative: deflate stored-block data truncated');
            }
            ensureCapacity(len);
            out.set(br.buf.subarray(br.pos, br.pos + len), outPos);
            outPos += len;
            br.pos += len;
        } else if (btype === 1 || btype === 2) {
            let litLenTable: HuffmanTable;
            let distTable: HuffmanTable;

            if (btype === 1) {
                if (_fixedLitLen === undefined || _fixedDist === undefined) {
                    _fixedLitLen = buildHuffmanTable(buildFixedLitLenLengths(), 288);
                    const distLengths = new Uint8Array(32);
                    distLengths.fill(5);
                    _fixedDist = buildHuffmanTable(distLengths, 32);
                }
                litLenTable = _fixedLitLen;
                distTable = _fixedDist;
            } else {
                const hlit = readBits(br, 5) + 257;
                const hdist = readBits(br, 5) + 1;
                const hclen = readBits(br, 4) + 4;

                const clLengths = new Uint8Array(19);
                for (let i = 0; i < hclen; i++) {
                    clLengths[CL_ORDER[i]] = readBits(br, 3);
                }
                const clTable = buildHuffmanTable(clLengths, 19);

                const totalCodes = hlit + hdist;
                const codeLengths = new Uint8Array(totalCodes);
                let ci = 0;
                while (ci < totalCodes) {
                    const sym = decodeSymbol(br, clTable);
                    if (sym < 16) {
                        codeLengths[ci++] = sym;
                    } else if (sym === 16) {
                        if (ci === 0) {
                            throw new ZipFormatError('zipnative: deflate dynamic header repeats with no previous code length');
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
                        throw new ZipFormatError('zipnative: invalid length symbol in deflate stream');
                    }
                    const length = LEN_BASE[lenIdx] + readBits(br, LEN_EXTRA[lenIdx]);

                    const distSym = decodeSymbol(br, distTable);
                    if (distSym >= DIST_BASE.length) {
                        throw new ZipFormatError('zipnative: invalid distance symbol in deflate stream');
                    }
                    const distance = DIST_BASE[distSym] + readBits(br, DIST_EXTRA[distSym]);
                    if (distance > outPos) {
                        throw new ZipFormatError('zipnative: deflate back-reference before start of output (corrupt stream)');
                    }

                    ensureCapacity(length);
                    for (let i = 0; i < length; i++) {
                        out[outPos] = out[outPos - distance];
                        outPos++;
                    }
                }
            }
        } else {
            throw new ZipFormatError(`zipnative: unsupported deflate block type ${btype} (corrupt stream)`);
        }
    }

    return outPos === out.length ? out : out.subarray(0, outPos);
}
