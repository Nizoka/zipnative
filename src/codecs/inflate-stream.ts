/**
 * zipnative — Resumable pure-TS raw DEFLATE decoder (RFC 1951)
 * ============================================================
 * The chunk-fed, suspendable decoder that reports its exact consumed-byte
 * position — the capability no other tier has (`DecompressionStream` and
 * node:zlib expose no read position), and the one that lets the forward
 * reader delimit data-descriptor (flag bit 3) entries.
 *
 * Design: a SYNC GENERATOR COROUTINE. The block loop of the one-shot
 * decoder survives almost verbatim; the only suspension points are the
 * input refills inside `readBitsG`/`decodeSymbolG` and the stored-block
 * copy — generator suspension persists every local (mid-header counters,
 * partial Huffman walks) for free, instead of a hand-written state
 * machine.
 *
 * Consumed-byte accounting rests on one invariant, inherited from the
 * one-shot decoder's LAZY single-byte refills: after every completed
 * bit-level operation, `bitCnt ≤ 7`. In particular, right after the final
 * block's end-of-block symbol the ≤ 7 buffered bits are exactly the
 * discarded pad of the stream's last byte — so the stream ends AT `pos`,
 * `leftover` is the unconsumed tail of the last chunk, and no bit/byte
 * boundary arithmetic is needed.
 *
 * Window: a 64 KiB linear buffer; when full, the newest 32 KiB slide to
 * the front (`copyWithin`) after flushing pending output — back-references
 * (max distance 32 768) always resolve. Memory is a fixed 64 KiB plus the
 * in-flight chunk, regardless of stream size.
 *
 * @module codecs/inflate-stream
 */

import { ZipDataError, ZipError, ZipFormatError } from '../types/zip-errors.js';
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

/** Resumable raw-deflate decoder — obtain via {@link createInflator}. */
export interface Inflator {
    /**
     * Feed one compressed chunk. Returns the decompressed pieces produced
     * (fresh copies, safe to retain). Throws `ZipFormatError` on corrupt
     * data, `ZipDataError` when the output bound is exceeded.
     */
    push(chunk: Uint8Array): Uint8Array[];
    /** True once the final block's end-of-block symbol was decoded. */
    readonly finished: boolean;
    /** Unconsumed tail of the LAST pushed chunk (zero-copy). Empty until finished. */
    readonly leftover: Uint8Array;
    /** Total compressed bytes the deflate stream consumed (excludes leftover). */
    readonly bytesConsumed: number;
    /** Total decompressed bytes produced. */
    readonly bytesProduced: number;
    /** Assert completion: throws `ZipFormatError` (truncated) if not finished. */
    end(): void;
}

const WIN_SIZE = 65536;
const KEEP = 32768; // window history preserved across slides (max back-ref distance)

interface InflateState {
    buf: Uint8Array;
    pos: number;
    bitBuf: number;
    bitCnt: number; // invariant: ≤ 7 at every operation boundary
    win: Uint8Array;
    winPos: number;
    emitStart: number;
    totalOut: number;
    readonly maxOutput: number;
}

type Yielded =
    | { readonly kind: 'need' }
    | { readonly kind: 'data'; readonly bytes: Uint8Array };

/** Flush un-emitted window output (if any), then suspend for more input. */
function* refill(st: InflateState): Generator<Yielded, void, Uint8Array> {
    if (st.winPos > st.emitStart) {
        yield { kind: 'data', bytes: st.win.slice(st.emitStart, st.winPos) };
        st.emitStart = st.winPos;
    }
    st.buf = yield { kind: 'need' };
    st.pos = 0;
}

function* readBitsG(st: InflateState, n: number): Generator<Yielded, number, Uint8Array> {
    while (st.bitCnt < n) {
        while (st.pos >= st.buf.length) {
            yield* refill(st);
        }
        st.bitBuf |= st.buf[st.pos++] << st.bitCnt;
        st.bitCnt += 8;
    }
    const value = st.bitBuf & ((1 << n) - 1);
    st.bitBuf >>>= n;
    st.bitCnt -= n;
    return value;
}

