---
description: "Run the full zipnative quality gate and report each step's measured result — the checklist every release and every substantial change must pass."
agent: "agent"
---

# Quality gate

Run every step below in order and report the measured result of each —
never a summary of what "should" pass. `vitest.config.ts` is the single
source of truth for the coverage thresholds (statements 85, branches 78,
functions 85, lines 85 — the measured numbers sit well above them).

1. `npm run typecheck:all` — tsc over src, tests and scripts. Zero errors.
2. `npm run lint` — eslint over src/. Zero findings.
3. `npm run test:coverage` — run it ALONE (never concurrently with other
   npm jobs); thresholds enforced by vitest.
4. `npm run build && npm run check:package` — tsup output + attw
   (`--profile node16 --ignore-rules cjs-resolves-to-esm`) + publint.
5. `npm run test:generate && npm run validate:zip` — regenerate the
   sample corpus, then the ISO/IEC 21320-1 conformance validator:
   declared-conformant samples PASS, declared-hostile archives FAIL with
   their clause, coverage canary green.
6. `npm run test:interop` — the differential extraction matrix against
   every foreign tool available on the machine.
7. `npm run verify:docs` — all documentation-integrity rules green.

After any `src/` change also refresh the committed playground bundle
(`npm run docs:playground`) — rule `playground-bundle` byte-compares it
in CI. Report intentional byte changes to deterministic output loudly:
they are semver-major by contract.
