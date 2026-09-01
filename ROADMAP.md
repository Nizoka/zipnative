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

## 0.2.x — M2: Deterministic write + streaming ✅ *(shipped 2026-09-01, current)*

- `createZip()` with `toBytes()` and `stream()` over one shared segment
  generator (byte-identical by construction)
- Pure-TS deflate encoder (the determinism pin) + differential fuzzing vs zlib
- `addStream()` with data descriptors; Zip64 auto-promotion
- The determinism contract, written down in `docs/determinism.md` **before**
  anyone depends on it
- Interop write gate goes **blocking** (unzip, 7z, zipinfo, python -m zipfile,
  jar on Linux; 7z, Expand-Archive, bsdtar, jar on Windows)
- Benchmarks vs fflate/jszip/adm-zip + committed `bench/RESULTS.md`

## 0.4.x — M3: Incremental modification ✅ *(shipped 2026-09-01, current)*

- `createZipModifier()` — append-only `save()` (original bytes verbatim, no
  recompression, no-op returns the identical buffer, SFX prefixes supported)
  and `saveCompact()` (true deletion, canonical layout, still no recompression)
- Round-trip gate: modified archives (dead bytes included) validated and
  byte-compared by foreign extractors in the interop matrix
- Contributor sample corpus (`npm run test:generate` → `test-output/`)

## 0.5.x — M4: Workers + parallelism + forward streaming ✅ *(shipped 2026-09-01, current)*

- `zipnative/worker`: `createParallelZip()` — real worker pool (Node
  worker_threads + Web Workers), byte-identical to `createZip` per tier,
  graceful degradation, library-resolved worker URL
- `iterateZipEntries()` — forward CD-less streaming reader (bounded
  memory, trust caveat documented; bit-3 entries refused pending the
  resumable inflater below)
- Perf policy recorded: no blocking CI gate; per-minor bench refresh +
  scheduled non-blocking trend workflow

## 0.6.x — Resumable pure-TS inflater

- Chunk-fed, suspendable raw-deflate decoder reporting its consumed-byte
  position — lifts the forward reader's bit-3 refusal (zipnative's own
  `addStream` output and bsdtar-style producers become forward-readable)

## 0.6 → 0.9 — Hardening to API freeze

- Docs site (`docs/`, GitHub Pages), `ecosystem.json` single source of truth,
  `verify-docs` named rules, mechanical `api.json`
- Interop corpus expansion (SFX stubs, comments, clean refusals)
- API-freeze release candidates

## 1.0.0

- Semver commitment; npm Trusted Publishing (OIDC) + provenance; the publish
  workflow re-runs the entire gate

## Post-1.0 satellites (separate repos)

- `zipnative-cli` — agent-grade CLI (`--json` envelope, `--dry-run`,
  doctor/schema/completion)
- `zipnative-mcp` — MCP server mirroring the CLI's JSON contract
- Read-only AES decryption behind an injected crypto provider (if demand)
