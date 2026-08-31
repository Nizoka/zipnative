/**
 * zipnative — Pure-TS raw DEFLATE encoder (RFC 1951)
 * ==================================================
 * The determinism pin of the codec facade: `deterministic: true` archives
 * compress through THIS encoder so identical inputs produce identical
 * bytes on every runtime.
 *
 * ── FROZEN CONTRACT ──────────────────────────────────────────────────
 * Every constant and tie-breaking rule in this file is part of the
 * public `deterministic: true` byte contract (see docs/determinism.md):
 * the hash multiplier/shift, the level configuration table, the unified
 * one-step-lazy rule (a deferred match wins ties), TOO_FAR, BLOCK_SYMS,
 * the Huffman construction ordering (frequency ascending, then symbol
 * ascending; leaf preferred over internal on equal frequency), the
 * overflow fix, and the stored ≤ fixed ≤ dynamic cost tie order.
 * Changing ANY of them changes emitted bytes and is semver-major.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Algorithm: LZ77 over a 32 KiB window with head/prev hash chains and
 * one-step lazy matching (zlib's configuration table gates effort per
 * level); per block (≤ 65 534 symbols) the cheapest of stored / fixed /
 * dynamic Huffman is emitted at exact bit cost. Non-goals: level-9
 * optimal parsing, Z_FILTERED strategies, preset dictionaries, and
 * bit-identity with zlib — the promise is self-identity only.
 *
 * @module codecs/deflate-pure
 */

import { ZipError } from '../types/zip-errors.js';

// ── Frozen constants ─────────────────────────────────────────────────

const MIN_MATCH = 3;
const MAX_MATCH = 258;
const WSIZE = 32768;
const WMASK = WSIZE - 1;
const TOO_FAR = 4096;
const HASH_SHIFT = 17; // 32 - 15 → 15-bit hash
const HASH_SIZE = 32768;
const BLOCK_SYMS = 65534;
const STORED_MAX = 65535;

// RFC 1951 §3.2.5 — redeclared locally (codec modules stay self-contained).
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// zlib's configuration_table (deflate.c), indexed by level 1–9; index 0 unused.
const CFG_GOOD = [0, 4, 4, 4, 4, 8, 8, 8, 32, 32];
const CFG_LAZY = [0, 4, 5, 6, 4, 16, 16, 32, 128, 258];
const CFG_NICE = [0, 8, 16, 32, 16, 32, 128, 128, 258, 258];
const CFG_CHAIN = [0, 4, 8, 32, 16, 32, 128, 256, 1024, 4096];

// ── Lazily built, memoized encoder tables ────────────────────────────

interface EncoderTables {
    /** (matchLen − 3) → length-code index 0..28. */
    readonly lengthSym: Uint8Array;
    /** zlib dist_code layout: d1 < 256 → [d1]; else [256 + (d1 >>> 7)]. */
    readonly distSym: Uint8Array;
    readonly fixedLitLens: Uint8Array;    // 288
    readonly fixedLitCodes: Uint16Array;  // 288, bit-reversed
    readonly fixedDistLens: Uint8Array;   // 30, all 5
    readonly fixedDistCodes: Uint16Array; // 30, bit-reversed
}

let _tables: EncoderTables | undefined;

function reverseBits(code: number, len: number): number {
    let out = 0;
    for (let i = 0; i < len; i++) {
        out = (out << 1) | ((code >>> i) & 1);
    }
    return out;
}

function buildEncoderTables(): EncoderTables {
    const lengthSym = new Uint8Array(256);
    for (let i = 0; i < 28; i++) {
        for (let len = LEN_BASE[i]; len < LEN_BASE[i + 1]; len++) {
            lengthSym[len - MIN_MATCH] = i;
        }
    }
    lengthSym[MAX_MATCH - MIN_MATCH] = 28; // length 258 → code 285, 0 extra bits

    const distSym = new Uint8Array(512);
    let d1 = 0;
    for (let code = 0; code < 16; code++) {
        for (let n = 0; n < (1 << DIST_EXTRA[code]); n++) distSym[d1++] = code;
    }
    let d = 2; // = 256 >> 7; larger distances are indexed by d1 >>> 7
    for (let code = 16; code < 30; code++) {
        for (let n = 0; n < (1 << (DIST_EXTRA[code] - 7)); n++) distSym[256 + d++] = code;
    }

    const fixedLitLens = new Uint8Array(288);
    for (let i = 0; i <= 143; i++) fixedLitLens[i] = 8;
    for (let i = 144; i <= 255; i++) fixedLitLens[i] = 9;
    for (let i = 256; i <= 279; i++) fixedLitLens[i] = 7;
    for (let i = 280; i <= 287; i++) fixedLitLens[i] = 8;
    const fixedLitCodes = buildCanonicalCodes(fixedLitLens, 288);

    const fixedDistLens = new Uint8Array(30);
    fixedDistLens.fill(5);
    const fixedDistCodes = buildCanonicalCodes(fixedDistLens, 30);

    return { lengthSym, distSym, fixedLitLens, fixedLitCodes, fixedDistLens, fixedDistCodes };
}

