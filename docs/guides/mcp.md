# zipnative-mcp — AI client integration

> **`zipnative-mcp` 1.0.0 is the MCP server that gives AI assistants the
> zipnative engine as thirteen typed tools** — inspect, list, read,
> verify, extract, scan, sanitise, create, modify, CRC, inflate, describe,
> draft — plus seven prompts and sandboxed file resources, over stdio or
> loopback Streamable HTTP, with no network access, ever. Pins
> `zipnative ^1.0.0`.

[`zipnative-mcp`](https://github.com/Nizoka/zipnative-mcp) exposes the
engine to any client that speaks the
[Model Context Protocol](https://modelcontextprotocol.io) — Claude
Desktop, Claude Code, Cursor, VS Code, Continue, Zed, Windsurf, Cline,
Roo Code, ChatGPT over Streamable HTTP, the MCP Inspector, or anything
built on the MCP SDKs. With it installed you can say to your assistant:

> *"Verify this build artefact, confirm it is reproducible and contains
> no encrypted or unsafe entries, then extract the manifest."*

…and the assistant will call `verify_zip`, `inspect_zip` with its CI
checks, and `read_zip_entry`, reasoning on structured results instead
of prose. The server adds only the MCP SDK and zod to the engine —
three runtime dependencies in total; the engine itself keeps zero.

## Installation

```bash
# Run directly with npx — the recommended form for MCP clients
npx -y zipnative-mcp

# Or install globally
npm install -g zipnative-mcp
zipnative-mcp
```

**Requirements:** Node.js ≥ 22. The published package carries npm
provenance and an MCP registry manifest (`server.json`, name
`io.github.Nizoka/zipnative-mcp`).

## Configuration by client

Every configuration below sets `ZIPNATIVE_MCP_OUTPUT_DIR`. It is
optional — without it the tools work on base64 only — but it is what
enables `zipPath` / `sourcePath` inputs, `outputMode: 'file'` and the
`zipnative://output/` resources.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows), then
restart Claude Desktop:

```json
{
  "mcpServers": {
    "zipnative": {
      "command": "npx",
      "args": ["-y", "zipnative-mcp"],
      "env": { "ZIPNATIVE_MCP_OUTPUT_DIR": "/Users/you/Documents/mcp-archives" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add zipnative --env ZIPNATIVE_MCP_OUTPUT_DIR=/path/to/mcp-archives -- npx -y zipnative-mcp
```

Or commit a project-scoped `.mcp.json` with the same `mcpServers`
shape as Claude Desktop — the zipnative-mcp repository ships one.

### Cursor · Continue · Zed · Windsurf · Cline · Roo Code

Any stdio-capable client takes the same `command` + `args` + `env`
triple. Cursor (`~/.cursor/mcp.json` or the project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "zipnative": {
      "command": "npx",
      "args": ["-y", "zipnative-mcp"],
      "env": { "ZIPNATIVE_MCP_OUTPUT_DIR": "/Users/you/Documents/mcp-archives" }
    }
  }
}
```

### VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "zipnative": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "zipnative-mcp"],
      "env": { "ZIPNATIVE_MCP_OUTPUT_DIR": "${workspaceFolder}/.mcp-archives" }
    }
  }
}
```

### Streamable HTTP (ChatGPT and other HTTP hosts)

```bash
ZIPNATIVE_MCP_PORT=3000 ZIPNATIVE_MCP_HTTP_TOKEN="$(openssl rand -hex 24)" npx -y zipnative-mcp
# → POST http://127.0.0.1:3000/mcp   (Authorization: Bearer <token>)
```

