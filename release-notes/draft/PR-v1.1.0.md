# release: v1.1.0 — range access, reproducible-for-any-archive, issues #9–#12, supply-chain parity

<!-- This exact string is reused three times: the PR title, the squash-commit
     subject, and the GitHub Release title (drop the "release: " prefix for
     the Release: "v1.1.0 — range access, reproducible-for-any-archive, issues #9–#12, supply-chain parity"). -->

> **Branch:** `release/v1.1.0` → `main` (squash)
> **Type:** MINOR — additive only; zero breaking changes (ledger C1–C10 below)
> **Distribution:** npm via Trusted Publishing (OIDC) + SLSA Build L2 provenance + SBOM attestation

## Summary

zipnative 1.1.0 is the first minor since the freeze and keeps every promise 1.0.0 made: zero runtime dependencies; 106 exports (77 at 1.0.0, none removed, none renamed); the 39 error codes unchanged; every new behaviour opt-in; `deterministic: true` bytes unchanged — proven by the byte baseline of the 33 pre-existing samples, by `tests/tools/api-compat.test.ts` and by the `compat-previous` job running the 1.0.0 suite against these sources. Existing inputs produce byte-identical output except out-of-range dates, whose previous output was wrong (C1). It closes #9–#12 at the source, ships the Zip64 streaming opt-in designed in 0.9, adds five adoption features (range access over remote and huge archives, cancellation and progress, raw transplant, canonicalisation of any archive, legacy name decoding and extended metadata), and brings the repository to hardening parity with pdfnative 1.8.0.

## What's in it

| Area | Change |
|---|---|
| Range access (F1) | `openZipRange()` over an injected `ByteRangeSource`; `ZipRangeReader`, `rangeSourceFromBytes()`; shared per-entry defences (`zip-entry-checks.ts`); cached tail window, 1 KiB header prefetch, 256 KiB ranged streaming; new limit `maxEntryCompressedSize` (CWE-770) |
| Cancellation & progress (F2) | `signal` / `onProgress` on every asynchronous call; abort rejects with `signal.reason` after release-without-cancel; `ZipProgress` |
| Raw transplant (F3) | `addRaw()` / `addFromReader()` (verified by default); raw-copy plan shared by writer and modifier |
| Canonical form (F4) | `canonicalizeZip()`, `saveCompact({ canonical })`, `analyzeDeterminism()`; canonical bytes join the frozen contract (golden-tested) |
| Legacy names & metadata (F5) | `nameDecoder` (sanitisation after decoding), `getExtendedTimestamps()`, `getUnixIds()`, `externalAttributesFromUnixMode()` |
| Zip64 streaming opt-in | `addStream(…, { zip64: true })` — APPNOTE 4.3.9.2 layout; ISO-validated, interop-extracted; 4 GiB + 1 real run in `conformance.yml` |
| Issues | #9 `dosTimeMode` + full clamping + `ZIP_TIMESTAMP_CLAMPED`; #10 `ZIP_DEFLATE_*` on every tier; #11 `createDecompressor()` codec contract + early refusal; #12 `verifyEntry().skipped` with a real `localHeaderMatch` |
| Encryption label | `feature: 'aes'` for WinZip AES; never decrypted (2.0 candidate) |
| Hardening / CI | `gate.ts` profiles, harden-runner + `--ignore-scripts`, `npm-publish` environment, pinned npm, SLSA L2 attest job, dependency review, weekly audit, rulesets, `os` + `compat-previous` jobs, sample byte baseline, opt-in hooks, Claude Code governance layer, `release-prepare`, 25 verify-docs rules, `publish.yml` in three jobs (verify → publish → attest the published tarball) |
| Docs & samples | 2 guides, remote playground + 4 playground upgrades, 4 recipes, 5 samples (38), 2 interop cases (19), `surfaces.json` + choose guide (9 capabilities), `errors.json` re-audit, ROADMAP / SECURITY / README / llms / agent brief / homepage |

## Compatibility ledger

