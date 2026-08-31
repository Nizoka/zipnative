# zipnative — canonical agent instructions

Read `AGENTS.md` at the repo root first; this file adds the exhaustive rules.
Scoped, auto-applied rules per domain live in `.github/instructions/*.instructions.md`.

## Non-negotiables

1. **Zero runtime dependencies.** Never add a `dependencies` field entry.
   Dev dependencies need written justification in the PR body. Benchmark
   comparators (fflate/jszip/adm-zip) may only be imported under `bench/`
   (ESLint `no-restricted-imports` enforces this).
2. **No `any`** (`@typescript-eslint/no-explicit-any` is `error`). **No
   classes** except `Error` subclasses in `src/types/zip-errors.ts`. **No
   module-level side effects** — lazy-build lookup tables inside functions,
   memoize in module scope on first call.
3. **Layering** `types → codecs → core → parser → worker` with zero reverse
   edges. Cross-layer needs (diagnostics in codecs, compression in the
   segment generator) are met by parameter injection.
4. **Security bounds**: every loop over archive bytes consults `ZipLimits`.
   A new loop introduces a new named limit with a CWE tag, a default, a test
   in `tests/fuzzing/`, and a SECURITY.md row — all in the same PR.
5. **Error style**: `throw new ZipFormatError('zipnative: <what failed> (<how to fix or which option to raise>)')`.
   Subclass only when callers must branch (`instanceof`).
6. **Diagnostics**: non-fatal conformance concerns use the emitter from
   `src/core/zip-diagnostics.ts` with a code from the closed
   `ZipDiagnosticCode` union and a payload factory function. `console.warn`
   is allowed in that module only.
7. **Determinism**: nothing in the default write path may read the clock,
   randomness, locale, or environment. Wall-clock timestamps require the
   caller to pass `'now'` and cost a diagnostic. Under `deterministic: true`
   output bytes are a frozen public contract — changing them is semver-major.
8. **API design**: single entry point `src/index.ts` with numbered export
   categories; anything not exported there is private. `fn(data, options?)`;
   explicit return types; module-local option types; readonly fields.
9. **Tests**: mirror `src/` under `tests/`. Reader features need a
   foreign-tool-produced fixture AND a raw-builder adversarial variant.
   Writer features (M2+) need a foreign-tool validation in the interop gate
   AND a read-back test. Never commit binaries our own code generated.
10. **Docs honesty**: mechanical extraction over guessing; unknown fields are
    `null`, never invented. "Known Limitations" sections are maintained.

## Commit / PR conventions

Conventional Commits (`feat(parser):`, `fix(codecs):`, `chore(ci):` …).
Branches `feat/…`, `fix/…`, `docs/…`, `release/vX.Y.Z`. PRs fill the template
checklist; CI must be green on Linux (Node 22/24) and Windows.

## Governance

`.github/ai-governance.json` is the contract: agents draft, humans decide.
No autonomous GitHub writes. Issue drafts → `.github/drafts/` →
`npm run verify:issue` before a human files them.
