# Roadmap

zipnative ships milestone by milestone; each version lands against the full
quality gate (typecheck, lint, coverage, build, package checks, Linux + Windows
CI, fuzzing, and — from 0.2 — the blocking interop conformance gate).

## 0.1.x — M1: Read + random access + secure extract ✅ *(shipped 2026-09-01)*

- `openZip()` — lazy central-directory reader, name-indexed random access
- `readEntry` / `readEntryStream` / `readEntryRaw` / `verifyEntry`
- Secure-by-default `extractZip` / `extractZipStream`, `sanitizeEntryPath`
- Zip64 reading with anti-spoofing cross-checks; UTF-8/CP437 names
- CRC-32 (slice-by-8); 4-tier inflate facade (injection → node:zlib →
  DecompressionStream → pure TS)
- CWE-tagged configurable limits; diagnostics channel; typed errors
- Adversarial fuzzing suite; interop read corpus (foreign-tool fixtures)

## 0.2.x — M2: Deterministic write + streaming ✅ *(shipped 2026-09-01)*

- `createZip()` with `toBytes()` and `stream()` over one shared segment
  generator (byte-identical by construction)
- Pure-TS deflate encoder (the determinism pin) + differential fuzzing vs zlib
- `addStream()` with data descriptors; Zip64 auto-promotion
- The determinism contract, written down in `docs/determinism.md` **before**
  anyone depends on it
- Interop write gate goes **blocking** (unzip, 7z, zipinfo, python -m zipfile,
  jar on Linux; 7z, Expand-Archive, bsdtar, jar on Windows)
- Benchmarks vs fflate/jszip/adm-zip + committed `bench/RESULTS.md`

## 0.4.x — M3: Incremental modification ✅ *(shipped 2026-09-01)*

- `createZipModifier()` — append-only `save()` (original bytes verbatim, no
  recompression, no-op returns the identical buffer, SFX prefixes supported)
  and `saveCompact()` (true deletion, canonical layout, still no recompression)
- Round-trip gate: modified archives (dead bytes included) validated and
  byte-compared by foreign extractors in the interop matrix
- Contributor sample corpus (`npm run test:generate` → `test-output/`)

## 0.5.x — M4: Workers + parallelism + forward streaming ✅ *(shipped 2026-09-01)*

- `zipnative/worker`: `createParallelZip()` — real worker pool (Node
  worker_threads + Web Workers), byte-identical to `createZip` per tier,
  graceful degradation, library-resolved worker URL
- `iterateZipEntries()` — forward CD-less streaming reader (bounded
  memory, trust caveat documented; bit-3 entries refused pending the
  resumable inflater below)
- Perf policy recorded: no blocking CI gate; per-minor bench refresh +
  scheduled non-blocking trend workflow

## 0.6.x — Resumable inflater + docs infrastructure ✅ *(shipped 2026-09-01)*

- Chunk-fed, suspendable raw-deflate decoder with exact consumed-byte
  reporting — the forward reader's bit-3 refusal is lifted for plain
  deflate (zipnative's own `addStream` output and bsdtar-style producers
  are forward-readable; store/encrypted/custom-codec + bit 3 stay refused)
- Docs infrastructure shipped ahead of the band: static site v1
  (`docs/`), mechanical `api.json`, llms pipeline, verify-docs at ~15
  named rules

## 0.7.x — Interop corpus expansion + docs finish ✅ *(shipped 2026-09-01)*

- Interop write cases 7 → 11 (SFX stubs via the modifier,
  comment-heavy, empty archive, store-only) — gate total 17 validations
  with the 6 foreign-producer reads; refusal-posture suite
  pinning the typed refusals foreign tools tolerate
- Guide renderer (`docs:guides`, .md as the source of truth) +
  `guide-render-sync`/`anchor-parity` rules (~17 named rules total)
- og:image shipped (the 0.6 deferral is closed), favicon/logo redesign,
  architecture diagrams, `docs:serve`

## 0.8.x — Error-code stability + docs charter ✅ *(shipped 2026-09-01)*

