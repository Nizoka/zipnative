# Release pull-request template

The body of the release pull request. Copy it into
`release-notes/draft/PR-v{{version}}.md` (the committed record of what the
release PR said; `RELEASE_PR_*.md` at the root stays git-ignored), replace
`{{version}}`, `{{date}}` and `{{headline}}`, and fill every section from the
facts of the branch. The Verification section is a record of what actually
ran, not a promise: paste the numbers the gate printed, and mark anything not
yet run as PENDING.

---

# release: v{{version}} — {{headline}}

## Summary

<!-- One paragraph: what the release is about, the compatibility statement
     (zero runtime dependencies, zero breaking changes: exports added / none
     removed, error codes unchanged, deterministic bytes unchanged), and where
     existing output changed — every intentional rebaseline is listed in the
     release note's Upgrade section. -->

## What's in it

| Area | Change |
|---|---|
| <!-- e.g. Zip64 streaming --> | <!-- the public surface, one row per workstream --> |
| Issues | <!-- #NN closed, with the one-line fix --> |
| Docs & samples | <!-- guides, playgrounds, samples added or rebaselined --> |

## Compatibility ledger

<!-- Every behaviour change, with its class (additive / bug fix: previous
     output was wrong / tooling) and the guard that proves it; mirrors the
     release note's Upgrade section. -->

| # | Change | Class | Guard |
|---|---|---|---|

## Deferred

<!-- What was scoped out and why, so the next release starts from a decision
     rather than a rediscovery. Delete the section if nothing was deferred. -->

- ...

## Docs, samples & recipes

- Release note `release-notes/v{{version}}.md` and the `CHANGELOG.md` entry `## [{{version}}] - {{date}}`.
- Manifest `docs/assets/ecosystem.json`: version {{version}}, `verifiedOn` {{date}}, counts updated (`derived.*`, `declared.iso21320`).
- CDN pin in `docs/playgrounds/load-engine.js` moves to `zipnative@{{version}}`, so the playgrounds resolve once the release is published.
- <!-- new or updated guides, playgrounds, recipes; sample count before → after -->

## Verification

The release gate is `npx tsx scripts/gate.ts --publish --require-all`. Each line names the individual gate and what it reported on the release commit:

- [ ] `npm run typecheck:all` — clean (src + tests + scripts).
- [ ] `npm run lint` — clean.
- [ ] `npm run build` + dist-check + dist-probe — ESM, CJS, declarations, worker script; no console/eval leak.
- [ ] `npm run test:coverage` — N tests across M files; statements / branches / functions / lines against the thresholds in vitest.config.ts.
- [ ] `npm run check:package` — attw + publint clean.
- [ ] `npm run verify:docs` — all rules passed, no warning.
- [ ] `npm run test:generate` + `npm run verify:samples` — N samples tracked; every rebaseline pre-declared in the release note.
- [ ] `npm run validate:zip` — N/M conformant / non-conformant as declared (ISO/IEC 21320-1, independent parser + foreign integrity pass).
- [ ] `npm run test:interop` — six extractors × N write cases, six producers read; exclusions justified.
- [ ] `tests/tools/api-compat.test.ts` + `compat-previous` — every 1.0.0 export present, the 1.0.0 suite green outside the declared allow-list.

## Pre-release audit

<!-- Date, the three agent reports (auditor-a, auditor-b, verifier), findings
     by severity, what was fixed (commit hashes), what was waived and why.
     The ledger lives under test-output/.audit/<version>/ (not committed). -->

## Merge checklist

- [ ] CI green: `ci (22)`, `ci (24)`, `os (windows-latest)`, `os (macos-latest)`, `interop-linux`, `interop-windows`, `sample-regression`, Docs, CodeQL.
- [ ] `release-notes/v{{version}}.md` reviewed; release date adjusted if publication is not {{date}}.
- [ ] Squash-merge to `main` with the title `release: v{{version}} — {{headline}}`.
- [ ] Tag `v{{version}}` on the merge commit; publish the GitHub Release (title `v{{version}} — {{headline}}`, body = the release note) → `publish.yml` → approve the `npm-publish` environment → npm with provenance; the `attest` job attaches the tarball and the SBOM.
- [ ] After publication: `npm view zipnative version` prints {{version}}, `npm audit signatures` verifies the provenance, and the CDN pin on the site (`zipnative@{{version}}`) resolves.
- [ ] Downstream: open the satellite issues (`zipnative-cli`, `zipnative-mcp`) from the release note's Downstream integration notes.

## AI assistance

<!-- The compliance report of .github/AGENT_RULES.md: what was drafted by AI,
     which instruction files were followed, the quality-gate results, and any
     rule this draft bends (with justification) for the human reviewer. -->
