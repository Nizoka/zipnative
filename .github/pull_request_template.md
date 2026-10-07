<!--
Thank you for contributing to zipnative. Describe the change, then walk the
checklist. The items mirror CONTRIBUTING.md §Pull Request Checklist word for
word; keep the two in step when you change either (verify:docs rule
pr-template-parity and tests/tools/workflows.test.ts both check it).
-->

## What and why

<!-- One paragraph: what changes, why, and which issue it closes (`Closes #…`). -->

## Checklist

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
- [ ] For releases: follow [Release](../CONTRIBUTING.md#release) — `release-notes/vX.Y.Z.md` written, Downstream integration notes filled, and `npx tsx scripts/gate.ts --publish` passes locally

## AI assistance

<!-- If AI tooling drafted part of this PR, include the compliance report of
     .github/AGENT_RULES.md: what was drafted by AI, which instruction files
     were followed, the quality-gate results, and any rule this draft bends
     (with justification) for the human reviewer. -->
