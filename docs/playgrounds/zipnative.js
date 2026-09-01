// src/types/zip-errors.ts
var ZipError = class extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
};
var ZipFormatError = class extends ZipError {
  constructor(code, message) {
    super(code, message);
    this.name = "ZipFormatError";
  }
};
var ZipLimitError = class extends ZipError {
  constructor(code, message, limit, configured, observed) {
    super(code, message);
    this.name = "ZipLimitError";
    this.limit = limit;
    this.configured = configured;
    this.observed = observed;
  }
};
var ZipSecurityError = class extends ZipError {
  constructor(code, message, entryName) {
    super(code, message);
    this.name = "ZipSecurityError";
    this.entryName = entryName;
  }
};
var ZipDataError = class extends ZipError {
  constructor(code, message, entryName, expectedCrc, actualCrc) {
    super(code, message);
    this.name = "ZipDataError";
    this.entryName = entryName;
    this.expectedCrc = expectedCrc;
    this.actualCrc = actualCrc;
  }
};
var ZipUnsupportedError = class extends ZipError {
  constructor(code, message, feature) {
    super(code, message);
    this.name = "ZipUnsupportedError";
    this.feature = feature;
  }
};

// src/codecs/crc32.ts
var _tables;
function buildTables() {
  const t = new Uint32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? (3988292384 ^ c >>> 1) >>> 0 : c >>> 1;
    }
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    for (let k = 1; k < 8; k++) {
      const prev = t[(k - 1) * 256 + n];
      t[k * 256 + n] = (prev >>> 8 ^ t[prev & 255]) >>> 0;
    }
  }
  return t;
}
function crc32(data, seed = 0) {
  const t = _tables ?? (_tables = buildTables());
  let c = ~seed >>> 0;
  let i = 0;
  const len = data.length;
  while (i + 8 <= len) {
    c = (c ^ (data[i] | data[i + 1] << 8 | data[i + 2] << 16 | data[i + 3] << 24)) >>> 0;
    const hi = (data[i + 4] | data[i + 5] << 8 | data[i + 6] << 16 | data[i + 7] << 24) >>> 0;
    c = (t[7 * 256 + (c & 255)] ^ t[6 * 256 + (c >>> 8 & 255)] ^ t[5 * 256 + (c >>> 16 & 255)] ^ t[4 * 256 + (c >>> 24)] ^ t[3 * 256 + (hi & 255)] ^ t[2 * 256 + (hi >>> 8 & 255)] ^ t[1 * 256 + (hi >>> 16 & 255)] ^ t[hi >>> 24]) >>> 0;
    i += 8;
  }
  while (i < len) {
    c = (c >>> 8 ^ t[(c ^ data[i++]) & 255]) >>> 0;
  }
  return ~c >>> 0;
}

