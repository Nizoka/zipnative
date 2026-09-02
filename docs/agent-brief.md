# zipnative — agent brief

A compact briefing for AI agents writing code with zipnative. Paste this
into a coding agent's context; the full ladder (guides, registries, sizes)
is indexed in [llms-index.json](llms-index.json) so you can decide what to
fetch before spending the tokens.

## What it is

Zero-runtime-dependency ZIP engine in pure TypeScript. One entry point —
`import { … } from 'zipnative'` (plus `zipnative/worker` for parallel
creation); everything public is exported there, nothing else is API. No
classes: factories return interfaces. Node ≥ 22, browsers, Deno, Bun,
Workers. The engine never touches the filesystem, never opens a socket,
never evals. 1.0: the 77-export surface, the 39-code error vocabulary and
the `deterministic: true` output bytes are frozen under semver.

## The core API

```ts
import { openZip, extractZip, verifyZip, createZip, createZipModifier, iterateZipEntries } from 'zipnative';

const reader = openZip(bytes);              // lazy CD walk, random access
const data = reader.readEntry('a.txt');     // CRC-verified, zero-copy source
const files = extractZip(bytes);            // in-memory, guards ON by default
const report = verifyZip(bytes);            // never throws for archive problems
const zip = createZip({ compression: { deterministic: true } }); // same SHA-256 everywhere
const mod = createZipModifier(openZip(bytes)); // edit without recompressing
for await (const e of iterateZipEntries(stream)) { /* unseekable sources */ }
```

## What agents get wrong (verified pitfalls)

- **Branch on `err.code`, never on message text.** Every thrown error
  carries a frozen machine-readable code (`ZIP_PATH_TRAVERSAL`,
  `ZIP_LIMIT_EXCEEDED`, …). Registry: [data/errors.json](data/errors.json).
- **`verifyZip` never throws for archive problems** — structural refusals
  land in `report.error`; encrypted/stream-only-codec entries are reported
  as `skipped`, never faked as corruption. Only caller bugs (invalid
  limits) throw.
- **`removeEntry` + `save()` does NOT erase content** — the append-only
  save keeps every original byte (data remanence). `saveCompact()` is the
  deletion path.
- **Forward iteration trusts local headers alone** — no central-directory
  cross-check. Prefer `openZip()` whenever the whole archive is available;
  never feed forward-read names to a filesystem without
  `sanitizeEntryPath()`.
- **Extraction is safe by default** — zip-slip, symlinks, duplicates,
  bombs and Windows device names are refused unless explicitly configured.
  A POSIX archive containing `aux.h` throws by default; opt out with
  `rejectTraversal: false`.
- **Determinism is opt-in per contract** — `deterministic: true` pins the
  pure-TS encoder (identical SHA-256 on every runtime); the default tier
  is byte-stable per environment only.
- **`addStream` > 4 GiB is a typed refusal** (`ZIP_UNSUPPORTED_ZIP64_STREAMING`)
  — buffer via `add()`; buffered entries and counts are fully Zip64.

## Verify your own output

Round-trip what you build: `openZip(bytes, { validate: 'eager' })` or one
call to `verifyZip(bytes)` gives a machine-readable verdict. Every archive
zipnative writes conforms to ISO/IEC 21320-1:2015, validated clause by
clause by the blocking `npm run validate:zip` gate — see the
[conformance guide](guides/conformance.html).

## Where to read more

- [llms.txt](llms.txt) — the documentation entry point (~1.7k tokens)
- [assets/api.json](assets/api.json) — all 77 exports with signatures
- [data/errors.json](data/errors.json) — the frozen error registry
- Guides: [quickstart](guides/quickstart.html) ·
  [security](guides/security.html) · [determinism](guides/determinism.html) ·
  [errors](guides/errors.html) · [use cases](guides/use-cases.html) ·
  [conformance](guides/conformance.html)
- Governance: agents draft, humans perform GitHub writes
  (`.github/ai-governance.json`).