The endpoint binds **loopback only** and accepts `POST /mcp` alone:
`GET` / `DELETE` answer 405, a foreign `Host` / `Origin` answers 403
(DNS-rebinding guard), bodies above 256 MiB answer 413. **Without
`ZIPNATIVE_MCP_HTTP_TOKEN` the endpoint has no authentication** — other
local processes can reach it; with the token, a missing or wrong bearer
answers 401 + `WWW-Authenticate`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ZIPNATIVE_MCP_OUTPUT_DIR` | *(unset)* | The **one** sandbox: `zipPath` / `sourcePath` inputs are read from it, `outputMode: 'file'` / `outputDir` outputs are written under it (exclusive create, never overwritten), and `resources/*` list and read it. The *real* path of every file read and every parent written must stay inside — a planted symlink or junction is `SECURITY_VIOLATION`. Unset ⇒ base64 only |
| `ZIPNATIVE_MCP_CACHE_DIR` | *(unset)* | Opt-in SHA-256-keyed result cache (1 h TTL, 256 MiB LRU, **plaintext at rest**). Never caches path inputs, file output, `defaultDate: 'now'`, `parallel`, `describe_engine` or `draft_governance_issue`; a hit carries `_meta.cached: true` |
| `ZIPNATIVE_MCP_PORT` | *(unset → stdio)* | A port 1–65535 serves Streamable HTTP on `http://127.0.0.1:<port>/mcp` instead of stdio |
| `ZIPNATIVE_MCP_HTTP_TOKEN` | *(unset)* | *(secret)* Bearer token for the HTTP transport — ≥ 16 characters, no whitespace; a weaker value refuses to start. Compared constant-time, never logged |
| `ZIPNATIVE_MCP_MAX_UNCOMPRESSED_BYTES` | `8589934592` (8 GiB) | Operator ceiling for `limits.maxEntryUncompressedSize` and `limits.maxTotalUncompressedSize` (integer ≥ 1024, read once at startup). A per-call value above it is `LIMIT_CEILING_EXCEEDED` |
| `ZIPNATIVE_MCP_MAX_ENTRIES` | `100000` | Operator ceiling for `limits.maxEntries` and `scan_zip_forward.maxEntries` (integer ≥ 1) |
| `ZIPNATIVE_MCP_WORKERS` | `8` | Operator ceiling for `create_zip.parallel.workers`; `0` disables worker threads (integer ≥ 0) |

An invalid ceiling refuses to start with one `[zipnative-mcp] fatal:`
line and exit 1.

## Protocol and transport

- **MCP 2026-07-28** on the MCP TypeScript SDK v2: stateless serving
  (`server/discover`), the `_meta` envelope, cache hints (`tools/list`
  and `prompts/list` public for 24 h, `server/discover` public for 1 h,
  the resource methods private with `ttlMs: 0`), and every
  `structuredContent` validated against the tool's `outputSchema`.
- **Automatic legacy fallback** for clients that open with `initialize`:
  2024-10-07, 2024-11-05, 2025-03-26, 2025-06-18 and 2025-11-25 are
  negotiated on both transports; the `tools/call` payload is identical
  on every path.
- **stdio** raises the SDK's frame cap to 256 MiB so multi-MiB base64
  archives fit in one call; nothing is ever printed to stdout except
  JSON-RPC.
- **Protocol errors** are JSON-RPC errors (`-32602` for an unknown
  tool, resource or prompt), as the specification requires; `isError:
  true` is reserved for execution failures.
- SIGINT / SIGTERM close the server gracefully, exit 0.

## Tool reference

Thirteen tools, in the order `tools/list` returns them. Every
archive-consuming tool takes exactly one of `zipBase64` (the raw archive
as base64, a `data:…;base64,` prefix tolerated, decoded ≤ 128 MiB) or
`zipPath` (a relative path inside the sandbox, container extensions
only — `.zip .jar .war .ear .docx .xlsx .pptx .odt .ods .odp .epub .vsix
.nupkg .whl .apk .ipa .xpi .crx .kmz`; ≤ 1 GiB). Every engine-touching
tool takes `limits` (the eight `ZipLimits` bounds — `maxEntries`,
`maxEntryUncompressedSize`, `maxTotalUncompressedSize`,
`maxCompressionRatio`, `maxNameBytes`, `maxExtraFieldBytes`,
`maxCommentBytes`, `maxCentralDirectoryBytes`; above the operator
ceilings → `LIMIT_CEILING_EXCEEDED`) and `strict` (escalate the first
diagnostic to `ZIP_STRICT_DIAGNOSTIC`). The read tools take `verbosity`
(`'full'` | `'summary'`) and `fields` (≤ 16 dot paths). Every result
carries `diagnostics[]` and `diagnosticCounts` (200 kept after
de-duplication). Tool annotations: the read tools are `readOnlyHint:
true`; every tool is `idempotentHint: true`, `destructiveHint: false`,
`openWorldHint: false`.

| Tool | Purpose |
|---|---|
| `inspect_zip` | One-call forensic report with a determinism verdict and CI assertions (`check`, `assert`) |
| `list_zip_entries` | Paged central-directory inventory with filters and the sanitized path each entry would extract to |
| `read_zip_entry` | One entry by name or index — decompressed, raw, or verified; byte ranges |
| `verify_zip` | The engine's `verifyZip` report verbatim — never fails for an archive problem |
| `extract_zip` | Secure extraction, inline or into the sandbox, with a dry-run plan |
| `scan_zip_forward` | Forward scan of a truncated or streamed archive — explicitly not authoritative |
| `sanitize_entry_paths` | The engine's traversal gate applied to a list of names |
| `create_zip` | A reproducible archive from inline or sandbox entries, optionally parallel or streamed |
| `modify_zip` | Add, replace, remove, rename, comment — append-only or compact, no recompression |
| `compute_crc32` | CRC-32 of inline bytes, text or a sandbox file, seedable |
| `inflate_raw` | Raw DEFLATE decompression under a mandatory output bound |
| `describe_engine` | Offline preflight: versions, tiers, codecs, limits, ceilings, caps, sandbox and cache state, the code registries |
| `draft_governance_issue` | A governance-compliant GitHub issue draft, produced locally for a human to submit |

### `inspect_zip`

Read-only report in one call — the `zipnative inspect --json` shape:
size, entry / file / directory counts, Zip64, comment, compressed vs
uncompressed totals and ratio, per-method counts, encrypted / symlink /
data-descriptor / Zip64 / cp437 / duplicate / unsafe-name counts, date
range, `prependedData` / `multipleEocd`, a `determinism` verdict
(`epochTimestamps`, `canonicalOrder`, `utf8Flags`, `noDataDescriptors`,
`canonicalLayout`, `deterministic`) and every diagnostic. Opens
**eagerly** by default: overlapping entries, entries reaching past EOF
and Zip64 spoofing are refused with their `ZIP_*` code rather than
summarised.

| Input | Type | Default | Notes |
|---|---|---|---|
| `zipBase64` / `zipPath` | string | — | exactly one |
| `validate` | `'eager'` \| `'lazy'` | `'eager'` | `lazy` defers local-header cross-checks to first read |
| `check` | string[] ≤ 15 | — | `deterministic`, `epoch-timestamps`, `canonical-order`, `utf8-names`, `no-data-descriptor`, `canonical-layout`, `no-zip64`, `zip64`, `no-encryption`, `no-symlinks`, `safe-names`, `no-duplicates`, `no-diagnostics`, `store-only`, `deflate-only` |
| `assert` | object | — | `maxEntries`, `minEntries`, `maxUncompressedBytes`, `maxRatio` (≥ 1), `has` (≤ 100 names), `method` (`'store'` \| `'deflate'`) |
| `strict`, `limits`, `verbosity`, `fields` | | | shared |

Outputs the report plus `checks[]` (`{ check, ok, detail }`) and
`checksPassed` when `check` / `assert` was supplied.

```jsonc
{ "zipBase64": "<base64 ZIP>", "check": ["deterministic", "no-encryption", "safe-names"], "assert": { "maxEntries": 5000, "has": ["manifest.json"] }, "verbosity": "summary", "fields": ["checksPassed", "checks"] }
```

### `list_zip_entries`

Every entry (duplicates included) in directory order as a full row —
name and encoding, sizes, ratio, CRC-32, method, timestamp, decoded
flags, Unix mode, symlink, Zip64, data descriptor, host system,
offsets, named extra fields, `sanitizedPath` (`null` = the extraction
gate would refuse it), comment — without decompressing anything.

| Input | Type | Default | Notes |
|---|---|---|---|
| `zipBase64` / `zipPath` | string | — | exactly one |
| `offset` | integer ≥ 0 | `0` | skip this many matching entries |
| `limit` | integer 1–2000 | `200` | `hasMore` tells you to page |
| `filter` | object | — | `names` (≤ 1000 exact), `prefix`, `glob` (≤ 32), `includeDirectories` |
| `includeExtraData` | boolean | `false` | extra-field payloads as base64 |
| `validate` | `'lazy'` \| `'eager'` | `'lazy'` | |
| `strict`, `limits`, `verbosity`, `fields` | | | shared |

```jsonc
{ "zipBase64": "<base64 ZIP>", "filter": { "prefix": "src/", "glob": ["**/*.json"] }, "limit": 50, "fields": ["entries.name", "entries.uncompressedSize", "hasMore"] }
```

### `read_zip_entry`

One entry by `name` (exact; the last duplicate wins) or `index`
(disambiguates duplicates). `mode: 'data'` returns the decompressed
content, CRC-verified, as base64 or UTF-8 text; a `range` reads a byte
window through the chunked stream (no CRC for a window). `mode: 'raw'`
returns the compressed payload verbatim — feed it to `inflate_raw`.
`mode: 'verify'` returns `{ ok, crcMatch, sizeMatch, localHeaderMatch }`
only. Encrypted entries are refused with `ZIP_UNSUPPORTED_ENCRYPTION`.

| Input | Type | Default | Notes |
|---|---|---|---|
| `zipBase64` / `zipPath` | string | — | exactly one |
| `name` / `index` | string / integer ≥ 0 | — | exactly one |
| `mode` | `'data'` \| `'raw'` \| `'verify'` | `'data'` | |
| `encoding` | `'base64'` \| `'utf8'` | `'base64'` | mode `data`; invalid UTF-8 → `ENTRY_NOT_UTF8` |
| `verifyCrc` | boolean | `true` | mode `data` without `range` |
| `range` | `{ offset ≥ 0, length 1–16777216 }` | — | mode `data` only |
| `strict`, `limits`, `verbosity`, `fields` | | | shared |

Inline cap 16 MiB per entry (`ENTRY_TOO_LARGE`, remedy `range` or
`extract_zip` file mode).

```jsonc
{ "zipBase64": "<base64 ZIP>", "name": "META-INF/MANIFEST.MF", "encoding": "utf8" }
```

### `verify_zip`

The engine's `verifyZip` report verbatim: eager structural validation,
then every entry's CRC-32 / size / local-header agreement. **Never
fails for a problem with the archive** — a structural refusal lands in
`error: { code: 'ZIP_*', message }`, an encrypted or stream-only-codec
entry is `skipped`, an entry with no codec here is reported `failed`.
Only caller mistakes are `isError`. Verify before you trust.

| Input | Type | Default | Notes |
|---|---|---|---|
| `zipBase64` / `zipPath` | string | — | exactly one |
| `entries` | `'all'` \| `'failed'` \| `'skipped'` \| `'none'` | `'all'` | which per-entry rows to return |
| `maxEntries` | integer 1–100000 | `1000` | cap on returned rows (`entriesTruncated`); counts cover every entry |
| `limits`, `verbosity`, `fields` | | | shared |

Outputs `ok`, `error`, `entryCount`, `verifiedCount`, `failedCount`,
`skippedCount`, `entries[]`, `entriesTruncated`, `diagnostics[]`.

```jsonc
{ "zipBase64": "<base64 ZIP>", "entries": "failed", "verbosity": "summary" }
```

### `extract_zip`

Extract with every engine guard on unless you name the relaxation:
unsafe names → `ZIP_PATH_TRAVERSAL` (`rejectTraversal: false` *skips*
them — an unsafe path is never emitted), symlinks →
`ZIP_SYMLINK_REJECTED` (`rejectSymlinks: false` extracts the target
text as data, never a link), duplicate sanitized paths →
`ZIP_EXTRACT_DUPLICATE_PATH` (`onDuplicate`), sizes beyond `limits` →
`ZIP_LIMIT_EXCEEDED`; overlapping entries and central / local
divergence are always refused. The archive is opened eagerly before any
plan in both modes.

| Input | Type | Default | Notes |
|---|---|---|---|
| `zipBase64` / `zipPath` | string | — | exactly one |
| `outputMode` | `'base64'` \| `'file'` | `'base64'` | inline ≤ 16 MiB per file, ≤ 32 MiB total; file mode ≤ 4 GiB |
| `outputDir` | string | — | file mode: relative directory inside the sandbox (created, never overwritten) |
| `includeData` | boolean | `true` | base64 mode: `false` = dry run (paths and sizes, nothing decompressed) |
| `filter` | object | — | as `list_zip_entries` |
| `rejectTraversal` | boolean | `true` | `false` skips unsafe names into `skipped[]` |
| `rejectSymlinks` | boolean | `true` | `false` writes the target text as data |
| `onDuplicate` | `'error'` \| `'first'` \| `'last'` | `'error'` | |
| `emptyDirectories` | boolean | `false` | file mode: create explicit empty directory entries |
| `strict`, `limits`, `verbosity`, `fields` | | | shared |

Outputs `mode`, `dryRun`, `fileCount`, `totalBytes`, `entries[]`
(`{ path, entryName, index, sizeBytes, crc32, method, dataBase64? |
filePath? }`), `skipped[]`, `outputDir`, `directoriesCreated`,
`diagnostics[]`; file mode adds up to 50 `resource_link` blocks.

```jsonc
{ "zipBase64": "<base64 ZIP>", "outputMode": "file", "outputDir": "unpacked/report", "filter": { "glob": ["docs/", "*.json"] } }
```

### `scan_zip_forward`

Walk local headers in stream order with bounded memory — the engine's
central-directory-less reader `iterateZipEntries`. The only tool that
works on a truncated archive or a stream cut mid-way, and the only one
whose result is **not authoritative**: forward iteration trusts local
headers alone, so a hostile archive can present different content here
than `inspect_zip` reports. The stream must start at a local header —
an SFX or prepended prefix is refused with `ZIP_SIGNATURE_MISMATCH`
(route such archives to `inspect_zip`; `modify_zip mode: 'compact'`
drops the prefix). Use it for forensics; prefer the authoritative tools
whenever the whole archive is available.

| Input | Type | Default | Notes |
|---|---|---|---|
| `zipBase64` / `zipPath` | string | — | exactly one; a `zipPath` streams from disk without the 1 GiB buffered cap |
| `data` | `'none'` \| `'verify'` \| `'include'` | `'none'` | skip payloads / check CRCs / return content (inline caps) |
| `filter` | object | — | as `list_zip_entries` |
| `maxEntries` | integer ≥ 1 | `10000` | clamped to `ZIPNATIVE_MCP_MAX_ENTRIES` |
| `tolerateTruncation` | boolean | `false` | `true`: a truncated stream ends the scan with `stoppedAt: 'error'` instead of failing |
| `strict`, `limits`, `verbosity`, `fields` | | | shared |

Outputs `trust: 'local-headers-only'`, `entryCount`, `keptCount`,
`entries[]`, `stoppedAt` (`'central-directory'` | `'eof'` |
`'max-entries'` | `'error'`), `truncated`, `inputBytes`,
`bytesDelivered`, `maxEntries`, `error`, `diagnostics[]`.

```jsonc
{ "zipBase64": "<base64 of a truncated download>", "tolerateTruncation": true, "verbosity": "summary" }
```

### `sanitize_entry_paths`

The engine's single traversal gate `sanitizeEntryPath()` over a list of
names: the safe `/`-separated relative form each maps to, or `null` with
the rule that fired (`empty`, `nul`, `absolute`, `drive`, `unc`,
`traversal`, `ads`, `device-name`, `no-segments`). No archive needed —
use it before an external filesystem sink.

| Input | Type | Default | Notes |
|---|---|---|---|
| `names` | string[] 1–10000 | — | each ≤ 4096 characters, as stored in an archive |
| `verbosity`, `fields` | | | projection |

```jsonc
{ "names": ["docs/readme.md", "../../etc/passwd", "C:\\Windows\\win.ini", "aux.txt", "a/./b//c.txt"] }
```

### `create_zip`

Write a ZIP from inline entries (`dataBase64` | `text` | `sourcePath` in
the sandbox, or `directory: true`). Reproducible on one runtime by
default — canonical order, DOS-epoch timestamps, UTF-8 names —
and identical on every runtime under `compression.deterministic: true`
(`summary.deflateTier: 'pure-pinned'`). `order: 'insertion'` keeps call
order for EPUB / JAR; `stream: true` on a `sourcePath` feeds the file
through `addStream` (bounded memory, > 4 GiB refused); `parallel`
compresses with the worker pool, byte-identical. Zip64 is emitted
exactly when a field overflows. Every archive it writes is ISO/IEC
21320-1 conformant.

| Input | Type | Default | Notes |
|---|---|---|---|
| `entries` | array 0–100000 | — | required; per entry `name`, exactly one payload, and optional `compression`, `date`, `comment`, `unixMode` xor `externalAttributes`, `extraFields` (≤ 16), `stream` |
| `order` | `'canonical'` \| `'insertion'` | `'canonical'` | |
| `defaultDate` | string | DOS epoch | ISO-8601 instant or `'now'` (`ZIP_TIMESTAMP_NOT_PINNED` diagnostic) |
| `compression` | object | deflate 6 | `method` (`'store'` \| `'deflate'`), `level` 0–9, `deterministic` |
| `comment` | string ≤ 65535 | — | |
| `chunkSize` | integer 1024–16777216 | 64 KiB | file-mode streaming chunk; never changes the bytes |
| `parallel` | object | — | `workers` 0–64 (≤ `ZIPNATIVE_MCP_WORKERS`), `minWorkerJobSize`, `jobTimeout` 1000–600000 ms |
| `includeSha256` | boolean | `false` | `summary.sha256` — the determinism proof |
| `outputMode` / `outputPath` | | `'base64'` | file mode: a relative path ending in a container extension |
| `strict`, `limits` | | | shared |

Outputs the archive as an embedded `resource` (≤ 50 MiB inline) or a
`resource_link`, plus `summary` (`entryCount`, `fileCount`,
`directoryCount`, `streamedCount`, `uncompressedBytes`, `order`,
`deterministic`, `deflateTier`, `parallel`, `sha256`) and
`diagnostics[]`.

```jsonc
{
  "entries": [
    { "name": "mimetype", "text": "application/epub+zip", "compression": { "method": "store" } },
    { "name": "META-INF/container.xml", "text": "<container/>" },
    { "name": "OEBPS/", "directory": true }
  ],
  "order": "insertion",
  "compression": { "deterministic": true },
  "includeSha256": true
}
```

### `modify_zip`

Edit an existing archive without recompressing anything: `operations`
applied in order. `mode: 'append'` = `save()` — the original bytes stay
verbatim and edits are appended, **but** removed or replaced payloads
remain in the file (data remanence; a `ZIP_DEAD_BYTES_RATIO` diagnostic
fires past 50 % dead bytes; 7-Zip is known to read the stale payload).
`mode: 'compact'` = `saveCompact()` — canonical rewrite, still no
recompression, removed data truly gone, SFX prefix dropped. Archives
with duplicate names are refused.

| Input | Type | Default | Notes |
|---|---|---|---|
| `zipBase64` / `zipPath` | string | — | exactly one |
| `operations` | array 1–1000 | — | `{ op: 'add' \| 'replace', name, payload… }`, `{ op: 'remove', name }`, `{ op: 'rename', from, to }`, `{ op: 'setComment', comment }` |
| `mode` | `'append'` \| `'compact'` | `'append'` | |
| `compression` / `defaultDate` | | engine defaults | for new payloads |
| `includeSha256` | boolean | `false` | |
| `outputMode` / `outputPath` | | `'base64'` | |
| `strict`, `limits` | | | shared |

Outputs the archive plus `summary` (`saveMode`, `operationsApplied`,
`entryCountBefore`, `entryCountAfter`, `inputBytes`, `outputBytes`,
`grewByBytes`, `noOp`, `sha256`).

```jsonc
{ "zipBase64": "<base64 ZIP>", "operations": [{ "op": "remove", "name": ".env" }, { "op": "rename", "from": "config.json", "to": "config/app.json" }], "mode": "compact" }
```

### `compute_crc32`

The ZIP checksum (IEEE CRC-32) of inline bytes, text or a sandbox file
(streamed, ≤ 1 GiB). `seed` continues a running CRC; `expect` compares
against a known value — cross-check an entry's `crc32` from
`list_zip_entries` against a file on disk.

| Input | Type | Default | Notes |
|---|---|---|---|
| `dataBase64` / `text` / `sourcePath` | string | — | exactly one |
| `seed` | integer 0–4294967295 | `0` | |
| `expect` | string | — | 1–8 hex digits, optional `0x` |

Outputs `crc32`, `hex`, `byteLength`, `seed`, `matches`.

```jsonc
{ "text": "hello world", "expect": "0d4a1185" }
```

### `inflate_raw`

Decompress a raw DEFLATE stream — for instance the payload from
`read_zip_entry mode: 'raw'` — through the engine's resumable inflater
under a **mandatory** `maxOutput` bound (`ZIP_INFLATE_OUTPUT_OVERFLOW`
past it). `method: 'store'` is a bounded pass-through; only methods 0
and 8 exist in this server.

| Input | Type | Default | Notes |
|---|---|---|---|
| `dataBase64` / `sourcePath` | string | — | exactly one |
| `maxOutput` | integer ≥ 1 | — | **required**; inline results capped at 50 MiB, file results at 4 GiB |
| `method` | string | `'deflate'` | `'deflate'`, `'store'` or a numeric id |
| `allowTrailing` | boolean | `false` | accept bytes after the stream silently (always reported as `leftover`) |
| `outputMode` / `outputPath` | | `'base64'` | file mode: `.bin .dat .txt .json .xml .md .csv .html .zip .tar .raw` |

```jsonc
{ "dataBase64": "<raw deflate payload>", "maxOutput": 1048576 }
```

### `describe_engine`

Offline preflight, no archive needed: server / engine / tool-API
versions, the deflate tier in use and the pinned deterministic tier,
runtime codecs and worker threads, the codec registry, the engine's
default `limits`, the operator ceilings, every server cap, whether the
sandbox and the cache are enabled, the 39 frozen `ZIP_*` error codes
and 11 diagnostic codes, and the engine exports this server
deliberately does not expose (with why). `network` is always `'none'`.
Never cached.

```jsonc
{ "fields": ["defaultLimits", "ceilings", "caps", "sandbox"] }
```

### `draft_governance_issue`

Draft a governance-compliant GitHub issue **locally** for a human to
review and submit — for `zipnative` or `zipnative-mcp`. The server
never contacts GitHub (it has no network code path); it returns the
draft Markdown and a machine-readable `compliance` report. Present
both, then stop: the human submits under their own identity.

| Input | Type | Default | Notes |
|---|---|---|---|
| `title` | string 8–160 | — | required |
| `summary` | string ≥ 16 | — | required |
| `issueType` | `'bug'` \| `'feature'` \| `'security'` \| `'docs'` \| `'performance'` | — | required |
| `targetRepo` | string | `'zipnative-mcp'` | |
| `reproduction` | `{ command, result }` | — | required |
| `expectedBehavior` | string ≥ 4 | — | required |
| `actualBehavior` | string | the reproduction result | |
| `affectedPackages` | string[] ≤ 16 | `['zipnative-mcp']` | |
| `duplicateSearchPerformed` | boolean | — | required, must be `true` |
| `outputMode` / `outputPath` | `'inline'` \| `'file'` | `'inline'` | file mode writes a relative `.md` inside the sandbox |

A draft that proposes a runtime dependency, omits a reproduction or sets
`duplicateSearchPerformed: false` is `GOVERNANCE_VIOLATION`.

## Prompts

Seven read-only prompts (no arguments) that teach the assistant the
workflows and the rules:

| Prompt | Teaches |
|---|---|
| `secure_extraction` | verify → inspect with checks → extract, guards on; when to relax which one |
| `reproducible_archive` | byte-identical archives with `create_zip` — `deterministic`, pinned dates, `includeSha256` as proof |
| `incremental_update` | `modify_zip` append vs compact, data remanence, the 7-Zip differential |
| `forensic_scan` | when and how to use `scan_zip_forward`, what a local-headers-only result can and cannot tell you |
| `verify_before_trust` | the discipline: never extract what you have not verified |
| `governance_contract` | the human-in-the-loop rules the server enforces |
| `draft_issue_workflow` | how to build a compliant issue draft with `draft_governance_issue` |

## Resources

With `ZIPNATIVE_MCP_OUTPUT_DIR` set, every regular file in the sandbox
is a resource under the `zipnative://output/{+path}` template:
`resources/list` walks the sandbox (≤ 1000 files, depth ≤ 8),
`resources/templates/list` advertises the template, and
`resources/read` returns `{ uri, mimeType, blob }` up to 50 MiB, with
the MIME type chosen by extension. Without a sandbox the list is empty.