// src/codecs/inflate-shared.ts
function buildHuffmanTable(lengths, maxSymbol) {
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
function buildFixedLitLenLengths() {
  const lengths = new Uint8Array(288);
  for (let i = 0; i <= 143; i++) lengths[i] = 8;
  for (let i = 144; i <= 255; i++) lengths[i] = 9;
  for (let i = 256; i <= 279; i++) lengths[i] = 7;
  for (let i = 280; i <= 287; i++) lengths[i] = 8;
  return lengths;
}
var _fixedLitLen;
var _fixedDist;
function getFixedTables() {
  if (_fixedLitLen === void 0 || _fixedDist === void 0) {
    _fixedLitLen = buildHuffmanTable(buildFixedLitLenLengths(), 288);
    const distLengths = new Uint8Array(32);
    distLengths.fill(5);
    _fixedDist = buildHuffmanTable(distLengths, 32);
  }
  return { litLen: _fixedLitLen, dist: _fixedDist };
}
var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
var CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// src/codecs/inflate-pure.ts
function readBits(br, n) {
  while (br.bitCnt < n) {
    if (br.pos >= br.buf.length) {
      throw new ZipFormatError("ZIP_DEFLATE_TRUNCATED", "zipnative: deflate stream truncated (unexpected end of data)");
    }
    br.bitBuf |= br.buf[br.pos++] << br.bitCnt;
    br.bitCnt += 8;
  }
  const val = br.bitBuf & (1 << n) - 1;
  br.bitBuf >>>= n;
  br.bitCnt -= n;
  return val;
}
function decodeSymbol(br, table) {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= 15; len++) {
    if (br.bitCnt < 1) {
      if (br.pos >= br.buf.length) {
        throw new ZipFormatError("ZIP_DEFLATE_TRUNCATED", "zipnative: deflate stream truncated (unexpected end of data)");
      }
      br.bitBuf |= br.buf[br.pos++] << br.bitCnt;
      br.bitCnt += 8;
    }
    const bit = br.bitBuf & 1;
    br.bitBuf >>>= 1;
    br.bitCnt--;
    code = code << 1 | bit;
    const count = table.counts[len];
    if (code - count < first) {
      return table.symbols[index + (code - first)];
    }
    index += count;
    first = first + count << 1;
  }
  throw new ZipFormatError("ZIP_DEFLATE_CORRUPT", "zipnative: invalid Huffman code in deflate stream");
}
function inflateRawJS(data, maxOutput) {
  const br = { buf: data, pos: 0, bitBuf: 0, bitCnt: 0 };
  const bounded = Number.isFinite(maxOutput);
  let out = new Uint8Array(bounded ? maxOutput : Math.min(data.length * 4, 1 << 20));
  let outPos = 0;
  const ensureCapacity = (needed) => {
    if (outPos + needed > maxOutput) {
      throw new ZipDataError(
        "ZIP_INFLATE_OUTPUT_OVERFLOW",
        `zipnative: deflate output exceeds the declared/permitted size of ${maxOutput} bytes (the archive metadata lies about this entry, or raise the relevant limit if intentional)`
      );
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
      br.bitBuf = 0;
      br.bitCnt = 0;
      if (br.pos + 4 > br.buf.length) {
        throw new ZipFormatError("ZIP_DEFLATE_TRUNCATED", "zipnative: deflate stored-block header truncated");
      }
      const len = br.buf[br.pos] | br.buf[br.pos + 1] << 8;
      const nlen = br.buf[br.pos + 2] | br.buf[br.pos + 3] << 8;
      br.pos += 4;
      if ((len ^ 65535) !== nlen) {
        throw new ZipFormatError("ZIP_DEFLATE_CORRUPT", "zipnative: deflate stored-block LEN/NLEN mismatch (corrupt stream)");
      }
      if (br.pos + len > br.buf.length) {
        throw new ZipFormatError("ZIP_DEFLATE_TRUNCATED", "zipnative: deflate stored-block data truncated");
      }
      ensureCapacity(len);
      out.set(br.buf.subarray(br.pos, br.pos + len), outPos);
      outPos += len;
      br.pos += len;
    } else if (btype === 1 || btype === 2) {
      let litLenTable;
      let distTable;
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
              throw new ZipFormatError("ZIP_DEFLATE_CORRUPT", "zipnative: deflate dynamic header repeats with no previous code length");
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
      for (; ; ) {
        const sym = decodeSymbol(br, litLenTable);
        if (sym < 256) {
          ensureCapacity(1);
          out[outPos++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const lenIdx = sym - 257;
          if (lenIdx >= LEN_BASE.length) {
            throw new ZipFormatError("ZIP_DEFLATE_CORRUPT", "zipnative: invalid length symbol in deflate stream");
          }
          const length = LEN_BASE[lenIdx] + readBits(br, LEN_EXTRA[lenIdx]);
          const distSym = decodeSymbol(br, distTable);
          if (distSym >= DIST_BASE.length) {
            throw new ZipFormatError("ZIP_DEFLATE_CORRUPT", "zipnative: invalid distance symbol in deflate stream");
          }
          const distance = DIST_BASE[distSym] + readBits(br, DIST_EXTRA[distSym]);
          if (distance > outPos) {
            throw new ZipFormatError("ZIP_DEFLATE_CORRUPT", "zipnative: deflate back-reference before start of output (corrupt stream)");
          }
          ensureCapacity(length);
          for (let i = 0; i < length; i++) {
            out[outPos] = out[outPos - distance];
            outPos++;
          }
        }
      }
    } else {
      throw new ZipFormatError("ZIP_DEFLATE_CORRUPT", `zipnative: unsupported deflate block type ${btype} (corrupt stream)`);
    }
  }
  return outPos === out.length ? out : out.subarray(0, outPos);
}

// src/codecs/deflate-pure.ts
var MIN_MATCH = 3;
var MAX_MATCH = 258;
var WSIZE = 32768;
var WMASK = WSIZE - 1;
var TOO_FAR = 4096;
var HASH_SHIFT = 17;
var HASH_SIZE = 32768;
var BLOCK_SYMS = 65534;
var STORED_MAX = 65535;
var LEN_BASE2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
var LEN_EXTRA2 = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
var DIST_BASE2 = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
var DIST_EXTRA2 = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
var CL_ORDER2 = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
var CFG_GOOD = [0, 4, 4, 4, 4, 8, 8, 8, 32, 32];
var CFG_LAZY = [0, 4, 5, 6, 4, 16, 16, 32, 128, 258];
var CFG_NICE = [0, 8, 16, 32, 16, 32, 128, 128, 258, 258];
var CFG_CHAIN = [0, 4, 8, 32, 16, 32, 128, 256, 1024, 4096];
var _tables2;
function reverseBits(code, len) {
  let out = 0;
  for (let i = 0; i < len; i++) {
    out = out << 1 | code >>> i & 1;
  }
  return out;
}
function buildEncoderTables() {
  const lengthSym = new Uint8Array(256);
  for (let i = 0; i < 28; i++) {
    for (let len = LEN_BASE2[i]; len < LEN_BASE2[i + 1]; len++) {
      lengthSym[len - MIN_MATCH] = i;
    }
  }
  lengthSym[MAX_MATCH - MIN_MATCH] = 28;
  const distSym = new Uint8Array(512);
  let d1 = 0;
  for (let code = 0; code < 16; code++) {
    for (let n = 0; n < 1 << DIST_EXTRA2[code]; n++) distSym[d1++] = code;
  }
  let d = 2;
  for (let code = 16; code < 30; code++) {
    for (let n = 0; n < 1 << DIST_EXTRA2[code] - 7; n++) distSym[256 + d++] = code;
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
function ensure(bw, needed) {
  if (bw.pos + needed <= bw.out.length) return;
  let size = bw.out.length * 2;
  while (size < bw.pos + needed) size *= 2;
  const grown = new Uint8Array(size);
  grown.set(bw.out);
  bw.out = grown;
}
function writeBits(bw, value, nbits) {
  bw.bitBuf |= value << bw.bitCnt;
  bw.bitCnt += nbits;
  while (bw.bitCnt >= 8) {
    ensure(bw, 1);
    bw.out[bw.pos++] = bw.bitBuf & 255;
    bw.bitBuf >>>= 8;
    bw.bitCnt -= 8;
  }
}
function alignByte(bw) {
  if (bw.bitCnt > 0) {
    ensure(bw, 1);
    bw.out[bw.pos++] = bw.bitBuf & 255;
    bw.bitBuf = 0;
    bw.bitCnt = 0;
  }
}
function finishWriter(bw) {
  alignByte(bw);
  return bw.out.subarray(0, bw.pos);
}
function buildCodeLengths(freq, n, maxBits) {
  const lengths = new Uint8Array(n);
  const leaves = [];
  for (let s = 0; s < n; s++) {
    if (freq[s] > 0) leaves.push(s);
  }
  leaves.sort((a, b) => freq[a] - freq[b] || a - b);
  const m = leaves.length;
  if (m === 0) {
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
  const total = 2 * m - 1;
  const nodeFreq = new Float64Array(total);
  const parent = new Int32Array(total);
  for (let j = 0; j < m; j++) nodeFreq[j] = freq[leaves[j]];
  let leafHead = 0;
  let intHead = m;
  let next = m;
  const pick = () => {
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
  const depth = new Uint16Array(total);
  for (let k = total - 2; k >= 0; k--) {
    depth[k] = depth[parent[k]] + 1;
  }
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
  let leafIdx = 0;
  for (let bits = maxBits; bits >= 1; bits--) {
    for (let k = 0; k < blCount[bits]; k++) {
      lengths[leaves[leafIdx++]] = bits;
    }
  }
  return lengths;
}
function buildCanonicalCodes(lengths, n) {
  const codes = new Uint16Array(n);
  const blCount = new Uint32Array(16);
  for (let s = 0; s < n; s++) {
    if (lengths[s] > 0) blCount[lengths[s]]++;
  }
  const nextCode = new Uint32Array(16);
  let code = 0;
  for (let bits = 1; bits <= 15; bits++) {
    code = code + blCount[bits - 1] << 1;
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
function tokenizeCodeLengths(litLens, hlit, distLens, hdist) {
  const seq = new Uint8Array(hlit + hdist);
  seq.set(litLens.subarray(0, hlit), 0);
  seq.set(distLens.subarray(0, hdist), hlit);
  const syms = new Uint8Array(seq.length);
  const args = new Uint8Array(seq.length);
  const clFreq = new Uint32Array(19);
  let count = 0;
  const push = (sym, arg) => {
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
var CL_EXTRA_BITS = (sym) => sym === 16 ? 2 : sym === 17 ? 3 : sym === 18 ? 7 : 0;
function writeStoredRange(bw, data, start, end, isFinal) {
  let offset = start;
  let remaining = end - start;
  while (remaining > 0 || offset === start) {
    const pieceLen = Math.min(remaining, STORED_MAX);
    const last = remaining - pieceLen === 0;
    writeBits(bw, isFinal && last ? 1 : 0, 1);
    writeBits(bw, 0, 2);
    alignByte(bw);
    ensure(bw, 4 + pieceLen);
    bw.out[bw.pos++] = pieceLen & 255;
    bw.out[bw.pos++] = pieceLen >>> 8 & 255;
    bw.out[bw.pos++] = ~pieceLen & 255;
    bw.out[bw.pos++] = ~pieceLen >>> 8 & 255;
    bw.out.set(data.subarray(offset, offset + pieceLen), bw.pos);
    bw.pos += pieceLen;
    offset += pieceLen;
    remaining -= pieceLen;
    if (remaining === 0) break;
  }
}
function emitBlock(bw, data, blockStart, blockEnd, litBuf, distBuf, symCount, litFreq, distFreq, isFinal, t) {
  litFreq[256] = 1;
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
  while (hclen > 4 && clLens[CL_ORDER2[hclen - 1]] === 0) hclen--;
  const dataBits = (L, D) => {
    let bits = 0;
    for (let s = 0; s < 286; s++) {
      if (litFreq[s] > 0) {
        bits += litFreq[s] * (L[s] + (s >= 257 ? LEN_EXTRA2[s - 257] : 0));
      }
    }
    for (let c = 0; c < 30; c++) {
      if (distFreq[c] > 0) {
        bits += distFreq[c] * (D[c] + DIST_EXTRA2[c]);
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
  const pad0 = 8 - (bw.bitCnt + 3 & 7) & 7;
  const storedBits = 3 + pad0 + 32 + 8 * n + (pieces - 1) * 40;
  if (storedBits <= fixedBits && storedBits <= dynamicBits) {
    writeStoredRange(bw, data, blockStart, blockEnd, isFinal);
    return;
  }
  const useFixed = fixedBits <= dynamicBits;
  writeBits(bw, isFinal ? 1 : 0, 1);
  writeBits(bw, useFixed ? 1 : 2, 2);
  let litCodes;
  let litL;
  let distCodes;
  let distL;
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
      writeBits(bw, clLens[CL_ORDER2[k]], 3);
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
      if (LEN_EXTRA2[li] > 0) writeBits(bw, len - LEN_BASE2[li], LEN_EXTRA2[li]);
      const d1 = dist - 1;
      const dc = d1 < 256 ? t.distSym[d1] : t.distSym[256 + (d1 >>> 7)];
      writeBits(bw, distCodes[dc], distL[dc]);
      if (DIST_EXTRA2[dc] > 0) writeBits(bw, d1 - (DIST_BASE2[dc] - 1), DIST_EXTRA2[dc]);
    }
  }
  writeBits(bw, litCodes[256], litL[256]);
}
function deflateStored(data) {
  const bw = {
    out: new Uint8Array(data.length + 5 * Math.max(1, Math.ceil(data.length / STORED_MAX)) + 8),
    pos: 0,
    bitBuf: 0,
    bitCnt: 0
  };
  writeStoredRange(bw, data, 0, data.length, true);
  return finishWriter(bw);
}
function deflateRawJS(data, level) {
  if (!Number.isInteger(level) || level < 0 || level > 9) {
    throw new ZipError("ZIP_INVALID_OPTION", `zipnative: deflate level must be an integer 0-9 (got ${String(level)})`);
  }
  if (data.length > 2147483646) {
    throw new ZipError("ZIP_INPUT_TOO_LARGE", "zipnative: deflate input exceeds 2 GiB \u2014 split the input");
  }
  if (level === 0) return deflateStored(data);
  const t = _tables2 ?? (_tables2 = buildEncoderTables());
  const len = data.length;
  const bw = {
    out: new Uint8Array(Math.max(256, len >>> 1)),
    pos: 0,
    bitBuf: 0,
    bitCnt: 0
  };
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(WSIZE);
  const hashAt = (p) => Math.imul(data[p] << 16 | data[p + 1] << 8 | data[p + 2], 2654435761) >>> HASH_SHIFT;
  const insert = (p) => {
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
  const longestMatch = (pos, firstCand, bestSoFar) => {
    matchLen = 0;
    matchDist = 0;
    const maxLen = Math.min(MAX_MATCH, len - pos);
    if (maxLen < MIN_MATCH) return;
    let bestLen = bestSoFar > 2 ? bestSoFar : 2;
    if (bestLen >= maxLen) return;
    let bestDist = 0;
    const limit = pos > WSIZE ? pos - WSIZE : 0;
    const nice = niceCfg < maxLen ? niceCfg : maxLen;
    let chain = maxChain;
    if (bestSoFar >= good) chain >>= 2;
    let cand = firstCand;
    do {
      if (cand < limit || cand >= pos) break;
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
  const litBuf = new Uint16Array(BLOCK_SYMS);
  const distBuf = new Uint16Array(BLOCK_SYMS);
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  let symCount = 0;
  let blockStart = 0;
  let emittedEnd = 0;
  const flushIfFull = () => {
    if (symCount === BLOCK_SYMS) {
      emitBlock(bw, data, blockStart, emittedEnd, litBuf, distBuf, symCount, litFreq, distFreq, false, t);
      blockStart = emittedEnd;
      symCount = 0;
      litFreq.fill(0);
      distFreq.fill(0);
    }
  };
  const pushLiteral = (c) => {
    litBuf[symCount] = c;
    distBuf[symCount] = 0;
    symCount++;
    litFreq[c]++;
    emittedEnd += 1;
    flushIfFull();
  };
  const pushPair = (l, dst) => {
    litBuf[symCount] = l;
    distBuf[symCount] = dst;
    symCount++;
    litFreq[257 + t.lengthSym[l - MIN_MATCH]]++;
    const d1 = dst - 1;
    distFreq[d1 < 256 ? t.distSym[d1] : t.distSym[256 + (d1 >>> 7)]]++;
    emittedEnd += l;
    flushIfFull();
  };
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
      pushPair(deferLen, deferDist);
      const last = i + deferLen - 2;
      for (let j = i + 1; j <= last; j++) insert(j);
      i += deferLen - 1;
      havePrev = false;
      deferLen = 0;
    } else {
      if (havePrev) {
        pushLiteral(data[i - 1]);
      }
      havePrev = true;
      deferLen = curLen;
      deferDist = curDist;
      i += 1;
    }
  }
  if (havePrev) {
    pushLiteral(data[len - 1]);
  }
  emitBlock(bw, data, blockStart, emittedEnd, litBuf, distBuf, symCount, litFreq, distFreq, true, t);
  return finishWriter(bw);
}

// src/codecs/deflate.ts
var _injected = null;
var _nodeDeflateRaw;
function setDeflateImpl(fn) {
  _injected = fn;
}
function getNodeDeflateRaw() {
  if (_nodeDeflateRaw !== void 0) return _nodeDeflateRaw;
  try {
    const g = globalThis;
    const proc = g["process"];
    if (!proc?.versions?.node) {
      _nodeDeflateRaw = null;
      return null;
    }
    const req = g["__non_webpack_require__"] ?? g["require"];
    if (req) {
      const zlib = req("node:zlib");
      const fn = zlib["deflateRawSync"];
      if (typeof fn === "function") {
        _nodeDeflateRaw = (data, level) => new Uint8Array(fn(data, { level }));
        return _nodeDeflateRaw;
      }
    }
    _nodeDeflateRaw = null;
    return null;
  } catch {
    _nodeDeflateRaw = null;
    return null;
  }
}
async function initNodeDeflate() {
  if (_nodeDeflateRaw !== void 0) return;
  try {
    const g = globalThis;
    const proc = g["process"];
    if (!proc?.versions?.node) {
      _nodeDeflateRaw = null;
      return;
    }
    const modName = "node:zlib";
    const zlib = await import(modName);
    const fn = zlib["deflateRawSync"];
    _nodeDeflateRaw = typeof fn === "function" ? (data, level) => new Uint8Array(fn(data, { level })) : null;
  } catch {
    _nodeDeflateRaw = null;
  }
}
function deflateRawSync(data, level, deterministic = false) {
  if (deterministic) return deflateRawJS(data, level);
  if (_injected) return _injected(data, level);
  const node = getNodeDeflateRaw();
  if (node) return node(data, level);
  return deflateRawJS(data, level);
}
function activeDeflateTier(deterministic = false) {
  if (deterministic) return "pure-pinned";
  if (_injected) return "injected";
  if (getNodeDeflateRaw()) return "node-zlib";
  return "pure";
}

// src/codecs/inflate.ts
var _injected2 = null;
var _nodeInflateRaw;
function setInflateImpl(fn) {
  _injected2 = fn;
}
function getNodeInflateRaw() {
  if (_nodeInflateRaw !== void 0) return _nodeInflateRaw;
  try {
    const g = globalThis;
    const proc = g["process"];
    if (!proc?.versions?.node) {
      _nodeInflateRaw = null;
      return null;
    }
    const req = g["__non_webpack_require__"] ?? g["require"];
    if (req) {
      const zlib = req("node:zlib");
      const fn = zlib["inflateRawSync"];
      if (typeof fn === "function") {
        _nodeInflateRaw = (data, maxOutput) => wrapNodeInflate(fn, data, maxOutput);
        return _nodeInflateRaw;
      }
    }
    _nodeInflateRaw = null;
    return null;
  } catch {
    _nodeInflateRaw = null;
    return null;
  }
}
async function initNodeZipCodecs() {
  await initNodeDeflate();
  if (_nodeInflateRaw !== void 0) return;
  try {
    const g = globalThis;
    const proc = g["process"];
    if (!proc?.versions?.node) {
      _nodeInflateRaw = null;
      return;
    }
    const modName = "node:zlib";
    const zlib = await import(modName);
    const fn = zlib["inflateRawSync"];
    _nodeInflateRaw = typeof fn === "function" ? (data, maxOutput) => wrapNodeInflate(fn, data, maxOutput) : null;
  } catch {
    _nodeInflateRaw = null;
  }
}
function wrapNodeInflate(fn, data, maxOutput) {
  try {
    const opts = Number.isFinite(maxOutput) ? { maxOutputLength: maxOutput } : void 0;
    return new Uint8Array(fn(data, opts));
  } catch (err) {
    const code = err.code;
    if (code === "ERR_BUFFER_TOO_LARGE") {
      throw new ZipDataError(
        "ZIP_INFLATE_OUTPUT_OVERFLOW",
        `zipnative: deflate output exceeds the declared/permitted size of ${maxOutput} bytes (the archive metadata lies about this entry, or raise the relevant limit if intentional)`
      );
    }
    throw err;
  }
}
function inflateRawSync(data, maxOutput) {
  if (_injected2) return _injected2(data, maxOutput);
  const node = getNodeInflateRaw();
  if (node) return node(data, maxOutput);
  return inflateRawJS(data, maxOutput);
}
function hasDecompressionStream() {
  try {
    return typeof globalThis.DecompressionStream === "function";
  } catch {
    return false;
  }
}
async function* inflateRawStream(data, maxOutput, chunkSize = 64 * 1024) {
  if (!_injected2 && hasDecompressionStream()) {
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    const writePromise = writer.write(data.slice()).then(() => writer.close());
    writePromise.catch(() => {
    });
    const reader = ds.readable.getReader();
    let produced = 0;
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      produced += value.length;
      if (produced > maxOutput) {
        await reader.cancel();
        throw new ZipDataError(
          "ZIP_INFLATE_OUTPUT_OVERFLOW",
          `zipnative: deflate output exceeds the declared/permitted size of ${maxOutput} bytes (the archive metadata lies about this entry, or raise the relevant limit if intentional)`
        );
      }
      yield value;
    }
    await writePromise;
    return;
  }
  const out = inflateRawSync(data, maxOutput);
  for (let i = 0; i < out.length; i += chunkSize) {
    yield out.subarray(i, Math.min(i + chunkSize, out.length));
  }
}

// src/codecs/codec-registry.ts
var METHOD_STORE = 0;
var METHOD_DEFLATE = 8;
var _registry;
function registry() {
  if (_registry === void 0) {
    _registry = /* @__PURE__ */ new Map();
    _registry.set(METHOD_STORE, {
      method: METHOD_STORE,
      name: "store",
      compressSync: (data) => data,
      decompressSync: (data) => data,
      decompressStream: async function* (data) {
        const chunkSize = 64 * 1024;
        for (let i = 0; i < data.length; i += chunkSize) {
          yield data.subarray(i, Math.min(i + chunkSize, data.length));
        }
      }
    });
    _registry.set(METHOD_DEFLATE, {
      method: METHOD_DEFLATE,
      name: "deflate",
      compressSync: (data, options) => deflateRawSync(data, options.level, options.deterministic),
      decompressSync: inflateRawSync,
      decompressStream: inflateRawStream
    });
  }
  return _registry;
}
function registerCodec(codec) {
  registry().set(codec.method, codec);
}
function getCodec(method) {
  return registry().get(method) ?? null;
}

// src/core/zip-constants.ts
var SIG_LOCAL_FILE_HEADER = 67324752;
var SIG_CENTRAL_FILE_HEADER = 33639248;
var SIG_EOCD = 101010256;
var SIG_ZIP64_EOCD = 101075792;
var SIG_ZIP64_EOCD_LOCATOR = 117853008;
var SIG_DATA_DESCRIPTOR = 134695760;
var LOCAL_FILE_HEADER_SIZE = 30;
var CENTRAL_FILE_HEADER_SIZE = 46;
var EOCD_SIZE = 22;
var ZIP64_EOCD_MIN_SIZE = 56;
var ZIP64_EOCD_LOCATOR_SIZE = 20;
var MAX_EOCD_SCAN = EOCD_SIZE + 65535;
var FLAG_ENCRYPTED = 1;
var FLAG_DATA_DESCRIPTOR = 8;
var FLAG_STRONG_ENCRYPTION = 64;
var FLAG_UTF8 = 2048;
var SENTINEL_U16 = 65535;
var SENTINEL_U32 = 4294967295;
var EXTRA_ZIP64 = 1;
var DOS_ATTR_DIRECTORY = 16;
var UNIX_TYPE_MASK = 61440;
var UNIX_TYPE_SYMLINK = 40960;

// src/core/zip-diagnostics.ts
function createDiagnosticEmitter(strict, handler) {
  const warned = /* @__PURE__ */ new Set();
  return (diagnostic) => {
    if (strict) {
      throw new ZipError("ZIP_STRICT_DIAGNOSTIC", `zipnative: [${diagnostic.code}] ${diagnostic.message}`);
    }
    if (handler) {
      handler(diagnostic);
      return;
    }
    if (!warned.has(diagnostic.code)) {
      warned.add(diagnostic.code);
      console.warn(`zipnative: ${diagnostic.message}`);
    }
  };
}
function prependedDataDiagnostic(base) {
  return {
    code: "ZIP_PREPENDED_DATA",
    severity: "info",
    message: `${base} byte(s) precede the archive (self-extractor stub or concatenation); all offsets were shifted accordingly. Verify the prefix is expected for this file.`
  };
}
function multipleEocdDiagnostic() {
  return {
    code: "ZIP_MULTIPLE_EOCD",
    severity: "info",
    message: "an additional end-of-central-directory signature exists inside the archive (nested zip or an earlier revision); the self-consistent record closest to the end is authoritative."
  };
}
function nameMismatchDiagnostic(entryName) {
  return {
    code: "ZIP_NAME_MISMATCH",
    severity: "warning",
    message: `entry '${entryName}': local-header filename bytes differ from the central directory (a parser-differential trick in hostile archives); the central directory is authoritative. Pass strict: true to reject such archives.`,
    entryName
  };
}
function unicodePathConflictDiagnostic(entryName) {
  return {
    code: "ZIP_UNICODE_PATH_CONFLICT",
    severity: "warning",
    message: `entry '${entryName}': the Unicode Path extra field (0x7075) disagrees with the header name; zipnative never acts on 0x7075 \u2014 the header name wins. Pass strict: true to reject such archives.`,
    entryName
  };
}
function invalidUtf8NameDiagnostic(entryName) {
  return {
    code: "ZIP_INVALID_UTF8_NAME",
    severity: "warning",
    message: `entry '${entryName}': the UTF-8 flag (bit 11) is set but the name bytes are not valid UTF-8; decoded as CP437 instead. The producer of this archive is buggy.`,
    entryName
  };
}
function duplicateNameDiagnostic(entryName) {
  return {
    code: "ZIP_DUPLICATE_NAME",
    severity: "warning",
    message: `entry '${entryName}' appears more than once in the central directory; getEntry() returns the last occurrence. extractZip defaults to onDuplicate: 'error'.`,
    entryName
  };
}
function extraFieldMalformedDiagnostic(entryName) {
  return {
    code: "ZIP_EXTRA_FIELD_MALFORMED",
    severity: "warning",
    message: `entry '${entryName}': an extra field overruns its declared length and was skipped (the producer of this archive is buggy).`,
    entryName
  };
}
function timestampNotPinnedDiagnostic() {
  return {
    code: "ZIP_TIMESTAMP_NOT_PINNED",
    severity: "info",
    message: "createZip used the wall clock (defaultDate: 'now') \u2014 output bytes will differ on every run. Pass a fixed Date (or omit defaultDate for the DOS-epoch default) for reproducible archives."
  };
}
function nondeterministicCodecDiagnostic() {
  return {
    code: "ZIP_NONDETERMINISTIC_CODEC",
    severity: "info",
    message: "this archive pins its timestamps but compresses through the platform codec, so bytes are stable only per zlib build \u2014 pass compression: { deterministic: true } for cross-runtime byte-identical output (see docs/determinism.md)."
  };
}
function deadBytesRatioDiagnostic(deadBytes, totalBytes) {
  const percent = Math.round(deadBytes / totalBytes * 100);
  return {
    code: "ZIP_DEAD_BYTES_RATIO",
    severity: "info",
    message: `incremental save(): ${percent}% of the output (${deadBytes} of ${totalBytes} bytes) is dead \u2014 removed/replaced content REMAINS RECOVERABLE in this file. Use saveCompact() for true deletion and a compact layout.`
  };
}
function zip64ExtraIgnoredDiagnostic(entryName) {
  return {
    code: "ZIP_ZIP64_EXTRA_IGNORED",
    severity: "warning",
    message: `entry '${entryName}': a zip64 extra field supplies a value for a header field that is not set to its sentinel; the non-sentinel header value wins (spoofing-resistant reading). Pass strict: true to reject such archives.`,
    entryName
  };
}

// src/core/zip-encoding.ts
var CP437_HIGH = "\xC7\xFC\xE9\xE2\xE4\xE0\xE5\xE7\xEA\xEB\xE8\xEF\xEE\xEC\xC4\xC5\xC9\xE6\xC6\xF4\xF6\xF2\xFB\xF9\xFF\xD6\xDC\xA2\xA3\xA5\u20A7\u0192\xE1\xED\xF3\xFA\xF1\xD1\xAA\xBA\xBF\u2310\xAC\xBD\xBC\xA1\xAB\xBB\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255D\u255C\u255B\u2510\u2514\u2534\u252C\u251C\u2500\u253C\u255E\u255F\u255A\u2554\u2569\u2566\u2560\u2550\u256C\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256B\u256A\u2518\u250C\u2588\u2584\u258C\u2590\u2580\u03B1\xDF\u0393\u03C0\u03A3\u03C3\xB5\u03C4\u03A6\u0398\u03A9\u03B4\u221E\u03C6\u03B5\u2229\u2261\xB1\u2265\u2264\u2320\u2321\xF7\u2248\xB0\u2219\xB7\u221A\u207F\xB2\u25A0\xA0";
var _utf8Strict;
function decodeUtf8Strict(bytes) {
  _utf8Strict ?? (_utf8Strict = new TextDecoder("utf-8", { fatal: true }));
  try {
    return _utf8Strict.decode(bytes);
  } catch {
    return null;
  }
}
function decodeCp437(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += b < 128 ? String.fromCharCode(b) : CP437_HIGH[b - 128];
  }
  return out;
}
function compareNames(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
function validateEntryName(name, isDirectory) {
  if (name.length === 0) {
    throw new ZipFormatError("ZIP_INVALID_ENTRY_NAME", "zipnative: entry name must not be empty");
  }
  if (name.includes("\0")) {
    throw new ZipFormatError("ZIP_INVALID_ENTRY_NAME", "zipnative: entry name must not contain NUL bytes");
  }
  if (name.includes("\\")) {
    throw new ZipFormatError(
      "ZIP_INVALID_ENTRY_NAME",
      `zipnative: entry name '${name}' contains a backslash \u2014 ZIP paths use forward slashes ('/')`
    );
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new ZipFormatError(
      "ZIP_INVALID_ENTRY_NAME",
      `zipnative: entry name '${name}' is absolute \u2014 archive paths must be relative`
    );
  }
  for (const segment of name.split("/")) {
    if (segment === "..") {
      throw new ZipFormatError(
        "ZIP_INVALID_ENTRY_NAME",
        `zipnative: entry name '${name}' contains a '..' segment \u2014 zipnative never writes traversal-capable archives`
      );
    }
  }
  if (isDirectory && !name.endsWith("/")) return `${name}/`;
  return name;
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// src/core/zip-limits.ts
var DEFAULT_ZIP_LIMITS = {
  maxEntries: 1e5,
  maxEntryUncompressedSize: 1024 * 1024 * 1024,
  // 1 GiB
  maxTotalUncompressedSize: 8 * 1024 * 1024 * 1024,
  // 8 GiB
  maxCompressionRatio: 1024,
  maxNameBytes: 4096,
  maxExtraFieldBytes: 65535,
  maxCommentBytes: 65535,
  maxCentralDirectoryBytes: 256 * 1024 * 1024
  // 256 MiB
};
function resolveLimits(overrides) {
  if (overrides === void 0) return DEFAULT_ZIP_LIMITS;
  const merged = { ...DEFAULT_ZIP_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === void 0) continue;
    if (!(key in merged)) {
      throw new ZipLimitError(
        "ZIP_LIMIT_INVALID",
        `zipnative: unknown limit '${key}' (valid keys: ${Object.keys(merged).join(", ")})`,
        key,
        NaN,
        NaN
      );
    }
    if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
      throw new ZipLimitError(
        "ZIP_LIMIT_INVALID",
        `zipnative: limit '${key}' must be a positive number or Infinity, got ${String(value)}`,
        key,
        NaN,
        NaN
      );
    }
    merged[key] = value;
  }
  return merged;
}
function enforceLimit(limits, limit, observed, context) {
  const configured = limits[limit];
  if (observed > configured) {
    throw new ZipLimitError(
      "ZIP_LIMIT_EXCEEDED",
      `zipnative: ${context} (${observed}) exceeds limits.${limit} (${configured}) \u2014 raise limits.${limit} explicitly if this archive is trusted`,
      limit,
      configured,
      observed
    );
  }
}

// src/core/zip-structs.ts
function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function toSafeNumber(value, field) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipFormatError(
      "ZIP_VALUE_UNREPRESENTABLE",
      `zipnative: ${field} is ${value}, beyond Number.MAX_SAFE_INTEGER \u2014 archives this large are not supported`
    );
  }
  return Number(value);
}
function parseEocd(bytes, pos) {
  if (pos + EOCD_SIZE > bytes.length) {
    throw new ZipFormatError("ZIP_RECORD_TRUNCATED", "zipnative: end-of-central-directory record truncated");
  }
  const dv = viewOf(bytes);
  if (dv.getUint32(pos, true) !== SIG_EOCD) {
    throw new ZipFormatError("ZIP_SIGNATURE_MISMATCH", "zipnative: end-of-central-directory signature missing at expected offset");
  }
  const commentLength = dv.getUint16(pos + 20, true);
  return {
    diskNumber: dv.getUint16(pos + 4, true),
    cdStartDisk: dv.getUint16(pos + 6, true),
    entriesOnDisk: dv.getUint16(pos + 8, true),
    totalEntries: dv.getUint16(pos + 10, true),
    cdSize: dv.getUint32(pos + 12, true),
    cdOffset: dv.getUint32(pos + 16, true),
    commentLength,
    comment: bytes.subarray(pos + EOCD_SIZE, pos + EOCD_SIZE + commentLength)
  };
}
function parseZip64Locator(bytes, pos) {
  if (pos < 0 || pos + ZIP64_EOCD_LOCATOR_SIZE > bytes.length) return null;
  const dv = viewOf(bytes);
  if (dv.getUint32(pos, true) !== SIG_ZIP64_EOCD_LOCATOR) return null;
  return {
    eocd64Disk: dv.getUint32(pos + 4, true),
    eocd64Offset: toSafeNumber(dv.getBigUint64(pos + 8, true), "zip64 EOCD locator offset"),
    totalDisks: dv.getUint32(pos + 16, true)
  };
}
function hasZip64EocdSignature(bytes, pos) {
  if (pos < 0 || pos + 4 > bytes.length) return false;
  return viewOf(bytes).getUint32(pos, true) === SIG_ZIP64_EOCD;
}
function parseZip64Eocd(bytes, pos) {
  if (pos + ZIP64_EOCD_MIN_SIZE > bytes.length) {
    throw new ZipFormatError("ZIP_RECORD_TRUNCATED", "zipnative: zip64 end-of-central-directory record truncated");
  }
  const dv = viewOf(bytes);
  return {
    versionMadeBy: dv.getUint16(pos + 12, true),
    versionNeeded: dv.getUint16(pos + 14, true),
    diskNumber: dv.getUint32(pos + 16, true),
    cdStartDisk: dv.getUint32(pos + 20, true),
    entriesOnDisk: toSafeNumber(dv.getBigUint64(pos + 24, true), "zip64 entries-on-disk"),
    totalEntries: toSafeNumber(dv.getBigUint64(pos + 32, true), "zip64 total entries"),
    cdSize: toSafeNumber(dv.getBigUint64(pos + 40, true), "zip64 central-directory size"),
    cdOffset: toSafeNumber(dv.getBigUint64(pos + 48, true), "zip64 central-directory offset")
  };
}
function parseCentralFileHeader(bytes, pos) {
  if (pos + CENTRAL_FILE_HEADER_SIZE > bytes.length) {
    throw new ZipFormatError("ZIP_RECORD_TRUNCATED", "zipnative: central-directory file header truncated");
  }
  const dv = viewOf(bytes);
  if (dv.getUint32(pos, true) !== SIG_CENTRAL_FILE_HEADER) {
    throw new ZipFormatError("ZIP_SIGNATURE_MISMATCH", "zipnative: central-directory file header signature missing (corrupt central directory)");
  }
  const nameLength = dv.getUint16(pos + 28, true);
  const extraLength = dv.getUint16(pos + 30, true);
  const commentLength = dv.getUint16(pos + 32, true);
  const recordLength = CENTRAL_FILE_HEADER_SIZE + nameLength + extraLength + commentLength;
  if (pos + recordLength > bytes.length) {
    throw new ZipFormatError("ZIP_RECORD_TRUNCATED", "zipnative: central-directory file header variable fields truncated");
  }
  const nameStart = pos + CENTRAL_FILE_HEADER_SIZE;
  return {
    versionMadeBy: dv.getUint16(pos + 4, true),
    versionNeeded: dv.getUint16(pos + 6, true),
    flags: dv.getUint16(pos + 8, true),
    compressionMethod: dv.getUint16(pos + 10, true),
    dosTime: dv.getUint16(pos + 12, true),
    dosDate: dv.getUint16(pos + 14, true),
    crc32: dv.getUint32(pos + 16, true),
    compressedSize: dv.getUint32(pos + 20, true),
    uncompressedSize: dv.getUint32(pos + 24, true),
    diskNumberStart: dv.getUint16(pos + 34, true),
    internalAttributes: dv.getUint16(pos + 36, true),
    externalAttributes: dv.getUint32(pos + 38, true),
    localHeaderOffset: dv.getUint32(pos + 42, true),
    name: bytes.subarray(nameStart, nameStart + nameLength),
    extra: bytes.subarray(nameStart + nameLength, nameStart + nameLength + extraLength),
    comment: bytes.subarray(nameStart + nameLength + extraLength, pos + recordLength),
    recordLength
  };
}
function writeLocalFileHeader(f) {
  const out = new Uint8Array(LOCAL_FILE_HEADER_SIZE + f.name.length + f.extra.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, SIG_LOCAL_FILE_HEADER, true);
  dv.setUint16(4, f.versionNeeded, true);
  dv.setUint16(6, f.flags, true);
  dv.setUint16(8, f.compressionMethod, true);
  dv.setUint16(10, f.dosTime, true);
  dv.setUint16(12, f.dosDate, true);
  dv.setUint32(14, f.crc32 >>> 0, true);
  dv.setUint32(18, f.compressedSize >>> 0, true);
  dv.setUint32(22, f.uncompressedSize >>> 0, true);
  dv.setUint16(26, f.name.length, true);
  dv.setUint16(28, f.extra.length, true);
  out.set(f.name, LOCAL_FILE_HEADER_SIZE);
  out.set(f.extra, LOCAL_FILE_HEADER_SIZE + f.name.length);
  return out;
}
function writeDataDescriptor(crc, compressedSize, uncompressedSize, zip64) {
  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, SIG_DATA_DESCRIPTOR, true);
  dv.setUint32(4, crc >>> 0, true);
  {
    dv.setUint32(8, compressedSize >>> 0, true);
    dv.setUint32(12, uncompressedSize >>> 0, true);
  }
  return out;
}
function matchDataDescriptor(head, measured) {
  const dv = viewOf(head);
  const u32 = (pos) => pos + 4 <= head.length ? dv.getUint32(pos, true) : null;
  const u64 = (pos) => {
    if (pos + 8 > head.length) return null;
    const value = dv.getBigUint64(pos, true);
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
  };
  const matches = (crc, csize, usize) => crc === measured.crc32 && csize === measured.compressedSize && usize === measured.uncompressedSize;
  const sized = (csize, usize) => csize === measured.compressedSize && usize === measured.uncompressedSize;
  const hasSignature = u32(0) === SIG_DATA_DESCRIPTOR;
  if (hasSignature && matches(u32(4), u32(8), u32(12))) return { ok: true, byteLength: 16 };
  if (hasSignature && matches(u32(4), u64(8), u64(16))) return { ok: true, byteLength: 24 };
  if (matches(u32(0), u32(4), u32(8))) return { ok: true, byteLength: 12 };
  if (matches(u32(0), u64(4), u64(12))) return { ok: true, byteLength: 20 };
  const crcCandidates = [
    [u32(4), hasSignature && sized(u32(8), u32(12))],
    [u32(4), hasSignature && sized(u64(8), u64(16))],
    [u32(0), sized(u32(4), u32(8))],
    [u32(0), sized(u64(4), u64(12))]
  ];
  for (const [crcField, sizesMatch] of crcCandidates) {
    if (sizesMatch && crcField !== null) {
      return { ok: false, crcMismatch: { expected: crcField, actual: measured.crc32 } };
    }
  }
  return { ok: false, crcMismatch: null };
}
function writeCentralFileHeader(f) {
  const out = new Uint8Array(CENTRAL_FILE_HEADER_SIZE + f.name.length + f.extra.length + f.comment.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, SIG_CENTRAL_FILE_HEADER, true);
  dv.setUint16(4, f.versionMadeBy, true);
  dv.setUint16(6, f.versionNeeded, true);
  dv.setUint16(8, f.flags, true);
  dv.setUint16(10, f.compressionMethod, true);
  dv.setUint16(12, f.dosTime, true);
  dv.setUint16(14, f.dosDate, true);
  dv.setUint32(16, f.crc32 >>> 0, true);
  dv.setUint32(20, f.compressedSize >>> 0, true);
  dv.setUint32(24, f.uncompressedSize >>> 0, true);
  dv.setUint16(28, f.name.length, true);
  dv.setUint16(30, f.extra.length, true);
  dv.setUint16(32, f.comment.length, true);
  dv.setUint16(34, 0, true);
  dv.setUint16(36, f.internalAttributes, true);
  dv.setUint32(38, f.externalAttributes >>> 0, true);
  dv.setUint32(42, f.localHeaderOffset >>> 0, true);
  let pos = CENTRAL_FILE_HEADER_SIZE;
  out.set(f.name, pos);
  pos += f.name.length;
  out.set(f.extra, pos);
  pos += f.extra.length;
  out.set(f.comment, pos);
  return out;
}
function writeEocd(totalEntries, cdSize, cdOffset, comment) {
  const out = new Uint8Array(EOCD_SIZE + comment.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, SIG_EOCD, true);
  dv.setUint16(4, 0, true);
  dv.setUint16(6, 0, true);
  dv.setUint16(8, totalEntries, true);
  dv.setUint16(10, totalEntries, true);
  dv.setUint32(12, cdSize >>> 0, true);
  dv.setUint32(16, cdOffset >>> 0, true);
  dv.setUint16(20, comment.length, true);
  out.set(comment, EOCD_SIZE);
  return out;
}
function writeZip64Eocd(totalEntries, cdSize, cdOffset) {
  const out = new Uint8Array(ZIP64_EOCD_MIN_SIZE);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, SIG_ZIP64_EOCD, true);
  dv.setBigUint64(4, 44n, true);
  dv.setUint16(12, 813, true);
  dv.setUint16(14, 45, true);
  dv.setUint32(16, 0, true);
  dv.setUint32(20, 0, true);
  dv.setBigUint64(24, BigInt(totalEntries), true);
  dv.setBigUint64(32, BigInt(totalEntries), true);
  dv.setBigUint64(40, BigInt(cdSize), true);
  dv.setBigUint64(48, BigInt(cdOffset), true);
  return out;
}
function writeZip64Locator(zip64EocdOffset) {
  const out = new Uint8Array(ZIP64_EOCD_LOCATOR_SIZE);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, SIG_ZIP64_EOCD_LOCATOR, true);
  dv.setUint32(4, 0, true);
  dv.setBigUint64(8, BigInt(zip64EocdOffset), true);
  dv.setUint32(16, 1, true);
  return out;
}
function parseLocalFileHeader(bytes, pos) {
  if (pos + LOCAL_FILE_HEADER_SIZE > bytes.length) {
    throw new ZipFormatError("ZIP_RECORD_TRUNCATED", "zipnative: local file header truncated");
  }
  const dv = viewOf(bytes);
  if (dv.getUint32(pos, true) !== SIG_LOCAL_FILE_HEADER) {
    throw new ZipFormatError(
      "ZIP_SIGNATURE_MISMATCH",
      "zipnative: no local file header at the offset the central directory declares (corrupt or hostile archive)"
    );
  }
  const nameLength = dv.getUint16(pos + 26, true);
  const extraLength = dv.getUint16(pos + 28, true);
  const nameStart = pos + LOCAL_FILE_HEADER_SIZE;
  const dataStart = nameStart + nameLength + extraLength;
  if (dataStart > bytes.length) {
    throw new ZipFormatError("ZIP_RECORD_TRUNCATED", "zipnative: local file header variable fields truncated");
  }
  return {
    versionNeeded: dv.getUint16(pos + 4, true),
    flags: dv.getUint16(pos + 6, true),
    compressionMethod: dv.getUint16(pos + 8, true),
    dosTime: dv.getUint16(pos + 10, true),
    dosDate: dv.getUint16(pos + 12, true),
    crc32: dv.getUint32(pos + 14, true),
    compressedSize: dv.getUint32(pos + 18, true),
    uncompressedSize: dv.getUint32(pos + 22, true),
    name: bytes.subarray(nameStart, nameStart + nameLength),
    extra: bytes.subarray(nameStart + nameLength, dataStart),
    dataStart
  };
}

// src/parser/zip-eocd.ts
function locateEocd(bytes, limits, emit) {
  if (bytes.length < EOCD_SIZE) {
    throw new ZipFormatError("ZIP_EOCD_NOT_FOUND", "zipnative: input too small to be a ZIP archive (< 22 bytes)");
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
        continue;
      }
      sawOtherSignature = true;
    } else {
      sawOtherSignature = true;
    }
  }
  if (eocdPos === -1) {
    throw new ZipFormatError("ZIP_EOCD_NOT_FOUND", sawOtherSignature ? "zipnative: an end-of-central-directory signature exists but no candidate is self-consistent (trailing garbage after the archive, or a hostile ambiguous file) \u2014 refusing to guess; remove the trailing bytes if this archive is trusted" : "zipnative: no end-of-central-directory record found \u2014 not a ZIP archive, or truncated");
  }
  if (sawOtherSignature) {
    emit(multipleEocdDiagnostic());
  }
  const eocd = parseEocd(bytes, eocdPos);
  enforceLimit(limits, "maxCommentBytes", eocd.commentLength, "archive comment length");
  const needsZip64 = eocd.totalEntries === SENTINEL_U16 || eocd.entriesOnDisk === SENTINEL_U16 || eocd.cdSize === SENTINEL_U32 || eocd.cdOffset === SENTINEL_U32 || eocd.diskNumber === SENTINEL_U16 || eocd.cdStartDisk === SENTINEL_U16;
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
      throw new ZipFormatError(
        "ZIP_ZIP64_LOCATOR_MISSING",
        "zipnative: a zip64 sentinel is set but the zip64 end-of-central-directory locator is missing (truncated or corrupt archive)"
      );
    }
    if (locator.totalDisks > 1) {
      throw new ZipUnsupportedError(
        "ZIP_UNSUPPORTED_MULTI_DISK",
        "zipnative: multi-disk (spanned) archives are not supported",
        "multi-disk"
      );
    }
    let z64Pos = -1;
    if (hasZip64EocdSignature(bytes, locator.eocd64Offset)) {
      z64Pos = locator.eocd64Offset;
    } else if (hasZip64EocdSignature(bytes, locatorPos - ZIP64_EOCD_MIN_SIZE)) {
      z64Pos = locatorPos - ZIP64_EOCD_MIN_SIZE;
    }
    if (z64Pos === -1) {
      throw new ZipFormatError(
        "ZIP_ZIP64_EOCD_MISPLACED",
        "zipnative: the zip64 end-of-central-directory record is not where the locator points (corrupt archive, or an unsupported prepended-data layout)"
      );
    }
    const z64 = parseZip64Eocd(bytes, z64Pos);
    const crossCheck = (classic, sentinel, z64Value, field) => {
      if (classic !== sentinel && classic !== z64Value) {
        throw new ZipSecurityError(
          "ZIP_ZIP64_CONTRADICTION",
          `zipnative: zip64 ${field} (${z64Value}) contradicts the non-sentinel classic value (${classic}) \u2014 parser-differential archives are rejected`
        );
      }
      return z64Value;
    };
    totalEntries = crossCheck(eocd.totalEntries, SENTINEL_U16, z64.totalEntries, "total entry count");
    entriesOnDisk = crossCheck(eocd.entriesOnDisk, SENTINEL_U16, z64.entriesOnDisk, "entries-on-disk count");
    cdSize = crossCheck(eocd.cdSize, SENTINEL_U32, z64.cdSize, "central-directory size");
    cdOffset = crossCheck(eocd.cdOffset, SENTINEL_U32, z64.cdOffset, "central-directory offset");
    diskNumber = crossCheck(eocd.diskNumber, SENTINEL_U16, z64.diskNumber, "disk number");
    cdStartDisk = crossCheck(eocd.cdStartDisk, SENTINEL_U16, z64.cdStartDisk, "central-directory start disk");
    cdEnd = z64Pos;
    isZip64 = true;
  }
  if (diskNumber !== 0 || cdStartDisk !== 0) {
    throw new ZipUnsupportedError(
      "ZIP_UNSUPPORTED_MULTI_DISK",
      "zipnative: multi-disk (spanned) archives are not supported",
      "multi-disk"
    );
  }
  if (entriesOnDisk !== totalEntries) {
    throw new ZipFormatError(
      "ZIP_EOCD_INCONSISTENT",
      "zipnative: entries-on-this-disk differs from total entries on a single-disk archive (corrupt or hostile end-of-central-directory record)"
    );
  }
  enforceLimit(limits, "maxEntries", totalEntries, "central-directory entry count");
  enforceLimit(limits, "maxCentralDirectoryBytes", cdSize, "central-directory size");
  const base = cdEnd - (cdOffset + cdSize);
  if (base < 0) {
    throw new ZipFormatError(
      "ZIP_EOCD_INCONSISTENT",
      "zipnative: the central directory overlaps the end-of-central-directory record (corrupt or hostile archive)"
    );
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
    comment: eocd.comment
  };
}

