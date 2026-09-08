# Choosing your surface

> **Write application code → the library. Drive a shell, Makefile or CI
> job → `zipnative-cli`. Give a conversational AI assistant tool access →
> `zipnative-mcp`.** All three surfaces sit on the same zero-dependency
> engine and write the same ISO/IEC 21320-1-conformant bytes, so the
> choice is about *who is calling*, not about what comes out — and you
> can switch later without re-authoring anything.

## The decision, in prose

**You are writing application code** — a Node, Deno, Bun, browser or
Worker service, a script with logic around the archive. Use the
**library** (`npm install zipnative`). It is the full surface: the lazy
reader, secure extraction, the deterministic writer, the incremental
modifier, forward streaming, worker parallelism, codec injection, and
the 39-code error vocabulary. Everything the other two surfaces do,
they do by calling this package.

**You are driving a shell, a CI pipeline, a container, or a build tool
in another language.** Use the **CLI** (`zipnative-cli`, binary
`zipnative`) — fifteen commands over stdin/stdout pipelines with an
agent-native contract: a `--json` envelope carrying `err.code` verbatim,
thirteen stable `E_*` classes, `--dry-run`, `--summary` / `--fields`
projection, JSON Schemas, shell completion. It is also the **filesystem
trust boundary** the engine refuses to be: `extract` writes files, and
re-checks every name before it does.

**You are (or you are building) a conversational assistant with tool
access** — Claude Desktop, Claude Code, Cursor, VS Code, or any Model
Context Protocol client. Use the **MCP server** (`zipnative-mcp`,
`npx -y zipnative-mcp`) — thirteen tools with strict schemas, seven
prompts, a sandbox for file inputs and outputs, and no network access
of any kind.

## Capability × surface

The same facts in machine-readable form live in
[`docs/data/surfaces.json`](../data/surfaces.json); export, command and
tool names are verified against [`api.json`](../assets/api.json) and
[`ecosystem.json`](../assets/ecosystem.json) by the documentation CI. An
em-dash means the surface genuinely lacks the capability, with the
honest alternative named in the notes below.

| Capability | Library (`zipnative`) | CLI (`zipnative-cli`) | MCP (`zipnative-mcp`) |
|---|---|---|---|
| List entries without extracting | `openZip` → `entries()` | `list` | `list_zip_entries` |
| Forensic report + CI assertions | compose `openZip` + `verifyZip` | `inspect --check …` | `inspect_zip` (`check`, `assert`) |
| Read one entry (random access) | `readEntry` / `readEntryStream` / `readEntryRaw` / `verifyEntry` | `cat` (`--raw`) | `read_zip_entry` (data / raw / verify, ranges) |
| One-call integrity verification | `verifyZip` | `verify` | `verify_zip` |
| Secure extraction (guards on by default) | `extractZip` / `extractZipStream` — in memory | `extract` — to disk, the trust boundary | `extract_zip` — inline or into the sandbox |
| Forward reading of unseekable sources | `iterateZipEntries` | `stream` | `scan_zip_forward` (not authoritative) |
| Entry-path sanitisation | `sanitizeEntryPath` | `extract --dry-run`, `inspect --check safe-names` | `sanitize_entry_paths` |
| Deterministic archive creation | `createZip` (`deterministic: true`) | `create --deterministic` | `create_zip` (`compression.deterministic`) |
| Worker-parallel compression | `createParallelZip` (`zipnative/worker`) | `create --parallel` | `create_zip` (`parallel`) |
| Constant-memory writing | `addStream` + `stream()` | `create --stream`, `--stdin-name` | `create_zip` (`stream: true`, file mode) |
| Incremental modification | `createZipModifier` → `save` / `saveCompact` | `modify` (`--compact`, `--in-place`) | `modify_zip` (`append` / `compact`) |
| CRC-32 | `crc32` | `crc32` | `compute_crc32` |
| Raw DEFLATE decompression (bounded) | `createInflator` | `inflate --max-output` | `inflate_raw` (`maxOutput` required) |
| Custom codecs / codec injection | `registerCodec`, `setDeflateImpl`, `setInflateImpl` | `--codec <module>` (command line only) | — (deliberately: a codec module is arbitrary code) |
| Security bounds (CWE-tagged) | `limits` option, `DEFAULT_ZIP_LIMITS` | the eight `--max-*` flags + `--max-input-size` | `limits` per call on the eight archive tools, under operator ceilings |
| Diagnostics channel / strict mode | `onDiagnostic`, `strict` | `--strict`, diagnostics in the envelope | `strict: true` on seven tools, `diagnostics[]` |
| Capability preflight | `VERSION`, `activeDeflateTier` | `doctor` | `describe_engine` |
| Machine contract (schemas, projection) | `api.json`, `errors.json` | `schema` (22 subjects), `--summary` / `--fields` | `tools/list` schemas, `verbosity` / `fields` |
| AI-governance contract | — (repository policy, `verify:issue`) | `govern` | `draft_governance_issue` + the prompts |
| Filesystem sink | — (by design) | `extract`, `create`, `modify` | `outputMode: 'file'` inside the sandbox, resources |
| Batch pipelines | — (compose the calls) | `batch` (directory or manifest mode) | — (one call per tool; the host orchestrates) |
| Shell completion | — | `completion` | — |
| Configuration file | — (options per call) | `.zipnativerc.json`, `--config` / `--no-config` | — (seven `ZIPNATIVE_MCP_*` variables instead) |
| Response cache | — | — | `ZIPNATIVE_MCP_CACHE_DIR` (opt-in, SHA-256 keyed) |
| Transports | in-process `import` | `--json` envelope over stdin / stdout pipes | stdio, Streamable HTTP (loopback, bearer token) |
| Prompts / guided workflows | — (`recipes/` in the repository) | `govern rules` (the protocol text only) | seven prompts (`prompts/list`) |
| Encryption (read or write) | — | — | — |

