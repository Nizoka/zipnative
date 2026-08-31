# Roadmap

zipnative ships milestone by milestone; each version lands against the full
quality gate (typecheck, lint, coverage, build, package checks, Linux + Windows
CI, fuzzing, and — from 0.2 — the blocking interop conformance gate).

## 0.1.x — M1: Read + random access + secure extract *(current)*

- `openZip()` — lazy central-directory reader, name-indexed random access
- `readEntry` / `readEntryStream` / `readEntryRaw` / `verifyEntry`
- Secure-by-default `extractZip` / `extractZipStream`, `sanitizeEntryPath`
- Zip64 reading with anti-spoofing cross-checks; UTF-8/CP437 names
- CRC-32 (slice-by-8); 4-tier inflate facade (injection → node:zlib →
  DecompressionStream → pure TS)
- CWE-tagged configurable limits; diagnostics channel; typed errors
- Adversarial fuzzing suite; interop read corpus (foreign-tool fixtures)

## 0.2.x — M2: Deterministic write + streaming

- `createZip()` with `toBytes()` and `stream()` over one shared segment
  generator (byte-identical by construction)
- Pure-TS deflate encoder (the determinism pin) + differential fuzzing vs zlib
- `addStream()` with data descriptors; Zip64 auto-promotion
- The determinism contract, written down in `docs/determinism.md` **before**
  anyone depends on it
- Interop write gate goes **blocking** (unzip, 7z, zipinfo, python -m zipfile,
  jar on Linux; 7z, Expand-Archive, bsdtar, jar on Windows)
- Benchmarks vs fflate/jszip/adm-zip + committed `bench/RESULTS.md`

## 0.4.x — M3: Incremental modification

- `createZipModifier()` — append-only `save()` (original bytes verbatim, no
  recompression, no-op returns the identical buffer) and `saveCompact()`
  (true deletion, canonical layout, still no recompression)
- Real-world round-trip gate: modify one entry of a DOCX/EPUB → foreign tools
  must still open it

## 0.5.x — M4: Workers + parallelism + forward streaming

- `zipnative/worker` subpath: parallel per-entry deflate pool
- `iterateZipEntries()` — forward, CD-less streaming reader for pipes
- Performance budgets in CI

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