// ── Bit writer (LSB-first, mirror of the decoder's BitReader) ────────

interface BitWriter {
    out: Uint8Array;
    pos: number;
    bitBuf: number; // invariant: bitCnt < 8 after every writeBits
    bitCnt: number;
}

function ensure(bw: BitWriter, needed: number): void {
    if (bw.pos + needed <= bw.out.length) return;
    let size = bw.out.length * 2;
    while (size < bw.pos + needed) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(bw.out);
    bw.out = grown;
}

/** Write `nbits` (≤ 15) LSB-first. bitBuf stays < 2^23 — no overflow. */
function writeBits(bw: BitWriter, value: number, nbits: number): void {
    bw.bitBuf |= value << bw.bitCnt;
    bw.bitCnt += nbits;
    while (bw.bitCnt >= 8) {
        ensure(bw, 1);
        bw.out[bw.pos++] = bw.bitBuf & 0xff;
        bw.bitBuf >>>= 8;
        bw.bitCnt -= 8;
    }
}

function alignByte(bw: BitWriter): void {
    if (bw.bitCnt > 0) {
        ensure(bw, 1);
        bw.out[bw.pos++] = bw.bitBuf & 0xff;
        bw.bitBuf = 0;
        bw.bitCnt = 0;
    }
}

function finishWriter(bw: BitWriter): Uint8Array {
    alignByte(bw);
    return bw.out.subarray(0, bw.pos);
}

// ── Huffman code-length construction (two-queue + zlib overflow fix) ─

/**
 * Frequencies → canonical code lengths capped at `maxBits`.
 * Deterministic by construction: leaves sorted (frequency ascending,
 * symbol ascending); on equal cost a leaf is taken before an internal
 * node; overflow reassignment walks the same sorted leaf order.
 */
function buildCodeLengths(freq: Uint32Array, n: number, maxBits: number): Uint8Array {
    const lengths = new Uint8Array(n);
    const leaves: number[] = [];
    for (let s = 0; s < n; s++) {
        if (freq[s] > 0) leaves.push(s);
    }
    leaves.sort((a, b) => (freq[a] - freq[b]) || (a - b));

    const m = leaves.length;
    if (m === 0) {
        // Only reachable for the distance tree of an all-literal block:
        // emit the two-code minimum so the header stays well-formed.
        lengths[0] = 1;
        lengths[1] = 1;
        return lengths;
    }
    if (m === 1) {
        const s = leaves[0];
        lengths[s] = 1;
        lengths[s === 0 ? 1 : 0] = 1;
        return lengths;
    }

    // Two-queue merge: leaves occupy slots 0..m-1 in sorted order,
    // internal nodes are appended FIFO (always non-decreasing cost).
    const total = 2 * m - 1;
    const nodeFreq = new Float64Array(total); // sums can exceed 2^32
    const parent = new Int32Array(total);
    for (let j = 0; j < m; j++) nodeFreq[j] = freq[leaves[j]];
    let leafHead = 0;
    let intHead = m;
    let next = m;
    const pick = (): number => {
        if (leafHead < m && (intHead >= next || nodeFreq[leafHead] <= nodeFreq[intHead])) {
            return leafHead++;
        }
        return intHead++;
    };
    for (let round = 0; round < m - 1; round++) {
        const a = pick();
        const b = pick();
        nodeFreq[next] = nodeFreq[a] + nodeFreq[b];
        parent[a] = next;
        parent[b] = next;
        next++;
    }

    // Depths root-down; leaf slot j's provisional length = depth[j].
    const depth = new Uint16Array(total);
    for (let k = total - 2; k >= 0; k--) {
        depth[k] = depth[parent[k]] + 1;
    }

    // Clamp to maxBits, then repair the Kraft sum (zlib gen_bitlen fix).
    const blCount = new Uint32Array(maxBits + 1);
    let overflow = 0;
    for (let j = 0; j < m; j++) {
        let bits = depth[j];
        if (bits > maxBits) {
            bits = maxBits;
            overflow++;
        }
        blCount[bits]++;
    }
    while (overflow > 0) {
        let bits = maxBits - 1;
        while (blCount[bits] === 0) bits--;
        blCount[bits]--;
        blCount[bits + 1] += 2;
        blCount[maxBits]--;
        overflow -= 2;
    }

    // Reassign lengths from blCount: longest codes to the least frequent
    // leaves, walking the frozen (freq asc, symbol asc) order.
    let leafIdx = 0;
    for (let bits = maxBits; bits >= 1; bits--) {
        for (let k = 0; k < blCount[bits]; k++) {
            lengths[leaves[leafIdx++]] = bits;
        }
    }
    return lengths;
}

