# AGENTS.md — zipnative agent guide

Condensed, editor-agnostic entry point for AI agents and new contributors.
The exhaustive rules live in `.github/copilot-instructions.md` and the
per-domain files in `.github/instructions/`.

## TL;DR

zipnative is a **zero-runtime-dependency, pure-TypeScript ZIP engine**:
random access, secure-by-default extraction, streaming, deterministic output,
incremental modification. Sibling of pdfnative — same doctrine, same shape.

## Commands

```bash
npm ci                    # install (dev deps only)
npm run typecheck:all     # tsc over src + tests + scripts
npm run lint              # eslint src/
npm run test              # vitest run
npm run test:coverage     # with v8 coverage thresholds
npm run build             # tsup → dist (esm+cjs+dts)
npm run check:package     # build + attw + publint
npm run test:interop      # foreign-tool conformance matrix
npm run test:generate     # sample corpus → test-output/ (git-ignored)
npm run bench             # vitest bench (bench/)
```

## Conventions

- **No `any`. No classes** (only `Error` subclasses in `src/types/zip-errors.ts`).
  No module-level side effects. `"sideEffects": false` is a promise.
- Public objects are **interfaces returned by closure factories**
  (`openZip() → ZipReader`); state lives in closed-over `Map`s.
- `verbNoun` functions, `PascalCase` types, `UPPER_SNAKE` constants,
  `_prefixed` internals. Options object last: `fn(data, options?)`.
  Option types live in the module that owns them; never invent a parallel
  option shape for a concept that already has one.
- Explicit return types on every export. `export type {}` for types.
- Errors: message starts `zipnative: ` and **names the remedy**. Typed
  subclasses only where callers must branch.
- Diagnostics (non-fatal conformance concerns) go through
  `src/core/zip-diagnostics.ts` — the ONLY module allowed to call
  `console.warn`. Parser failures throw; conformance concerns diagnose;
  never mix the two.
- Every untrusted-input loop consults a named, CWE-tagged bound from
  `src/core/zip-limits.ts`. New loop ⇒ new named limit, documented in
  SECURITY.md in the same PR.
- Validate early — before any I/O or allocation.

## Architecture (dependency flow)

```
types/  ◄─ codecs/ ◄─ core/ ◄─ parser/ ◄─ worker/
```

- `types/` — leaf: shared types + Error classes. Imports nothing.
- `codecs/` — CRC-32, inflate/deflate facades, codec registry. Needs a
  diagnostic emitter? It is *passed in* as a parameter, never imported.
- `core/` — records/structs, encoding, limits, diagnostics, the shared
  segment generator, builder + stream writer.
- `parser/` — EOCD/CD/reader/extract/modifier on top of everything.
- **Sanctioned reverse edges: NONE.** Adding one requires updating this
  file first, in its own reviewed commit.

## Where to read before changing X

| X | Read first |
|---|---|
| Any parser loop / new record type | `.github/instructions/security.instructions.md`, `src/core/zip-limits.ts` |
| Public API surface | `.github/instructions/api-design.instructions.md`, `src/index.ts` export categories |
| Name decoding, paths | `src/core/zip-encoding.ts` (traversal rules are security-critical) |
| Zip64 anything | `src/parser/zip-eocd.ts` header comment (sentinel/cross-check policy) |
| Codecs, compression tiers | `src/codecs/inflate.ts` (tier order + memoization pattern) |
| Tests / fixtures | `.github/instructions/testing.instructions.md`, `tests/fixtures/README.md` |
| Determinism (M2+) | `docs/guides/determinism.md` — bytes under `deterministic: true` are a frozen contract |

## Files to never touch without explicit instruction

- `tests/fixtures/**` committed binaries (foreign provenance — regenerating
  them locally destroys the point)
- `.gitattributes` (protects those binaries from CRLF corruption)
- SHA pins in `.github/workflows/*.yml` (Dependabot owns bumps)

## What zipnative will NOT do

No encryption through 1.0 (detect + typed error only). No other archive
formats or built-in exotic codecs. No multi-disk. No filesystem I/O in the
engine. No archive repair. No sockets, no eval — ever. No runtime
dependencies — a PR or AI draft proposing one fails review mechanically
(`npm run verify:issue`).

## Ecosystem context

`zipnative` (this repo, core) → satellites post-1.0: `zipnative-cli`,
`zipnative-mcp`, each in its own repo pinning `zipnative ^x.y.0`. The core
stays dependency-free by exiling integrations there. Cross-repo version
facts live in `docs/assets/ecosystem.json` (single source of truth).

## AI governance

Human-in-the-loop: agents are draftsmen, humans merge. Autonomous GitHub
writes are not allowed. Issue drafts go to `.github/drafts/` and must pass
`npm run verify:issue`. See `.github/AGENT_RULES.md` + `.github/ai-governance.json`.

## Versioning

SemVer + Conventional Commits. Manual version bumps, Keep-a-Changelog
CHANGELOG.md, one `release-notes/vX.Y.Z.md` per release (Security section
first, mandatory "Downstream integration notes"). `CITATION.cff` version
stays in sync with `package.json`.
