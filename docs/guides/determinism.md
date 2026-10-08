# The zipnative determinism contract

> Reproducible output is a product feature with a written contract: what is
> guaranteed always, what is guaranteed per environment, and what
> `compression: { deterministic: true }` pins bit-for-bit on every runtime.

This document is the contract; it was written down *before* anyone depended
on it, and the golden tests
([tests/core/zip-determinism.test.ts](https://github.com/Nizoka/zipnative/blob/main/tests/core/zip-determinism.test.ts),
[tests/codecs/deflate-pure.test.ts](https://github.com/Nizoka/zipnative/blob/main/tests/codecs/deflate-pure.test.ts))
enforce it byte-for-byte.

## The three levels of guarantee

1. **Structurally deterministic — always.** Entry order, header layout,
   flags, attributes, timestamps and Zip64 decisions never depend on the
   clock, randomness, locale or environment. Two `createZip` runs with
   identical inputs produce structurally identical archives everywhere.
   One stated exception: an explicit `Date` is written as a local-time DOS
   field by default (the Info-ZIP / 7-Zip convention), so it follows the
   process time zone unless `dosTimeMode: 'utc'` is set (1.1) or the date
   is omitted (DOS epoch).
2. **Bitwise deterministic per environment — the default.** Deflate
   compresses through the best available tier (`node:zlib`, or the pure-TS
   encoder elsewhere), so bytes are stable for a given runtime + zlib
   build, but may differ across environments.
3. **Bitwise deterministic everywhere — `compression: { deterministic: true }`.**
   The pure-TS encoder is pinned: `SHA256(A) === SHA256(B)` for identical
   inputs on every runtime (Node, browsers, Deno, Bun, Workers). This is
   the mode for content addressing, reproducible builds, caching and
   signatures.

## Canonicalization rules (level 1, always)

| Aspect | Rule |
|---|---|
| Entry order | sorted by raw UTF-8 name bytes, unsigned bytewise (`order: 'insertion'` preserves call order — still deterministic given identical calls) |
| Timestamps | DOS epoch `1980-01-01 00:00:00` unless a `Date` is given; fields are local-time by default, UTC with `dosTimeMode: 'utc'` (1.1); dates below 1980-01-01 clamp to the epoch, above 2107-12-31 23:59:58 to that maximum, an invalid `Date` to the epoch — each with the `ZIP_TIMESTAMP_CLAMPED` diagnostic (1.1; before, an out-of-range date produced a wrong date silently); `'now'` emits `ZIP_TIMESTAMP_NOT_PINNED` |
| Name encoding | always UTF-8 with flag bit 11, including pure-ASCII names |
| version-made-by | constant `0x032D` (Unix, spec 4.5) |
| versions-needed | 20, or 45 exactly when the entry uses Zip64 — `addStream` entries with `zip64: true` (1.1) use 45 in both records |
| External attributes | files `0o100644 << 16`, directories `(0o40755 << 16) \| 0x10` |
| Internal attributes | 0 |
| Extra fields | none, except Zip64 (0x0001) exactly when a field overflows, carrying exactly the overflowed fields in spec order; caller-supplied `extraFields` are embedded verbatim (their determinism is the caller's) and bounded — `maxExtraFieldBytes` plus a hard 65535 structural cap (the u16 header field), enforced at plan time since 0.8.1 — and, for `addStream` entries with `zip64: true` (1.1), a Zip64 extra with both sizes zero in the local header (APPNOTE 4.5.3, sizes sentinel) and one with both final sizes in the central record, the offset only when it overflows |
| Method selection | empty content is stored; deflate falls back to store when it does not shrink the payload (a pure function of the content) |
| Zip64 records | emitted exactly when a classic field overflows; classic EOCD sentinels only the overflowed fields |
| Data descriptors | never on buffered entries; always on `addStream` entries — the 16-byte form, or the 24-byte Zip64 form exactly when `zip64: true` (1.1) |

## Canonical compaction (level 1, 1.1)

`canonicalizeZip(bytes)` and `saveCompact({ canonical: true })` rewrite
*any* archive — whoever produced it — into the canonical form without
decompressing a payload, and the resulting bytes are part of this
contract: the golden SHA-256 hashes in
[tests/parser/zip-canonical.test.ts](https://github.com/Nizoka/zipnative/blob/main/tests/parser/zip-canonical.test.ts)
pin `canonicalizeZip()` over two committed foreign fixtures (a bsdtar and
a PowerShell archive), and changing them is semver-major.

| Aspect | Rule |
|---|---|
| Entry order | raw name bytes ascending, unsigned bytewise |
| Timestamps | the DOS epoch, or the one `date` passed (`dosTimeMode` applies) |
| Name encoding | flag bit 11 set on every non-ASCII name; raw bytes never re-encoded |
| version-made-by | `0x032D` |
| Extra fields | dropped except Zip64 (0x0001), recomputed |
| Comments | dropped unless `keepComments: true` |
| External attributes | kept unless `keepExternalAttributes: false` |
| Payloads, layout | compressed bytes copied bit for bit; the compact layout (no descriptors, no prefix, no dead bytes) |
| Idempotence | `canonicalizeZip(canonicalizeZip(x))` equals `canonicalizeZip(x)` |

`analyzeDeterminism(bytes)` reports which of these rules an archive
already satisfies (`epochTimestamps`, `canonicalOrder`, `utf8Flags`,
`canonicalExtras`, `canonicalVersionMadeBy`, `noDataDescriptors` — the
last informational) and names every offending entry. It checks for the
DOS epoch unless given the pinned date: `analyzeDeterminism(bytes, { date,
dosTimeMode })` is the verdict for an archive canonicalised with that
`date`. The
[reproducible builds guide](reproducible-builds.html) walks through
measure → canonicalise → prove.

## The frozen encoder contract (level 3)

Under `deterministic: true`, deflate output bytes are produced by
[src/codecs/deflate-pure.ts](https://github.com/Nizoka/zipnative/blob/main/src/codecs/deflate-pure.ts) and every
constant in that file is frozen public API:

- hash function `imul(3-byte window, 0x9E3779B1) >>> 17` over a 32 KiB
  window with head/prev chains;
- zlib's level configuration table (good/lazy/nice/chain for levels 1–9);
- unified one-step-lazy matching, deferred match wins ties, `TOO_FAR = 4096`;
- 65 534-symbol blocks, hash history never reset across blocks;
- Huffman construction: two-queue merge over leaves sorted (frequency
  ascending, symbol ascending), leaf preferred on equal cost, zlib
  overflow fix at 15 bits (7 for the code-length tree), reassignment in
  the same sorted order;
- block choice at exact bit cost with the tie order stored ≤ fixed ≤ dynamic.

**Changing any of these changes emitted bytes and is a semver-major
release.** The golden SHA-256 tables in the test suite are the tripwire.

## Documented determinism losses

| Situation | Effect | Signal |
|---|---|---|
| Default codec tier (no `deterministic: true`) | bytes vary across zlib builds | `ZIP_NONDETERMINISTIC_CODEC` (info; emitted when an explicit date is pinned but the codec is not) |
| `defaultDate: 'now'` | bytes vary per run | `ZIP_TIMESTAMP_NOT_PINNED` (info) |
| `addStream` vs `add` of identical content | different layout (data descriptor) | documented here; use `add()` when bytes must match |
| Injected codec (`setDeflateImpl`) | caller-defined bytes | never used for `deterministic: true` |
| Explicit `Date` without `dosTimeMode: 'utc'` | DOS fields follow the process time zone | documented here (1.1); set `dosTimeMode: 'utc'` or omit the date |
| `addStream` + `zip64: true` on content below 4 GiB | Zip64 records without an overflow; streaming readers that size the descriptor from measured lengths (Java `ZipInputStream`) cannot read the entry | documented here (1.1); opt in only for entries that may exceed 4 GiB |
| `deterministic: true` + `addStream` above 2 GiB | `ZIP_INPUT_TOO_LARGE` — the pinned encoder buffers one entry | use `store` or the default tier for the Zip64 opt-in |

## Verifying reproducibility

```ts
import { createZip } from 'zipnative';

const build = () => {
    const zip = createZip({ compression: { deterministic: true } });
    zip.add('data.json', payload); // identical inputs...
    return zip.toBytes();
};
// ...identical bytes, on any runtime:
sha256(build()) === sha256(build());
```

For an archive you did not build, `analyzeDeterminism(bytes)` (1.1) says
which rule it breaks and `canonicalizeZip(bytes)` rewrites it into the
canonical form above — the [reproducible builds guide](reproducible-builds.html).