// src/core/zip-dos-time.ts
var DETERMINISTIC_DOS_DATE = 33;
var DETERMINISTIC_DOS_TIME = 0;
function dosDateTimeToDate(dosDate, dosTime) {
  const day = dosDate & 31;
  const month = dosDate >>> 5 & 15;
  const year = (dosDate >>> 9 & 127) + 1980;
  const seconds = (dosTime & 31) * 2;
  const minutes = dosTime >>> 5 & 63;
  const hours = dosTime >>> 11 & 31;
  return new Date(year, Math.max(0, month - 1), Math.max(1, day), hours, minutes, seconds);
}
function dateToDosDateTime(date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const dosDate = year - 1980 << 9 | date.getMonth() + 1 << 5 | date.getDate();
  const dosTime = date.getHours() << 11 | date.getMinutes() << 5 | date.getSeconds() >>> 1;
  return { dosDate, dosTime };
}

// src/core/zip-extra-fields.ts
function parseExtraFields(extra) {
  const fields = [];
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
  return { fields, malformed };
}
function resolveZip64(fields, classic) {
  const zip64 = fields.find((f) => f.id === 1);
  let { uncompressedSize, compressedSize, localHeaderOffset, diskNumberStart } = classic;
  let usesZip64 = false;
  let suppliedNonSentinel = false;
  if (zip64 !== void 0) {
    const dv = viewOf(zip64.data);
    let pos = 0;
    const need = (sentinel, bytes) => {
      return pos + bytes <= zip64.data.length;
    };
    if (classic.uncompressedSize === SENTINEL_U32) {
      if (need(true, 8)) {
        uncompressedSize = toSafeNumber(dv.getBigUint64(pos, true), "zip64 uncompressed size");
        usesZip64 = true;
      }
      pos += 8;
    }
    if (classic.compressedSize === SENTINEL_U32) {
      if (need(true, 8)) {
        compressedSize = toSafeNumber(dv.getBigUint64(pos, true), "zip64 compressed size");
        usesZip64 = true;
      }
      pos += 8;
    }
    if (classic.localHeaderOffset === SENTINEL_U32) {
      if (need(true, 8)) {
        localHeaderOffset = toSafeNumber(dv.getBigUint64(pos, true), "zip64 local-header offset");
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
    if (zip64.data.length > pos) {
      suppliedNonSentinel = true;
    }
  }
  return { uncompressedSize, compressedSize, localHeaderOffset, diskNumberStart, usesZip64, suppliedNonSentinel };
}
function buildZip64Extra(uncompressedSize, compressedSize, localHeaderOffset) {
  const size = (uncompressedSize !== void 0 ? 8 : 0) + (compressedSize !== void 0 ? 8 : 0) + (localHeaderOffset !== void 0 ? 8 : 0);
  const out = new Uint8Array(4 + size);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 1, true);
  dv.setUint16(2, size, true);
  let pos = 4;
  if (uncompressedSize !== void 0) {
    dv.setBigUint64(pos, BigInt(uncompressedSize), true);
    pos += 8;
  }
  if (compressedSize !== void 0) {
    dv.setBigUint64(pos, BigInt(compressedSize), true);
    pos += 8;
  }
  if (localHeaderOffset !== void 0) {
    dv.setBigUint64(pos, BigInt(localHeaderOffset), true);
  }
  return out;
}
function serializeExtraFields(fields) {
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
function resolveUtMtime(fields) {
  const ut = fields.find((f) => f.id === 21589);
  if (ut === void 0 || ut.data.length < 5) return null;
  const flags = ut.data[0];
  if ((flags & 1) === 0) return null;
  const dv = viewOf(ut.data);
  const seconds = dv.getInt32(1, true);
  return new Date(seconds * 1e3);
}
function resolveUnicodePath(fields) {
  const up = fields.find((f) => f.id === 28789);
  if (up === void 0 || up.data.length < 6) return null;
  if (up.data[0] !== 1) return null;
  return up.data.subarray(5);
}

// src/parser/zip-cd.ts
function parseCentralDirectory(bytes, layout, limits, emit) {
  const entries = [];
  const cdEnd = layout.cdOffset + layout.cdSize;
  let pos = layout.cdOffset;
  for (let i = 0; i < layout.totalEntries; i++) {
    if (pos >= cdEnd) {
      throw new ZipFormatError(
        "ZIP_CD_INCONSISTENT",
        `zipnative: central directory ended after ${i} of ${layout.totalEntries} declared entries (corrupt or hostile archive)`
      );
    }
    const cfh = parseCentralFileHeader(bytes, pos);
    if (pos + cfh.recordLength > cdEnd) {
      throw new ZipFormatError(
        "ZIP_CD_INCONSISTENT",
        "zipnative: a central-directory record extends past the declared central-directory size (corrupt or hostile archive)"
      );
    }
    enforceLimit(limits, "maxNameBytes", cfh.name.length, "entry name length");
    enforceLimit(limits, "maxExtraFieldBytes", cfh.extra.length, "entry extra-field length");
    enforceLimit(limits, "maxCommentBytes", cfh.comment.length, "entry comment length");
    entries.push(makeEntry(cfh, layout.base, emit));
    pos += cfh.recordLength;
  }
  if (pos !== cdEnd) {
    throw new ZipFormatError(
      "ZIP_CD_INCONSISTENT",
      "zipnative: the central directory contains bytes beyond its declared entries (corrupt or hostile archive)"
    );
  }
  return entries;
}
function makeEntry(cfh, base, emit) {
  const { fields, malformed } = parseExtraFields(cfh.extra);
  const utf8Flagged = (cfh.flags & FLAG_UTF8) !== 0;
  let name;
  let nameEncoding;
  if (utf8Flagged) {
    const decoded = decodeUtf8Strict(cfh.name);
    if (decoded === null) {
      name = decodeCp437(cfh.name);
      nameEncoding = "cp437";
      emit(invalidUtf8NameDiagnostic(name));
    } else {
      name = decoded;
      nameEncoding = "utf-8";
    }
  } else {
    name = decodeCp437(cfh.name);
    nameEncoding = "cp437";
  }
  if (malformed) {
    emit(extraFieldMalformedDiagnostic(name));
  }
  const z64 = resolveZip64(fields, {
    uncompressedSize: cfh.uncompressedSize,
    compressedSize: cfh.compressedSize,
    localHeaderOffset: cfh.localHeaderOffset,
    diskNumberStart: cfh.diskNumberStart
  });
  if (z64.suppliedNonSentinel) {
    emit(zip64ExtraIgnoredDiagnostic(name));
  }
  if (z64.diskNumberStart !== 0) {
    throw new ZipUnsupportedError(
      "ZIP_UNSUPPORTED_MULTI_DISK",
      `zipnative: entry '${name}' starts on disk ${z64.diskNumberStart} \u2014 multi-disk archives are not supported`,
      "multi-disk"
    );
  }
  const unicodePath = resolveUnicodePath(fields);
  if (unicodePath !== null && !bytesEqual(unicodePath, cfh.name)) {
    emit(unicodePathConflictDiagnostic(name));
  }
  const utMtime = resolveUtMtime(fields);
  const lastModified = utMtime ?? dosDateTimeToDate(cfh.dosDate, cfh.dosTime);
  const isDirectory = name.endsWith("/") || (cfh.externalAttributes & DOS_ATTR_DIRECTORY) !== 0 && z64.uncompressedSize === 0;
  return {
    name,
    rawName: cfh.name,
    nameEncoding,
    isDirectory,
    compressionMethod: cfh.compressionMethod,
    compressedSize: z64.compressedSize,
    uncompressedSize: z64.uncompressedSize,
    crc32: cfh.crc32,
    localHeaderOffset: z64.localHeaderOffset + base,
    lastModified,
    dosDate: cfh.dosDate,
    dosTime: cfh.dosTime,
    flags: cfh.flags,
    versionMadeBy: cfh.versionMadeBy,
    versionNeeded: cfh.versionNeeded,
    internalAttributes: cfh.internalAttributes,
    externalAttributes: cfh.externalAttributes,
    comment: cfh.comment,
    extraFields: fields,
    isEncrypted: (cfh.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0,
    usesZip64: z64.usesZip64,
    usesDataDescriptor: (cfh.flags & FLAG_DATA_DESCRIPTOR) !== 0
  };
}

// src/parser/zip-reader.ts
function wrapDecompressError(err, entryName) {
  if (err instanceof ZipError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new ZipDataError(
    "ZIP_DECOMPRESSION_FAILED",
    `zipnative: entry '${entryName}' failed to decompress (${detail}) \u2014 the data is corrupt or hostile`,
    entryName
  );
}
function openZip(bytes, options) {
  const limits = resolveLimits(options?.limits);
  const emit = createDiagnosticEmitter(options?.strict, options?.onDiagnostic);
  const layout = locateEocd(bytes, limits, emit);
  let entryList;
  let nameIndex;
  let boundaries;
  const ensureEntries = () => {
    entryList ?? (entryList = parseCentralDirectory(bytes, layout, limits, emit));
    return entryList;
  };
  const ensureIndex = () => {
    if (nameIndex === void 0) {
      nameIndex = /* @__PURE__ */ new Map();
      for (const entry of ensureEntries()) {
        if (nameIndex.has(entry.name)) {
          emit(duplicateNameDiagnostic(entry.name));
        }
        nameIndex.set(entry.name, entry);
      }
    }
    return nameIndex;
  };
  const ensureBoundaries = () => {
    if (boundaries === void 0) {
      const list = ensureEntries();
      const sorted = list.map((e) => e.localHeaderOffset);
      sorted.push(layout.cdOffset);
      sorted.sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === sorted[i - 1]) {
          throw new ZipSecurityError(
            "ZIP_ENTRY_OVERLAP",
            "zipnative: two entries share one local-header offset \u2014 overlapping-entry archives are rejected (decompression-bomb/smuggling shape)"
          );
        }
      }
      boundaries = sorted;
    }
    return boundaries;
  };
  const checkEntryExtent = (entry, dataEnd) => {
    if (dataEnd > bytes.length) {
      throw new ZipFormatError(
        "ZIP_RECORD_TRUNCATED",
        `zipnative: entry '${entry.name}' data extends past the end of the archive (truncated or corrupt)`
      );
    }
    if (entry.localHeaderOffset >= layout.cdOffset) {
      throw new ZipSecurityError(
        "ZIP_ENTRY_OVERLAP",
        `zipnative: entry '${entry.name}' claims to start inside the central directory \u2014 overlapping-entry archives are rejected`,
        entry.name
      );
    }
    const sorted = ensureBoundaries();
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = lo + hi >>> 1;
      if (sorted[mid] <= entry.localHeaderOffset) lo = mid + 1;
      else hi = mid;
    }
    const nextBoundary = lo < sorted.length ? sorted[lo] : bytes.length;
    if (dataEnd > nextBoundary) {
      throw new ZipSecurityError(
        "ZIP_ENTRY_OVERLAP",
        `zipnative: entry '${entry.name}' extends into another entry or the central directory \u2014 overlapping-entry archives are rejected (decompression-bomb/smuggling shape)`,
        entry.name
      );
    }
  };
  const resolveEntry = (entryOrName) => {
    if (typeof entryOrName !== "string") return entryOrName;
    const entry = ensureIndex().get(entryOrName);
    if (entry === void 0) {
      throw new ZipError(
        "ZIP_ENTRY_NOT_FOUND",
        `zipnative: no entry named '${entryOrName}' in this archive (names are case-sensitive; iterate reader.entries() to list them)`
      );
    }
    return entry;
  };
  const prepareRead = (entry) => {
    if (entry.isEncrypted) {
      const feature = (entry.flags & FLAG_STRONG_ENCRYPTION) !== 0 ? "strong-encryption" : "zipcrypto";
      throw new ZipUnsupportedError(
        "ZIP_UNSUPPORTED_ENCRYPTION",
        `zipnative: entry '${entry.name}' is encrypted (${feature}) \u2014 encryption is not supported (see README: What zipnative will NOT do); check entry.isEncrypted to route around such entries`,
        feature
      );
    }
    enforceLimit(limits, "maxEntryUncompressedSize", entry.uncompressedSize, `entry '${entry.name}' declared size`);
    if (entry.compressedSize >= 1024 && entry.compressedSize > 0) {
      const ratio = entry.uncompressedSize / entry.compressedSize;
      enforceLimit(limits, "maxCompressionRatio", ratio, `entry '${entry.name}' compression ratio`);
    }
    const lfh = parseLocalFileHeader(bytes, entry.localHeaderOffset);
    let dataEnd = lfh.dataStart + entry.compressedSize;
    if ((lfh.flags & FLAG_DATA_DESCRIPTOR) !== 0) {
      dataEnd += 12;
    }
    checkEntryExtent(entry, dataEnd);
    if (lfh.compressionMethod !== entry.compressionMethod) {
      throw new ZipSecurityError(
        "ZIP_CD_LFH_MISMATCH",
        `zipnative: entry '${entry.name}' local header declares method ${lfh.compressionMethod} but the central directory says ${entry.compressionMethod} \u2014 parser-differential archives are rejected`,
        entry.name
      );
    }
    if ((lfh.flags & FLAG_DATA_DESCRIPTOR) === 0) {
      if (lfh.crc32 !== entry.crc32 || lfh.compressedSize !== entry.compressedSize || lfh.uncompressedSize !== entry.uncompressedSize) {
        const sizesSentinel = lfh.compressedSize === 4294967295 && lfh.uncompressedSize === 4294967295;
        if (!(sizesSentinel && lfh.crc32 === entry.crc32)) {
          throw new ZipDataError(
            "ZIP_SIZE_MISMATCH",
            `zipnative: entry '${entry.name}' local header sizes/CRC contradict the central directory (corrupt or hostile archive)`,
            entry.name,
            entry.crc32,
            lfh.crc32
          );
        }
      }
    }
    if (!bytesEqual(lfh.name, entry.rawName)) {
      emit(nameMismatchDiagnostic(entry.name));
    }
    return bytes.subarray(lfh.dataStart, lfh.dataStart + entry.compressedSize);
  };
  const codecFor = (entry) => {
    const codec = getCodec(entry.compressionMethod);
    if (codec === null) {
      throw new ZipUnsupportedError(
        "ZIP_UNSUPPORTED_METHOD",
        `zipnative: entry '${entry.name}' uses compression method ${entry.compressionMethod}, which has no registered codec \u2014 registerCodec() one, or re-save the archive with store/deflate`,
        `method:${entry.compressionMethod}`
      );
    }
    return codec;
  };
  const checkOutput = (entry, out, verifyCrc) => {
    if (out.length !== entry.uncompressedSize) {
      throw new ZipDataError(
        "ZIP_SIZE_MISMATCH",
        `zipnative: entry '${entry.name}' decompressed to ${out.length} bytes but the central directory declares ${entry.uncompressedSize} (corrupt or hostile archive)`,
        entry.name
      );
    }
    if (verifyCrc) {
      const actual = crc32(out);
      if (actual !== entry.crc32) {
        throw new ZipDataError(
          "ZIP_CRC_MISMATCH",
          `zipnative: entry '${entry.name}' CRC-32 mismatch \u2014 the data is corrupt (pass { verifyCrc: false } only if you accept corrupt output)`,
          entry.name,
          entry.crc32,
          actual
        );
      }
    }
  };
  const reader = {
    bytes,
    entryCount: layout.totalEntries,
    comment: layout.comment,
    isZip64: layout.isZip64,
    entries() {
      return ensureEntries()[Symbol.iterator]();
    },
    getEntry(name) {
      return ensureIndex().get(name) ?? null;
    },
    readEntry(entryOrName, readOptions) {
      const entry = resolveEntry(entryOrName);
      const compressed = prepareRead(entry);
      const codec = codecFor(entry);
      if (codec.decompressSync === void 0) {
        throw new ZipUnsupportedError(
          "ZIP_UNSUPPORTED_CODEC_MODE",
          `zipnative: the codec for method ${entry.compressionMethod} is stream-only \u2014 use readEntryStream()`,
          `method:${entry.compressionMethod}`
        );
      }
      let raw;
      try {
        raw = codec.decompressSync(compressed, entry.uncompressedSize);
      } catch (err) {
        throw wrapDecompressError(err, entry.name);
      }
      const out = entry.compressionMethod === METHOD_STORE ? raw.slice() : raw;
      checkOutput(entry, out, readOptions?.verifyCrc !== false);
      return out;
    },
    async *readEntryStream(entryOrName, readOptions) {
      const entry = resolveEntry(entryOrName);
      const compressed = prepareRead(entry);
      const codec = codecFor(entry);
      if (codec.decompressStream === void 0) {
        throw new ZipUnsupportedError(
          "ZIP_UNSUPPORTED_CODEC_MODE",
          `zipnative: the codec for method ${entry.compressionMethod} has no streaming decompressor \u2014 use readEntry()`,
          `method:${entry.compressionMethod}`
        );
      }
      const verifyCrc = readOptions?.verifyCrc !== false;
      let produced = 0;
      let crc = 0;
      try {
        for await (const chunk of codec.decompressStream(compressed, entry.uncompressedSize)) {
          produced += chunk.length;
          if (verifyCrc) crc = crc32(chunk, crc);
          yield chunk;
        }
      } catch (err) {
        throw wrapDecompressError(err, entry.name);
      }
      if (produced !== entry.uncompressedSize) {
        throw new ZipDataError(
          "ZIP_SIZE_MISMATCH",
          `zipnative: entry '${entry.name}' streamed ${produced} bytes but the central directory declares ${entry.uncompressedSize} (corrupt or hostile archive)`,
          entry.name
        );
      }
      if (verifyCrc && crc !== entry.crc32) {
        throw new ZipDataError(
          "ZIP_CRC_MISMATCH",
          `zipnative: entry '${entry.name}' CRC-32 mismatch \u2014 the data is corrupt`,
          entry.name,
          entry.crc32,
          crc
        );
      }
    },
    readEntryRaw(entryOrName) {
      const entry = resolveEntry(entryOrName);
      return prepareRead(entry);
    },
    verifyEntry(entryOrName) {
      const entry = resolveEntry(entryOrName);
      let localHeaderMatch = false;
      let crcMatch = false;
      let sizeMatch = false;
      try {
        const compressed = prepareRead(entry);
        localHeaderMatch = true;
        const codec = codecFor(entry);
        if (codec.decompressSync !== void 0) {
          const raw = codec.decompressSync(compressed, entry.uncompressedSize);
          sizeMatch = raw.length === entry.uncompressedSize;
          crcMatch = crc32(raw) === entry.crc32;
        }
      } catch {
      }
      return { ok: localHeaderMatch && crcMatch && sizeMatch, crcMatch, sizeMatch, localHeaderMatch };
    }
  };
  if (options?.validate === "eager") {
    for (const entry of ensureEntries()) {
      const lfh = parseLocalFileHeader(bytes, entry.localHeaderOffset);
      let dataEnd = lfh.dataStart + entry.compressedSize;
      if ((lfh.flags & FLAG_DATA_DESCRIPTOR) !== 0) dataEnd += 12;
      checkEntryExtent(entry, dataEnd);
    }
  }
  return reader;
}

// src/codecs/inflate-stream.ts
var WIN_SIZE = 65536;
var KEEP = 32768;
function* refill(st) {
  if (st.winPos > st.emitStart) {
    yield { kind: "data", bytes: st.win.slice(st.emitStart, st.winPos) };
    st.emitStart = st.winPos;
  }
  st.buf = yield { kind: "need" };
  st.pos = 0;
}
function* readBitsG(st, n) {
  while (st.bitCnt < n) {
    while (st.pos >= st.buf.length) {
      yield* refill(st);
    }
    st.bitBuf |= st.buf[st.pos++] << st.bitCnt;
    st.bitCnt += 8;
  }
  const value = st.bitBuf & (1 << n) - 1;
  st.bitBuf >>>= n;
  st.bitCnt -= n;
  return value;
}
function* decodeSymbolG(st, table) {
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
    code = code << 1 | bit;
    const count = table.counts[len];
    if (code - count < first) {
      return table.symbols[index + (code - first)];
    }
    index += count;
    first = first + count << 1;
  }
  throw new ZipFormatError("ZIP_DEFLATE_CORRUPT", "zipnative: invalid Huffman code in deflate stream");
}
function* slide(st) {
  if (st.winPos > st.emitStart) {
    yield { kind: "data", bytes: st.win.slice(st.emitStart, st.winPos) };
  }
  st.win.copyWithin(0, st.winPos - KEEP, st.winPos);
  st.winPos = KEEP;
  st.emitStart = KEEP;
}
function boundOutput(st, needed) {
  if (st.totalOut + needed > st.maxOutput) {
    throw new ZipDataError(
      "ZIP_INFLATE_OUTPUT_OVERFLOW",
      `zipnative: deflate output exceeds the declared/permitted size of ${st.maxOutput} bytes (the archive metadata lies about this entry, or raise the relevant limit if intentional)`
    );
  }
}
function* inflateChunked(st) {
  let bfinal = 0;
  while (bfinal === 0) {
    bfinal = yield* readBitsG(st, 1);
    const btype = yield* readBitsG(st, 2);
    if (btype === 0) {
      st.bitBuf = 0;
      st.bitCnt = 0;
      const len = yield* readBitsG(st, 16);
      const nlen = yield* readBitsG(st, 16);
      if ((len ^ 65535) !== nlen) {
        throw new ZipFormatError("ZIP_DEFLATE_CORRUPT", "zipnative: deflate stored-block LEN/NLEN mismatch (corrupt stream)");
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
      let litLenTable;
      let distTable;
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
              throw new ZipFormatError("ZIP_DEFLATE_CORRUPT", "zipnative: deflate dynamic header repeats with no previous code length");
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
      for (; ; ) {
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
            throw new ZipFormatError("ZIP_DEFLATE_CORRUPT", "zipnative: invalid length symbol in deflate stream");
          }
          const length = LEN_BASE[lenIdx] + (yield* readBitsG(st, LEN_EXTRA[lenIdx]));
          const distSym = yield* decodeSymbolG(st, distTable);
          if (distSym >= DIST_BASE.length) {
            throw new ZipFormatError("ZIP_DEFLATE_CORRUPT", "zipnative: invalid distance symbol in deflate stream");
          }
          const distance = DIST_BASE[distSym] + (yield* readBitsG(st, DIST_EXTRA[distSym]));
          if (distance > st.totalOut) {
            throw new ZipFormatError("ZIP_DEFLATE_CORRUPT", "zipnative: deflate back-reference before start of output (corrupt stream)");
          }
          boundOutput(st, length);
          for (let i = 0; i < length; i++) {
            if (st.winPos === WIN_SIZE) {
              yield* slide(st);
            }
            st.win[st.winPos] = st.win[st.winPos - distance];
            st.winPos++;
            st.totalOut++;
          }
        }
      }
    } else {
      throw new ZipFormatError("ZIP_DEFLATE_CORRUPT", `zipnative: unsupported deflate block type ${btype} (corrupt stream)`);
    }
  }
  if (st.winPos > st.emitStart) {
    yield { kind: "data", bytes: st.win.slice(st.emitStart, st.winPos) };
    st.emitStart = st.winPos;
  }
}
function createInflator(maxOutput) {
  const st = {
    buf: new Uint8Array(0),
    pos: 0,
    bitBuf: 0,
    bitCnt: 0,
    win: new Uint8Array(WIN_SIZE),
    winPos: 0,
    emitStart: 0,
    totalOut: 0,
    maxOutput
  };
  const generator = inflateChunked(st);
  let started = false;
  let finished = false;
  let consumedBase = 0;
  let leftover = new Uint8Array(0);
  const step = (chunk) => {
    const out = [];
    let res;
    if (!started) {
      started = true;
      res = generator.next();
    } else {
      res = generator.next(chunk);
    }
    for (; ; ) {
      if (res.done) {
        finished = true;
        leftover = st.buf.subarray(st.pos);
        return out;
      }
      if (res.value.kind === "data") {
        out.push(res.value.bytes);
        res = generator.next();
        continue;
      }
      return out;
    }
  };
  return {
    get finished() {
      return finished;
    },
    get leftover() {
      return leftover;
    },
    get bytesConsumed() {
      return consumedBase + st.pos;
    },
    get bytesProduced() {
      return st.totalOut;
    },
    push(chunk) {
      if (finished) {
        throw new ZipError(
          "ZIP_API_MISUSE",
          "zipnative: push() after the deflate stream finished \u2014 check inflator.finished and use leftover"
        );
      }
      if (!started) {
        step();
        if (finished) {
          return [];
        }
      }
      consumedBase += st.buf.length;
      return step(chunk);
    },
    end() {
      if (!finished) {
        throw new ZipFormatError(
          "ZIP_DEFLATE_TRUNCATED",
          "zipnative: deflate stream truncated \u2014 the final block never completed"
        );
      }
    }
  };
}

