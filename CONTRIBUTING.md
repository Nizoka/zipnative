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

## Workflow

1. Branch from `main`: `feat/…`, `fix/…`, `docs/…`.
2. Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
   `feat(parser): …`, `fix(codecs): …`, `chore:`, `docs:`, `test:`, `refactor:`.
3. Before pushing:
   ```bash
   npm run typecheck:all && npm run lint && npm run test:coverage && npm run build
   ```
   If your change affects emitted bytes or adds a feature area, also:
   ```bash
   npm run test:interop    # foreign-tool conformance, both directions
   npm run test:generate   # refresh test-output/ samples for inspection
   ```
   New sample categories follow the 3-step recipe in `scripts/README.md`
   (and bump `derived.sampleZips` in `docs/assets/ecosystem.json`).
4. Tests mirror `src/` under `tests/`. New parser behavior needs an adversarial
   variant in `tests/fuzzing/` built with the raw byte-level builder
   (`tests/helpers/raw-zip-builder.ts`) — never only fixtures produced by our
   own writer.
5. Fixture rules are strict — see `tests/fixtures/README.md`. Committed
   binaries must have foreign provenance, be < 20 KB, and be protected by
   `.gitattributes`.

## Playground bundle

The interactive playgrounds run a committed copy of the engine's own
bundle (`docs/playgrounds/zipnative.js`). After any `src/` change, refresh
it with `npm run build && npm run docs:playground` — the `playground-bundle`
verify-docs rule byte-compares it against `dist/index.js` in CI and fails
on drift.

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
npm run test:generate   # 33-sample corpus → test-output/ (git-ignored)
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

## Honesty rules

- The README comparison table keeps fflate's "fastest raw deflate" cell.
  Benchmarks report scenario wins (random access, streaming memory ceiling,
  in-place update), never deflate drag races.
- "Known Limitations" sections are maintained, not deleted.

## AI-assisted contributions

This repository operates under a human-in-the-loop AI governance policy —
see `.github/AGENT_RULES.md` and `.github/ai-governance.json`. Agents draft;
humans review and merge. AI-drafted issues go through `.github/drafts/` and
`npm run verify:issue`.