function* decodeSymbolG(st: InflateState, table: HuffmanTable): Generator<Yielded, number, Uint8Array> {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
        if (st.bitCnt < 1) {
            while (st.pos >= st.buf.length) {
                yield* refill(st);
            }
            st.bitBuf |= st.buf[st.pos++] << st.bitCnt;
            st.bitCnt += 8;
        }
        const bit = st.bitBuf & 1;
        st.bitBuf >>>= 1;
        st.bitCnt--;
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

/** Slide the window: flush, then keep the newest 32 KiB of history. */
function* slide(st: InflateState): Generator<Yielded, void, Uint8Array> {
    if (st.winPos > st.emitStart) {
        yield { kind: 'data', bytes: st.win.slice(st.emitStart, st.winPos) };
    }
    st.win.copyWithin(0, st.winPos - KEEP, st.winPos);
    st.winPos = KEEP;
    st.emitStart = KEEP;
}

function boundOutput(st: InflateState, needed: number): void {
    if (st.totalOut + needed > st.maxOutput) {
        throw new ZipDataError(
            `zipnative: deflate output exceeds the declared/permitted size of ${st.maxOutput} bytes `
            + '(the archive metadata lies about this entry, or raise the relevant limit if intentional)');
    }
}

/** The resumable decoder core — see the module header for the protocol. */
function* inflateChunked(st: InflateState): Generator<Yielded, void, Uint8Array> {
    let bfinal = 0;
    while (bfinal === 0) {
        bfinal = yield* readBitsG(st, 1);
        const btype = yield* readBitsG(st, 2);

        if (btype === 0) {
            // Stored block — realign to the byte boundary (the discarded
            // bits belong to already-consumed bytes, so accounting holds).
            st.bitBuf = 0;
            st.bitCnt = 0;
            const len = yield* readBitsG(st, 16);
            const nlen = yield* readBitsG(st, 16);
            if ((len ^ 0xFFFF) !== nlen) {
                throw new ZipFormatError('zipnative: deflate stored-block LEN/NLEN mismatch (corrupt stream)');
            }
            boundOutput(st, len);
            let remaining = len;
            while (remaining > 0) {
                while (st.pos >= st.buf.length) {
                    yield* refill(st);
                }
                if (st.winPos === WIN_SIZE) {
                    yield* slide(st);
                }
                const take = Math.min(remaining, st.buf.length - st.pos, WIN_SIZE - st.winPos);
                st.win.set(st.buf.subarray(st.pos, st.pos + take), st.winPos);
                st.pos += take;
                st.winPos += take;
                st.totalOut += take;
                remaining -= take;
            }
        } else if (btype === 1 || btype === 2) {
            let litLenTable: HuffmanTable;
            let distTable: HuffmanTable;

            if (btype === 1) {
                const fixed = getFixedTables();
                litLenTable = fixed.litLen;
                distTable = fixed.dist;
            } else {
                const hlit = (yield* readBitsG(st, 5)) + 257;
                const hdist = (yield* readBitsG(st, 5)) + 1;
                const hclen = (yield* readBitsG(st, 4)) + 4;

                const clLengths = new Uint8Array(19);
                for (let i = 0; i < hclen; i++) {
                    clLengths[CL_ORDER[i]] = yield* readBitsG(st, 3);
                }
                const clTable = buildHuffmanTable(clLengths, 19);

                const totalCodes = hlit + hdist;
                const codeLengths = new Uint8Array(totalCodes);
                let ci = 0;
                while (ci < totalCodes) {
                    const sym = yield* decodeSymbolG(st, clTable);
                    if (sym < 16) {
                        codeLengths[ci++] = sym;
                    } else if (sym === 16) {
                        if (ci === 0) {
                            throw new ZipFormatError('zipnative: deflate dynamic header repeats with no previous code length');
                        }
                        const repeat = (yield* readBitsG(st, 2)) + 3;
                        const prev = codeLengths[ci - 1];
                        for (let r = 0; r < repeat && ci < totalCodes; r++) codeLengths[ci++] = prev;
                    } else if (sym === 17) {
                        const repeat = (yield* readBitsG(st, 3)) + 3;
                        for (let r = 0; r < repeat && ci < totalCodes; r++) codeLengths[ci++] = 0;
                    } else {
                        const repeat = (yield* readBitsG(st, 7)) + 11;
                        for (let r = 0; r < repeat && ci < totalCodes; r++) codeLengths[ci++] = 0;
                    }
                }

                litLenTable = buildHuffmanTable(codeLengths.subarray(0, hlit), hlit);
                distTable = buildHuffmanTable(codeLengths.subarray(hlit), hdist);
            }

            for (;;) {
                const sym = yield* decodeSymbolG(st, litLenTable);
                if (sym < 256) {
                    boundOutput(st, 1);
                    if (st.winPos === WIN_SIZE) {
                        yield* slide(st);
                    }
                    st.win[st.winPos++] = sym;
                    st.totalOut++;
                } else if (sym === 256) {
                    break;
                } else {
                    const lenIdx = sym - 257;
                    if (lenIdx >= LEN_BASE.length) {
                        throw new ZipFormatError('zipnative: invalid length symbol in deflate stream');
                    }
                    const length = LEN_BASE[lenIdx] + (yield* readBitsG(st, LEN_EXTRA[lenIdx]));

                    const distSym = yield* decodeSymbolG(st, distTable);
                    if (distSym >= DIST_BASE.length) {
                        throw new ZipFormatError('zipnative: invalid distance symbol in deflate stream');
                    }
                    const distance = DIST_BASE[distSym] + (yield* readBitsG(st, DIST_EXTRA[distSym]));
                    if (distance > st.totalOut) {
                        throw new ZipFormatError('zipnative: deflate back-reference before start of output (corrupt stream)');
                    }

                    boundOutput(st, length);
                    for (let i = 0; i < length; i++) {
                        if (st.winPos === WIN_SIZE) {
                            yield* slide(st);
                        }
                        // After a slide winPos = 32768 ≥ distance, so the
                        // source index is always in range.
                        st.win[st.winPos] = st.win[st.winPos - distance];
                        st.winPos++;
                        st.totalOut++;
                    }
                }
            }
        } else {
            throw new ZipFormatError(`zipnative: unsupported deflate block type ${btype} (corrupt stream)`);
        }
    }

    // Final flush.
    if (st.winPos > st.emitStart) {
        yield { kind: 'data', bytes: st.win.slice(st.emitStart, st.winPos) };
        st.emitStart = st.winPos;
    }
}

/**
 * Create a resumable raw-deflate decoder.
 *
 * @param maxOutput - Hard decompressed-output bound (`ZipDataError` beyond it)
 */
export function createInflator(maxOutput: number): Inflator {
    const st: InflateState = {
        buf: new Uint8Array(0),
        pos: 0,
        bitBuf: 0,
        bitCnt: 0,
        win: new Uint8Array(WIN_SIZE),
        winPos: 0,
        emitStart: 0,
        totalOut: 0,
        maxOutput,
    };
    const generator = inflateChunked(st);
    let started = false;
    let finished = false;
    let consumedBase = 0;
    let leftover: Uint8Array = new Uint8Array(0);

    /** Resume the generator, collecting output until it needs input or ends. */
    const step = (chunk?: Uint8Array): Uint8Array[] => {
        const out: Uint8Array[] = [];
        let res: IteratorResult<Yielded, void>;
        if (!started) {
            started = true;
            res = generator.next();
        } else {
            res = generator.next(chunk as Uint8Array);
        }
        for (;;) {
            if (res.done) {
                finished = true;
                leftover = st.buf.subarray(st.pos);
                return out;
            }
            if (res.value.kind === 'data') {
                out.push(res.value.bytes);
                res = generator.next();
                continue;
            }
            return out; // suspended at 'need' — the fed buffer is fully consumed
        }
    };

    return {
        get finished(): boolean {
            return finished;
        },
        get leftover(): Uint8Array {
            return leftover;
        },
        get bytesConsumed(): number {
            return consumedBase + st.pos;
        },
        get bytesProduced(): number {
            return st.totalOut;
        },

        push(chunk: Uint8Array): Uint8Array[] {
            if (finished) {
                throw new ZipError(
                    'zipnative: push() after the deflate stream finished — check inflator.finished and use leftover');
            }
            if (!started) {
                step(); // run to the first input request (produces nothing)
                if (finished) {
                    // Degenerate: cannot happen (an empty stream still needs
                    // its first block header), but keep the contract exact.
                    return [];
                }
            }
            // The generator only suspends at 'need' with its buffer fully
            // consumed — account it before swapping in the new chunk.
            consumedBase += st.buf.length;
            return step(chunk);
        },

        end(): void {
            if (!finished) {
                throw new ZipFormatError(
                    'zipnative: deflate stream truncated — the final block never completed');
            }
        },
    };
}