// src/parser/zip-chunk-cursor.ts
function createChunkCursor(source) {
  const iterator = source[Symbol.asyncIterator]();
  const pending = [];
  let buffered = 0;
  let sourceDone = false;
  let bytesRead = 0;
  const fill = async (min) => {
    while (buffered < min && !sourceDone) {
      const { done, value } = await iterator.next();
      if (done) {
        sourceDone = true;
        break;
      }
      if (value.length > 0) {
        pending.push(value);
        buffered += value.length;
      }
    }
  };
  const consume = (n) => {
    const head = pending[0];
    const takeLen = Math.min(n, head.length);
    const piece = head.subarray(0, takeLen);
    if (takeLen === head.length) {
      pending.shift();
    } else {
      pending[0] = head.subarray(takeLen);
    }
    buffered -= takeLen;
    bytesRead += takeLen;
    return piece;
  };
  return {
    get bytesRead() {
      return bytesRead;
    },
    async readExact(n) {
      await fill(n);
      if (buffered < n) {
        throw new ZipFormatError(
          "ZIP_STREAM_TRUNCATED",
          `zipnative: stream truncated at byte ${bytesRead + buffered} \u2014 expected ${n} more bytes`
        );
      }
      const first = pending[0];
      if (first.length >= n) {
        return consume(n);
      }
      const out = new Uint8Array(n);
      let pos = 0;
      while (pos < n) {
        const piece = consume(n - pos);
        out.set(piece, pos);
        pos += piece.length;
      }
      return out;
    },
    async peek4() {
      await fill(4);
      if (buffered === 0) return null;
      if (buffered < 4) {
        throw new ZipFormatError(
          "ZIP_STREAM_TRUNCATED",
          `zipnative: stream truncated at byte ${bytesRead + buffered} \u2014 a ${buffered}-byte tail is too short for any ZIP record`
        );
      }
      if (pending[0].length >= 4) return pending[0].subarray(0, 4);
      const out = new Uint8Array(4);
      let pos = 0;
      for (const piece of pending) {
        const takeLen = Math.min(4 - pos, piece.length);
        out.set(piece.subarray(0, takeLen), pos);
        pos += takeLen;
        if (pos === 4) break;
      }
      return out;
    },
    async nextChunk() {
      if (buffered === 0) {
        await fill(1);
        if (buffered === 0) return null;
      }
      return consume(pending[0].length);
    },
    unread(bytes) {
      if (bytes.length === 0) return;
      pending.unshift(bytes);
      buffered += bytes.length;
      bytesRead -= bytes.length;
    },
    async peekUpTo(n) {
      await fill(n);
      const available = Math.min(n, buffered);
      const out = new Uint8Array(available);
      let pos = 0;
      for (const piece of pending) {
        const takeLen = Math.min(available - pos, piece.length);
        out.set(piece.subarray(0, takeLen), pos);
        pos += takeLen;
        if (pos === available) break;
      }
      return out;
    },
    async *take(n) {
      let remaining = n;
      while (remaining > 0) {
        if (buffered === 0) {
          await fill(1);
          if (buffered === 0) {
            throw new ZipFormatError(
              "ZIP_STREAM_TRUNCATED",
              `zipnative: stream truncated at byte ${bytesRead} \u2014 ${remaining} payload bytes missing`
            );
          }
        }
        const piece = consume(remaining);
        remaining -= piece.length;
        yield piece;
      }
    }
  };
}