/** Canonical codes (RFC 1951 §3.2.2), stored bit-reversed for LSB emission. */
function buildCanonicalCodes(lengths: Uint8Array, n: number): Uint16Array {
    const codes = new Uint16Array(n);
    const blCount = new Uint32Array(16);
    for (let s = 0; s < n; s++) {
        if (lengths[s] > 0) blCount[lengths[s]]++;
    }
    const nextCode = new Uint32Array(16);
    let code = 0;
    for (let bits = 1; bits <= 15; bits++) {
        code = (code + blCount[bits - 1]) << 1;
        nextCode[bits] = code;
    }
    for (let s = 0; s < n; s++) {
        const len = lengths[s];
        if (len > 0) {
            codes[s] = reverseBits(nextCode[len]++, len);
        }
    }
    return codes;
}

// ── Code-length sequence RLE (symbols 16/17/18) ──────────────────────

interface ClTokens {
    readonly syms: Uint8Array;
    readonly args: Uint8Array;
    readonly count: number;
    readonly clFreq: Uint32Array;
}

/**
 * RLE-tokenize the SINGLE concatenated litlen++dist length sequence —
 * runs legally cross the litlen/dist boundary and `prevLen` must survive
 * it (splitting the run there is the classic invalid-header bug).
 */
function tokenizeCodeLengths(litLens: Uint8Array, hlit: number, distLens: Uint8Array, hdist: number): ClTokens {
    const seq = new Uint8Array(hlit + hdist);
    seq.set(litLens.subarray(0, hlit), 0);
    seq.set(distLens.subarray(0, hdist), hlit);

    const syms = new Uint8Array(seq.length);
    const args = new Uint8Array(seq.length);
    const clFreq = new Uint32Array(19);
    let count = 0;
    const push = (sym: number, arg: number): void => {
        syms[count] = sym;
        args[count] = arg;
        count++;
        clFreq[sym]++;
    };

    let prevLen = -1;
    let i = 0;
    while (i < seq.length) {
        const v = seq[i];
        let run = 1;
        while (i + run < seq.length && seq[i + run] === v) run++;
        i += run;

        if (v === 0) {
            while (run >= 11) {
                const r = Math.min(run, 138);
                push(18, r - 11);
                run -= r;
            }
            if (run >= 3) {
                push(17, run - 3);
                run = 0;
            }
            while (run-- > 0) push(0, 0);
            prevLen = 0;
        } else {
            if (v !== prevLen) {
                push(v, 0);
                run--;
                prevLen = v;
            }
            while (run >= 3) {
                const r = Math.min(run, 6);
                push(16, r - 3);
                run -= r;
            }
            while (run-- > 0) push(v, 0);
        }
    }
    return { syms, args, count, clFreq };
}

const CL_EXTRA_BITS = (sym: number): number => (sym === 16 ? 2 : sym === 17 ? 3 : sym === 18 ? 7 : 0);

// ── Stored blocks ────────────────────────────────────────────────────

