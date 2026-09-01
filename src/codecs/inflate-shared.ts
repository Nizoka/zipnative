/**
 * zipnative — shared inflate tables and Huffman construction
 * ==========================================================
 * Used by both the one-shot decoder (inflate-pure.ts) and the resumable
 * decoder (inflate-stream.ts) so the RFC 1951 constants and canonical
 * table construction exist exactly once. (The ENCODER redeclares its own
 * copies deliberately — deflate-pure.ts is a frozen byte contract and
 * stays self-contained.)
 *
 * @module codecs/inflate-shared
 */

import { ZipFormatError } from '../types/zip-errors.js';

export interface HuffmanTable {
    readonly counts: Uint16Array;  // count of codes per bit length
    readonly symbols: Uint16Array; // symbols sorted by code
}

/**
 * Build a canonical Huffman decode table from code lengths (RFC 1951
 * §3.2.2), validating the Kraft inequality exactly as zlib's `inflate_table`
 * does: an over-subscribed set is always rejected; an incomplete set is
 * rejected too, except an empty table (no codes) and — for the literal/
 * length and distance alphabets only — a lone one-bit code. Without this a
 * corrupt stream would decode to silent garbage instead of throwing.
 *
 * @param isCodeLengthTable - true for the code-length (CL) alphabet, where
 *   even a single-code incomplete set is invalid (zlib's CODES type).
 */
export function buildHuffmanTable(lengths: Uint8Array, maxSymbol: number, isCodeLengthTable = false): HuffmanTable {
    const MAX_BITS = 15;
    const counts = new Uint16Array(MAX_BITS + 1);
    const symbols = new Uint16Array(maxSymbol);

    let totalCodes = 0;
    let maxLen = 0;
    for (let i = 0; i < maxSymbol; i++) {
        const len = lengths[i];
        if (len > 0) { counts[len]++; totalCodes++; if (len > maxLen) maxLen = len; }
    }

    // Kraft check (zlib inftrees.c): left starts at 1 and is halved-then-
    // debited per length; negative means over-subscribed, positive means
    // incomplete. An empty alphabet (totalCodes === 0) is legal (e.g. a
    // block with no back-references has an empty distance table).
    if (totalCodes > 0) {
        let left = 1;
        for (let len = 1; len <= MAX_BITS; len++) {
            left <<= 1;
            left -= counts[len];
            if (left < 0) {
                throw new ZipFormatError('ZIP_DEFLATE_CORRUPT', 'zipnative: over-subscribed Huffman table in deflate stream');
            }
        }
        if (left > 0 && (isCodeLengthTable || maxLen !== 1)) {
            throw new ZipFormatError('ZIP_DEFLATE_CORRUPT', 'zipnative: incomplete Huffman table in deflate stream');
        }
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

/** The fixed-Huffman tables (RFC 1951 §3.2.6), built lazily and memoized. */
export function getFixedTables(): { litLen: HuffmanTable; dist: HuffmanTable } {
    if (_fixedLitLen === undefined || _fixedDist === undefined) {
        _fixedLitLen = buildHuffmanTable(buildFixedLitLenLengths(), 288);
        const distLengths = new Uint8Array(32);
        distLengths.fill(5);
        _fixedDist = buildHuffmanTable(distLengths, 32);
    }
    return { litLen: _fixedLitLen, dist: _fixedDist };
}

// ── Length/distance tables (RFC 1951 §3.2.5) ─────────────────────────

export const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
export const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
export const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
export const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** Code-length alphabet transmission order (RFC 1951 §3.2.7). */
export const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