// src/parser/zip-iterate.ts
var DRAIN_REMEDY = "consume the previous entry's data() fully or call skip() before advancing \u2014 forward iteration cannot seek backwards";
async function* iterateZipEntries(source, options) {
  const limits = resolveLimits(options?.limits);
  const emit = createDiagnosticEmitter(options?.strict, options?.onDiagnostic);
  const cursor = createChunkCursor(source);
  let entryCount = 0;
  let totalProduced = 0;
  let previous = null;
  for (; ; ) {
    if (previous !== null && !previous.done) {
      throw new ZipError("ZIP_API_MISUSE", `zipnative: ${DRAIN_REMEDY}`);
    }
    const sig = await cursor.peek4();
    if (sig === null) return;
    const sigValue = sig[0] | sig[1] << 8 | sig[2] << 16 | sig[3] << 24;
    const sigU32 = sigValue >>> 0;
    if (sigU32 === SIG_CENTRAL_FILE_HEADER || sigU32 === SIG_EOCD || sigU32 === SIG_ZIP64_EOCD) {
      return;
    }
    if (sigU32 !== SIG_LOCAL_FILE_HEADER) {
      throw new ZipFormatError(
        "ZIP_SIGNATURE_MISMATCH",
        `zipnative: expected a local file header at byte ${cursor.bytesRead} \u2014 not a ZIP stream, or corrupt`
      );
    }
    entryCount++;
    enforceLimit(limits, "maxEntries", entryCount, "streamed entry count");
    const fixed = await cursor.readExact(30);
    const view = new DataView(fixed.buffer, fixed.byteOffset, fixed.byteLength);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    enforceLimit(limits, "maxNameBytes", nameLength, "entry name length");
    enforceLimit(limits, "maxExtraFieldBytes", extraLength, "entry extra-field length");
    const tail = await cursor.readExact(nameLength + extraLength);
    const window = new Uint8Array(30 + tail.length);
    window.set(fixed, 0);
    window.set(tail, 30);
    const lfh = parseLocalFileHeader(window, 0);
    const { fields } = parseExtraFields(lfh.extra);
    const z64 = resolveZip64(fields, {
      uncompressedSize: lfh.uncompressedSize,
      compressedSize: lfh.compressedSize,
      localHeaderOffset: 0,
      diskNumberStart: 0
    });
    const utf8Flagged = (lfh.flags & FLAG_UTF8) !== 0;
    let name;
    let nameEncoding;
    if (utf8Flagged) {
      const decoded = decodeUtf8Strict(lfh.name);
      if (decoded === null) {
        name = decodeCp437(lfh.name);
        nameEncoding = "cp437";
        emit(invalidUtf8NameDiagnostic(name));
      } else {
        name = decoded;
        nameEncoding = "utf-8";
      }
    } else {
      name = decodeCp437(lfh.name);
      nameEncoding = "cp437";
    }
    const usesDescriptor = (lfh.flags & FLAG_DATA_DESCRIPTOR) !== 0;
    const isEncrypted = (lfh.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0;
    if (usesDescriptor && (isEncrypted || lfh.compressionMethod !== METHOD_DEFLATE)) {
      throw new ZipUnsupportedError(
        "ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR",
        `zipnative: entry '${name}' combines a data descriptor (flag bit 3) with ${isEncrypted ? "encryption" : `method ${lfh.compressionMethod}`} \u2014 its payload cannot be delimited without the central directory; use openZip() on the complete archive instead`,
        "cd-less-descriptor"
      );
    }
    const compressedSize = z64.compressedSize;
    const uncompressedSize = z64.uncompressedSize;
    if (!usesDescriptor) {
      enforceLimit(limits, "maxEntryUncompressedSize", uncompressedSize, `entry '${name}' declared size`);
      if (compressedSize >= 1024 && compressedSize > 0) {
        enforceLimit(
          limits,
          "maxCompressionRatio",
          uncompressedSize / compressedSize,
          `entry '${name}' compression ratio`
        );
      }
    }
    const header = {
      name,
      rawName: lfh.name,
      nameEncoding,
      isDirectory: name.endsWith("/"),
      compressionMethod: lfh.compressionMethod,
      compressedSize,
      uncompressedSize,
      crc32: lfh.crc32,
      flags: lfh.flags,
      versionNeeded: lfh.versionNeeded,
      dosDate: lfh.dosDate,
      dosTime: lfh.dosTime,
      lastModified: resolveUtMtime(fields) ?? dosDateTimeToDate(lfh.dosDate, lfh.dosTime),
      isEncrypted,
      extraFields: fields
    };
    const state = { done: compressedSize === 0 && !usesDescriptor, consumed: false };
    previous = state;
    const guardConsume = () => {
      if (state.consumed) {
        throw new ZipError("ZIP_API_MISUSE", `zipnative: data()/skip() for entry '${name}' was already used \u2014 it is single-shot`);
      }
      state.consumed = true;
    };
    const entry = {
      header,
      data: () => {
        if (isEncrypted) {
          const feature = (lfh.flags & FLAG_STRONG_ENCRYPTION) !== 0 ? "strong-encryption" : "zipcrypto";
          throw new ZipUnsupportedError(
            "ZIP_UNSUPPORTED_ENCRYPTION",
            `zipnative: entry '${name}' is encrypted (${feature}) \u2014 encryption is not supported; skip() it to continue`,
            feature
          );
        }
        const codec = getCodec(lfh.compressionMethod);
        if (codec === null) {
          throw new ZipUnsupportedError(
            "ZIP_UNSUPPORTED_METHOD",
            `zipnative: entry '${name}' uses compression method ${lfh.compressionMethod}, which has no registered codec \u2014 skip() it, or registerCodec() one`,
            `method:${lfh.compressionMethod}`
          );
        }
        guardConsume();
        return usesDescriptor ? streamDescriptorEntry() : streamEntryData();
      },
      skip: async () => {
        guardConsume();
        if (usesDescriptor) {
          const drain = streamDescriptorEntry();
          for (let res = await drain.next(); !res.done; res = await drain.next()) {
          }
          return;
        }
        const discard = cursor.take(compressedSize);
        for (let res = await discard.next(); !res.done; res = await discard.next()) {
        }
        state.done = true;
      }
    };
    async function* streamDescriptorEntry() {
      const inflator = createInflator(limits.maxEntryUncompressedSize);
      let crc = 0;
      let fed = 0;
      while (!inflator.finished) {
        const chunk = await cursor.nextChunk();
        if (chunk === null) {
          throw new ZipFormatError(
            "ZIP_STREAM_TRUNCATED",
            `zipnative: stream truncated inside entry '${name}' \u2014 the deflate stream never completed`
          );
        }
        fed += chunk.length;
        let pieces;
        try {
          pieces = inflator.push(chunk);
        } catch (err) {
          throw err instanceof ZipError ? err : new ZipDataError(
            "ZIP_DECOMPRESSION_FAILED",
            `zipnative: entry '${name}' failed to decompress (${err instanceof Error ? err.message : String(err)})`,
            name
          );
        }
        for (const piece of pieces) {
          totalProduced += piece.length;
          enforceLimit(limits, "maxTotalUncompressedSize", totalProduced, "total streamed output");
          crc = crc32(piece, crc);
          yield piece;
        }
        if (fed >= 1024) {
          enforceLimit(
            limits,
            "maxCompressionRatio",
            inflator.bytesProduced / fed,
            `entry '${name}' compression ratio`
          );
        }
      }
      inflator.end();
      if (inflator.leftover.length > 0) {
        cursor.unread(inflator.leftover);
      }
      const measured = {
        crc32: crc,
        compressedSize: inflator.bytesConsumed,
        uncompressedSize: inflator.bytesProduced
      };
      if (measured.compressedSize >= 1024) {
        enforceLimit(
          limits,
          "maxCompressionRatio",
          measured.uncompressedSize / measured.compressedSize,
          `entry '${name}' compression ratio`
        );
      }
      const head = await cursor.peekUpTo(24);
      const match = matchDataDescriptor(head, measured);
      if (!match.ok) {
        throw match.crcMismatch !== null ? new ZipDataError(
          "ZIP_CRC_MISMATCH",
          `zipnative: entry '${name}' data-descriptor CRC-32 mismatch \u2014 the data is corrupt`,
          name,
          match.crcMismatch.expected,
          match.crcMismatch.actual
        ) : new ZipDataError(
          "ZIP_DESCRIPTOR_MISMATCH",
          `zipnative: entry '${name}' has no data descriptor matching the decompressed payload (corrupt or hostile stream)`,
          name
        );
      }
      await cursor.readExact(match.byteLength);
      state.done = true;
    }
    async function* streamEntryData(_self) {
      let produced = 0;
      let crc = 0;
      const outputCap = Math.min(uncompressedSize, limits.maxEntryUncompressedSize);
      const account = (chunk) => {
        produced += chunk.length;
        totalProduced += chunk.length;
        if (produced > outputCap) {
          throw new ZipDataError(
            "ZIP_SIZE_MISMATCH",
            `zipnative: entry '${name}' produced more than its declared ${uncompressedSize} bytes (the local header lies \u2014 corrupt or hostile stream)`,
            name
          );
        }
        enforceLimit(limits, "maxTotalUncompressedSize", totalProduced, "total streamed output");
        crc = crc32(chunk, crc);
      };
      if (lfh.compressionMethod === METHOD_STORE) {
        for await (const piece of cursor.take(compressedSize)) {
          account(piece);
          yield piece;
        }
      } else {
        yield* pumpInflate(cursor, compressedSize, account);
      }
      if (produced !== uncompressedSize) {
        throw new ZipDataError(
          "ZIP_SIZE_MISMATCH",
          `zipnative: entry '${name}' produced ${produced} bytes but its header declares ${uncompressedSize} (corrupt or hostile stream)`,
          name
        );
      }
      if (crc !== lfh.crc32) {
        throw new ZipDataError(
          "ZIP_CRC_MISMATCH",
          `zipnative: entry '${name}' CRC-32 mismatch \u2014 the data is corrupt`,
          name,
          lfh.crc32,
          crc
        );
      }
      state.done = true;
    }
    yield entry;
  }
}
function wrapInflateError(err) {
  if (err instanceof ZipError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new ZipDataError(
    "ZIP_DECOMPRESSION_FAILED",
    `zipnative: streamed entry failed to decompress (${detail}) \u2014 the data is corrupt or hostile`
  );
}
async function* pumpInflate(cursor, compressedSize, account) {
  if (hasDecompressionStream()) {
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    let writeError = null;
    const writeAll = (async () => {
      try {
        for await (const piece of cursor.take(compressedSize)) {
          await writer.write(piece.slice());
        }
        await writer.close();
      } catch (err) {
        writeError = err;
        try {
          await writer.abort(err);
        } catch {
        }
      }
    })();
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        account(value);
        yield value;
      }
    } catch (err) {
      await writeAll;
      throw wrapInflateError(writeError ?? err);
    }
    await writeAll;
    if (writeError !== null) {
      throw wrapInflateError(writeError);
    }
    return;
  }
  const inflator = createInflator(Number.MAX_SAFE_INTEGER);
  try {
    for await (const piece of cursor.take(compressedSize)) {
      if (inflator.finished) continue;
      for (const chunk of inflator.push(piece)) {
        account(chunk);
        yield chunk;
      }
    }
    inflator.end();
  } catch (err) {
    throw wrapInflateError(err);
  }
}