| # | Change | Class | Guard |
|---|---|---|---|
| C1 | Out-of-range / invalid dates clamp correctly, with `ZIP_TIMESTAMP_CLAMPED` | bug fix — bytes change only where the previous output was wrong | 33/33 baseline unchanged; `zip-dos-time*.test.ts` |
| C2 | Node / `DecompressionStream` tiers raise `ZIP_DEFLATE_*` (`ZipFormatError`) for corrupt payloads | classification fix (both codes frozen since 0.8.0) | `inflate-tier-parity.test.ts` |
| C3 | Real `localHeaderMatch` for encrypted entries; a contradicting local header fails the archive | tightening, never looser | `zip-verify-reasons.test.ts`, `compat-previous` |
| C4 | `skipped: 'unsupported-method'` still fails the archive | additive | `zip-verify-reasons.test.ts` |
| C5 | Unions widened (`'aes'`, `EntrySkipReason`, `'custom'`, `ZIP_TIMESTAMP_CLAMPED`) | additive | `api-compat.test.ts` |
| C6 | Interfaces extended with optional members (`ZipWriter`, `saveCompact(options?)`, `ZipCodec`, `ZipCommonOptions`, `AddEntryOptions`, `ZipLimits`, `AnalyzeDeterminismOptions`; `StreamControl.tracker` is `@internal`) | additive | `api-compat.test.ts` (77/77 signatures, `VERSION` aside) |
| C7 | `maxEntryCompressedSize` only on `openZipRange` allocations | additive | `zip-range-reader.test.ts` |
| C8 | Two error messages reworded | outside the contract | — |
| C9 | `recipes/custom-codec.ts` → method 97 | docs | `recipes.test.ts` |
| C10 | Tooling (`validate-zip` descriptor width, verify-docs, workflows, `.npmrc`, vitest `TZ=UTC`/forks/`json-summary`, coverage thresholds 88 / 80 / 85 / 90, `eol-lf` fails) | outside the API | `tests/tools/*` |

## Deferred

- **AES read-only decryption** — contradicts the published 1.x policy ("no encryption, read or write, in 1.x"); 1.1.0 labels such entries `feature: 'aes'` and stops. 2.0 candidate (ROADMAP).
- **Pure-TS streaming deflate under `deterministic: true`** — lifts the 2 GiB per-entry cap and makes the Zip64 opt-in deterministic. 1.2 candidate.
- **Modifier / `extractZipStream` over a `ZipRangeReader`** — 1.2 candidate.
- **Writing UT / NTFS extra fields** — interacts with the "extra fields: none, except Zip64" contract; decided first, then 1.2.
- **Worker playground** — the CDN-served worker script is cross-origin; a Blob shim remains a docs item.
- **Checksum-pinned external validators** — the runner image's unzip / 7-Zip / bsdtar / Python / `jar` / `Expand-Archive`; versions are recorded in the job summary (Known limitations).
- **The 1.2 standards backlog** — the 23 minor findings of the final audit (verify-docs harness, `api-exists`, `verify:bundle`, harden-runner `block`, CodeQL `security-extended`, issue forms, `security.txt`, signed commits, the `.gitattributes` fixture-README exception, …): `.github/drafts/zipnative-1.2-standards-backlog.md` (`verify:issue` OK) and ROADMAP § 1.2 candidates.
- **Fixture naming warning** (`<tool>-<version>-<trait>.zip`) in `tests/docs/fixture-budget.test.ts` — not added; the two committed fixtures predate the convention.

## Docs, samples & recipes

- Release note `release-notes/v1.1.0.md` (Security first; Upgrade = the ledger; Downstream integration notes) and the `CHANGELOG.md` entry `## [1.1.0] - 2026-10-08` (the previously unreleased ecosystem-docs entry folded in).
- Manifest `docs/assets/ecosystem.json`: version 1.1.0, `verifiedOn` 2026-10-08, `derived.*` (exports 106, errorCodes 39, diagnostics 12, testFiles 61, sampleGenerators 12, guides 11, playgrounds 8, recipes 16, interopTools 6, interopValidations 19, verifyDocsRules 52, sampleZips 38), `declared` (tests 757, coverage 95 / 95.2, iso21320 33 / 5).
- CDN pin in `docs/playgrounds/load-engine.js` moves to `zipnative@1.1.0`, so the playgrounds resolve once the release is published (documented window between merge and publish).
- Guides 9 → 11 (`large-and-remote`, `reproducible-builds`); playgrounds 7 → 8 (`remote`); recipes 12 → 16; samples 33 → 38 (five new entries baselined with `since: 1.1.0`, the 33 others byte-identical); interop write cases 11 → 13.
- Three issue drafts under `.github/drafts/` (git-ignored; `verify:issue` OK) for the human to file: `zipnative-cli-bump-1.1.0.md`, `zipnative-mcp-bump-1.1.0.md`, `zipnative-1.2-standards-backlog.md`.

## Verification

