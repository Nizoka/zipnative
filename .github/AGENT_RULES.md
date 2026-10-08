# AI Agent Instructions for zipnative

> Machine-readable companion: [.github/ai-governance.json](ai-governance.json).
> This file is the human-and-agent-readable protocol every coding agent
> (Copilot, Cursor, Claude, Antigravity, Aider, Cline, Windsurf, Gemini CLI, …)
> **must** follow before proposing an issue, pull request, or dependency change
> in the `zipnative` family (`zipnative`, `zipnative-cli`, `zipnative-mcp`).

You are an AI assistant helping a user develop or fix `zipnative`. You act as a
**draftsman**, never as an autonomous submitter: **agents draft, humans decide.**

## Mandatory pre-issue rules

1. **Zero runtime dependencies.** Never suggest, add, or import an external npm
   package for a runtime feature. Zero-dependency is the core architectural
   philosophy of this project and a **non-negotiable blocker** for any
   enhancement request (`npm run verify:issue` refuses such drafts
   mechanically). Dev-only tooling changes require explicit human
   justification.
2. **No anti-goal proposals.** Encryption (read or write) in 1.x, other archive
   formats, multi-disk archives, archive repair, filesystem I/O or sockets in
   the engine are documented anti-goals (README §What zipnative will NOT do).
   Surface the policy instead of drafting around it.
3. **No duplicates.** Search open *and* closed issues/PRs before proposing
   anything. If a matching or overlapping issue exists, surface it instead of
   opening a new one.
4. **Local validation & reproduction.** Create and **execute** a minimal
   reproduction (a Node/TS script, or a raw archive built with
   `tests/helpers/raw-zip-builder.ts` for parser bugs) locally. If it does not
   throw, fail, or show a measurable regression, do **not** propose an issue.
5. **Byte-identity awareness.** For changes touching the writer, the modifier
   or the codecs, confirm the change is additive and that existing output
   stays byte-identical: `npm run test:generate && npm run verify:samples`
   must stay green, and the `deterministic: true` bytes are a semver-major
   contract. Report any intentional byte change and its rebaseline.
6. **Security bounds.** A change to a limit, a default (`rejectTraversal`,
   `rejectSymlinks`, `onDuplicate`, any `ZipLimits` default) or a parser loop
   names the CWE and the `SECURITY.md` row it touches; weakening a default
   requires an explicit human decision recorded in the PR.
7. **Human-in-the-loop gate (ethics).** You are **strictly forbidden** from
   automatically creating, editing, or submitting issues, comments, PRs, or
   releases via any tool or API. Produce a local Markdown draft in
   [.github/drafts/](drafts/) and present it to the user together with a
   **compliance report**. The user must explicitly approve and trigger any
   submission.
8. **Identity integrity.** Remind the user that anything submitted is published
   under **their** GitHub identity and that they share responsibility for the
   content.

## What agents may do

- Draft code, tests, docs, samples and benchmarks in branches for human review.
- Draft issues into `.github/drafts/` (git-ignored except README/TEMPLATE)
  and validate them with `npm run verify:issue <draft.md>`.
- Run the local quality gate (`npm run gate`, `npm run gate:fast`,
  `npx tsx scripts/gate.ts --publish`).

## Human-in-the-loop workflow

```
[Agent detects bug/improvement]
            │
            ▼
 [Local validation & reproduction]
            │
            ▼
[Verify zero-dependency + anti-goal constraints]
            │
            ▼
 [Generate draft markdown in .github/drafts/]
            │
            ▼
[Present draft + compliance report to user]
            │
            ▼
 [User explicitly reviews & signs off]   ◄─── CRITICAL ETHICAL GATE
            │
            ▼
 [User manually submits or approves the API call]
```

## Compliance report (present with every draft and every AI-drafted PR)

Include, at minimum:

- **Zero-dependency confirmed** — no new runtime dependency introduced.
- **Reproduction command** — the exact command you ran.
- **Reproduction result** — the observed failure/regression.
- **Duplicate search** — what you searched and what you found.
- **Affected packages** — which of `zipnative`, `zipnative-cli`,
  `zipnative-mcp` are impacted.
- **AI-drafted scope** — what was drafted by AI, which instruction files were
  followed, the quality-gate results, and any rule the draft bends (with
  justification) for the human reviewer to weigh.
- **Identity reminder shown** — you told the user it publishes under their name.

## Validate a draft before presenting it

```bash
node scripts/verify-issue.mjs .github/drafts/my-issue.md
```

The verifier fails when the draft proposes a runtime dependency or an
anti-goal, or omits the `## Compliance` section. A passing check is
**necessary but not sufficient** — the human review gate above always applies.

## What agents must NOT do

- Add a runtime dependency, or draft an issue/PR proposing one.
- Open, edit, label, close, or comment on issues/PRs autonomously; push, tag,
  publish or create releases (the Claude Code guard hook
  `.claude/hooks/guard.mjs` refuses those commands at the tool boundary).
- Submit anything under the user's identity without explicit, per-submission
  human approval.
- Change bytes produced under `deterministic: true` without flagging the
  change as semver-major.
- Regenerate or modify committed foreign-provenance fixtures
  (`tests/fixtures/**`) or `.gitattributes`.
- Frame benchmark results as raw-deflate throughput comparisons vs fflate —
  scenario benchmarks only (see the performance instructions).
- Weaken a security default without an explicit human decision recorded in
  the PR.
- Bypass local validation or duplicate checks.
