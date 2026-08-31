# Fixture provenance rules

**Committed binaries are allowed ONLY when their provenance is foreign** —
produced by a tool that is not zipnative. The whole point of the interop
corpus is that our reader is exercised against bytes we did not shape.

Rules (enforced by review + `tests/docs/fixture-budget.test.ts`):

- `interop/` — tiny archives (< 20 KB each) produced by named foreign tools.
  Naming: `<tool>-<version>-<trait>.zip` (e.g. `infozip-3.0-utf8.zip`,
  `7z-24.08-zip64.zip`, `explorer-win11-store.zip`, `powershell-7.4-basic.zip`).
  Record the exact producer and command below when adding one.
- `realworld/` — minimal real-format samples (DOCX/EPUB/VSIX/JAR), smallest
  possible, license/source noted below.
- `adversarial/` — MUST stay empty of committed files: adversarial archives
  are generated in `beforeAll` by `tests/helpers/raw-zip-builder.ts`
  (seeded, engine-independent). Never commit what our own code can build.
- `.gitattributes` marks everything under `tests/fixtures/` as `binary`.
  Never remove that protection — CRLF conversion silently corrupts archives.

## Provenance ledger

| File | Producer (exact version) | Command | Added |
|---|---|---|---|
| interop/powershell-compress-archive-basic.zip | PowerShell 7 Compress-Archive (System.IO.Compression), Windows 11 | `Compress-Archive -Path <src>/* -DestinationPath out.zip` via scripts/generate-fixtures.ts | 2026-09-01 |
| interop/bsdtar-basic.zip | bsdtar 3.8.8 (libarchive 3.8.8, zlib 1.2.13.1-motley), Windows 11 tar.exe | `tar -a -cf out.zip -C <src> .` via scripts/generate-fixtures.ts | 2026-09-01 |