The release gate is `npx tsx scripts/gate.ts --publish --require-all`. Each line names the individual gate and what it reported on the release commit (Windows 11, Node 22.23, 2026-10-08; one uninterrupted run on the tree of the final audit's fix loop, 13 steps, 800 s):

- [x] `npm run typecheck:all` — clean (src + tests + scripts), 102 s
- [x] `npm run lint` — clean, 33 s
- [x] `npm run build` + dist-check + dist-probe — ESM, CJS, declarations, worker script present; no console / eval / Node I/O leak in the bundles
- [x] `npm run test:coverage` — 757 tests across 61 files (6 skipped: foreign producers absent), thresholds 88 / 80 / 85 / 90 met, statements 95.2 % / branches 89.4 % / functions 96.7 % / lines 96.0 % (`coverage/coverage-summary.json`, now written and read by the gate and by verify-docs), 191 s
- [x] `npm run check:package` — attw + publint clean
- [x] `npm run verify:docs` — 52 rules, 0 problems, 0 warnings (`--strict` clean)
- [x] `npm run test:generate` + `npm run verify:samples` — 38 archives generated, 38 tracked: 33 byte-identical to their 1.0.0 baseline, 5 new with `since: 1.1.0`
- [x] `npm run validate:zip` — 33 conformant / 5 expected non-conformant, as declared (ISO/IEC 21320-1 profile, independent parser + foreign integrity pass)
- [x] `npm run test:interop` — 13 write cases extracted and byte-compared by the extractors present on this machine, 6 producers read; documented exclusions only
- [x] `tests/tools/api-compat.test.ts` + `compat-previous` — api-compat: 77/77 exports present (kind, subpath, signature — `VERSION` aside), 39/39 codes with their classes, 11/11 diagnostics; compat-previous (gate step `compat:previous`, 2026-10-08, 216 s): the v1.0.0 suite against the 1.1.0 sources — 365 passed, 11 skipped, 0 failed, 3 file exclusions (repository-tree tests, the dist-gated worker integration, the foreign-producer spawner), no behaviour-change exclusion needed

CI (to be observed on the PR): `ci (22)`, `ci (24)`, `os (windows-latest)`, `os (macos-latest)`, `interop-linux`, `interop-windows`, `sample-regression`, `compat-previous`, Docs, CodeQL.

## Pre-release audit

Run on 2026-10-08 against `2acf541` per `.claude/skills/release-audit` — Auditor A (62 claim rows, every claim reproduced by a command), Auditor B (47 surface rows), Auditor D (41 calls written from the published docs alone and executed), then two adversarial verifiers re-deriving every finding. Ledger, reports and verdict under `test-output/.audit/1.1.0/` (git-ignored).

- Verified: **1 blocker, 8 majors, 11 minors confirmed; 4 downgraded to notes; 0 rejected; 2 duplicates.** Headline findings: the guides promised a golden hash for `canonicalizeZip` that no test held (B-25); `signal` / `onProgress` were silently ignored where the docs' only example suggested putting them — `stream(options)`, `readEntryStream(entry, options)`, the remote playground (D-06, D-07, B-04); the parallel `toBytes()` reported no progress (D-08); an archive canonicalised with a pinned date failed the guide's own `analyzeDeterminism()` gate (D-12); the `extractZipStream` shape was documented nowhere and the README sample awaited the generator (D-34, V2-01); a non-existent limit name in the guide (B-06).
- Fixed in `72faadc` (every change additive; `api-compat` records the one widened signature under ledger C6): per-call `signal` / `onProgress` on both writers and both readers, progress on the parallel `toBytes()` and on skipped entries, `analyzeDeterminism({ date, dosTimeMode })`, golden SHA-256 hashes over two committed foreign fixtures, and the twenty documentation corrections listed in the ledger. Fast gate green on the fix (749 tests, 47 verify-docs rules); the full publish gate re-ran on `72faadc`, 13/13 steps — the Verification section.
- Waived (downgraded notes, 1.2 enhancements): `since` per export in `api.json` (B-08) and interface members in `api.json` (D-36 — the root cause of three documentation gaps, now fixed in prose).
- Not verifiable locally: the 4 GiB + 1 stream (conformance.yml only), the 2 GiB deterministic cap, Java `ZipInputStream` behaviour and the four interop tools absent on this machine, and the GitHub-side `npm-publish` environment and applied rulesets (merge checklist).

Second pass — the final conformity audit, run the same day on `fedb645` with two fresh auditors (engine scope, philosophy, code defects and documentation: 38 rows; tooling parity with pdfnative, CI/CD, supply chain and hygiene: 25 rows) and an adversarial verifier that re-derived every finding and re-ran half of the holds. Ledger, reports and verdict under `test-output/.audit/1.1.0-final/`.

- Verified: **3 blockers, 6 majors, 24 minors confirmed; 4 downgraded; 0 rejected; 0 duplicates.** Blockers: `publish.yml` could not complete its own gate (`compat:previous` needs the previous tag, the checkout fetched none); `npm audit --audit-level=high` was red on three dev dependencies, which also gates `ci.yml`; `canonicalizeZip()` dropped `nameDecoder` and froze legacy names as mojibake. Majors: a pre-aborted `signal` leaked the worker pool; the parallel `toBytes()` progress series was not monotonic; synchronous calls ignored an already-aborted `signal`; no limits table existed despite the promise in `zip-limits.ts`; the reproducible-builds guide claimed names are never re-encoded; `coverage-summary.json` was never written, so the published coverage figure was checked by nothing.
- Fixed in this branch (every change additive; ledger C6 and C10 updated): the engine fixes with their tests, `publish.yml` in three jobs with one digest-checked artifact and a dry-run dispatch, `npm audit fix`, `json-summary` + thresholds 88 / 80 / 85 / 90, five new verify-docs rules (`no-control-bytes`, `playground-syntax`, `export-named`, `limits-table`, `since-tags`), the limits table, the llms.txt completeness pass (every export named), the corrected guides, `eol-lf` now failing on CRLF, and the bookkeeping. One artefact found during the fix loop (V-01: a `$&` replacement slip in verify-docs' `version-token` escape helper) fixed too. The full publish gate re-ran on the result: 13/13 (the Verification section).
- Docs-autonomy pass (phase D) replayed by the verifier on the touched surfaces after the fixes: 18 programs written from the published docs alone, 27 rows, **0 blockers**; every required call behaves as documented. Two majors and four minors, all documentation sentences, fixed in the follow-up docs commit: the large-and-remote guide still said synchronous calls ignore `signal`; `errors.json` named `decompressSync` where the range reader's `readEntryStream()` needs `decompressStream`; `analyzeDeterminism` signature in llms.txt; the `addFromReader` name-string form; the lazy reader reporting `ZIP_SIGNATURE_MISMATCH` before `ZIP_ENTRY_OVERLAP` for one hostile shape; the deflate tier memoised at the first query, so `activeDeflateTier()` before `initNodeZipCodecs()` pins the pure tier (documented; a side-effect-free query is a 1.2 item).
- Deferred to 1.2 (minors, backlog draft): `verify:bundle`, the `.gitattributes` exception for `tests/fixtures/README.md`, and the standards items listed in ROADMAP § 1.2 candidates.

**Verdict: GO** (`test-output/.audit/1.1.0/verdict.md` for the first pass, `test-output/.audit/1.1.0-final/verdict.md` for the final one).

## Merge checklist

- [ ] Create the GitHub environment `npm-publish` (required reviewer, **no branch restriction** — the dry run dispatches from the release branch); link the npm Trusted Publisher to `publish.yml` and that environment; apply `.github/rulesets/main.json` (squash-only, `compat-previous` required) and `tags.json` in Settings → Rules; enable the dependency graph (dependency review); leave "Immutable releases" off (the `attest` job uploads assets to the Release after it is published).
- [ ] Dispatch **Publish** by hand on `release/v1.1.0` with `dry-run` ticked (the default) and approve the environment: `verify` must pass the full publish gate on the runner, `publish` must stop at `npm publish --dry-run`, `attest` must be skipped. This is the first run of the three-job workflow; nothing is published.
- [ ] CI green on every required check.
- [ ] `release-notes/v1.1.0.md` reviewed; release date adjusted if publication is not 2026-10-08 (`npx tsx scripts/release-prepare.ts --version 1.1.0 --date <merge day>` restamps `verifiedOn`, the sitemap and the CHANGELOG heading).
- [ ] Squash-merge to `main` with the title `release: v1.1.0 — range access, reproducible-for-any-archive, issues #9–#12, supply-chain parity`.
- [ ] Tag `v1.1.0` on the merge commit; publish the GitHub Release (title `v1.1.0 — range access, reproducible-for-any-archive, issues #9–#12, supply-chain parity`, body = the release note) → `publish.yml` → approve the `npm-publish` environment → npm with provenance; the `attest` job compares the published tarball with the registry's and attaches it and the SBOM with their provenance.
- [ ] After publication: `npm view zipnative version` prints 1.1.0, `npm audit signatures` verifies the provenance, and the CDN pin on the site (`zipnative@1.1.0`) resolves — the remote playground needs it.
- [ ] Downstream: file the two satellite issues from `.github/drafts/` under your own identity.

## AI assistance

Drafted with Claude Code under `.github/AGENT_RULES.md`: human-in-the-loop (no push, tag, release or publish performed; branch and PR body prepared), no runtime dependency proposed, every untrusted-input loop bound by a named CWE-tagged limit (`maxEntryCompressedSize` added with its SECURITY.md rows), instruction files followed (`security`, `api-design`, `testing`, `zip-core`, `performance`), commits without attribution trailers (repository convention), quality gate results recorded in the Verification section above. Rules bent: none.