// src/parser/zip-extract.ts
function sanitizeEntryPath(name) {
  if (name.length === 0) return null;
  if (name.includes("\0")) return null;
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return null;
  if (/^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.startsWith("//")) return null;
  const segments = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    if (segment.includes(":")) return null;
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  return segments.join("/");
}
function isSymlinkEntry(entry) {
  return (entry.externalAttributes >>> 16 & UNIX_TYPE_MASK) === UNIX_TYPE_SYMLINK;
}
function planExtraction(entries, options) {
  const limits = resolveLimits(options?.limits);
  const rejectTraversal = options?.rejectTraversal !== false;
  const rejectSymlinks = options?.rejectSymlinks !== false;
  const onDuplicate = options?.onDuplicate ?? "error";
  const byPath = /* @__PURE__ */ new Map();
  let totalUncompressed = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (options?.filter !== void 0 && !options.filter(entry)) continue;
    if (isSymlinkEntry(entry)) {
      if (rejectSymlinks) {
        throw new ZipSecurityError(
          "ZIP_SYMLINK_REJECTED",
          `zipnative: entry '${entry.name}' is a symlink \u2014 rejected by default (CWE-59); pass rejectSymlinks: false to receive its target as data`,
          entry.name
        );
      }
    }
    const path = sanitizeEntryPath(entry.name);
    if (path === null) {
      if (rejectTraversal) {
        throw new ZipSecurityError(
          "ZIP_PATH_TRAVERSAL",
          `zipnative: entry name '${entry.name}' escapes the extraction root (zip-slip, CWE-22) \u2014 this archive is hostile or corrupt; pass rejectTraversal: false to skip such entries instead`,
          entry.name
        );
      }
      continue;
    }
    totalUncompressed += entry.uncompressedSize;
    enforceLimit(limits, "maxTotalUncompressedSize", totalUncompressed, "total declared uncompressed size");
    const existing = byPath.get(path);
    if (existing !== void 0) {
      if (onDuplicate === "error") {
        throw new ZipSecurityError(
          "ZIP_EXTRACT_DUPLICATE_PATH",
          `zipnative: duplicate entry path '${path}' \u2014 a shadowing hazard (CWE-694); pass onDuplicate: 'first' or 'last' to resolve deliberately`,
          entry.name
        );
      }
      if (onDuplicate === "first") continue;
    }
    byPath.set(path, { path, entry });
  }
  return [...byPath.values()];
}
function extractZip(bytes, options) {
  const reader = openZip(bytes, options);
  const planned = planExtraction(reader.entries(), options);
  return planned.map(({ path, entry }) => ({
    path,
    entry,
    data: reader.readEntry(entry)
  }));
}
async function* extractZipStream(bytes, options) {
  const reader = openZip(bytes, options);
  const planned = planExtraction(reader.entries(), options);
  for (const { path, entry } of planned) {
    yield {
      path,
      entry,
      stream: () => reader.readEntryStream(entry)
    };
  }
}

