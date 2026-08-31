# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
