## Summary

<!-- What does this PR change, and why? -->

## Checklist

- [ ] `npm run typecheck:all && npm run lint && npm run test:coverage && npm run build` passes locally
- [ ] No runtime dependency added (dev deps justified below if any)
- [ ] New parser behavior has an adversarial test in `tests/fuzzing/` (raw-builder, not writer-produced)
- [ ] Security bounds touched? `src/core/zip-limits.ts` and SECURITY.md updated together
- [ ] Public API touched? `src/index.ts` export categories and README updated
- [ ] Determinism-affecting change? Golden tests and docs updated (semver-major if `deterministic: true` bytes change)
- [ ] Conventional Commit title (`feat(parser): …`, `fix(codecs): …`)

## AI assistance

<!-- If AI tooling drafted part of this PR, say so — see .github/AGENT_RULES.md. -->
