---
description: "Test and fixture rules"
applyTo: "tests/**,recipes/**,bench/**"
---

# Testing rules

- vitest with `globals: false` — import `describe/it/expect` explicitly.
- `tests/` mirrors `src/`; cross-cutting suites: `tests/integration/`,
  `tests/fuzzing/`, `tests/docs/`.
- **Anti-circularity invariant**: the reader is never tested only against our
  own writer. Reader features need (a) a foreign-tool-produced fixture from
  `tests/fixtures/interop/` and (b) an adversarial variant built with
  `tests/helpers/raw-zip-builder.ts` (hand-written header bytes, seeded,
  engine-independent). Writer features (M2+) need (a) foreign-tool
  validation in the interop gate and (b) a read-back test.
- **Fixture policy**: committed binaries only when provenance is foreign
  (named `<tool>-<version>-<trait>.zip`, < 20 KB, listed with provenance in
  `tests/fixtures/README.md`, protected by `.gitattributes`). Everything our
  own code can generate is built in `beforeAll` — never committed.
- Coverage exclusions in `vitest.config.ts` each carry a written
  justification comment.
- Recipes in `recipes/` import from `'zipnative'` (the vitest alias maps it
  to `src/index.ts`) and declare machine-checkable `expects` in
  `recipes/index.json`; `tests/docs/recipes.test.ts` executes them.
- Benchmarks live in `bench/*.bench.ts` (vitest bench); comparators are
  dev-deps fenced to `bench/`; results are committed prose in
  `bench/RESULTS.md`, regenerated manually per minor — never a blocking gate.
