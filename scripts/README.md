# zipnative scripts

Contributor tooling — all zero-dependency TypeScript, run with `tsx`,
typechecked by `npm run typecheck:scripts` (they need `@types/node`,
which `src/` deliberately does not).

## Quick start

```bash
npm run test:generate   # write the sample corpus to test-output/
npm run test:interop    # both-direction foreign-tool conformance gate
npm run verify:docs     # docs/versions/sample-count integrity (never writes)
npm run fixtures:generate  # (manual) grow the committed foreign-fixture corpus
```

## Sample generation (`test:generate`)

Writes 38 demonstration archives into the **git-ignored `test-output/`**
directory, grouped by feature area, for human inspection with real tools
(Explorer, 7-Zip, unzip, hex editors). Every sample is re-opened with
zipnative's eager reader as it is written — an archive our strictest read
path rejects never lands silently.

```
scripts/
├── generate-samples.ts        driver: static import list + banners
├── helpers/io.ts              GenerateContext, writeSafe (EBUSY-tolerant), summary table
└── generators/                one module per feature area
    ├── attributes.ts          Unix modes, symlink, UT + ux ids, NTFS times (1.1)             (3)
    ├── basic-formats.ts       store / deflate levels / empty / mixed                         (6)
    ├── comments.ts            archive + entry comments                                       (2)
    ├── deterministic.ts       byte-identical pair + SHA in the label                         (2)
    ├── edge-cases.ts          SFX prefix / empty entries / high ratio                        (3)
    ├── forward-trust.ts       the forward reader's trust caveat, demonstrated                (1)
    ├── incremental.ts         -original / -updated / -compacted / merged-from-two (1.1)      (5)
    ├── names-encoding.ts      ascii / utf-8 / deep paths / Shift-JIS legacy (1.1)            (4)
    ├── parallel.ts            worker-pool output, byte-identical to the sequential writer    (2)
    ├── refusals.ts            archives the engine must refuse, with their expected code      (6)
    ├── streaming.ts           data-descriptor entries (bit 3)                                (2)
    └── zip64.ts               66 000-entry zip64 EOCD / streaming opt-in (1.1)               (2)
```

The `incremental/` triple is the modifier's showcase: `-updated.zip`
starts with the byte-identical prefix of `-original.zip` (append-only
save) and still contains the removed payload (data remanence — see
SECURITY.md); `-compacted.zip` is the true-deletion form.

### Adding a new sample category

1. Create `scripts/generators/<area>.ts` exporting exactly
   `export async function generate(ctx: GenerateContext): Promise<void>`
   and writing via `ctx.writeSafe(resolve(ctx.outputDir, '<area>', name), '<area>/<label>', bytes)`.
2. Import and `await` it in `generate-samples.ts` under a banner naming
   the area and the release it landed in.
3. Bump `derived.sampleZips` in `docs/assets/ecosystem.json` (the
   `verify:docs` canary fails on an undeclared surplus), update the tree
   above, run `npm run typecheck:scripts`, then `npx tsx scripts/verify-samples.ts --update`
   so the new archive joins the byte baseline with the release as its `since`
   (justify the rebaseline in the release note).

## Other scripts

- `run-interop.ts` — the conformance gate (blocking in CI): foreign
  producers → zipnative reads; zipnative's archive matrix → foreign
  extractors validate/byte-compare.
- `generate-fixtures.ts` — manual growth of the committed
  foreign-provenance corpus (`tests/fixtures/interop/` + provenance
  ledger). Never run in CI.
- `verify-docs.ts` — named-rule docs integrity (`path:line [rule] message`),
  `--online`/`--strict`/`--json`; `--rules` lists the catalogue; read-only.
- `verify-samples.ts` — SHA-256 baseline of the sample corpus (`--update`
  rebaselines, `--strict` fails on untracked samples, `--json`).
- `release-prepare.ts` — the version bump in one pass (`--version X.Y.Z`,
  `--dry-run`); see CONTRIBUTING.md § Release.
- `run-compat.ts` — `compat:previous`: the previous release's test suite
  (`git archive <tag>`) against the current `src/`, minus the exclusions in
  `tests/compat/allow-<version>.json`; `--list` prints them.
- `gate.ts` — the CI/publish gate runner (`--fast`, `--ci`, `--publish`,
  `--require-all`, `--only`, `--from`, `--json`).
- `build-claude-rules.ts` — renders `.claude/rules/` from
  `.github/instructions/` (`npm run agents:rules`).
- `verify-issue.mjs` — AI-governance draft validator (see .github/AGENT_RULES.md).
