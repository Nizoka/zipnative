# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-07

**Zero breaking changes.** The public surface grew from 77 to 106 exports with none removed, the 39 error codes are unchanged, every new behaviour is opt-in, and the `deterministic: true` bytes are unchanged — proven by the byte baseline of the 33 pre-existing samples (`npm run verify:samples`), by `tests/tools/api-compat.test.ts` (every 1.0.0 export, code and signature still present) and by the `compat-previous` CI job (the 1.0.0 test suite run against these sources). The one deliberate output change — dates outside the DOS range, previously wrong — is entry C1 of the compatibility ledger in [release-notes/v1.1.0.md](release-notes/v1.1.0.md).

### Security

- **`verifyZip()` / `verifyEntry()` stop fabricating `localHeaderMatch`** for encrypted entries (hard-coded `true` in one path, `false` in the other); the local header is cross-checked even when the payload cannot be verified, and an encrypted entry whose local header contradicts the central directory now fails the archive — CWE-1288, [#12](https://github.com/Nizoka/zipnative/issues/12). Verdicts were never loosened.
- **One error classification for corrupt deflate on every tier** — node:zlib, `DecompressionStream` and the pure-TS inflater all raise `ZipFormatError` `ZIP_DEFLATE_CORRUPT` / `ZIP_DEFLATE_TRUNCATED`; `ZIP_DECOMPRESSION_FAILED` is reserved for registered or injected codecs — CWE-703, [#10](https://github.com/Nizoka/zipnative/issues/10).
- **Encrypted entries labelled by scheme** — `feature: 'aes'` for WinZip AES (method 99 or the 0x9901 extra), `'zipcrypto'`, `'strong-encryption'`; still never decrypted in 1.x.
- **One new named bound, `maxEntryCompressedSize`** (1 GiB + 1 MiB, CWE-770), consulted only by the byte-range reader's whole-payload fetches; the in-memory reader never refuses a 1.0.0 archive on it. A `nameDecoder` runs before path sanitisation (CWE-22); a lying byte-range source is `ZIP_RECORD_TRUNCATED` (CWE-20).
- **Supply chain** — harden-runner and `npm ci --ignore-scripts` on every job (`.npmrc` makes it the local default), `dependency-review.yml`, weekly `audit.yml`, `publish.yml` in the `npm-publish` environment with a pinned npm, the full gate re-run and OIDC provenance, a separate `attest` job (SLSA Build L2 provenance for the tarball and the CycloneDX SBOM), committed branch and tag rulesets, `CODEOWNERS`.

### Added

- **`openZipRange(source, options?)`** — random access over an injected `ByteRangeSource { size, read(offset, length) }` (HTTP `Range`, `Blob.slice()`, a file handle, object storage); `ZipRangeReader`, `rangeSourceFromBytes()`; the same defences as `openZip()` through the shared `src/parser/zip-entry-checks.ts`; 256 KiB ranged streaming through `createDecompressor()`; the cached tail window serves the central directory and small archives without a round trip, local headers are prefetched with 1 KiB of slack. Guide: [large and remote archives](docs/guides/large-and-remote.md); playground: [remote range access](docs/playgrounds/remote.html).
- **`signal` and `onProgress`** on every asynchronous call (`extractZipStream`, `iterateZipEntries`, `readEntryStream`, `stream()`, `createParallelZip`, `openZipRange`); an abort rejects with `signal.reason` after resources are released (stream locks released without cancel, worker pools closed); `ZipProgress`, `ZipProgressHandler`.
- **`addRaw()` and `addFromReader()`** on `ZipWriter` — transplant entries without recompression; `addFromReader` verifies the source entry first unless `verify: false`; `RawEntryMeta`, `RawEntryReader`, `AddFromReaderOptions`; the modifier's raw-copy plan now lives in `core/zip-segments.ts`.
- **`canonicalizeZip()`, `saveCompact({ canonical })`, `analyzeDeterminism()`** — measure, canonicalise and prove reproducibility for any archive without recompression; `CanonicalOptions`, `CompactOptions`, `CanonicalizeOptions`, `DeterminismReport`, `DeterminismOffender`, `DeterminismConcern`; the canonical bytes join the frozen determinism contract (golden-tested). Guide: [reproducible builds](docs/guides/reproducible-builds.md).
- **`nameDecoder`** on every read path (applied when flag bit 11 is clear; `nameEncoding: 'custom'`), **`getExtendedTimestamps()`** (UT, NTFS, DOS fallback — `ExtendedTimestamps`), **`getUnixIds()`** (`UnixIds`), **`externalAttributesFromUnixMode()`**.
- **`dosTimeMode: 'local' | 'utc'`** on every option bag that writes or reads `lastModified`, with full DOS-date clamping and the new `ZIP_TIMESTAMP_CLAMPED` diagnostic — [#9](https://github.com/Nizoka/zipnative/issues/9).
- **`ZipCodec.createDecompressor?(maxOutput)` → `ZipDecompressor`** — the incremental codec contract; the forward reader streams any codec exposing it and refuses the others before the first byte with `ZIP_UNSUPPORTED_CODEC_MODE`; built-in store and deflate implement it; `_resetInflateCache()` — [#11](https://github.com/Nizoka/zipnative/issues/11).
- **`AddEntryOptions.zip64`** — the per-entry Zip64 streaming opt-in for `addStream()` (APPNOTE 4.3.9.2: version 45, sentinel sizes and a (0, 0) Zip64 extra in the local header, 24-byte descriptor, both sizes in the central record); buffered entries refuse the option with `ZIP_INVALID_OPTION`.
- **`EntryVerification.skipped`** (`EntrySkipReason`: `'encrypted' | 'stream-only-codec' | 'unsupported-method'`); `verifyZip()` delegates every entry to `verifyEntry()` — [#12](https://github.com/Nizoka/zipnative/issues/12).
- **Samples and interop** — `zip64/zip64-streamed`, `incremental/merged-from-two`, `names-encoding/shift-jis-legacy` (an expected ISO non-conformant), `attributes/unix-ids`, `attributes/ntfs-timestamps` (38 samples, 33/5 in the ISO canary); write cases `zip64-streamed` and `transplanted` (19 validations); `validate-zip` keys the descriptor width on the local header's Zip64 extra (`WF/DESCRIPTOR-WIDTH`).
- **Tooling** — `scripts/gate.ts` (`gate`, `gate:fast`; profiles `--fast` / `--ci` / `--publish`, `--require-all`, `--only`, `--from`, `--json`, dist probes), `verify:samples` + `tests/regression/` (SHA-256 baseline with a `since` chain), `release:prepare`, `compat:previous` (`scripts/run-compat.ts` + `tests/compat/`), `agents:rules`, `hooks:install` / `hooks:uninstall` (opt-in `pre-commit` / `pre-push`), `scripts/lib/prose-language.ts`, `scripts/lib/agent-config.ts`; `tests/tools/` (workflows, gate, guard, agent-config, verify-issue, release-prepare, prose-language, api-compat); `vitest.config.ts` pins `TZ=UTC` and `pool: 'forks'`, and writes `test-output/.gate/vitest.json` under `GATE=1`.
- **verify-docs** — 20 rules (47 in all, `--rules` lists them): `derived-counts`, `count-tokens`, `version-token`, `errors-verified-on`, `sample-regression`, `prose-language`, `claude-md-budget`, `governance-sources`, `node-pin-parity`, `ruleset-parity`, `agent-config-parity`, `claude-rules-sync`, `claude-rules-budget`, `pr-template-parity`, `eol-lf`, `skills-shape`, `sitemap-lastmod-vs-git`, `bench-parity`, `rules-list`, and a `since` check in `surfaces-shape`; `docs/assets/ecosystem.json` gains `derived.*` figures recomputed from the tree and `declared.tests` / coverage held to the last gate run; the duplicated `switcher-parity` block is gone.
- **Governance** — `CLAUDE.md`, `.claude/settings.json`, `.claude/hooks/guard.mjs`, `.claude/rules/` rendered from `.github/instructions/`, the `release-audit` skill; `AGENT_RULES.md` and `ai-governance.json` on the pdfnative schema; `ISSUE_TEMPLATE/maintenance.md`, `prompts/compliance-audit.prompt.md`, `release-notes/PR_TEMPLATE.md`; `.nvmrc`, `.node-version`, `.npmrc`.
- **Docs and site** — two guides, the remote playground, four recipes (`remote-range`, `determinism-report`, `zip64-stream`, `utc-dates`), nine 1.1.0 capabilities in `docs/data/surfaces.json` and the choose guide; the inspector shows the determinism verdict and extended timestamps, the modifier offers canonical compaction, the streaming page demonstrates progress and cancellation, the toolkit pins dates with `dosTimeMode`; `docs/data/errors.json` re-audited for nine codes.

### Changed

- Out-of-range dates clamp correctly (1975-07-15 → 1980-01-01, not 1980-07-15; 2200 → 2107-12-31 23:59:58; an invalid `Date` → the epoch) with `ZIP_TIMESTAMP_CLAMPED` — bytes change only for inputs whose previous output was wrong (ledger C1).
- `ZipUnsupportedFeature` + `'aes'`, `ZipEntry.nameEncoding` + `'custom'`, `ZipDiagnosticCode` + `ZIP_TIMESTAMP_CLAMPED` (additive; an exhaustive consumer `switch` adds a case — ledger C5); `ZipWriter`, `ZipModifier.saveCompact(options?)`, `ZipCodec`, `ZipCommonOptions`, `AddEntryOptions`, `ZipLimits` extended with optional members (C6).
- The messages of `ZIP_UNSUPPORTED_ZIP64_STREAMING` and `ZIP_UNSUPPORTED_CODEC_MODE` name the new remedies (outside the contract — C8); `recipes/custom-codec.ts` uses method 97 (C9).
- `ci.yml` gains the `os` (Windows, macOS) and `compat-previous` jobs, runs the gate with `--require-all` and drops its path filter; `conformance.yml` runs samples, baseline, ISO validation and interop through the gate on Linux and Windows and the 4 GiB streaming test behind `ZIPNATIVE_BIG_TESTS`; `sample-regression.yml`; rulesets require `ci (22)`, `ci (24)`, `os (windows-latest)`, `os (macos-latest)`, `interop-linux`, `interop-windows`, `sample-regression`, `compat-previous`.
- ROADMAP: the post-1.0 items resolved (Zip64 opt-in shipped; AES moved to the 2.0 candidates; 1.2 candidates listed); SECURITY.md gains the supply-chain section, the `1.1.x` support row and three threat rows; AGENTS.md fits a 120-line budget; README, llms.txt, the agent brief, the homepage and the guides describe 1.1; `verifiedOn` 2026-10-07.

### Fixed

- [#9](https://github.com/Nizoka/zipnative/issues/9) DOS timestamps depended on the process time zone and clamped only the year.
- [#10](https://github.com/Nizoka/zipnative/issues/10) node:zlib and `DecompressionStream` errors leaked or carried a runtime-dependent class.
- [#11](https://github.com/Nizoka/zipnative/issues/11) `iterateZipEntries()` ignored registered codecs.
- [#12](https://github.com/Nizoka/zipnative/issues/12) `verifyEntry()` reported encrypted and stream-only entries as failed without a reason and with a fabricated `localHeaderMatch`.

### Documentation (the ecosystem alignment, previously unreleased)

The site and the repository docs aligned on the published ecosystem: `zipnative` 1.0.0, `zipnative-cli` 1.0.0 (npm 2026-09-05) and `zipnative-mcp` 1.0.0 (npm 2026-09-07). No engine change.

- **The satellites are published** — README (ecosystem table, badges, status line), ROADMAP, AGENTS.md, llms.txt and the agent brief say so, with binaries, counts and the `^1.0.0` pin; `docs/assets/ecosystem.json` records both packages in full (version, repo, binary, pin, command groups, tools, prompts, resource templates, transports, environment variables) and is the single source of truth every count on the site is checked against.
- **Three new guides** in the pdfnative charter — [CLI](docs/guides/cli.md) (the fifteen commands with every flag, the agent contract, global options, environment, security posture, what the CLI does not do), [MCP](docs/guides/mcp.md) (client configuration for Claude Desktop, Claude Code, Cursor, VS Code and Streamable HTTP; the thirteen tools with inputs and outputs; seven prompts; sandboxed resources; the seven environment variables; error and security models) and [Choosing your surface](docs/guides/choose.md) (the capability × surface matrix, twin of the new `docs/data/surfaces.json`).
- **Two new playgrounds** — the [CLI command builder](docs/playgrounds/cli.html) (every flag of every command from an embedded copy of the CLI surface, validation of the combinations the CLI refuses, 27 presets, a copy-ready POSIX line; nothing executed, by design) and the [MCP tool explorer](docs/playgrounds/mcp.html) (the real MCP payloads, client configuration, and a Run button executing the engine call behind twelve of the thirteen tools on a sample or a dropped archive — honest about what only the Node server can do).
- **Use case 5 — Encrypt first, then archive** ([use-cases guide](docs/guides/use-cases.md), with its diagram): why no surface has a password (ZipCrypto is broken; AES-in-ZIP is not in 1.x) and how confidentiality is delegated to the document layer — pdfnative AES-256 or Office — while the archive stays deterministic and verifiable.
- **Landing** — a "Pick your surface" section, a hero install switcher, the satellite badges, a live npm version strip (`docs/assets/versions.js`, the pdfnative widget), and `architecture.svg` extended with an "ecosystem consumers" band above the module diagram. Nav and footers on every page link the new material; `og-image` and `social-preview` carry CLI and MCP.
- **Playgrounds are CDN-only** — `load-engine.js` imports the published package (esm.sh → jsDelivr, capability probe, loud on-page error when both fail); the pre-publication fallback — the committed copy of `dist/index.js`, the `docs:playground` script and the build step in `docs.yml` — is removed.
- **verify-docs** — `playground-bundle` is replaced by `cdn-pin`; `manifest-shape` covers every package; `jsonld-version` checks the satellite `about` nodes; new rules `satellite-counts` (every "N commands / tools / prompts" literal across HTML, Markdown, SVG and root docs equals the manifest), `surfaces-shape`, `cli-surface-parity` (the `docs/data/cli-surface.json` snapshot of `zipnative schema manifest` against the manifest, the guide and the builder's flag table), `mcp-surface-parity` (guide headings, prompts, env vars, resource template, card order on the playground), `switcher-parity` and `versions-widget`. `verifiedOn` → 2026-09-07.

## [1.0.0] - 2026-09-02

**First stable release — the freeze is the feature.** No engine behavior changes vs 0.9.0. From 1.0.0 the public API surface (77 exports across `zipnative` and `zipnative/worker`), the 39-code error vocabulary and the `deterministic: true` output bytes are a semver commitment: removals, renames and byte changes are semver-major. First npm publication, via Trusted Publishing (OIDC) with provenance.

### Added

- **`.github/workflows/publish.yml`** — fires on "Release published" (+ manual dispatch); OIDC Trusted Publishing (no long-lived token), re-runs the entire gate (audit, typecheck, lint, coverage, build, dist smoke, worker integration, attw+publint, interop, verify:docs), generates a CycloneDX SBOM (90-day artifact + attached to the GitHub Release), then `npm publish --provenance --access public`. All actions SHA-pinned. `publishConfig.provenance: true` makes a laptop publish fail by design — CI is the only publish path.
- **`tsdoc-complete`** — the 22nd verify-docs rule: every public export must carry a TSDoc summary (api.json `summary: null` fails the build); the five undocumented exports (`FLAG_*`, `METHOD_STORE`, `METHOD_DEFLATE`) got their docs — 77/77 documented.
- **Visual identity** — the "zipper-cut Z" logo (three concepts rendered and compared at 28/40/74 px; the Z monogram's diagonal now carries interlocking zipper teeth in negative space), redesigned favicon (vertical gradient for 16 px legibility), regenerated og-image, and a new 1280×640 `social-preview.svg/png` for the GitHub social slot.
- **`release-notes/draft/PR-v1.0.0.md`** — the release PR with the measured verification table and the human go-live runbook (push, npm Trusted Publisher configuration, GitHub Release, provenance check).
- **The conformance authority gate ("veraZIP")** — `npm run validate:zip` ([scripts/validate-zip.ts](scripts/validate-zip.ts)): **the first open clause-by-clause ISO/IEC 21320-1:2015 validator** (the ISO-standardised ZIP profile, LoC fdd000361 — JHOVE has no ZIP module and `zip -T` is a documented alias of `unzip -tqq`, so no authority validator existed). Independent by construction (its own raw EOCD/CD/LFH parser — never the engine's), it checks APPNOTE well-formedness cross-checks plus the normative Table-1 annotations (the 10 structural clauses machine-checked; the disregarded clauses need no check), veraPDF-style clause tags on every failure, over the full sample corpus. Expectations are two-sided: 29 samples must PASS (three hostile archives — zip-slip, device-name, duplicate-paths — are *conformant but refused*: spec-valid ≠ safe), 4 crafted archives must FAIL with their declared clause; counts canaried against `declared.iso21320` in ecosystem.json. Level 1 re-tests conformant samples with foreign integrity checkers (`unzip -t`, `7z t`, `python -m zipfile -t`, `tar -tf`, `jar tf`) when present. Blocking in `conformance.yml` (Linux + Windows) and in `publish.yml` before `npm publish`; the differential extraction matrix (`test:interop`) stays as the empirical layer. New [conformance guide](docs/guides/conformance.md) tells the full authority story.
- **`docs/agent-brief.md`** — a compact paste-ready briefing for coding agents (core API, verified pitfalls, self-verification), with a "Copy as prompt" button on the landing #agents section; listed in llms.txt and budgeted in llms-index.json.
- **`.github/prompts/quality-gate.prompt.md`** — the 7-step gate encoded as an agent prompt (vitest.config.ts as the threshold source of truth).
- **Tree-shaking proof** ([tests/integration/treeshake.test.ts](tests/integration/treeshake.test.ts), dist-gated) — esbuild-bundles the published entry through package.json resolution and asserts: a crc32-only import carries none of the writer/codec subsystems (< 15% of the full surface, measured ~5%), a bare `import 'zipnative'` shakes to nothing (`"sideEffects": false` honoured — the test fails if the flag is removed, verified), and the entry is real ESM. Configuration was already conformant (type module, sideEffects false, types-first exports map, tsup treeshake); this pins it.

### Fixed

- **First-real-CI-run fixes** — (a) `tsconfig.test.json` now maps `zipnative/worker` in `paths`: without it, tsc fell back to package.json self-reference into `dist/`, which exists after a local build but not in CI where typecheck runs first (reproduced locally by hiding `dist/`, then proven fixed). (b) Foreign-tool exit codes are read per each tool's documented contract: Info-ZIP unzip and 7-Zip both use exit 1 for non-fatal warnings (empty zipfile, SFX-prefixed data) and exit 2+ for real format/CRC errors — the helpers treated any non-zero status as refusal, which broke `validate:zip`/`test:interop` on the CI runners; `{0, 1}` now passes for those two tools only, and a level-1 failure prints how to reproduce. (c) 7-Zip's CLI (23.01 and 26.02 alike) refuses offset-opened (SFX-prefixed) archives in `t` **and** `x` — carried as documented per-file exclusions in both gates (unzip, bsdtar, python and jar extract the same archive byte-identically), never by widening accepted exit codes into real-error territory; the v0.7 note that credited 7-Zip with SFX support is corrected in place. (d) **A finding worth the gate's existence**: on the append-only `modified-incremental` archive, 7-Zip extracts the **stale** replaced payload and misses the appended entry — it does not honour the authoritative final central directory (the multi-EOCD parser differential the v0.4 notes warned about, now demonstrated on a mainstream tool; five other tools and zipnative's strict reader read it correctly). Documented in the conformance guide with the practical remedy: ship `saveCompact()` output when 7-Zip interop matters.

### Changed

- **Documentation flipped to its stable-era stance** — "through 1.0"/"pre-1.0" normalised to "in 1.x" everywhere (README, SECURITY, AGENTS, llms.txt, errors guide + registry, ai-governance); README status is now the semver freeze statement; satellites read "planned".
- **SECURITY.md** — supported-versions table (`1.0.x` only), release-integrity section (Trusted Publishing, provenance verification via `npm audit signatures`, SBOM), and the explicit compatibility promise; `ecosystem.json` records the contracts (`deterministic_bytes_are_semver_major`, `error_codes_frozen_since: 0.8.0`).
- **`package.json`** — `files` now ships `CHANGELOG.md`, `SECURITY.md` and `THIRD-PARTY-NOTICES.md` alongside `dist`/`LICENSE`/`README.md` (21-file tarball, `npm pack --dry-run` inspected). Sourcemaps are deliberately kept in the package. The `overrides.esbuild` pin is a build-time-only tool constraint — the published package has zero runtime dependencies.
- **Badges harmonised on the pdfnative set** (README + landing): CI, CodeQL, npm version/downloads, bundle size, dependencies-0, TypeScript-strict, coverage (kept — measured), License-MIT, provenance-signed, website; the landing additionally carries the OpenSSF Scorecard badge. The npm-fed badges self-heal at first publication.
- **`llms-index.json` budget completed** — `data/errors.json` and `agent-brief.md` now appear in the artefacts list with byte + approximate token sizes (errors.json was referenced from llms.txt but missing from the budget).
- **CI hardening** — `persist-credentials: false` on every workflow checkout (previously scorecard-only); CONTRIBUTING's docs-preview section no longer claims `file://` works for the playgrounds (module scripts + CDN loader require HTTP — `docs:serve` on port 5000, same as pdfnative).

## [0.9.0] - 2026-09-02

**Final pre-freeze release candidate.** The last additive API wave before the 1.0 freeze — one-call verification, wider stream sources, entry-attribute helpers — plus full-project coverage hardening (tests, samples, recipes, playgrounds) and the Zip64-streaming decision record. No archive-byte changes; deterministic bytes unchanged.

### Added

- **`verifyZip(bytes, options?)` → `ZipVerificationReport`** ([src/parser/zip-verify.ts](src/parser/zip-verify.ts)) — one-call deep validation composing `openZip(validate: 'eager')` + per-entry `verifyEntry` + diagnostic collection. **Never throws for archive problems**: structural refusals land in `report.error` (`{ code, message }` on the frozen vocabulary — no new codes), per-entry results carry `crcMatch`/`sizeMatch`/`localHeaderMatch`, and encrypted or stream-only-codec entries are reported as `skipped` with a reason, never faked as corruption. Only caller bugs (invalid limits) throw. New "Verifying" export category (`verifyZip`, `VerifiedEntry`, `VerifyZipOptions`, `ZipVerificationReport`).
- **`ByteSource` source widening** ([src/core/zip-source.ts](src/core/zip-source.ts)) — `AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>`, normalised once at the boundary. A `ReadableStream` is always driven through `getReader()` — the native async iterator would *cancel* the stream on early exit, and the contract here is release-without-cancel: `iterateZipEntries` closes its source on every exit path (clean stop at the central directory, EOF, thrown refusal, abandoned iteration), releasing the reader lock and leaving the rest of the stream to its owner (pinned by test). Applied symmetrically to `iterateZipEntries` and `ZipWriter.addStream` (worker subpath included).
- **Entry-attribute helpers** ([src/core/zip-attributes.ts](src/core/zip-attributes.ts)) — `isSymlinkEntry(entry)` (moved from the extractor's internals to public API) and `getUnixMode(entry): number | null` (null when `versionMadeBy` is not Unix-hosted — an explicit null-vs-0 contract). New "Entry attributes" export category; api.json now lists **77 exports**.
- **Coverage hardening** — [tests/parser/zip-verify.test.ts](tests/parser/zip-verify.test.ts) + [tests/integration/coverage-hardening.test.ts](tests/integration/coverage-hardening.test.ts) (~24 new tests): custom codecs end-to-end through `registerCodec` (both `ZIP_UNSUPPORTED_CODEC_MODE` branches finally reached), `setDeflateImpl`/`activeDeflateTier`, `addStream`'s deterministic buffered fallback, the `ZIP_UNSUPPORTED_ZIP64_STREAMING` refusal (previously an untested branch), the pure inflate pump without `DecompressionStream`, strict-parity across the five entry points, `extractZipStream` zip-slip parity, bit-3 `skip()` under limits, `ReadableStream` sources, and raw-attribute decoding.
- **Samples 22 → 33** — new generators `refusals` (six hostile archives self-validated by *inverse* validation: generation aborts unless the exact expected `err.code` fires; shipped with a `refusals.json` manifest), `parallel` (sequential vs worker output, SHA-256-verified IDENTICAL), `forward-trust` (LFH ≠ CD name — the openZip/iterate trust differential, inspectable), `attributes` (Unix modes + symlink), and an incremental dead-bytes sample that asserts `ZIP_DEAD_BYTES_RATIO` fires.
- **Recipes 7 → 12** — `verify-archive`, `resumable-inflate`, `custom-codec` (hand-assembled method-99 archive; refused before `registerCodec`, readable after), `parallel-create` (first `zipnative/worker` recipe), `sanitize-external-sink`.
- **Playgrounds 3 → 5 + CDN-first loading** — `modify.html` (save vs saveCompact byte counts, live `ZIP_DEAD_BYTES_RATIO`) and `stream.html` (chunked forward iteration, resumable-inflater `bytesConsumed`/`bytesProduced` counters, the trust caveat made visible); all five pages load the engine through a shared version-pinned CDN loader (esm.sh → jsDelivr → committed local bundle fallback, source displayed) so the playgrounds run the published package once it exists and keep working before then. The `playground-bundle` verify-docs rule also pins the loader version.

### Changed

- **Release-notes format** — `release-notes/TEMPLATE.md` adopts the pdfnative template (fixed section order, GitHub-Release-title convention, publication workflow) with `Known limitations` and `Downstream integration notes` as documented zipnative extensions; all nine historical notes reformatted in place, substance unchanged.
- **Zip64-streaming decision record** ([ROADMAP.md](ROADMAP.md)) — per-entry `AddEntryOptions.zip64` opt-in design retained; implementation post-1.0 (the speculative LFH extra is the hard part); the typed refusal stays and is now regression-tested.
- `docs/playgrounds/` hub, sitemap, JSON-LD and `llms.txt` cover the five playgrounds; documentation refreshed for the 0.9 surface (README status + `verifyZip` example, quickstart "Verify in one call", llms.txt sections).

**Conformance pass on 0.8.1.** A follow-up forensic review of the 0.8.1 release (two investigation agents + manual verification) — navigation 404s root-caused and fixed, one spec-conformance fix, honest disclosures, and a documentation-wide factuality sweep. verify-docs stands at **21 named rules**.

### Fixed

- **`docs:serve` 404s / unstyled guides hub** — `npx serve`'s default `cleanUrls` redirects `/guides/index.html` → `/guides` *without* a trailing slash, shifting the relative-URL base to `/`: `guide.css` and every hub link then 404'd. All hub links, canonicals, sitemap entries and JSON-LD URLs are now **directory-form** (`guides/`, `playgrounds/`, `./`), the shape pdfnative uses and every static host serves correctly. The use-cases footer clone artifact (mislabelled link, missing entry) is repaired.
- **APPNOTE §4.5.3 conformance** — the incremental `save()` append path's local-header Zip64 extra now carries **both** sizes and sentinels both classic fields (the emit-only-overflowed-fields rule applies to central-directory records only); extracted into a unit-tested `lfhZip64Fields()` helper, closing the missing A4 regression test.
- The archive-comment line in the inspector playground decodes the comment bytes (it printed `{}` for every commentless archive); `planForCopy` sets the UTF-8 name flag only and never clears it (ASCII is valid UTF-8); `docs.yml` builds before `verify:docs` so the `playground-bundle` byte comparison actually runs in CI.

### Changed

- **Honest disclosure of the 0.8.1 behavioral change**: default extraction refuses Windows reserved device names (`CON`, `NUL`, `COM1`…`LPT9`, CWE-67) and names that collapse to nothing — POSIX-authored archives containing e.g. `aux.h` now throw by default on every platform (opt out with `rejectTraversal: false`). The refusal message now names CWE-67 instead of claiming a zip-slip; README/security/errors docs updated.
- Documentation factuality sweep: interop numbers corrected (write corpus 7 → 11 cases; 17 = gate total with the 6 producer reads), landing metrics measured (350+ tests, 91.7% coverage), "every fix has a regression test" corrected to twelve of thirteen, playground tier claim corrected (pure-TS, sync APIs), README badges + err.code contract added, playgrounds discoverable from guides and `llms.txt`.

## [0.8.1] - 2026-09-01

**Docs finish + a full multi-agent code review.** Patch release: 13 verified correctness/security/resource fixes (no archive-byte change for valid inputs; the deterministic encoder contract is untouched) plus the documentation the 0.8 site was still missing.

### Fixed

Thirteen findings from a three-agent review (two reviewers + an adversarial verifier), twelve with a regression test in [tests/integration/review-fixes.test.ts](tests/integration/review-fixes.test.ts):

- **`renameEntry` mojibake** — renaming a CP437 source entry to a non-ASCII name now sets the UTF-8 flag to match the re-encoded bytes; the entry no longer round-trips corrupt or becomes unfindable after `save()`/`saveCompact()`.
- **`save()` Zip64 sizes** — the append path applied Zip64 only to the local-header offset; raw-copied (renamed) entries ≥ 4 GiB now sentinel their sizes and carry the Zip64 size extra in both LFH and CFH instead of silently truncating to a corrupt archive.
- **Over-subscribed / incomplete Huffman tables** — `buildHuffmanTable` now runs zlib's Kraft check (single-code and empty-table tolerance preserved), so corrupt deflate streams throw `ZIP_DEFLATE_CORRUPT` through `createInflator`/`inflateRawJS` instead of decoding to silent garbage.
- **Zip64 descriptor mis-parse** — a zero-length entry's 24-byte Zip64 data descriptor is no longer aliased to the 16-byte form; `matchDataDescriptor` disambiguates by which length the next PK record aligns to.
- **`sanitizeEntryPath` device names** — the external-sink gate now rejects Windows reserved device names (`CON`, `NUL`, `COM1`…`LPT9`, CWE-67).
- **`validateEntryName`** rejects names that collapse to nothing (`.`, `./`) which its own extractor would refuse.
- **`readExact(0)`** returns an empty buffer instead of leaking a raw `TypeError` from the forward reader on an empty-name entry at a chunk boundary.
- **Oversized extra fields** — the write path enforces `maxExtraFieldBytes` and a hard 65535 structural cap; a `> 64 KiB` extra field threw a u16-wrapped corrupt archive.
- **Per-entry `compression.level`** is validated on both the builder and the modifier and on both tiers — no more raw `RangeError` from `node:zlib`.
- **Bounded inflate allocation** — the pure inflater grows toward `maxOutput` by doubling and copies the result out, so a hostile central directory can no longer force a 1 GiB upfront allocation from a tiny payload (CWE-789).
- **Worker pool** — a throwing main-thread fallback now rejects the job (new `PendingJob.reject`) instead of crashing the process and hanging `toBytes()`; abandoning `stream()` mid-entry releases the source iterator and stream locks; job payloads are sliced at dispatch, not submission (no ~2× upfront duplication).

### Added

- **Use-cases guide** ([docs/guides/use-cases.md](docs/guides/use-cases.md)) — four production architectures with diagrams (the manifest peek, untrusted-upload intake, the reproducibility gate, streaming intake at the edge), each built from shipped APIs, in the pdfnative use-case visual language.
- **Interactive playgrounds** ([docs/playgrounds/](docs/playgrounds/)) — archive toolkit, inspector, and secure-extraction demo running a committed copy of the engine's own zero-dependency bundle in the browser (no CDN, no npm); `npm run docs:playground` + a `playground-bundle` verify-docs rule keep the bundle in sync.

### Changed

- The architecture diagram now draws the forbidden reverse edge its legend describes (a struck red `core → parser` arrow); guide pages and the guides hub carry the full site footer.

## [0.8.0] - 2026-09-01

**Error-code stability + the pdfnative docs charter** (API-freeze band, wave 1). No archive-byte changes; the API is additive.

### Added

- **Stable machine-readable error codes on every thrown error** ([src/types/zip-errors.ts](src/types/zip-errors.ts)): `ZipError` gains a required readonly `code: ZipErrorCode` — a closed union of **39 codes** in per-class sub-unions (`'ZIP_EOCD_NOT_FOUND'`, `'ZIP_PATH_TRAVERSAL'`, `'ZIP_LIMIT_EXCEEDED'`, …), populated at every one of ~110 throw sites with per-cause granularity. **Frozen from 0.8.0**: removal or renaming is semver-major; additions are semver-minor. Branch on `err.code`, never on message text (messages are byte-identical to 0.7). `ZipUnsupportedError.feature` narrows to the closed `ZipUnsupportedFeature` union; `ZipLimitError.limit` types as `keyof ZipLimits`.
- **[docs/data/errors.json](docs/data/errors.json)** — the machine-readable registry (code, class, cause, remedy, CWE) covering the 39 error codes and 11 diagnostic codes — plus the **`error-parity` verify-docs rule** (bidirectional source↔registry sync, class membership, guide completeness, literal-code discipline at throw sites) and the new **[errors guide](docs/guides/errors.md)**.
- **`createInflator()` / `Inflator` published** — the freeze decision named in the 0.6 notes, resolved: the resumable raw-deflate decoder with exact `bytesConsumed` reporting (the capability neither `DecompressionStream` nor `node:zlib` exposes) is public API. `maxOutput` stays positional and required — inflate output on untrusted input must be bounded.
- Surface hygiene: `FLAG_ENCRYPTED`/`FLAG_DATA_DESCRIPTOR`/`FLAG_STRONG_ENCRYPTION`/`FLAG_UTF8` exported (the masks for the public `entry.flags`), `activeDeflateTier()` + `DeflateTier` (tier introspection for the determinism story), `StreamOptions` re-exported from `zipnative/worker`, `"./worker/zip-worker.js"` added to the exports map (resolve worker-script copies via `import.meta.resolve`).
- **Docs site rethemed to the exact pdfnative charter**: the 23-token palette (dark declared under both `[data-theme]` and `prefers-color-scheme` — no more dark-preference flash), gradient hero with CTAs and static badges, measured metrics band, icon-chip feature cards, ARIA code tabs with SRI-pinned Prism highlighting, the honest comparison table and real benchmark bars on the landing, a standalone [assets/architecture.svg](docs/assets/architecture.svg) in the pdfnative visual language, the full guide chrome (`guide.css`/`guide.js`, breadcrumbs, source bar, per-block copy buttons) and a 3-column footer.

### Changed

- Error constructors are code-first (construction-only signature change; nobody constructs zipnative errors externally pre-1.0). `strict: true` escalation now throws `ZipError` with code `ZIP_STRICT_DIAGNOSTIC` instead of a bare `Error` (a strict widening; the message now embeds the diagnostic code).
- [docs/assets/api.json](docs/assets/api.json) is multi-entry: every export carries a `subpath` field and the `./worker` surface is finally in the manifest (69 exports).
- Dead layer barrels `src/{codecs,core,parser}/index.ts` deleted (zero imports, unreachable via the exports map).

### Fixed

None engine-side.

## [0.7.0] - 2026-09-01

**Interop corpus expansion + docs finish** (first slice of the 0.7→0.9 hardening band). No engine behavior changes.

### Added

- **Guide renderer** ([scripts/build-guides.ts](scripts/build-guides.ts), `npm run docs:guides`, wired into `docs:all`): guide `.html` shells are now machine-rendered from their `.md` sources (the `.md` stays the single source of truth) with GFM parsing pinned to `marked` 12.0.2 exact, deep-linkable heading anchors from the shared `slugify` (the same one the llms index uses — anchor parity by construction), externalised outbound links, and an idempotent `data-prerendered` marker. Prerendered-only: the pages ship zero client-side rendering code and no CDN scripts.
- **verify-docs grown to ~17 named rules**: `guide-render-sync` (rebuilds every guide article in memory through the same pure `applyGuideRender` and byte-compares — a hand-edited or stale shell fails CI) and `anchor-parity` (every internal `#fragment` link must resolve to a real id in its target; `.md` targets resolve to the paired `.html`).
- **`npm run docs:serve`** (transient `npx serve`, nothing added to package dependencies) plus a CONTRIBUTING "Docs local preview" section — the site is static, any static server works.
- **Visual identity**: redesigned [docs/favicon.svg](docs/favicon.svg) (gradient tile, geometric Z monogram, the family folded-corner mark), new [docs/assets/logo.svg](docs/assets/logo.svg), and the previously deferred **og:image shipped** — [docs/assets/og-image.svg](docs/assets/og-image.svg) as the committed source, rasterised once to the 1200×630 [og-image.png](docs/assets/og-image.png) via headless Edge (an OS tool; the command is documented in the SVG header), with `og:image`/`twitter:card` metadata wired into every page.
- **Architecture diagrams**: a new `#architecture` landing section with two inline, theme-aware, accessible SVGs — the strict `types → codecs → core → parser → worker` layer flow ("zero reverse edges"), and the shared segment generator feeding both `toBytes()` and `stream()` byte-identically.
- **Interop gate expanded to 17 validations** (6 foreign-producer reads + 11 written archives extracted): `sfx-prefixed` (a stub-prepended archive produced by the incremental modifier, extracted by foreign tools — Expand-Archive excluded with its documented .NET offset limitation), `comment-heavy` (archive + per-entry comments), `empty-archive` (a bare EOCD must be accepted everywhere), `store-only`; `excludeTools` now accepts platform-qualified ids (`tool@platform`).
- **Refusal-posture integration suite** ([tests/integration/refusal-posture.test.ts](tests/integration/refusal-posture.test.ts)): archives many foreign tools tolerate — multi-disk EOCDs (classic and zip64-locator forms), contradictory entry counts, trailing garbage — are pinned to their typed refusals (`ZipUnsupportedError('multi-disk')`, `ZipFormatError`); the posture gap with foreign tools is deliberate and now regression-tested.

### Changed

- Inter-guide links in the `.md` sources now target the paired `.html` pages (kept honest by `anchor-parity`).

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
