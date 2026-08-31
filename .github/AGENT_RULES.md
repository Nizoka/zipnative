# Agent rules — human-in-the-loop governance

This repository is built with AI assistance under an explicit contract:
**agents draft, humans decide.** The machine-readable version is
`ai-governance.json`; this file is the prose.

## What agents may do

- Draft code, tests, docs and benchmarks in branches/PRs for human review.
- Draft issues into `.github/drafts/` (git-ignored except README/TEMPLATE)
  and validate them with `npm run verify:issue <draft.md>`.
- Run the local quality gate (`typecheck:all`, `lint`, `test:coverage`,
  `build`, `test:interop`).

## What agents may NOT do

- Perform autonomous GitHub writes (file issues, merge, publish, edit
  releases) — a human performs every write after review.
- Add a runtime dependency, or draft an issue/PR proposing one
  (`verify-issue` fails such drafts mechanically).
- Change bytes produced under `deterministic: true` without flagging the
  change as semver-major.
- Regenerate or modify committed foreign-provenance fixtures.
- Frame benchmark results as raw-deflate throughput comparisons vs fflate —
  scenario benchmarks only (see performance instructions).
- Weaken a security default (`rejectTraversal`, `rejectSymlinks`,
  `onDuplicate`, any `ZipLimits` default) — proposals to do so require an
  explicit human decision recorded in the PR.

## Compliance report

AI-drafted PRs include in their description: what was drafted by AI, which
instructions files were followed, the quality-gate results, and any rule this
draft bends (with justification) for the human reviewer to weigh.