## Honest notes

- **No surface encrypts, by policy.** ZipCrypto is broken and AES-in-ZIP
  is not in 1.x; every surface *detects* encrypted entries
  (`entry.isEncrypted`, `ZIP_UNSUPPORTED_ENCRYPTION`) and never
  decrypts. Confidentiality belongs to the document layer — encrypt the
  PDF with pdfnative, the workbook with Office, then archive the
  encrypted files; the archive stays deterministic and verifiable.
  [Case 5](use-cases.html#case-5--encrypt-first-then-archive) shows the
  pattern with a diagram.
- **Only the CLI and the MCP sandbox write files.** The engine returns
  data plus sanitized paths and never touches a filesystem; the CLI
  writes wherever you point it (re-checking every name); the MCP server
  writes only inside `ZIPNATIVE_MCP_OUTPUT_DIR`, never overwriting. If
  you extract with anything else, run the names through
  `sanitizeEntryPath` (or `sanitize_entry_paths`) first.
- **The forward readers are not authoritative** on any surface —
  `iterateZipEntries`, `stream` and `scan_zip_forward` trust local
  headers alone. Prefer the central-directory path whenever the whole
  archive is available.
- **Append-only modification keeps every original byte** on every
  surface: `save()`, `modify` without `--compact`, `modify_zip mode:
  'append'` leave removed content recoverable, and 7-Zip's CLI mis-reads
  that layout. Compact when deletion or 7-Zip interop matters.
- **The table is the complete story** for these capabilities, not a
  sample — where a cell is an em-dash, the surface genuinely lacks the
  capability today rather than hiding it under another name.

## You can switch later

All three surfaces call the same engine, so the artefacts are
interchangeable: an archive built by `create_zip` verifies under
`zipnative verify`, extracts under `extractZip`, and its `sha256` from
`includeSha256` equals the one `create --deterministic` produces from the
same inputs. Inputs travel too — the CLI's `create --from-manifest`, the
MCP `create_zip.entries` and the library's `add()` calls describe the
same entries. Starting on the "wrong" surface costs a call-site
migration, not a re-authoring.

## Further reading

- [Quickstart](quickstart.html) — the library in five minutes.
- [CLI guide](cli.html) · [MCP guide](mcp.html) — the complete
  per-surface references.
- [CLI playground](../playgrounds/cli.html) ·
  [MCP playground](../playgrounds/mcp.html) — try both surfaces in the
  browser.
- [Use cases](use-cases.html) — five production architectures with
  diagrams.
- [Agent brief](../agent-brief.md) — the same decision tree in
  paste-into-context form.
