# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-01

Milestone **M3 — incremental modification**.

### Added

- `createZipModifier()` ([src/parser/zip-modifier.ts](src/parser/zip-modifier.ts)) — `addEntry`/`replaceEntry`/`removeEntry`/`renameEntry`/`setComment` over an edit overlay (source bytes never mutated) with two save paths:
  - `save()` — **append-only**: original archive copied verbatim (SFX prefixes included, offsets stay valid by construction), appended entries, a new central directory in which untouched records are the source's raw CFH bytes verbatim, new EOCD with Zip64 promotion. No-op returns `reader.bytes` by reference. Untouched entries are never recompressed. **Data remanence documented loudly**: removed/replaced content remains recoverable — a `ZIP_DEAD_BYTES_RATIO` diagnostic fires past 50% dead bytes.
  - `saveCompact()` — canonical rewrite through the same segment generator as `createZip`, still without recompression (payloads raw-copied with their CRC/sizes/metadata), removed content truly gone. Zero-edit compact of a deterministic `createZip` archive reproduces it byte-identically (golden-tested).
  - Renames are raw copies into the appended zone — zipnative never emits an archive its own strict reader would flag. Encrypted entries are copyable (never decompressed, never readable). Duplicate-name source archives are refused with a typed error.
- **Contributor sample generation** (`npm run test:generate`, the pdfnative model): 8 generators → 22 archives in git-ignored `test-output/`, grouped by feature area, each self-validated through the eager reader as written; includes the `incremental-original/-updated/-compacted` triple demonstrating append-only remanence vs true deletion. Sample-count canary in `verify:docs` (surplus fails, shortfall warns). Recipe: `update-entry-in-place`.
- Interop gate: `modified-incremental` and `modified-compacted` write cases — foreign extractors validate and byte-compare archives carrying dead bytes from incremental saves.

### Changed

- `validateEntryName`/`compareNames` moved to [src/core/zip-encoding.ts](src/core/zip-encoding.ts) (shared by builder and modifier); `PlannedEntry` gained optional source-fidelity fields (`versionMadeBy`, `internalAttributes`, `versionNeededMin`) that `planArchive` never sets — `createZip` output bytes are unchanged (determinism goldens prove it).

## [0.2.0] - 2026-09-01

Milestone **M2 — deterministic write + streaming**.

### Added

- `createZip()` — archive writer with `add`, `addDirectory`, `addStream`, `setComment`, and two output paths consuming ONE shared segment generator: `toBytes()` (sync, buffered) and `stream()` (async, fixed-size chunks, bounded memory) — byte-identical by construction ([src/core/zip-segments.ts](src/core/zip-segments.ts)).
- **Pure-TS raw DEFLATE encoder** ([src/codecs/deflate-pure.ts](src/codecs/deflate-pure.ts)): LZ77 hash chains with zlib's level configuration, one-step lazy matching, fixed + dynamic Huffman with the 15-bit overflow fix, exact-cost block selection. Within 5% of zlib -6 on typical corpora; validated by differential fuzzing against zlib inflate (200 seeded rounds) and frozen golden SHA-256 hashes.
- **Determinism contract** ([docs/determinism.md](docs/determinism.md)): canonical entry ordering, DOS-epoch default timestamps, constant metadata; `compression: { deterministic: true }` pins the pure encoder for cross-runtime byte-identical archives. Golden-tested.
- 4-tier deflate compression facade ([src/codecs/deflate.ts](src/codecs/deflate.ts)): injection (with `level`) → node:zlib → pure TS; `CompressionStream('deflate-raw')` used on streaming paths.
- `addStream()` entries with data-descriptor layout; Zip64 auto-promotion for >65 535 entries and >4 GiB offsets (round-trip tested with a real 70 000-entry archive).
- Interop **write gate now blocking**: zipnative's archive matrix (store/deflate, streamed descriptors, deterministic mode, unicode names, zip64 counts) validated and byte-compared by foreign extractors (Expand-Archive, bsdtar, unzip, 7z, python zipfile, jar — whichever are present).
- Scenario benchmarks vs fflate/jszip/adm-zip + committed [bench/RESULTS.md](bench/RESULTS.md).
- Recipes: `deterministic-build`, `create-streaming`.

### Changed

- Reader overlap defence reworked to O(log n) per read: sorted region boundaries from the central directory + real-extent check at local-header parse time (duplicate offsets rejected outright; `validate: 'eager'` still checks every entry). Random access on a 10k-entry archive is now the fastest of the compared libraries.

### Known limitations

- `addStream` entries beyond 4 GiB are rejected (`ZipUnsupportedError('zip64-streaming')`) — buffer via `add()`; Zip64 streaming is scheduled post-M4.
- Without `CompressionStream` (or when `deterministic: true`), stream-entry compression buffers the entry (documented fallback).

## [0.1.0] - 2026-09-01

Milestone **M1 — read + random access + secure extraction**. Tagged, not published to npm.

### Added

- Project scaffolding: build (tsup, ESM+CJS+types), strict TypeScript (3 configs), ESLint 9 flat config, vitest 4 with v8 coverage thresholds, CI (ubuntu Node 22/24 matrix + blocking Windows job), CodeQL, OpenSSF Scorecard, Dependabot, interop conformance workflow, docs integrity workflow, AI-agent governance policy.
- **Read path**: `openZip()` with lazy central-directory parsing and random access, `readEntry()` / `readEntryStream()` / `readEntryRaw()` / `verifyEntry()`, secure-by-default `extractZip()` / `extractZipStream()` with `sanitizeEntryPath()`, Zip64 reading with anti-spoofing cross-checks, UTF-8/CP437 name decoding, CRC-32 (slice-by-8), 4-tier inflate facade (injection → node:zlib → DecompressionStream → pure TS), CWE-tagged configurable security limits, deduplicating diagnostics channel, typed error hierarchy, adversarial fuzzing suite, foreign-provenance interop fixtures.
