# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-09-01

**Resumable inflater + documentation infrastructure.**

### Added

- **Resumable pure-TS raw-deflate decoder** ([src/codecs/inflate-stream.ts](src/codecs/inflate-stream.ts)) — a chunk-fed, suspendable coroutine (sync-generator design: language-level suspension persists all decoder state) with EXACT consumed-byte reporting via the decoder's `bitCnt ≤ 7` refill invariant, a sliding 64 KiB window, and incremental output bounding. Differentially fuzzed against zlib at 1-byte-to-whole chunkings with `bytesConsumed` asserted exact.
- **`iterateZipEntries` now reads data-descriptor entries (flag bit 3)** for plain deflate — zipnative's own `addStream()` output and bsdtar-style archives are forward-readable. The trailing descriptor is identified by **validation against the measured CRC and sizes** (all four spec forms — signed/signless × 32/64-bit; the `PK\x07\x08` signature is a hint, never authoritative, so the CRC-equals-signature collision is handled). Still refused: store+bit3 (not self-delimiting), encrypted+bit3, custom codecs+bit3. `skip()` on a bit-3 entry costs a full decompress-and-discard (documented). Bit-3 protection = output counting + an incremental ratio guard (declared sizes don't exist).
- The known-size no-`DecompressionStream` fallback now streams through the resumable inflater — the old buffer-the-whole-entry caveat is gone.
- **Documentation infrastructure** (the 0.6 hardening band): mechanical [docs/assets/api.json](docs/assets/api.json) (`npm run docs:api` — regex extraction, null-never-guessed), the llms pipeline (`npm run docs:llms` → llms-full.txt / llms-recipes.txt / llms-index.json with shared slugify and LF-normalised sizes), and the static docs site v1 ([docs/](docs/): landing page with the load-bearing SEO/JSON-LD set, three guides as .md+.html pairs, sitemap with audit-date lastmod, robots.txt naming llms.txt, zero build dependencies).
- **verify-docs expanded to ~15 named rules** (Problem/walk/allow-marker infrastructure): api-json-sync, llms-sync, llms-index-sync, llms-index-quality, verified-on-parity, seo-head, internal-links, sitemap-parity, jsonld-version, cdn-sri, contrast (WCAG on the theme tokens), plus the existing version/manifest/sample rules — it caught real defects (broken links from the guide move, a stale JSON-LD version) during its own introduction.

### Changed

- `docs/determinism.md` moved to [docs/guides/determinism.md](docs/guides/determinism.md) (guides are the llms-pipeline source of truth); references updated.
- Shared inflate tables extracted to [src/codecs/inflate-shared.ts](src/codecs/inflate-shared.ts) (one-shot and resumable decoders import one implementation; the encoder stays deliberately self-contained — its bytes are the frozen contract).

## [0.5.0] - 2026-09-01

Milestone **M4 — workers, parallelism and forward streaming**.

### Added

- **`zipnative/worker` subpath** — `createParallelZip()` ([src/worker/](src/worker/)): per-entry deflate fanned out across a real worker pool (Node `worker_threads` AND Web Workers, sized from available cores, capped at 8), with a readiness handshake, per-job timeout, slice-before-transfer rule (caller buffers are never detached), and graceful degradation — worker failures recompress the affected job inline; an archive never fails for infrastructure reasons. `ParallelZipWriter` matches `ZipWriter` except `toBytes(): Promise<Uint8Array>`. **Byte-identity with `createZip` per resolved compression tier is a tested contract** (including through real worker threads); `deterministic: true` guarantees it unconditionally. Worker script resolved by the library (`new URL('./zip-worker.js', import.meta.url)`) with a `workerUrl` escape hatch.
- **`iterateZipEntries()`** ([src/parser/zip-iterate.ts](src/parser/zip-iterate.ts)) — forward, central-directory-less streaming reader for pipes and unseekable bodies: bounded memory (incremental `DecompressionStream` pump), all security limits enforced with output counting, CRC verified, drain contract enforced, clean stop at the central directory. **Trust caveat documented**: local headers only — `openZip()` remains the authoritative path. v0.5 scope: data-descriptor entries (flag bit 3) are refused with `ZipUnsupportedError('cd-less-descriptor')` — this includes zipnative's own `addStream()` output and some producers (bsdtar among them); a resumable inflater is roadmapped.
- Fuzzing: `streaming-boundaries` suite (1-byte/prime chunkings, truncation at every point, seeded corruption — which caught and pinned a real `DecompressionStream` hang on truncated input during development).
- CI: real-worker integration step post-build on Linux and Windows; scheduled non-blocking `bench.yml` trend archive. Perf-gate decision recorded: no blocking benchmark gate (shared-runner variance), reference numbers refreshed per minor in `bench/RESULTS.md`.
- Recipe: `iterate-stream`.

### Changed

- Core planning refactored behavior-frozen: shared `finishBufferedPlan` (the deterministic method rules exist once), `planArchiveAsync` with injected compressor, `createSpecCollector` behind both writers, shared `assembleArchive`. `createZip` bytes unchanged (goldens prove it).

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
- **Determinism contract** ([docs/guides/determinism.md](docs/guides/determinism.md)): canonical entry ordering, DOS-epoch default timestamps, constant metadata; `compression: { deterministic: true }` pins the pure encoder for cross-runtime byte-identical archives. Golden-tested.
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