// src/core/zip-segments.ts
function checkSpec(spec, limits) {
  enforceLimit(limits, "maxNameBytes", spec.nameBytes.length, "entry name length");
  enforceLimit(limits, "maxCommentBytes", spec.comment.length, "entry comment length");
}
function buildStreamPlan(spec) {
  return {
    nameBytes: spec.nameBytes,
    method: spec.method === "store" ? METHOD_STORE : METHOD_DEFLATE,
    flags: FLAG_UTF8 | FLAG_DATA_DESCRIPTOR,
    dosDate: spec.dosDate,
    dosTime: spec.dosTime,
    externalAttributes: spec.externalAttributes,
    comment: spec.comment,
    extraFields: spec.extraFields,
    payload: null,
    source: spec.source,
    level: spec.level,
    deterministic: spec.deterministic,
    crc32: 0,
    compressedSize: 0,
    uncompressedSize: 0
  };
}
function finishBufferedPlan(spec, data, compressed, crc) {
  let method = spec.method === "store" || data.length === 0 ? METHOD_STORE : METHOD_DEFLATE;
  let payload;
  if (method === METHOD_DEFLATE && compressed !== null) {
    if (compressed.length >= data.length) {
      method = METHOD_STORE;
      payload = data;
    } else {
      payload = compressed;
    }
  } else {
    method = METHOD_STORE;
    payload = data;
  }
  return {
    nameBytes: spec.nameBytes,
    method,
    flags: FLAG_UTF8,
    dosDate: spec.dosDate,
    dosTime: spec.dosTime,
    externalAttributes: spec.externalAttributes,
    comment: spec.comment,
    extraFields: spec.extraFields,
    payload,
    source: null,
    level: spec.level,
    deterministic: spec.deterministic,
    crc32: crc,
    compressedSize: payload.length,
    uncompressedSize: data.length
  };
}
function needsDeflate(spec, data) {
  return spec.method === "deflate" && data.length > 0;
}
function planArchive(specs, comment, limits, _emit) {
  enforceLimit(limits, "maxEntries", specs.length, "archive entry count");
  enforceLimit(limits, "maxCommentBytes", comment.length, "archive comment length");
  const plans = [];
  let hasStreamEntries = false;
  for (const spec of specs) {
    checkSpec(spec, limits);
    if (spec.source !== null) {
      hasStreamEntries = true;
      plans.push(buildStreamPlan(spec));
      continue;
    }
    const data = spec.data ?? new Uint8Array(0);
    let compressed = null;
    if (needsDeflate(spec, data)) {
      const codec = getCodec(METHOD_DEFLATE);
      if (codec?.compressSync === void 0) {
        throw new ZipError("ZIP_INTERNAL", "zipnative: the deflate codec has no compressor registered (internal invariant)");
      }
      compressed = codec.compressSync(data, { level: spec.level, deterministic: spec.deterministic });
    }
    plans.push(finishBufferedPlan(spec, data, compressed, crc32(data)));
  }
  return { plans, comment, hasStreamEntries };
}
function assembleArchive(ctx) {
  const segments = [];
  let total = 0;
  const generator = archiveSegments(ctx);
  for (let res = generator.next(); !res.done; res = generator.next()) {
    const segment = res.value;
    if (segment.kind !== "bytes") {
      throw new ZipError("ZIP_INTERNAL", "zipnative: unexpected stream segment in the buffered writer (internal invariant)");
    }
    segments.push(segment.bytes);
    total += segment.bytes.length;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const segment of segments) {
    out.set(segment, pos);
    pos += segment.length;
  }
  return out;
}
function* archiveSegments(ctx) {
  let offset = 0;
  const offsets = new Array(ctx.plans.length);
  const seg = (bytes) => {
    offset += bytes.length;
    return { kind: "bytes", bytes };
  };
  for (let i = 0; i < ctx.plans.length; i++) {
    const plan = ctx.plans[i];
    offsets[i] = offset;
    const isStream = plan.source !== null;
    const lfhExtra = serializeExtraFields(plan.extraFields);
    yield seg(writeLocalFileHeader({
      versionNeeded: 20,
      flags: plan.flags,
      compressionMethod: plan.method,
      dosTime: plan.dosTime,
      dosDate: plan.dosDate,
      crc32: isStream ? 0 : plan.crc32,
      compressedSize: isStream ? 0 : plan.compressedSize,
      uncompressedSize: isStream ? 0 : plan.uncompressedSize,
      name: plan.nameBytes,
      extra: lfhExtra
    }));
    if (isStream) {
      const consumed = yield { kind: "stream-entry", plan };
      offset += consumed ?? 0;
    } else if (plan.payload !== null && plan.payload.length > 0) {
      yield seg(plan.payload);
      plan.payload = null;
    }
  }
  const cdOffset = offset;
  for (let i = 0; i < ctx.plans.length; i++) {
    const plan = ctx.plans[i];
    const z64Unc = plan.uncompressedSize > SENTINEL_U32 - 1 ? plan.uncompressedSize : void 0;
    const z64Comp = plan.compressedSize > SENTINEL_U32 - 1 ? plan.compressedSize : void 0;
    const z64Off = offsets[i] > SENTINEL_U32 - 1 ? offsets[i] : void 0;
    const usesZip64 = z64Unc !== void 0 || z64Comp !== void 0 || z64Off !== void 0;
    const extraParts = [];
    if (usesZip64) extraParts.push(buildZip64Extra(z64Unc, z64Comp, z64Off));
    if (plan.extraFields.length > 0) extraParts.push(serializeExtraFields(plan.extraFields));
    const extra = concat(extraParts);
    yield seg(writeCentralFileHeader({
      versionMadeBy: plan.versionMadeBy ?? 813,
      // Unix, spec 4.5 — constant (determinism contract)
      versionNeeded: Math.max(usesZip64 ? 45 : 20, plan.versionNeededMin ?? 0),
      flags: plan.flags,
      compressionMethod: plan.method,
      dosTime: plan.dosTime,
      dosDate: plan.dosDate,
      crc32: plan.crc32,
      compressedSize: z64Comp !== void 0 ? SENTINEL_U32 : plan.compressedSize,
      uncompressedSize: z64Unc !== void 0 ? SENTINEL_U32 : plan.uncompressedSize,
      internalAttributes: plan.internalAttributes ?? 0,
      externalAttributes: plan.externalAttributes,
      localHeaderOffset: z64Off !== void 0 ? SENTINEL_U32 : offsets[i],
      name: plan.nameBytes,
      extra,
      comment: plan.comment
    }));
  }
  const cdSize = offset - cdOffset;
  const count = ctx.plans.length;
  const needsZip64 = count > SENTINEL_U16 - 1 || cdSize > SENTINEL_U32 - 1 || cdOffset > SENTINEL_U32 - 1;
  if (needsZip64) {
    const z64Pos = offset;
    yield seg(writeZip64Eocd(count, cdSize, cdOffset));
    yield seg(writeZip64Locator(z64Pos));
  }
  yield seg(writeEocd(
    count > SENTINEL_U16 - 1 ? SENTINEL_U16 : count,
    cdSize > SENTINEL_U32 - 1 ? SENTINEL_U32 : cdSize,
    cdOffset > SENTINEL_U32 - 1 ? SENTINEL_U32 : cdOffset,
    ctx.comment
  ));
}
function assertStreamSizesInRange(plan, entryName) {
  if (plan.uncompressedSize > SENTINEL_U32 - 1 || plan.compressedSize > SENTINEL_U32 - 1) {
    throw new ZipUnsupportedError(
      "ZIP_UNSUPPORTED_ZIP64_STREAMING",
      `zipnative: stream entry '${entryName}' exceeds 4 GiB \u2014 Zip64 streaming is not supported yet; buffer the content via add() or split it (see README Known Limitations)`,
      "zip64-streaming"
    );
  }
}
function concat(parts) {
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// src/core/zip-stream-writer.ts
var DEFAULT_CHUNK = 65536;
var MIN_CHUNK = 1024;
var MAX_CHUNK = 16777216;
function resolveChunkSize(value) {
  if (value === void 0) return DEFAULT_CHUNK;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ZipError("ZIP_INVALID_OPTION", `zipnative: chunkSize must be a positive number (got ${String(value)})`);
  }
  return Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, Math.floor(value)));
}
function hasCompressionStream() {
  try {
    return typeof globalThis.CompressionStream === "function";
  } catch {
    return false;
  }
}
async function* streamArchive(planCtx, options) {
  const chunkSize = resolveChunkSize(options?.chunkSize);
  const ctx = planCtx();
  let buf = new Uint8Array(chunkSize);
  let filled = 0;
  function* push(bytes) {
    let i = 0;
    while (i < bytes.length) {
      const take = Math.min(chunkSize - filled, bytes.length - i);
      buf.set(bytes.subarray(i, i + take), filled);
      filled += take;
      i += take;
      if (filled === chunkSize) {
        yield buf;
        buf = new Uint8Array(chunkSize);
        filled = 0;
      }
    }
  }
  const generator = archiveSegments(ctx);
  let res = generator.next();
  while (!res.done) {
    const segment = res.value;
    if (segment.kind === "bytes") {
      yield* push(segment.bytes);
      res = generator.next();
    } else {
      let consumed = 0;
      for await (const piece of compressStreamEntry(segment.plan)) {
        consumed += piece.length;
        yield* push(piece);
      }
      res = generator.next(consumed);
    }
  }
  if (filled > 0) {
    yield buf.subarray(0, filled);
  }
}
async function* compressStreamEntry(plan) {
  const source = plan.source;
  const entryName = new TextDecoder().decode(plan.nameBytes);
  let crc = 0;
  let uncompressed = 0;
  let compressed = 0;
  if (plan.method === METHOD_STORE) {
    for await (const chunk of source) {
      crc = crc32(chunk, crc);
      uncompressed += chunk.length;
      compressed += chunk.length;
      plan.uncompressedSize = uncompressed;
      plan.compressedSize = compressed;
      assertStreamSizesInRange(plan, entryName);
      yield chunk;
    }
  } else if (!plan.deterministic && hasCompressionStream() && hasDecompressionStream()) {
    const cs = new CompressionStream("deflate-raw");
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    const writeAll = (async () => {
      for await (const chunk of source) {
        crc = crc32(chunk, crc);
        uncompressed += chunk.length;
        await writer.write(chunk.slice());
      }
      await writer.close();
    })();
    writeAll.catch(() => {
    });
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      compressed += value.length;
      plan.uncompressedSize = uncompressed;
      plan.compressedSize = compressed;
      assertStreamSizesInRange(plan, entryName);
      yield value;
    }
    await writeAll;
  } else {
    const pieces = [];
    for await (const chunk of source) {
      crc = crc32(chunk, crc);
      uncompressed += chunk.length;
      pieces.push(chunk.slice());
    }
    const whole = new Uint8Array(uncompressed);
    let pos = 0;
    for (const piece of pieces) {
      whole.set(piece, pos);
      pos += piece.length;
    }
    const out = deflateRawSync(whole, plan.level, plan.deterministic);
    compressed = out.length;
    plan.uncompressedSize = uncompressed;
    plan.compressedSize = compressed;
    assertStreamSizesInRange(plan, entryName);
    const chunkSize = DEFAULT_CHUNK;
    for (let i = 0; i < out.length; i += chunkSize) {
      yield out.subarray(i, Math.min(i + chunkSize, out.length));
    }
  }
  plan.crc32 = crc;
  plan.uncompressedSize = uncompressed;
  plan.compressedSize = compressed;
  assertStreamSizesInRange(plan, entryName);
  yield writeDataDescriptor(crc, compressed, uncompressed);
}

// src/core/zip-builder.ts
var te = new TextEncoder();
function createSpecCollector(options) {
  const limits = resolveLimits(options?.limits);
  const emit = createDiagnosticEmitter(options?.strict, options?.onDiagnostic);
  const order = options?.order ?? "canonical";
  const defaultCompression = options?.compression;
  const defaultMethod = defaultCompression?.method ?? "deflate";
  const defaultLevel = defaultCompression?.level ?? 6;
  const defaultDeterministic = defaultCompression?.deterministic === true;
  if (defaultLevel !== void 0 && (!Number.isInteger(defaultLevel) || defaultLevel < 0 || defaultLevel > 9)) {
    throw new ZipError("ZIP_INVALID_OPTION", `zipnative: compression.level must be an integer 0-9 (got ${String(defaultLevel)})`);
  }
  let defaultDos;
  let datePinned;
  if (options?.defaultDate === "now") {
    emit(timestampNotPinnedDiagnostic());
    defaultDos = dateToDosDateTime(/* @__PURE__ */ new Date());
    datePinned = false;
  } else if (options?.defaultDate instanceof Date) {
    defaultDos = dateToDosDateTime(options.defaultDate);
    datePinned = true;
  } else {
    defaultDos = { dosDate: DETERMINISTIC_DOS_DATE, dosTime: DETERMINISTIC_DOS_TIME };
    datePinned = false;
  }
  const specs = [];
  const names = /* @__PURE__ */ new Set();
  let archiveComment = options?.comment === void 0 ? new Uint8Array(0) : typeof options.comment === "string" ? te.encode(options.comment) : options.comment;
  let hasStreamEntries = false;
  const makeSpec = (name, isDirectory, data, source, entryOptions) => {
    const finalName = validateEntryName(name, isDirectory);
    if (names.has(finalName)) {
      throw new ZipFormatError(
        "ZIP_DUPLICATE_ENTRY_NAME",
        `zipnative: duplicate entry name '${finalName}' \u2014 every archive path must be unique`
      );
    }
    names.add(finalName);
    const compression = entryOptions?.compression;
    const dos = entryOptions?.date !== void 0 ? dateToDosDateTime(entryOptions.date) : defaultDos;
    specs.push({
      nameBytes: te.encode(finalName),
      isDirectory,
      data: isDirectory ? new Uint8Array(0) : data,
      source,
      method: isDirectory ? "store" : compression?.method ?? defaultMethod,
      level: compression?.level ?? defaultLevel,
      deterministic: compression?.deterministic ?? defaultDeterministic,
      dosDate: dos.dosDate,
      dosTime: dos.dosTime,
      externalAttributes: entryOptions?.externalAttributes ?? (isDirectory ? (16877 << 16 | DOS_ATTR_DIRECTORY) >>> 0 : 33188 << 16 >>> 0),
      comment: entryOptions?.comment === void 0 ? new Uint8Array(0) : te.encode(entryOptions.comment),
      extraFields: entryOptions?.extraFields ?? []
    });
  };
  return {
    limits,
    emit,
    add(name, data, entryOptions) {
      const bytes = typeof data === "string" ? te.encode(data) : data;
      makeSpec(name, false, bytes, null, entryOptions);
    },
    addDirectory(name, entryOptions) {
      makeSpec(name, true, null, null, entryOptions);
    },
    addStream(name, source, entryOptions) {
      hasStreamEntries = true;
      makeSpec(name, false, null, source, entryOptions);
    },
    setComment(comment) {
      archiveComment = typeof comment === "string" ? te.encode(comment) : comment;
    },
    hasStreamEntries: () => hasStreamEntries,
    orderedSpecs: () => order === "canonical" ? [...specs].sort((a, b) => compareNames(a.nameBytes, b.nameBytes)) : specs,
    comment: () => archiveComment,
    emitPlanDiagnostics: () => {
      if (datePinned && !defaultDeterministic && activeDeflateTier(false) !== "pure") {
        emit(nondeterministicCodecDiagnostic());
      }
    }
  };
}
function createZip(options) {
  const collector = createSpecCollector(options);
  const plan = () => {
    collector.emitPlanDiagnostics();
    return planArchive(collector.orderedSpecs(), collector.comment(), collector.limits);
  };
  return {
    add: collector.add,
    addDirectory: collector.addDirectory,
    addStream: collector.addStream,
    setComment: collector.setComment,
    toBytes() {
      if (collector.hasStreamEntries()) {
        throw new ZipError(
          "ZIP_API_MISUSE",
          "zipnative: toBytes() is incompatible with addStream() entries (their sizes are only known after the source is consumed). Use stream(), or buffer the content via add()."
        );
      }
      return assembleArchive(plan());
    },
    stream(streamOptions) {
      return streamArchive(plan, streamOptions);
    }
  };
}