## Token-frugal reads

Every read tool accepts `verbosity: 'summary'` (only the scalar summary
fields) and `fields: [...]` (≤ 16 dot paths). When a `fields` entry
matches nothing the result carries `_meta.unmatchedFields` and
`_meta.availableFields` so the assistant can correct itself in one
turn. Archive-producing tools deliver the bytes **once**, as an
embedded `resource` with a `data:` URI (never duplicated into
`structuredContent`); file mode returns a `resource_link` instead.

## Error model

An execution failure is `{ content: [{ type: 'text', text: '<tool>
failed [CODE]: message' }], isError: true, _meta: { error: { code,
message, data? } } }`. Sixteen wrapper codes — `VALIDATION_ERROR`,
`INPUT_TOO_LARGE`, `INPUT_NOT_FOUND`, `ENTRY_TOO_LARGE`,
`ENTRY_NOT_UTF8`, `OUTPUT_TOO_LARGE`, `OUTPUT_EXISTS`, `IO_ERROR`,
`SECURITY_VIOLATION`, `MISSING_OUTPUT_PATH`, `INVALID_PATH`,
`INVALID_EXTENSION`, `LIMIT_CEILING_EXCEEDED`, `UNKNOWN_RESOURCE`,
`GOVERNANCE_VIOLATION`, `ENGINE_ERROR` — sit next to the engine's 39
frozen `ZIP_*` codes, passed through verbatim (`ZIP_PATH_TRAVERSAL`,
`ZIP_LIMIT_EXCEEDED`, `ZIP_UNSUPPORTED_ENCRYPTION`, …), and
`ZIP_STRICT_DIAGNOSTIC` under `strict: true`. `data.remedy` names the
way out where one exists (a `range`, a tool to call first, a ceiling).

