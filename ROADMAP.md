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

- Interop write gate: 11 → 17 validations (SFX stubs via the modifier,
  comment-heavy, empty archive, store-only); refusal-posture suite
  pinning the typed refusals foreign tools tolerate
- Guide renderer (`docs:guides`, .md as the source of truth) +
  `guide-render-sync`/`anchor-parity` rules (~17 named rules total)
- og:image shipped (the 0.6 deferral is closed), favicon/logo redesign,
  architecture diagrams, `docs:serve`

## 0.8.x — Error-code stability + docs charter ✅ *(shipped 2026-09-01, current)*

- 0.8.1: a three-agent code review (13 verified fixes, all regression-
  tested), interactive browser playgrounds on a committed engine bundle,
  and a four-case use-cases guide with diagrams

- **Stable machine-readable error codes**: every thrown error carries
  `err.code` from a closed 39-code union, frozen from 0.8.0
  (removal/renaming is semver-major); registry `docs/data/errors.json`
  + `error-parity` verify rule + the errors guide
- Freeze decisions resolved: `createInflator`/`Inflator` published
  (exact `bytesConsumed` — the resumable-inflate differentiator),
  `ZipUnsupportedFeature` closed, `FLAG_*` masks and
  `activeDeflateTier()` exported, `_spawn` removed from public types,
  `./worker/zip-worker.js` subpath export, api.json covers `./worker`
- Docs site rethemed to the exact pdfnative charter (tokens, layout,
  guide chrome, Prism, architecture diagram, metrics/comparison/
  benchmarks sections)

## 0.9 — Final pre-freeze release candidate

- `verifyZip(data, options?)` — one-call deep validation returning a
  stable machine-readable report (the agent-facing archive inventory)
- `iterateZipEntries` source widening (`ReadableStream<Uint8Array>`)
- Entry attribute helpers (`isSymlinkEntry`, `getUnixMode`)
- Zip64-streaming decision record (per-entry opt-in design; the typed
  refusal lifts additively, implementation may land post-1.0)
- Freeze checklist + last-chance taxonomy renames, RC tag

## 1.0.0

- Semver commitment; npm Trusted Publishing (OIDC) + provenance; the publish
  workflow re-runs the entire gate

## Post-1.0 satellites (separate repos)

- `zipnative-cli` — agent-grade CLI (`--json` envelope, `--dry-run`,
  doctor/schema/completion)
- `zipnative-mcp` — MCP server mirroring the CLI's JSON contract
- Read-only AES decryption behind an injected crypto provider (if demand)
