---
description: "ZIP format engine rules — records, offsets, Zip64, EOCD"
applyTo: "src/core/**,src/parser/**"
---

# ZIP core engineering rules

- All fixed-layout record I/O goes through `src/core/zip-structs.ts` pure
  functions over `DataView`. Never hand-decode header bytes elsewhere.
- ZIP integers are **little-endian, unsigned**. 64-bit fields are read with
  `getBigUint64` and converted to `number`; any value above
  `Number.MAX_SAFE_INTEGER` throws `ZipFormatError`. No `bigint` in public API.
- The **central directory is authoritative** over local headers. Divergence
  policy (fatal vs diagnostic) is the table in `src/parser/zip-reader.ts` —
  extend the table, don't scatter ad-hoc checks.
- EOCD discovery: backward scan ≤ 65 557 bytes; accept only a self-consistent
  candidate (`pos + 22 + commentLength === fileLength`) closest to EOF;
  ambiguity → `ZipFormatError`, never a guess. Prepended data shifts every
  offset by `base` and emits `ZIP_PREPENDED_DATA`.
- Zip64: a sentinel (`0xFFFF`/`0xFFFFFFFF`) is the ONLY licence to read the
  64-bit replacement; a zip64 extra supplying a non-sentinel field is
  diagnosed and ignored; Zip64-EOCD values diverging from non-sentinel
  classic values are `ZipSecurityError`.
- Entry payloads are **zero-copy `subarray` views** of the source buffer.
  Copy only at decompression output.
- Offsets carried in `ZipEntry` are absolute (prepend shift already applied).