- **0.8.0 — Stable machine-readable error codes**: every thrown error
  carries `err.code` from a closed 39-code union, frozen from 0.8.0
  (removal/renaming is semver-major); registry `docs/data/errors.json`
  + `error-parity` verify rule + the errors guide. Freeze decisions
  resolved: `createInflator`/`Inflator` published (exact
  `bytesConsumed` — the resumable-inflate differentiator),
  `ZipUnsupportedFeature` closed, `FLAG_*` masks and
  `activeDeflateTier()` exported, `_spawn` removed from public types,
  `./worker/zip-worker.js` subpath export, api.json covers `./worker`.
  Docs site rethemed to the exact pdfnative charter.
- **0.8.1 — Docs finish + multi-agent review**: 13 verified fixes
  (12 regression-tested; B7 by inspection), interactive browser
  playgrounds on a committed engine bundle, a four-case use-cases guide
  with diagrams.
- **0.8.2 — Conformance pass**: directory-form navigation (docs:serve
  cleanUrls 404s fixed), APPNOTE-conformant LFH Zip64 extras, honest
  CWE-67 refusal messages, documentation factuality sweep; verify-docs
  at 21 named rules.

## 0.9 — Final pre-freeze release candidate ✅ *(shipped 2026-09-02)*

- `verifyZip(data, options?)` — one-call deep validation returning a
  stable machine-readable report (the agent-facing archive inventory);
  never throws for archive problems, `skipped` reasons for
  encrypted/stream-only-codec entries
- Source widening: `ByteSource` (`AsyncIterable<Uint8Array> |
  ReadableStream<Uint8Array>`) accepted by `iterateZipEntries` AND
  `addStream` (worker subpath included)
- Entry attribute helpers (`isSymlinkEntry`, `getUnixMode`)
- Coverage pass across the whole project: ~24 new tests for the
  untested branches, samples 22 → 33 (hostile refusal corpus under
  inverse validation), recipes 7 → 12, playgrounds 3 → 5 with
  CDN-first engine loading (local-bundle fallback pre-publication)
- Zip64-streaming decision record (per-entry opt-in design; the typed
  refusal lifts additively, implementation may land post-1.0).
  **Decision (0.9.0, ADR):** the design retained is
  `AddEntryOptions.zip64?: boolean` — a per-entry opt-in on `addStream`.
  When set, the writer emits a speculative Zip64 extra in the local
  header with both size fields present-but-zero (APPNOTE §4.5.3) and a
  64-bit data descriptor (`writeDataDescriptor` already supports the
  form); the reader side already accepts all four descriptor shapes, so
  the change is writer-only and additive. The hard part — and the reason
  implementation is deferred post-1.0 — is the speculative LFH extra:
  it must be reserved before sizes are known, and a wrong guess cannot
  be patched in a forward-only stream. Until then the typed refusal
  stays (`ZIP_UNSUPPORTED_ZIP64_STREAMING`), and since 0.9.0 it is
  covered by a regression test instead of being an untested branch.
- Freeze checklist run; no last-chance taxonomy renames were needed
  (the 39-code vocabulary stands as frozen in 0.8.0); RC tagged
- Deferred from the band, logged: a worker playground (the only page
  requiring build-tooling changes — post-1.0)

## 1.0.0 ✅ *(shipped 2026-09-02, current)*

- Semver commitment: the 77-export API surface, the 39-code error
  vocabulary and the `deterministic: true` bytes are frozen (SECURITY.md
  states the promise; `tsdoc-complete` polices 77/77 documented exports)
- npm Trusted Publishing (OIDC) + provenance + CycloneDX SBOM; the
  publish workflow re-runs the entire gate before `npm publish`
- The conformance authority gate ("veraZIP"): `validate:zip` — the
  first open clause-by-clause ISO/IEC 21320-1:2015 validator
  (independent raw parser; JHOVE has no ZIP module, `zip -T` aliases
  `unzip -tqq`) + foreign integrity pass, blocking in conformance.yml
  and publish.yml on top of the six-parser extraction matrix
- Agent token economy: docs/agent-brief.md (+ landing "Copy as
  prompt"), completed llms-index token budget; satellite `--summary`/
  `--fields` contract recorded in AGENTS.md
- Visual identity: the zipper-cut Z (logo, favicon, og-image, GitHub
  social preview)

## Post-1.0 satellites (separate repos)

- `zipnative-cli` — agent-grade CLI (`--json` envelope, `--dry-run`,
  doctor/schema/completion)
- `zipnative-mcp` — MCP server mirroring the CLI's JSON contract
- Read-only AES decryption behind an injected crypto provider (if demand)
