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
| Hardening / CI | `gate.ts` profiles, harden-runner + `--ignore-scripts`, `npm-publish` environment, pinned npm, SLSA L2 attest job, dependency review, weekly audit, rulesets, `os` + `compat-previous` jobs, sample byte baseline, opt-in hooks, Claude Code governance layer, `release-prepare`, 20 verify-docs rules |
| Docs & samples | 2 guides, remote playground + 4 playground upgrades, 4 recipes, 5 samples (38), 2 interop cases (19), `surfaces.json` + choose guide (9 capabilities), `errors.json` re-audit, ROADMAP / SECURITY / README / llms / agent brief / homepage |

## Compatibility ledger

| # | Change | Class | Guard |
|---|---|---|---|
| C1 | Out-of-range / invalid dates clamp correctly, with `ZIP_TIMESTAMP_CLAMPED` | bug fix — bytes change only where the previous output was wrong | 33/33 baseline unchanged; `zip-dos-time*.test.ts` |
| C2 | Node / `DecompressionStream` tiers raise `ZIP_DEFLATE_*` (`ZipFormatError`) for corrupt payloads | classification fix (both codes frozen since 0.8.0) | `inflate-tier-parity.test.ts` |
| C3 | Real `localHeaderMatch` for encrypted entries; a contradicting local header fails the archive | tightening, never looser | `zip-verify-reasons.test.ts`, `compat-previous` |
| C4 | `skipped: 'unsupported-method'` still fails the archive | additive | `zip-verify-reasons.test.ts` |
| C5 | Unions widened (`'aes'`, `EntrySkipReason`, `'custom'`, `ZIP_TIMESTAMP_CLAMPED`) | additive | `api-compat.test.ts` |
| C6 | Interfaces extended with optional members (`ZipWriter`, `saveCompact(options?)`, `ZipCodec`, `ZipCommonOptions`, `AddEntryOptions`, `ZipLimits`) | additive | `api-compat.test.ts` (77/77 signatures, `VERSION` aside) |
| C7 | `maxEntryCompressedSize` only on `openZipRange` allocations | additive | `zip-range-reader.test.ts` |
| C8 | Two error messages reworded | outside the contract | — |
| C9 | `recipes/custom-codec.ts` → method 97 | docs | `recipes.test.ts` |
| C10 | Tooling (`validate-zip` descriptor width, verify-docs, workflows, `.npmrc`, vitest `TZ=UTC`/forks) | outside the API | `tests/tools/*` |

## Deferred

- **AES read-only decryption** — contradicts the published 1.x policy ("no encryption, read or write, in 1.x"); 1.1.0 labels such entries `feature: 'aes'` and stops. 2.0 candidate (ROADMAP).
- **Pure-TS streaming deflate under `deterministic: true`** — lifts the 2 GiB per-entry cap and makes the Zip64 opt-in deterministic. 1.2 candidate.
- **Modifier / `extractZipStream` over a `ZipRangeReader`** — 1.2 candidate.
- **Writing UT / NTFS extra fields** — interacts with the "extra fields: none, except Zip64" contract; decided first, then 1.2.
- **Worker playground** — the CDN-served worker script is cross-origin; a Blob shim remains a docs item.
- **Checksum-pinned external validators** — the runner image's unzip / 7-Zip / bsdtar / Python / `jar` / `Expand-Archive`; versions are recorded in the job summary (Known limitations).
- **Coverage thresholds** — kept at 85 / 78 / 85 / 85; raising them needs the branch figure measured on an idle machine.
- **Fixture naming warning** (`<tool>-<version>-<trait>.zip`) in `tests/docs/fixture-budget.test.ts` — not added; the two committed fixtures predate the convention.

## Docs, samples & recipes

- Release note `release-notes/v1.1.0.md` (Security first; Upgrade = the ledger; Downstream integration notes) and the `CHANGELOG.md` entry `## [1.1.0] - 2026-10-08` (the previously unreleased ecosystem-docs entry folded in).
- Manifest `docs/assets/ecosystem.json`: version 1.1.0, `verifiedOn` 2026-10-08, `derived.*` (exports 106, errorCodes 39, diagnostics 12, testFiles 61, sampleGenerators 12, guides 11, playgrounds 8, recipes 16, interopTools 6, interopValidations 19, verifyDocsRules 47, sampleZips 38), `declared` (tests 749, coverage 93 / 93.9, iso21320 33 / 5).
- CDN pin in `docs/playgrounds/load-engine.js` moves to `zipnative@1.1.0`, so the playgrounds resolve once the release is published (documented window between merge and publish).
- Guides 9 → 11 (`large-and-remote`, `reproducible-builds`); playgrounds 7 → 8 (`remote`); recipes 12 → 16; samples 33 → 38 (five new entries baselined with `since: 1.1.0`, the 33 others byte-identical); interop write cases 11 → 13.
- Two satellite issue drafts under `.github/drafts/` (git-ignored; `verify:issue` OK) for the human to file: `zipnative-cli-bump-1.1.0.md`, `zipnative-mcp-bump-1.1.0.md`.