/** Emit `[start, end)` as stored pieces; BFINAL only on the last iff `isFinal`. */
function writeStoredRange(bw: BitWriter, data: Uint8Array, start: number, end: number, isFinal: boolean): void {
    let offset = start;
    let remaining = end - start;
    while (remaining > 0 || offset === start) {
        const pieceLen = Math.min(remaining, STORED_MAX);
        const last = remaining - pieceLen === 0;
        writeBits(bw, isFinal && last ? 1 : 0, 1);
        writeBits(bw, 0, 2);
        alignByte(bw);
        ensure(bw, 4 + pieceLen);
        bw.out[bw.pos++] = pieceLen & 0xff;
        bw.out[bw.pos++] = (pieceLen >>> 8) & 0xff;
        bw.out[bw.pos++] = ~pieceLen & 0xff;
        bw.out[bw.pos++] = (~pieceLen >>> 8) & 0xff;
        bw.out.set(data.subarray(offset, offset + pieceLen), bw.pos);
        bw.pos += pieceLen;
        offset += pieceLen;
        remaining -= pieceLen;
        if (remaining === 0) break;
    }
}

// ── Block emission (cost pick: stored vs fixed vs dynamic) ───────────

function emitBlock(
    bw: BitWriter,
    data: Uint8Array,
    blockStart: number,
    blockEnd: number,
    litBuf: Uint16Array,
    distBuf: Uint16Array,
    symCount: number,
    litFreq: Uint32Array,
    distFreq: Uint32Array,
    isFinal: boolean,
    t: EncoderTables,
): void {
    litFreq[256] = 1; // exactly one EOB per block

    const litLens = buildCodeLengths(litFreq, 286, 15);
    const distLens = buildCodeLengths(distFreq, 30, 15);

    let hlit = 286;
    while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
    let hdist = 30;
    while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;

    const tokens = tokenizeCodeLengths(litLens, hlit, distLens, hdist);
    const clLens = buildCodeLengths(tokens.clFreq, 19, 7);
    const clCodes = buildCanonicalCodes(clLens, 19);
    let hclen = 19;
    while (hclen > 4 && clLens[CL_ORDER[hclen - 1]] === 0) hclen--;

    // Exact bit costs.
    const dataBits = (L: Uint8Array, D: Uint8Array): number => {
        let bits = 0;
        for (let s = 0; s < 286; s++) {
            if (litFreq[s] > 0) {
                bits += litFreq[s] * (L[s] + (s >= 257 ? LEN_EXTRA[s - 257] : 0));
            }
        }
        for (let c = 0; c < 30; c++) {
            if (distFreq[c] > 0) {
                bits += distFreq[c] * (D[c] + DIST_EXTRA[c]);
            }
        }
        return bits;
    };
    let clBits = 0;
    for (let k = 0; k < tokens.count; k++) {
        clBits += clLens[tokens.syms[k]] + CL_EXTRA_BITS(tokens.syms[k]);
    }
    const dynamicBits = 3 + 14 + 3 * hclen + clBits + dataBits(litLens, distLens);
    const fixedBits = 3 + dataBits(t.fixedLitLens, t.fixedDistLens);
    const n = blockEnd - blockStart;
    const pieces = Math.max(1, Math.ceil(n / STORED_MAX));
    const pad0 = (8 - ((bw.bitCnt + 3) & 7)) & 7;
    const storedBits = 3 + pad0 + 32 + 8 * n + (pieces - 1) * 40;

    // Frozen tie order: stored ≤ both → stored; else fixed ≤ dynamic → fixed.
    if (storedBits <= fixedBits && storedBits <= dynamicBits) {
        writeStoredRange(bw, data, blockStart, blockEnd, isFinal);
        return;
    }

    const useFixed = fixedBits <= dynamicBits;
    writeBits(bw, isFinal ? 1 : 0, 1);
    writeBits(bw, useFixed ? 1 : 2, 2);

    let litCodes: Uint16Array;
    let litL: Uint8Array;
    let distCodes: Uint16Array;
    let distL: Uint8Array;
    if (useFixed) {
        litCodes = t.fixedLitCodes;
        litL = t.fixedLitLens;
        distCodes = t.fixedDistCodes;
        distL = t.fixedDistLens;
    } else {
        writeBits(bw, hlit - 257, 5);
        writeBits(bw, hdist - 1, 5);
        writeBits(bw, hclen - 4, 4);
        for (let k = 0; k < hclen; k++) {
            writeBits(bw, clLens[CL_ORDER[k]], 3);
        }
        for (let k = 0; k < tokens.count; k++) {
            const sym = tokens.syms[k];
            writeBits(bw, clCodes[sym], clLens[sym]);
            const extra = CL_EXTRA_BITS(sym);
            if (extra > 0) writeBits(bw, tokens.args[k], extra);
        }
        litCodes = buildCanonicalCodes(litLens, 286);
        litL = litLens;
        distCodes = buildCanonicalCodes(distLens, 30);
        distL = distLens;
    }

    for (let k = 0; k < symCount; k++) {
        const dist = distBuf[k];
        if (dist === 0) {
            const lit = litBuf[k];
            writeBits(bw, litCodes[lit], litL[lit]);
        } else {
            const len = litBuf[k];
            const li = t.lengthSym[len - MIN_MATCH];
            const sym = 257 + li;
            writeBits(bw, litCodes[sym], litL[sym]);
            if (LEN_EXTRA[li] > 0) writeBits(bw, len - LEN_BASE[li], LEN_EXTRA[li]);
            const d1 = dist - 1;
            const dc = d1 < 256 ? t.distSym[d1] : t.distSym[256 + (d1 >>> 7)];
            writeBits(bw, distCodes[dc], distL[dc]);
            if (DIST_EXTRA[dc] > 0) writeBits(bw, d1 - (DIST_BASE[dc] - 1), DIST_EXTRA[dc]);
        }
    }
    writeBits(bw, litCodes[256], litL[256]); // end of block
}