## Security model

- **Every archive is untrusted input**, and the engine's guards are on
  by default: zip-slip and device names (CWE-22 / 67), bombs
  (CWE-400 / 409, enforced *while* inflating), symlinks (CWE-59),
  overlapping entries (CWE-405, no opt-out), parser-differential
  smuggling (CWE-436, the central directory is authoritative), Zip64
  spoofing (CWE-1288, no opt-out), duplicate names (CWE-694).
- **The sandbox is the one filesystem boundary** for reads and writes;
  paths must be relative, real paths must stay inside, files are opened
  exclusively, a failed write removes the partial file.
- **Inputs are validated at the boundary** by strict JSON Schemas and
  Zod — unknown or misspelt keys are `VALIDATION_ERROR`.
- **No encryption, ever**: encrypted entries are detected, skipped by
  `verify_zip`, refused by the read paths. There is no password input —
  see [Case 5](use-cases.html#case-5--encrypt-first-then-archive) for
  how confidentiality is delegated to the document layer.
- **No network, ever**: no telemetry, no GitHub, no update check, no URL
  from any argument, no operator-configurable endpoint of any kind.
  `describe_engine` reports `network: 'none'`.

## Further reading

- [MCP playground](../playgrounds/mcp.html) — the thirteen tools with
  their real payloads, most of them executable in your browser against
  the published engine.
- [Choosing your surface](choose.html) · [CLI guide](cli.html) — the
  same engine for scripts and CI.
- [Security model](security.html) · [Errors and error codes](errors.html)
  · [Use cases](use-cases.html).
- The full README, AGENTS.md (with the complete error reference),
  `server.json` and thirty executable JSON examples live in the
  [zipnative-mcp repository](https://github.com/Nizoka/zipnative-mcp).
