# Contributing to zipnative

Thanks for your interest! zipnative follows the engineering doctrine of its
sibling [pdfnative](https://github.com/Nizoka/pdfnative). The short version:

## Ground rules

- **Zero runtime dependencies.** Never add one to `package.json`. Dev
  dependencies require written justification in the PR. Benchmark comparators
  (fflate, jszip, adm-zip) are fenced to `bench/` by an ESLint rule.
- **No classes** except `Error` subclasses. Public objects are interfaces
  returned by closure factories; state lives in closed-over `Map`s.
- **No module-level side effects** — the package declares `"sideEffects": false`
  and must stay tree-shakeable.
- **Strict layering**: `types → codecs → core → parser → worker`. No reverse
  edges; if one ever becomes necessary it must be enumerated in `AGENTS.md`
  first.
- **Every untrusted-input loop gets a named, CWE-tagged, configurable bound**
  in `src/core/zip-limits.ts`.
- Errors are prefixed `zipnative: ` and include the remedy. Conformance
  concerns go through the diagnostics channel, never `console`.
- **Zero breaking changes within a major.** Exports are added, never removed
  or renamed; options and fields are optional; error codes and
  `deterministic: true` bytes are frozen. `tests/tools/api-compat.test.ts`
  (every previous export, code and signature still present), the
  `compat-previous` CI job (the previous release's own test suite run
  against the current sources — `npm run compat:previous`; exclusions live
  in `tests/compat/allow-<version>.json` with a reason each) and the sample
  baseline (`npm run verify:samples`) are the mechanical guards; a bug fix
  that changes previously-wrong output is listed in the release note's
  Upgrade section and referenced from the allow-list.

## Workflow

1. Branch from `main`: `feat/…`, `fix/…`, `docs/…`, `release/vX.Y.Z`.
2. Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
   `feat(parser): …`, `fix(codecs): …`, `chore:`, `docs:`, `test:`, `refactor:`.
3. Install with the repository defaults — `.npmrc` sets `ignore-scripts=true`
   (no dependency lifecycle script ever runs on your machine or on CI) and
   `.nvmrc` / `.node-version` pin the Node line (22). Optional git hooks
   (pre-commit lint + CRLF guard, pre-push fast gate) are installed with
   `npm run hooks:install` and removed with `npm run hooks:uninstall`; nothing
   activates them for you.
4. Before pushing, run the gate — the single definition of "green", shared
   with CI (`scripts/gate.ts`):
   ```bash
   npm run gate:fast     # typecheck:all, lint, test, verify:docs — the inner loop
   npm run gate          # the CI profile: + build, dist checks, coverage, package
                         #   checks, samples against the baseline, ISO validation
   npx tsx scripts/gate.ts --publish   # + the foreign-tool interop matrix (release branches)
   ```
   `--only <step>` runs one step, `--from <step>` resumes, `--json` prints a
   machine-readable report; every step's full output lands in
   `test-output/.gate/<step>.log`. (PowerShell swallows a bare `--`, so call
   the script directly when passing flags.)
   If your change affects emitted bytes or adds a feature area, also:
   ```bash
   npm run test:interop    # foreign-tool conformance, both directions
   npm run test:generate   # refresh test-output/ samples for inspection
   npm run verify:samples  # every sample still emits what its reference release emitted
   ```
   New sample categories follow the 3-step recipe in `scripts/README.md`
   (and bump `derived.sampleZips` in `docs/assets/ecosystem.json`). An
   intended change of existing output is rebaselined with
   `npx tsx scripts/verify-samples.ts --update` and explained in the commit
   and the release note.
5. Tests mirror `src/` under `tests/`. New parser behavior needs an adversarial
   variant in `tests/fuzzing/` built with the raw byte-level builder
   (`tests/helpers/raw-zip-builder.ts`) — never only fixtures produced by our
   own writer.
6. Fixture rules are strict — see `tests/fixtures/README.md`. Committed
   binaries must have foreign provenance, be < 20 KB, and be protected by
   `.gitattributes`.

## Pull Request Checklist

The pull request template mirrors this list word for word (`verify:docs` rule
`pr-template-parity` and `tests/tools/workflows.test.ts` keep the two in step).

- [ ] `npm run gate` passes — the CI profile in one command (`npm run gate:fast` for a quick loop while iterating)
- [ ] No runtime dependency added (dev deps justified in the description if any)
- [ ] No `any` types, no classes outside `src/types/zip-errors.ts`, no module-level side effects
- [ ] New parser behaviour has an adversarial test in `tests/fuzzing/` (raw-builder, not writer-produced)
- [ ] Security bounds touched? `src/core/zip-limits.ts` and SECURITY.md updated together, CWE named
- [ ] Public API touched? `src/index.ts` export categories, `npm run docs:api`, README and the guides updated; additions only (`tests/tools/api-compat.test.ts`)
- [ ] Emitted bytes touched? `npm run test:generate && npm run verify:samples` passes; an intended output change is rebaselined with `npx tsx scripts/verify-samples.ts --update` and explained in the commit (semver-major if `deterministic: true` bytes change)
- [ ] Conformance touched? `npm run validate:zip && npm run test:interop` passes locally; new samples bump `derived.sampleZips` and `declared.iso21320` in `docs/assets/ecosystem.json`
- [ ] If docs/, playgrounds, README or llms files changed: `npm run docs:all && npm run verify:docs` passes
- [ ] CHANGELOG.md updated if user-facing changes
- [ ] Conventional Commit title (`feat(parser): …`, `fix(codecs): …`)
- [ ] For releases: follow [Release](#release) — `release-notes/vX.Y.Z.md` written, Downstream integration notes filled, and `npx tsx scripts/gate.ts --publish` passes locally

## Playground engine (CDN)

The interactive playgrounds import the **published** `zipnative` package
from a version-pinned CDN (esm.sh, then jsDelivr) through the shared
loader `docs/playgrounds/load-engine.js` — no local bundle, so what runs
in the browser is the npm artefact byte for byte. At each release, bump
the loader's `VERSION` constant with the manifest; the `cdn-pin`
verify-docs rule fails on drift and on any reintroduced local fallback.
Consequence: a playground change that needs unreleased engine behaviour
must wait for the release that ships it.

## Docs local preview

The documentation site (`docs/`) is static HTML/CSS/JS with **no build
step for viewing** — every guide is pre-rendered into its shell by
`npm run docs:guides` (verify-docs's `guide-render-sync` keeps the
committed render in sync with its Markdown source). The playgrounds use
module scripts and a CDN loader, so serve over HTTP (`file://` blocks
them; the same port pdfnative uses):

```bash
npm run docs:serve                                # http://localhost:5000
# equivalents, pick any:
npx http-server docs/ -p 5000
python -m http.server 5000 --directory docs/
```

Entry points: `http://localhost:5000/` (landing),
`http://localhost:5000/guides/` (guide hub),
`http://localhost:5000/playgrounds/` (playgrounds). After editing a
guide's `.md`, run `npm run docs:guides && npm run docs:llms` and commit
the regenerated files — CI rejects stale renders.

## Conformance validation (the veraPDF analogue)

Every generated sample archive is validated clause by clause against
ISO/IEC 21320-1:2015 by `scripts/validate-zip.ts` — an independent raw
parser that never imports the engine (a validator sharing the engine's
parser would attest the engine with the engine):

```bash
npm run test:generate   # sample corpus → test-output/ (git-ignored)
npm run validate:zip    # ISO profile + foreign integrity pass
```

No external installation is needed — level 0 is pure byte parsing; the
foreign integrity pass uses whatever tools your machine has (`unzip`,
`7z`, `python`, `tar`, `jar`) and prints SKIP for the rest. Expectations
are two-sided: the hostile archives from the refusals/forward-trust
corpora MUST fail with their declared clause, and the scanned counts are
canaried against `declared.iso21320` in `docs/assets/ecosystem.json` —
adding or removing a sample means updating that manifest. **CI is
blocking**: both conformance jobs (Linux + Windows) and the publish
workflow run the validator before the interop matrix.

## Release

Releases are prepared on a `release/vX.Y.Z` branch and performed by the
maintainer; an agent prepares everything and stops before pushing
(`.github/AGENT_RULES.md`).

1. `npx tsx scripts/release-prepare.ts --version X.Y.Z` bumps every version
   site in one pass (package manifests, `src/index.ts`, `CITATION.cff`, the
   ecosystem manifest and its `verifiedOn` stamps, the CDN pin, the JSON-LD,
   SECURITY.md's support table) and scaffolds `release-notes/vX.Y.Z.md`.
2. Write the release note from `release-notes/TEMPLATE.md` (Security first,
   Upgrade = the compatibility ledger, Downstream integration notes for the
   satellites) and mirror its bullets into `CHANGELOG.md`.
3. `npm run docs:all && npm run verify:docs` — regenerate `api.json`, the
   guide renders and the llms files; every count in prose must equal the
   manifest.
4. `npx tsx scripts/gate.ts --publish --require-all` — the exact gate
   `publish.yml` runs, foreign tools included. Then, once the branch is
   pushed, dispatch Publish by hand with `dry-run` ticked: `verify` runs the
   same gate on a runner, `publish` stops at `npm publish --dry-run`, `attest`
   is skipped. A green dry run is the precondition of the tag.
5. Run the pre-release audit (`/release-audit` in Claude Code, or the
   procedure in `.claude/skills/release-audit/SKILL.md`): two auditors, an
   adversarial verifier, a docs-autonomy pass, a GO/NO-GO ledger. Fix every
   confirmed blocker through the normal gate loop.
6. Open the pull request from `release-notes/PR_TEMPLATE.md`; CI must be green
   on every required check (`ci (22)`, `ci (24)`, `os (windows-latest)`,
   `os (macos-latest)`, `interop-linux`, `interop-windows`, `sample-regression`,
   `compat-previous`).
7. Maintainer: squash-merge, tag `vX.Y.Z`, publish the GitHub Release with the
   release note as body → `publish.yml` → approve the `npm-publish`
   environment → npm Trusted Publishing with provenance; the `attest` job
   compares the published tarball with the registry's, then attaches it and
   the CycloneDX SBOM with their provenance. Verify with
   `npm audit signatures`.

## Honesty rules

- The README comparison table keeps fflate's "fastest raw deflate" cell.
  Benchmarks report scenario wins (random access, streaming memory ceiling,
  in-place update), never deflate drag races.
- "Known Limitations" sections are maintained, not deleted.

## AI-assisted contributions

This repository operates under a human-in-the-loop AI governance policy —
see `.github/AGENT_RULES.md` and `.github/ai-governance.json`. Agents draft;
humans review and merge. AI-drafted issues go through `.github/drafts/` and
`npm run verify:issue`. Claude Code sessions additionally run under
`.claude/settings.json` and the fail-closed guard hook
`.claude/hooks/guard.mjs` (`CLAUDE.md` describes both).
