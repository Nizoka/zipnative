# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project scaffolding: build (tsup, ESM+CJS+types), strict TypeScript (3 configs), ESLint 9 flat config, vitest 4 with v8 coverage thresholds, CI (ubuntu Node 22/24 matrix + blocking Windows job), CodeQL, OpenSSF Scorecard, Dependabot, interop conformance workflow, docs integrity workflow, AI-agent governance policy.
- **M1 — read path**: `openZip()` with lazy central-directory parsing and random access, `readEntry()` / `readEntryStream()` / `readEntryRaw()` / `verifyEntry()`, secure-by-default `extractZip()` / `extractZipStream()` with `sanitizeEntryPath()`, Zip64 reading with anti-spoofing cross-checks, UTF-8/CP437 name decoding, CRC-32 (slice-by-8), 4-tier inflate facade (injection → node:zlib → DecompressionStream → pure TS), CWE-tagged configurable security limits, deduplicating diagnostics channel, typed error hierarchy, adversarial fuzzing suite.