## Verification

The release gate is `npx tsx scripts/gate.ts --publish --require-all`. Each line names the individual gate and what it reported on the release commit (Windows 11, Node 22, 2026-10-08; the gate ran in three resumed segments after fixing the codec-test matchers and the compat extraction path — every step passed on the release tree):

- [x] `npm run typecheck:all` — clean (src + tests + scripts), 46.8 s
- [x] `npm run lint` — clean, 33.2 s
- [x] `npm run build` + dist-check + dist-probe — ESM, CJS, declarations, worker script present; no console / eval / Node I/O leak in the bundles
- [x] `npm run test:coverage` — 749 tests across 61 files (6 skipped: foreign producers absent), thresholds 85 / 78 / 85 / 85 met, statements 93.9 % (declared.coverageMeasured), 210.9 s
- [x] `npm run check:package` — attw + publint clean
- [x] `npm run verify:docs` — 47 rules, 0 problems, 0 warnings (`--strict` clean)
- [x] `npm run test:generate` + `npm run verify:samples` — 38 archives generated, 38 tracked: 33 byte-identical to their 1.0.0 baseline, 5 new with `since: 1.1.0`
- [x] `npm run validate:zip` — 33 conformant / 5 expected non-conformant, as declared (ISO/IEC 21320-1 profile, independent parser + foreign integrity pass)
- [x] `npm run test:interop` — 13 write cases extracted and byte-compared by the extractors present on this machine, 6 producers read; documented exclusions only
- [x] `tests/tools/api-compat.test.ts` + `compat-previous` — api-compat: 77/77 exports present (kind, subpath, signature — `VERSION` aside), 39/39 codes with their classes, 11/11 diagnostics; compat-previous (gate step `compat:previous`, 2026-10-08): the v1.0.0 suite against the 1.1.0 sources — 365 passed, 11 skipped, 0 failed, 3 file exclusions (repository-tree tests, the dist-gated worker integration, the foreign-producer spawner), no behaviour-change exclusion needed

CI (to be observed on the PR): `ci (22)`, `ci (24)`, `os (windows-latest)`, `os (macos-latest)`, `interop-linux`, `interop-windows`, `sample-regression`, `compat-previous`, Docs, CodeQL.

## Pre-release audit

PENDING — `.claude/skills/release-audit` (auditor A: claims vs code; auditor B: machine surfaces vs prose; adversarial verifier; docs-autonomy pass; GO / NO-GO). Ledger under `test-output/.audit/1.1.0/` (not committed); summary to be pasted here.

## Merge checklist

- [ ] Create the GitHub environment `npm-publish` (required reviewer); link the npm Trusted Publisher to `publish.yml` and that environment; apply `.github/rulesets/main.json` and `tags.json` in Settings → Rules (the new required check is `compat-previous`); enable the dependency graph (dependency review).
- [ ] CI green on every required check.
- [ ] `release-notes/v1.1.0.md` reviewed; release date adjusted if publication is not 2026-10-08 (`npx tsx scripts/release-prepare.ts --version 1.1.0 --date <merge day>` restamps `verifiedOn`, the sitemap and the CHANGELOG heading).
- [ ] Squash-merge to `main` with the title `release: v1.1.0 — range access, reproducible-for-any-archive, issues #9–#12, supply-chain parity`.
- [ ] Tag `v1.1.0` on the merge commit; publish the GitHub Release (title `v1.1.0 — range access, reproducible-for-any-archive, issues #9–#12, supply-chain parity`, body = the release note) → `publish.yml` → approve the `npm-publish` environment → npm with provenance; the `attest` job attaches the tarball and the SBOM.
- [ ] After publication: `npm view zipnative version` prints 1.1.0, `npm audit signatures` verifies the provenance, and the CDN pin on the site (`zipnative@1.1.0`) resolves — the remote playground needs it.
- [ ] Downstream: file the two satellite issues from `.github/drafts/` under your own identity.

## AI assistance

Drafted with Claude Code under `.github/AGENT_RULES.md`: human-in-the-loop (no push, tag, release or publish performed; branch and PR body prepared), no runtime dependency proposed, every untrusted-input loop bound by a named CWE-tagged limit (`maxEntryCompressedSize` added with its SECURITY.md rows), instruction files followed (`security`, `api-design`, `testing`, `zip-core`, `performance`), commits without attribution trailers (repository convention), quality gate results recorded in the Verification section above. Rules bent: none.
