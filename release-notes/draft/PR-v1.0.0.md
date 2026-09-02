# release: v1.0.0 — first stable npm release

<!-- This exact string is reused three times: the PR title, the squash-commit
     subject, and the GitHub Release title (drop the "release: " prefix for
     the Release: "v1.0.0 — first stable npm release"). -->

> **Branch:** `main` (linear history — no release branch; the tag is the release)
> **Type:** First stable release (MAJOR — the freeze itself; 100% backward-compatible with v0.9.0)
> **Distribution:** first npm publication, via Trusted Publishing (OIDC) + provenance

## Summary

zipnative 1.0.0 — the zero-dependency TypeScript ZIP engine, frozen and published. Everything shipped 0.1 → 0.9 becomes a semver commitment: the 77-export API surface, the 39-code error vocabulary, and the `deterministic: true` output bytes (changing any of them is now semver-major). This release adds no engine behavior — it is the freeze, the publication pipeline, and the professional finish: publish workflow with provenance + SBOM, complete TSDoc policed by a verify rule, supported-versions policy, the new visual identity, and the documentation flipped to its stable-era stance.

## What's in it (0.1 → 1.0)

| Area | Change |
|---|---|
| Read (v0.1) | `openZip` lazy central-directory reader, random access, CRC-verified reads, secure-by-default `extractZip`, Zip64 with anti-spoofing cross-checks |
| Write (v0.2) | `createZip` buffered + streaming from one segment generator (byte-identical), pure-TS DEFLATE encoder, frozen `deterministic: true` contract |
| Modify (v0.4) | `createZipModifier` — append-only `save()` (no recompression) + `saveCompact()` true deletion; remanence documented loudly |
| Parallel (v0.5) | `zipnative/worker` — real worker pool (Node + browser), byte-identical to `createZip` per tier |
| Forward streaming (v0.5–0.6) | `iterateZipEntries` on unseekable streams; resumable pure-TS inflater lifts the bit-3 refusal for plain deflate |
| Error contract (v0.8) | Stable machine-readable `err.code` — 39 frozen codes, registry + guide + `error-parity` rule |
| Verification (v0.9) | `verifyZip` one-call machine-readable report; never throws for archive problems |
| Sources (v0.9) | `ByteSource` — `ReadableStream` accepted everywhere, release-without-cancel enforced on every exit path |
| Publication (v1.0) | `publish.yml`: OIDC Trusted Publishing, provenance, CycloneDX SBOM, full gate re-run before `npm publish` |
| Freeze (v1.0) | TSDoc 77/77 + `tsdoc-complete` rule; SECURITY.md supported-versions + compatibility promise; docs flipped to 1.x stance; new logo/OG/social identity |

## Deferred to post-1.0 (recorded, not forgotten)

- **Zip64 streaming** (`addStream` > 4 GiB) — designed (per-entry `zip64` opt-in, ADR in ROADMAP.md), typed refusal until implemented.
- **Encryption** — none in 1.x by policy (ZipCrypto is broken); AES behind an injected provider is a later-major candidate.
- **Worker playground** — the only docs page needing build-tooling changes.
- **Satellites** — `zipnative-cli`, `zipnative-mcp` (separate repos, pinning `zipnative ^1.0.0`).

## Docs, samples & playgrounds

- 6 guides (quickstart, security, determinism, errors, use-cases + hub), machine-rendered from `.md`; 22-rule `verify:docs`.
- 33 self-validated sample archives (hostile refusal corpus generated under inverse validation), 12 executable recipes, 5 browser playgrounds with CDN-first engine loading (version-pinned esm.sh → jsDelivr → committed local bundle).
- Machine-readable artefacts: `api.json` (77 exports, extracted), `errors.json` (frozen registry), llms pipeline.

## Verification (measured on this tree)

| Gate | Command | Result |
|---|---|---|
| Types | `npm run typecheck:all` | clean (src + tests + scripts) |
| Lint | `npm run lint` | clean |
| Tests | `npm run test:coverage` | 38 files, 386 passed + 4 skipped; statements 93.89%, branches 86.56%, functions 94.68%, lines 94.73% — thresholds met |
| Build | `npm run build` | ESM + CJS + d.ts, main + worker entries |
| Package | `npm run check:package` | attw (node16 profile) + publint: clean |
| Pack | `npm pack --dry-run` | 21 files, ~484 kB tarball — dist + LICENSE/README/CHANGELOG/SECURITY/THIRD-PARTY-NOTICES only |
| Interop | `npm run test:interop` | 2 producer reads + 17 write validations (Expand-Archive, bsdtar) — OK |
| Docs | `npm run verify:docs` | 22 rules, 0 problems, 0 warnings |
| Audit | `npm audit --audit-level=high` | 0 vulnerabilities |
| Attribution | `git log --format=%B \| grep -ic claude` | 0 |

## Review

- v0.8.1: three-agent code review (two reviewers + adversarial verifier) — 13 verified findings, all fixed, 12 regression-tested.
- v0.8.2: forensic conformance pass — navigation root cause, APPNOTE §4.5.3 fix, documentation-wide factuality sweep.
- v0.9.0: coverage pass — the untested branches tested; the ByteSource lock-release contract bug found by a new test and fixed before the freeze.
- v1.0.0: final GO/NO-GO pass (gate + coverage matrix + security review) — see the release notes.

## Merge checklist (the human go-live runbook)

- [ ] Push `main` and all tags to the GitHub remote (`git push origin main --follow-tags`).
- [ ] Recommended: create a GitHub **Environment** `npm-publish` with a required reviewer and bind the publish job to it — turns the human-in-the-loop policy into a technical control.
- [ ] On npmjs.com → create/claim the `zipnative` package → Settings → **Configure Trusted Publishing**: repository `Nizoka/zipnative`, workflow `publish.yml`.
- [ ] Verify CI is green on the pushed `main` (ci, conformance, docs, CodeQL).
- [ ] Create the GitHub Release from tag `v1.0.0`, title `v1.0.0 — first stable npm release`, body = `release-notes/v1.0.0.md`.
- [ ] The "Release published" event triggers `.github/workflows/publish.yml`: full gate re-run → CycloneDX SBOM attached to the Release → `npm publish --provenance --access public`.
- [ ] Post-publish: `npm view zipnative version` → `1.0.0`; `npm audit signatures` in a consumer project confirms the provenance attestation; the playgrounds at zipnative.dev now load from the CDN (footer shows "CDN (host)").