// ── Level 0: stored-only fast path ───────────────────────────────────

function deflateStored(data: Uint8Array): Uint8Array {
    const bw: BitWriter = {
        out: new Uint8Array(data.length + 5 * Math.max(1, Math.ceil(data.length / STORED_MAX)) + 8),
        pos: 0,
        bitBuf: 0,
        bitCnt: 0,
    };
    writeStoredRange(bw, data, 0, data.length, true);
    return finishWriter(bw);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Compress to a raw DEFLATE stream (RFC 1951, no zlib wrapper — ZIP's
 * framing for method 8). Deterministic: identical (data, level) yields
 * identical bytes on every runtime.
 *
 * @param data - Bytes to compress (≤ 2 GiB)
 * @param level - 0 (stored blocks only) to 9 (deepest match search)
 */
export function deflateRawJS(data: Uint8Array, level: number): Uint8Array {
    if (!Number.isInteger(level) || level < 0 || level > 9) {
        throw new ZipError(`zipnative: deflate level must be an integer 0-9 (got ${String(level)})`);
    }
    if (data.length > 0x7ffffffe) {
        throw new ZipError('zipnative: deflate input exceeds 2 GiB — split the input');
    }
    if (level === 0) return deflateStored(data);

    const t = (_tables ??= buildEncoderTables());
    const len = data.length;

    const bw: BitWriter = {
        out: new Uint8Array(Math.max(256, len >>> 1)),
        pos: 0,
        bitBuf: 0,
        bitCnt: 0,
    };

    // Hash chains — absolute positions, no window rebasing (whole input
    // is in memory). Slot aliasing across the 32 KiB ring is harmless:
    // every candidate is bounds-checked against [limit, pos) and the
    // walk is capped by the chain limit.
    const head = new Int32Array(HASH_SIZE).fill(-1);
    const prev = new Int32Array(WSIZE);

    const hashAt = (p: number): number =>
        (Math.imul((data[p] << 16) | (data[p + 1] << 8) | data[p + 2], 0x9E3779B1) >>> HASH_SHIFT);

    /** Insert position p into its chain; return the previous chain head. */
    const insert = (p: number): number => {
        if (p > len - MIN_MATCH) return -1;
        const h = hashAt(p);
        const cand = head[h];
        prev[p & WMASK] = cand;
        head[h] = p;
        return cand;
    };

    const good = CFG_GOOD[level];
    const maxLazy = CFG_LAZY[level];
    const niceCfg = CFG_NICE[level];
    const maxChain = CFG_CHAIN[level];

    let matchLen = 0;
    let matchDist = 0;
    const longestMatch = (pos: number, firstCand: number, bestSoFar: number): void => {
        matchLen = 0;
        matchDist = 0;
        const maxLen = Math.min(MAX_MATCH, len - pos);
        if (maxLen < MIN_MATCH) return;
        let bestLen = bestSoFar > 2 ? bestSoFar : 2;
        if (bestLen >= maxLen) return; // deferred match already saturates
        let bestDist = 0;
        const limit = pos > WSIZE ? pos - WSIZE : 0;
        const nice = niceCfg < maxLen ? niceCfg : maxLen;
        let chain = maxChain;
        if (bestSoFar >= good) chain >>= 2;

        let cand = firstCand;
        do {
            if (cand < limit || cand >= pos) break;
            // Fast reject on the byte a longer match must also share.
            if (data[cand + bestLen] === data[pos + bestLen] && data[cand] === data[pos]) {
                let k = 0;
                while (k < maxLen && data[cand + k] === data[pos + k]) k++;
                if (k > bestLen) {
                    bestLen = k;
                    bestDist = pos - cand;
                    if (bestLen >= nice || bestLen >= maxLen) break;
                }
            }
            cand = prev[cand & WMASK];
        } while (--chain !== 0);

        if (bestDist !== 0 && bestLen >= MIN_MATCH) {
            matchLen = bestLen;
            matchDist = bestDist;
        }
    };

    // Symbol block state.
    const litBuf = new Uint16Array(BLOCK_SYMS);
    const distBuf = new Uint16Array(BLOCK_SYMS);
    const litFreq = new Uint32Array(286);
    const distFreq = new Uint32Array(30);
    let symCount = 0;
    let blockStart = 0;
    let emittedEnd = 0;

    const flushIfFull = (): void => {
        if (symCount === BLOCK_SYMS) {
            emitBlock(bw, data, blockStart, emittedEnd, litBuf, distBuf, symCount, litFreq, distFreq, false, t);
            blockStart = emittedEnd;
            symCount = 0;
            litFreq.fill(0);
            distFreq.fill(0);
        }
    };
    const pushLiteral = (c: number): void => {
        litBuf[symCount] = c;
        distBuf[symCount] = 0;
        symCount++;
        litFreq[c]++;
        emittedEnd += 1;
        flushIfFull();
    };
    const pushPair = (l: number, dst: number): void => {
        litBuf[symCount] = l;
        distBuf[symCount] = dst;
        symCount++;
        litFreq[257 + t.lengthSym[l - MIN_MATCH]]++;
        const d1 = dst - 1;
        distFreq[d1 < 256 ? t.distSym[d1] : t.distSym[256 + (d1 >>> 7)]]++;
        emittedEnd += l;
        flushIfFull();
    };

    // ── Unified one-step-lazy scan (levels 1–9) ──────────────────────
    let i = 0;
    let havePrev = false;
    let deferLen = 0;
    let deferDist = 0;

    while (i < len) {
        const cand = insert(i);
        let curLen = 0;
        let curDist = 0;
        if (cand >= 0 && deferLen < maxLazy) {
            longestMatch(i, cand, deferLen);
            curLen = matchLen;
            curDist = matchDist;
            if (curLen === MIN_MATCH && curDist > TOO_FAR) curLen = 0;
        }

        if (havePrev && deferLen >= MIN_MATCH && curLen <= deferLen) {
            // The deferred match (starting at i-1) wins — ties included.
            pushPair(deferLen, deferDist);
            // Interior hash inserts: i-1 and i are already in; cover the rest.
            const last = i + deferLen - 2;
            for (let j = i + 1; j <= last; j++) insert(j);
            i += deferLen - 1;
            havePrev = false;
            deferLen = 0;
        } else {
            if (havePrev) {
                pushLiteral(data[i - 1]); // the deferred position lost the race
            }
            havePrev = true;
            deferLen = curLen;
            deferDist = curDist;
            i += 1;
        }
    }
    if (havePrev) {
        pushLiteral(data[len - 1]); // flush the trailing deferral
    }

    // Always one final block — possibly zero symbols (empty input →
    // a fixed block holding only EOB, 2 bytes total).
    emitBlock(bw, data, blockStart, emittedEnd, litBuf, distBuf, symCount, litFreq, distFreq, true, t);
    return finishWriter(bw);
}