// src/parser/zip-modifier.ts
var te2 = new TextEncoder();
function createZipModifier(reader, options) {
  const limits = resolveLimits(options?.limits);
  const emit = createDiagnosticEmitter(options?.strict, options?.onDiagnostic);
  const layout = locateEocd(reader.bytes, limits, () => void 0);
  const entries = [...reader.entries()];
  const sourceIndex = /* @__PURE__ */ new Map();
  {
    let pos = layout.cdOffset;
    for (let i = 0; i < layout.totalEntries; i++) {
      const cfh = parseCentralFileHeader(reader.bytes, pos);
      const record = {
        entry: entries[i],
        rawCfh: reader.bytes.subarray(pos, pos + cfh.recordLength)
      };
      if (sourceIndex.has(record.entry.name)) {
        throw new ZipFormatError(
          "ZIP_DUPLICATE_ENTRY_NAME",
          `zipnative: the archive contains duplicate entry name '${record.entry.name}' \u2014 incremental modification of duplicate-name archives is not supported; extract and rebuild with createZip() instead`
        );
      }
      sourceIndex.set(record.entry.name, record);
      pos += cfh.recordLength;
    }
  }
  const edits = /* @__PURE__ */ new Map();
  let pendingComment = null;
  const existsNow = (name) => {
    const edit = edits.get(name);
    if (edit !== void 0) return edit.kind !== "remove";
    return sourceIndex.has(name);
  };
  const defaultCompression = options?.compression;
  let defaultDos;
  if (options?.defaultDate === "now") {
    emit(timestampNotPinnedDiagnostic());
    defaultDos = dateToDosDateTime(/* @__PURE__ */ new Date());
  } else if (options?.defaultDate instanceof Date) {
    defaultDos = dateToDosDateTime(options.defaultDate);
  } else {
    defaultDos = { dosDate: DETERMINISTIC_DOS_DATE, dosTime: DETERMINISTIC_DOS_TIME };
  }
  const validateNewName = (name, isDirectory) => {
    const finalName = validateEntryName(name, isDirectory);
    enforceLimit(limits, "maxNameBytes", te2.encode(finalName).length, "entry name length");
    return finalName;
  };
  const specForWrite = (name, edit) => {
    const isDirectory = name.endsWith("/");
    const compression = edit.options?.compression;
    const dos = edit.options?.date !== void 0 ? dateToDosDateTime(edit.options.date) : defaultDos;
    return {
      nameBytes: te2.encode(name),
      isDirectory,
      data: isDirectory ? new Uint8Array(0) : edit.data,
      source: null,
      method: isDirectory ? "store" : compression?.method ?? defaultCompression?.method ?? "deflate",
      level: compression?.level ?? defaultCompression?.level ?? 6,
      deterministic: compression?.deterministic ?? defaultCompression?.deterministic ?? false,
      dosDate: dos.dosDate,
      dosTime: dos.dosTime,
      externalAttributes: edit.options?.externalAttributes ?? (isDirectory ? (16877 << 16 | 16) >>> 0 : 33188 << 16 >>> 0),
      comment: edit.options?.comment === void 0 ? new Uint8Array(0) : te2.encode(edit.options.comment),
      extraFields: edit.options?.extraFields ?? []
    };
  };
  const rawCompressedSlice = (entry) => {
    if (!entry.isEncrypted) return reader.readEntryRaw(entry);
    const lfh = parseLocalFileHeader(reader.bytes, entry.localHeaderOffset);
    if (lfh.compressionMethod !== entry.compressionMethod) {
      throw new ZipSecurityError(
        "ZIP_CD_LFH_MISMATCH",
        `zipnative: entry '${entry.name}' local header declares method ${lfh.compressionMethod} but the central directory says ${entry.compressionMethod} \u2014 parser-differential archives are rejected`,
        entry.name
      );
    }
    const dataEnd = lfh.dataStart + entry.compressedSize;
    if (dataEnd > reader.bytes.length || dataEnd > layout.cdOffset) {
      throw new ZipFormatError(
        "ZIP_RECORD_TRUNCATED",
        `zipnative: entry '${entry.name}' data extends past its region (truncated or corrupt archive)`
      );
    }
    return reader.bytes.subarray(lfh.dataStart, dataEnd);
  };
  const planForCopy = (source, nameBytes) => ({
    nameBytes,
    method: source.compressionMethod,
    flags: source.flags & ~FLAG_DATA_DESCRIPTOR,
    dosDate: source.dosDate,
    dosTime: source.dosTime,
    externalAttributes: source.externalAttributes,
    comment: source.comment,
    // Zip64 extras are recomputed from the new offsets; the rest travel.
    extraFields: source.extraFields.filter((f) => f.id !== EXTRA_ZIP64),
    payload: rawCompressedSlice(source),
    source: null,
    level: 6,
    deterministic: false,
    crc32: source.crc32,
    compressedSize: source.compressedSize,
    uncompressedSize: source.uncompressedSize,
    versionMadeBy: source.versionMadeBy,
    internalAttributes: source.internalAttributes,
    versionNeededMin: source.versionNeeded
  });
  const buildAppendedPlans = () => {
    const writeSpecs = [];
    const copyPlans = [];
    for (const [name, edit] of edits) {
      if (edit.kind === "write") {
        writeSpecs.push(specForWrite(name, edit));
      } else if (edit.kind === "rawCopy") {
        copyPlans.push(planForCopy(edit.source, te2.encode(name)));
      }
    }
    const writePlans = planArchive(writeSpecs, new Uint8Array(0), limits).plans;
    return [...writePlans, ...copyPlans].sort((a, b) => compareNames(a.nameBytes, b.nameBytes));
  };
  const survivingSources = () => [...sourceIndex.values()].filter((record) => !edits.has(record.entry.name));
  const deadBytesEstimate = (originalLength) => {
    let dead = originalLength - layout.cdOffset;
    for (const name of edits.keys()) {
      const record = sourceIndex.get(name);
      if (record === void 0) continue;
      try {
        const lfh = parseLocalFileHeader(reader.bytes, record.entry.localHeaderOffset);
        dead += lfh.dataStart - record.entry.localHeaderOffset + record.entry.compressedSize;
      } catch {
      }
    }
    return dead;
  };
  return {
    reader,
    addEntry(name, data, entryOptions) {
      const bytes = typeof data === "string" ? te2.encode(data) : data;
      const finalName = validateNewName(name, false);
      if (finalName.endsWith("/") && bytes.length > 0) {
        throw new ZipError(
          "ZIP_INVALID_OPTION",
          `zipnative: entry name '${finalName}' ends with '/' (a directory) but carries data \u2014 drop the trailing slash for a file, or pass empty data for a directory`
        );
      }
      if (existsNow(finalName)) {
        throw new ZipError(
          "ZIP_ENTRY_EXISTS",
          `zipnative: entry '${finalName}' already exists \u2014 use replaceEntry() to overwrite it`
        );
      }
      edits.set(finalName, { kind: "write", data: bytes, options: entryOptions });
    },
    replaceEntry(name, data, entryOptions) {
      const bytes = typeof data === "string" ? te2.encode(data) : data;
      const finalName = validateNewName(name, false);
      if (!existsNow(finalName)) {
        throw new ZipError(
          "ZIP_ENTRY_NOT_FOUND",
          `zipnative: no entry named '${finalName}' (it may have been removed) \u2014 use addEntry() to create it`
        );
      }
      edits.set(finalName, { kind: "write", data: bytes, options: entryOptions });
    },
    removeEntry(name) {
      if (!existsNow(name)) {
        throw new ZipError(
          "ZIP_ENTRY_NOT_FOUND",
          `zipnative: no entry named '${name}' to remove (names are case-sensitive)`
        );
      }
      if (sourceIndex.has(name)) {
        edits.set(name, { kind: "remove" });
      } else {
        edits.delete(name);
      }
    },
    renameEntry(from, to) {
      if (!existsNow(from)) {
        throw new ZipError(
          "ZIP_ENTRY_NOT_FOUND",
          `zipnative: no entry named '${from}' to rename (it may have been removed)`
        );
      }
      const pending = edits.get(from);
      const fromIsDirectory = pending?.kind === "write" ? from.endsWith("/") : sourceIndex.get(from)?.entry.isDirectory ?? from.endsWith("/");
      const finalTo = validateNewName(to, fromIsDirectory);
      if (existsNow(finalTo)) {
        throw new ZipError(
          "ZIP_ENTRY_EXISTS",
          `zipnative: an entry named '${finalTo}' already exists \u2014 removeEntry() it first (renames never overwrite implicitly)`
        );
      }
      if (pending !== void 0 && pending.kind !== "remove") {
        edits.set(finalTo, pending);
      } else {
        const record = sourceIndex.get(from);
        edits.set(finalTo, { kind: "rawCopy", source: record.entry });
      }
      if (sourceIndex.has(from)) {
        edits.set(from, { kind: "remove" });
      } else {
        edits.delete(from);
      }
    },
    setComment(comment) {
      const bytes = typeof comment === "string" ? te2.encode(comment) : comment;
      enforceLimit(limits, "maxCommentBytes", bytes.length, "archive comment length");
      pendingComment = bytes;
    },
    save() {
      if (edits.size === 0 && (pendingComment === null || bytesEqual(pendingComment, layout.comment))) {
        return reader.bytes;
      }
      const original = reader.bytes;
      const base = layout.base;
      const segments = [original];
      let abs = original.length;
      const emitSeg = (bytes) => {
        segments.push(bytes);
        abs += bytes.length;
      };
      const appended = buildAppendedPlans();
      const storedOffsets = new Array(appended.length);
      for (let i = 0; i < appended.length; i++) {
        const plan = appended[i];
        storedOffsets[i] = abs - base;
        emitSeg(writeLocalFileHeader({
          versionNeeded: Math.max(20, plan.versionNeededMin ?? 0),
          flags: plan.flags,
          compressionMethod: plan.method,
          dosTime: plan.dosTime,
          dosDate: plan.dosDate,
          crc32: plan.crc32,
          compressedSize: plan.compressedSize,
          uncompressedSize: plan.uncompressedSize,
          name: plan.nameBytes,
          extra: serializeExtraFields(plan.extraFields)
        }));
        if (plan.payload !== null && plan.payload.length > 0) {
          emitSeg(plan.payload);
        }
      }
      const cdStartAbs = abs;
      const items = [
        ...survivingSources().map((record) => ({ nameBytes: record.entry.rawName, raw: record.rawCfh })),
        ...appended.map((plan, i) => ({ nameBytes: plan.nameBytes, plan, storedOffset: storedOffsets[i] }))
      ];
      items.sort((a, b) => compareNames(a.nameBytes, b.nameBytes));
      enforceLimit(limits, "maxEntries", items.length, "surviving entry count");
      for (const item of items) {
        if ("raw" in item) {
          emitSeg(item.raw);
          continue;
        }
        const { plan, storedOffset } = item;
        const z64Off = storedOffset > SENTINEL_U32 - 1 ? storedOffset : void 0;
        const usesZip64 = z64Off !== void 0;
        const extraParts = [];
        if (usesZip64) extraParts.push(buildZip64Extra(void 0, void 0, z64Off));
        if (plan.extraFields.length > 0) extraParts.push(serializeExtraFields(plan.extraFields));
        const extra = extraParts.length === 0 ? new Uint8Array(0) : extraParts.length === 1 ? extraParts[0] : concatBytes(extraParts);
        emitSeg(writeCentralFileHeader({
          versionMadeBy: plan.versionMadeBy ?? 813,
          versionNeeded: Math.max(usesZip64 ? 45 : 20, plan.versionNeededMin ?? 0),
          flags: plan.flags,
          compressionMethod: plan.method,
          dosTime: plan.dosTime,
          dosDate: plan.dosDate,
          crc32: plan.crc32,
          compressedSize: plan.compressedSize,
          uncompressedSize: plan.uncompressedSize,
          internalAttributes: plan.internalAttributes ?? 0,
          externalAttributes: plan.externalAttributes,
          localHeaderOffset: usesZip64 ? SENTINEL_U32 : storedOffset,
          name: plan.nameBytes,
          extra,
          comment: plan.comment
        }));
      }
      const cdSize = abs - cdStartAbs;
      const cdOffsetStored = cdStartAbs - base;
      enforceLimit(limits, "maxCentralDirectoryBytes", cdSize, "new central-directory size");
      const count = items.length;
      const needsZip64 = count > SENTINEL_U16 - 1 || cdSize > SENTINEL_U32 - 1 || cdOffsetStored > SENTINEL_U32 - 1;
      if (needsZip64) {
        const z64Abs = abs;
        emitSeg(writeZip64Eocd(count, cdSize, cdOffsetStored));
        emitSeg(writeZip64Locator(z64Abs - base));
      }
      emitSeg(writeEocd(
        count > SENTINEL_U16 - 1 ? SENTINEL_U16 : count,
        cdSize > SENTINEL_U32 - 1 ? SENTINEL_U32 : cdSize,
        cdOffsetStored > SENTINEL_U32 - 1 ? SENTINEL_U32 : cdOffsetStored,
        pendingComment ?? layout.comment
      ));
      const dead = deadBytesEstimate(original.length);
      if (dead / abs > 0.5) {
        emit(deadBytesRatioDiagnostic(dead, abs));
      }
      const out = new Uint8Array(abs);
      let pos = 0;
      for (const segment of segments) {
        out.set(segment, pos);
        pos += segment.length;
      }
      return out;
    },
    saveCompact() {
      const writeSpecs = [];
      const plans = [];
      for (const [name, edit] of edits) {
        if (edit.kind === "write") {
          writeSpecs.push(specForWrite(name, edit));
        } else if (edit.kind === "rawCopy") {
          plans.push(planForCopy(edit.source, te2.encode(name)));
        }
      }
      for (const record of survivingSources()) {
        plans.push(planForCopy(record.entry, record.entry.rawName));
      }
      plans.push(...planArchive(writeSpecs, new Uint8Array(0), limits).plans);
      plans.sort((a, b) => compareNames(a.nameBytes, b.nameBytes));
      enforceLimit(limits, "maxEntries", plans.length, "surviving entry count");
      const ctx = {
        plans,
        comment: pendingComment ?? layout.comment};
      return assembleArchive(ctx);
    }
  };
}
function concatBytes(parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// src/index.ts
var VERSION = "0.8.0";

export { DEFAULT_ZIP_LIMITS, FLAG_DATA_DESCRIPTOR, FLAG_ENCRYPTED, FLAG_STRONG_ENCRYPTION, FLAG_UTF8, METHOD_DEFLATE, METHOD_STORE, VERSION, ZipDataError, ZipError, ZipFormatError, ZipLimitError, ZipSecurityError, ZipUnsupportedError, activeDeflateTier, crc32, createInflator, createZip, createZipModifier, extractZip, extractZipStream, getCodec, initNodeZipCodecs, iterateZipEntries, openZip, registerCodec, sanitizeEntryPath, setDeflateImpl, setInflateImpl };