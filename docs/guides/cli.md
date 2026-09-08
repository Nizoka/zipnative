# zipnative-cli — Command-line reference

> **`zipnative-cli` 1.0.0 is the official command-line interface for the
> zipnative engine** — fifteen commands over stdin/stdout pipelines, an
> agent-native automation contract (a `--json` envelope carrying the
> engine's `err.code` verbatim, `--dry-run`, `--summary` / `--fields`
> projection, JSON Schemas), and the one job the engine refuses by design:
> writing to the filesystem. Offline, always. Pins `zipnative ^1.0.0`.

[`zipnative-cli`](https://github.com/Nizoka/zipnative-cli) is a pure
dispatch layer over [`zipnative`](https://github.com/Nizoka/zipnative):
no ZIP logic lives in the CLI, every command forwards to a public engine
API, and the engine's guarantees — safe-by-default extraction,
deterministic bytes, the frozen 39-code error vocabulary — arrive
unchanged. What the CLI *adds* is the process boundary the engine
deliberately lacks: files, directories, pipes, exit codes, shell
completion, and a JSON contract that agents and CI can drive without
parsing prose.

| Command | Engine API behind it |
|---|---|
| `create` | `createZip()` / `createParallelZip()` (`zipnative/worker`) — `add`, `addDirectory`, `addStream`, `toBytes` / `stream` |
| `modify` | `createZipModifier(openZip(bytes))` — `save()` (append-only) / `saveCompact()` |
| `list` | `openZip()` → `entries()` |
| `inspect` | `openZip({ validate: 'eager' })` → entries, flags, diagnostics; the `--check` assertions are CLI logic over engine facts |
| `cat` | `openZip()` → `readEntryStream()` / `readEntryRaw()` |
| `extract` | `extractZipStream()` (default) / `extractZip()` (`--buffered`) + `sanitizeEntryPath()` re-checked at the sink |
| `stream` | `iterateZipEntries()` — local headers only |
| `verify` | `verifyZip()` verbatim; with `--entry`, `openZip({ validate: 'eager' })` → `verifyEntry()` per name |
| `crc32` | `crc32()` |
| `inflate` | `createInflator()` (or a registered codec) |
| `batch` | the commands above, orchestrated |
| `doctor` | `VERSION`, `activeDeflateTier()`, `getCodec()`, `DEFAULT_ZIP_LIMITS` + runtime probes |
| `schema` | — (the CLI's own JSON Schemas, Draft 2020-12) |
| `completion` | — (generated from the same command table as `--help`) |
| `govern` | — (the AI-governance contract, `.github/ai-governance.json`) |

## Installation

```bash
# Run directly with npx — no global install required
npx zipnative-cli list archive.zip

# Or install globally: the binary is called `zipnative`
npm install --global zipnative-cli
zipnative list archive.zip
```

**Requirements:** Node.js ≥ 22. The package has exactly one runtime
dependency, `zipnative ^1.0.0`, ships as a single CommonJS binary, and is
published with npm provenance — verify the artefact with
`npm audit signatures`. Every command runs **offline**: no command can
open a socket.

## When to use the CLI

| Use the **CLI** when… | Use the **library** when… | Use the **MCP server** when… |
|---|---|---|
| You write shell scripts, Makefiles or CI jobs | You build a Node, Bun, Deno, browser or Worker service | A conversational assistant needs archive tools |
| Archives live on disk or arrive through a pipe | Archives live in memory or in a stream you control | Archives arrive as base64 or in a sandbox directory |
| You want exit codes, `--dry-run` and a JSON envelope | You want the full API — random access, modifiers, codecs | You want typed tools with schemas and prompts |

The three surfaces share one engine, so the artefacts are
interchangeable; the [choosing guide](choose.html) holds the full
capability × surface matrix.

## Quick start

```bash
# A reproducible archive: identical SHA-256 on every runtime
zipnative create src/ docs/ --output release.zip --deterministic

# Inventory without decompressing a byte
zipnative list release.zip --format json | jq '.entries[].name'

# A CI gate: fail (exit 1, E_CHECK_FAILED) unless every assertion holds
zipnative inspect release.zip --check deterministic,no-encryption,safe-names,max-entries=1000

# Extract behind the default guards — zip-slip, symlinks, bombs, duplicates refused
zipnative extract --input release.zip --output-dir ./out

# Integrity in one call (never fails for an archive problem — it reports)
zipnative verify release.zip --json
```

## The agent contract

The CLI is designed to be driven by programs — CI runners, coding
agents, other languages — without parsing prose.

- **stdout is the artefact, stderr is the channel.** Archive bytes,
  entry bytes, reports, schemas and scripts go to stdout. Diagnostics,
  progress and — under `--json` — the status or error **envelope** go to
  stderr, as the last line that starts with `{`. `batch` is the one
  exception: its JSON report *is* the stdout document.
- **Stable error codes.** Every failure is one of 13 `E_*` classes
  (`E_USAGE` exit 2; `E_INPUT`, `E_PARSE`, `E_IO`, `E_SECURITY`,
  `E_DATA`, `E_LIMIT`, `E_UNSUPPORTED`, `E_NOT_FOUND`,
  `E_VERIFY_FAILED`, `E_CHECK_FAILED`, `E_POLICY`, `E_RUNTIME` exit 1)
  and the envelope carries the engine's `ZIP_*` code verbatim as
  `zipCode`, the entry name when one is involved, a `detail` object and
  a `remedy` string. Branch on the codes, never on message text.
- **Exit codes:** `0` success (also a closed pipe), `1` any `E_*` class
  but usage, `2` usage error, `130` / `143` interrupted by SIGINT /
  SIGTERM (only the file being written is removed; finished outputs
  stay).
- **`--dry-run`** on `create`, `extract`, `modify`, `stream`, `cat`,
  `inflate` and `batch` validates and prints the plan, writing nothing.
- **Token economy:** `--summary` returns a minimal verdict and
  `--fields a,b.c` projects dot paths, on `list`, `inspect`, `verify`,
  `stream` and `batch`.
- **Schemas:** `zipnative schema <subject>` prints a JSON Schema
  (Draft 2020-12) for every input and output shape, and
  `zipnative schema manifest` the capability manifest — commands, flags,
  codes, limits — that this page and the [CLI playground](../playgrounds/cli.html)
  are checked against.
- **Config:** `.zipnativerc.json` is discovered upward from the working
  directory (global keys plus command-scoped sections; explicit flags win).
  Unattended runs should pass `--no-config` or `--config <file>`. The
  `codec` key is refused from any config file — a codec module executes
  code.
- **Parsing rules:** flags and positionals are order-independent; a
  boolean flag never consumes the next token; `--flag=false|0|no|off` is
  the explicit off form; a lone `-` means stdin or stdout; combined short
  flags (`-lq`) are refused. Short aliases taking a value: `-i`, `-o`,
  `-d`, `-e`, `-f`; boolean: `-q`, `-h`, `-V`.

A status envelope and an error envelope, as an agent sees them. The
error `message` is the CLI's short context, a colon, then the engine's
own message verbatim; `remedy` is the exact string from the remedy table
below (message wording is not a contract — the codes and `remedy` are):

```json
{"ok":true,"command":"create","dryRun":false,"output":"release.zip","entries":42,"files":40,"directories":2,"bytes":183044,"bytesIn":611203,"method":"deflate","level":6,"deterministic":true,"tier":"pure-pinned","order":"canonical","stream":false,"layout":"buffered","parallel":false,"skipped":[],"diagnostics":[]}
{"ok":false,"command":"extract","error":{"code":"E_SECURITY","message":"Failed to extract: zipnative: entry name '../../etc/passwd' escapes the extraction root (zip-slip, CWE-22) — this archive is hostile or corrupt; pass rejectTraversal: false to skip such entries instead","zipCode":"ZIP_PATH_TRAVERSAL","entryName":"../../etc/passwd","remedy":"--skip-unsafe (extract, stream)"}}
```

Without `--json` the same failure prints the message line and then a
`remedy: …` line on stderr, with the same text.

### Refused combinations (exit 2, `E_USAGE`)

Usage errors are detected **before any I/O**, so a refused combination
never leaves a partial file behind. Beyond the obvious (an unknown flag,
a malformed value, a missing required flag), the CLI refuses:

| Command | Refused |
|---|---|
| `create` | `--from-manifest` together with input paths or `--stdin-name`; no input at all; `--stdin-name` together with a `-` input path (stdin is consumed once); `--workers` / `--min-job-size` / `--job-timeout` without `--parallel`; `--chunk-size` without `--stream` or `--stdin-name`; `--parallel` under `--pure-codecs` unless `--deterministic` is also given (the worker bundle resolves `node:zlib` itself); `--parallel` with a `--codec` module that registers method 0 / 8, or exports `deflateImpl` without `--deterministic`; `--entry-comment` without `=`, or naming an entry that is not in the archive; `--comment` with `--comment-file` |
| `modify` | no `--input`; no edit at all (at least one of `--add`, `--replace`, `--remove`, `--rename`, `--add-dir`, `--comment`, `--comment-file`, `--from-manifest`); `--from-manifest` together with any edit flag or comment flag; `--in-place` with `--output`; `--in-place` when the input is stdin; stdin named twice (`--input -` plus a `-` payload, or two `-` payloads) |
| `extract` | no `--output-dir`; `--allow-symlinks` with `--skip-symlinks` |
| `stream` | `--output-dir` with `--cat`; `--preserve-mode`, `--allow-symlinks` or `--skip-symlinks` at all (no central directory to read attributes from) |
| `cat` | no `--input`; no entry name |
| `inflate` | `--max-output 0`; a `--method` that is not `deflate`, `store` or a number |
| `batch` | `--manifest` with `--input-dir` / `--output-dir`; neither `--manifest` nor `--input-dir`; `--task create` without `--output-dir`; `--concurrency` outside 1–64 |
| `govern` | `verify-issue` without a draft path |
| `completion` | a shell other than `bash`, `zsh`, `fish`, `powershell` (`pwsh` is accepted as an alias) |
| global | any `--max-*` bound set to `0` (use `none` to disable); a `.zipnativerc.json` that sets `codec`; `--config` naming a file that does not exist; combined short flags (`-lq`) |

`--config` together with `--no-config` is **not** refused: `--no-config`
wins and the named file is never read.

## Error classes, codes and remedies

The engine's 39 frozen `ZIP_*` codes map to the CLI's `E_*` classes by
a fixed table (`zipnative schema errors` prints it; a core release that
added a code would fail the CLI's own type-check rather than leak as
`E_RUNTIME`). Grouped by class:

| Class (exit) | `ZIP_*` codes |
|---|---|
| `E_USAGE` (2) | `ZIP_INVALID_OPTION`, `ZIP_LIMIT_INVALID` |
| `E_PARSE` (1) | `ZIP_EOCD_NOT_FOUND`, `ZIP_EOCD_INCONSISTENT`, `ZIP_ZIP64_LOCATOR_MISSING`, `ZIP_ZIP64_EOCD_MISPLACED`, `ZIP_CD_INCONSISTENT`, `ZIP_RECORD_TRUNCATED`, `ZIP_SIGNATURE_MISMATCH`, `ZIP_STREAM_TRUNCATED`, `ZIP_VALUE_UNREPRESENTABLE`, `ZIP_DEFLATE_TRUNCATED`, `ZIP_DEFLATE_CORRUPT` |
| `E_INPUT` (1) | `ZIP_ENTRY_EXISTS`, `ZIP_INVALID_ENTRY_NAME`, `ZIP_DUPLICATE_ENTRY_NAME` |
| `E_SECURITY` (1) | `ZIP_ENTRY_OVERLAP`, `ZIP_CD_LFH_MISMATCH`, `ZIP_ZIP64_CONTRADICTION`, `ZIP_PATH_TRAVERSAL`, `ZIP_SYMLINK_REJECTED`, `ZIP_EXTRACT_DUPLICATE_PATH` |
| `E_DATA` (1) | `ZIP_CRC_MISMATCH`, `ZIP_SIZE_MISMATCH`, `ZIP_INFLATE_OUTPUT_OVERFLOW`, `ZIP_DESCRIPTOR_MISMATCH`, `ZIP_DECOMPRESSION_FAILED` |
| `E_LIMIT` (1) | `ZIP_LIMIT_EXCEEDED`, `ZIP_INPUT_TOO_LARGE` |
| `E_UNSUPPORTED` (1) | `ZIP_UNSUPPORTED_ENCRYPTION`, `ZIP_UNSUPPORTED_METHOD`, `ZIP_UNSUPPORTED_MULTI_DISK`, `ZIP_UNSUPPORTED_ZIP64_STREAMING`, `ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR`, `ZIP_UNSUPPORTED_CODEC_MODE` |
| `E_NOT_FOUND` (1) | `ZIP_ENTRY_NOT_FOUND` |
| `E_CHECK_FAILED` (1) | `ZIP_STRICT_DIAGNOSTIC` |
| `E_RUNTIME` (1) | `ZIP_API_MISUSE`, `ZIP_INTERNAL` |

`E_IO`, `E_VERIFY_FAILED` and `E_POLICY` carry no `ZIP_*` code: they are
the CLI's own (a filesystem error, a `verify` verdict, a governance
violation). A `node:zlib` failure on the sync path is mapped to the same
codes the pure tier would raise (`Z_DATA_ERROR` → `ZIP_DEFLATE_CORRUPT`,
`Z_BUF_ERROR` → `ZIP_DEFLATE_TRUNCATED`), so the class never depends on
the codec tier.

**Remedies.** The engine's messages name library options that do not
exist on a command line, so the envelope adds `remedy` — the flag or
command that lifts the refusal. The table is fixed; a code absent from
it has no remedy (structural refusals, corrupt data, usage errors). One
exception: a `ZIP_LIMIT_EXCEEDED` names its bound, and the remedy is
then the exact flag, `--max-<bound> <value> (raise the bound for trusted
input only; "none" disables it)`.

| `zipCode` | `remedy` |
|---|---|
| `ZIP_PATH_TRAVERSAL` | `--skip-unsafe (extract, stream)` |
| `ZIP_SYMLINK_REJECTED` | `--allow-symlinks (target text as data) \| --skip-symlinks (extract)` |
| `ZIP_EXTRACT_DUPLICATE_PATH` | `--on-duplicate first\|last (extract, stream)` |
| `ZIP_LIMIT_EXCEEDED` | `--max-<bound> <size> (the bound is named in detail.limit; trusted input only)` |
| `ZIP_UNSUPPORTED_ENCRYPTION` | `--skip-unsupported (extract, stream); no password support in 1.x` |
| `ZIP_UNSUPPORTED_METHOD` | `--codec <module> \| --skip-unsupported (extract, stream)` |
| `ZIP_UNSUPPORTED_CODEC_MODE` | `cat / extract --codec <module> on the complete file` |
| `ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR` | `cat / extract on the complete file (random access)` |
| `ZIP_UNSUPPORTED_ZIP64_STREAMING` | `create without --stream (buffered entries are fully Zip64)` |
| `ZIP_ENTRY_NOT_FOUND` | `zipnative list <archive> (names are case-sensitive)` |
| `ZIP_ENTRY_EXISTS` | `modify --replace <name>=<path>` |
| `ZIP_STRICT_DIAGNOSTIC` | `drop --strict, or fix the producer named by the diagnostic` |
| `ZIP_INVALID_ENTRY_NAME` | `a plain relative name (no .., no drive, no device name)` |
| `ZIP_DUPLICATE_ENTRY_NAME` | `unique entry names` |

**Diagnostics.** The engine's eleven diagnostic codes are informational
— they ride in the envelope's `diagnostics[]` and are never thrown
unless `--strict` (when the first one becomes `E_CHECK_FAILED`, or
`E_VERIFY_FAILED` under `verify`): `ZIP_PREPENDED_DATA`,
`ZIP_MULTIPLE_EOCD`, `ZIP_NAME_MISMATCH`, `ZIP_UNICODE_PATH_CONFLICT`,
`ZIP_INVALID_UTF8_NAME`, `ZIP_DUPLICATE_NAME`,
`ZIP_EXTRA_FIELD_MALFORMED`, `ZIP_ZIP64_EXTRA_IGNORED`,
`ZIP_TIMESTAMP_NOT_PINNED`, `ZIP_NONDETERMINISTIC_CODEC`,
`ZIP_DEAD_BYTES_RATIO`. The [errors guide](errors.html) explains each
code and each diagnostic.

## Command reference

Fifteen commands in four groups. Every command accepts the
[global options](#global-options); the tables below list the
command-specific flags.

### Create & modify

#### `zipnative create`

Build a deterministic ZIP from files, directories, stdin or a manifest.

```bash
zipnative create [<path>...] --output <out.zip> [options]
zipnative create --from-manifest <entries.json> -o <out.zip>
cat file | zipnative create --stdin-name <name> -o <out.zip>
```

| Flag | Default | Description |
|---|---|---|
| `<path>...` / `--input`, `-i` | — | Files and directories (directories walked recursively); `--input` is repeatable |
| `--stdin-name <n>` | — | Read stdin as one entry named `<n>` |
| `--from-manifest <f>` | — | JSON manifest (`zipnative schema create-manifest`) |
| `--output`, `-o` | stdout | Output path |
| `--overwrite` | refuse (`E_IO`) | Replace an existing output file |
| `--base <dir>` | each input's parent | Entry names relative to `<dir>` |
| `--prefix <dir/>` | — | Prepend to every entry name |
| `--dir-entries` | off | Emit explicit directory entries (keeps empty directories) |
| `--include <glob>` / `--exclude <glob>` | — | Keep / drop matching names (repeatable; `*`, `**`, `?`) |
| `--follow-symlinks` | skipped with a warning | Dereference symlinks — symlink entries are never written |
| `--method store\|deflate` | `deflate` | Compression method |
| `--level 0-9` | `6` | Deflate level |
| `--deterministic` | off | Pin the pure-TS encoder: identical SHA-256 on every runtime (`tier: "pure-pinned"`) |
| `--order canonical\|insertion` | `canonical` | Entry order; `insertion` keeps argv order (an EPUB `mimetype` first) |
| `--date epoch\|now\|<ISO>` | `epoch` | Entry timestamp; an ISO date is UTC wall-clock (range 1980–2107, 2-second resolution) |
| `--mtime` | off | Use each file's modification time (local time, non-reproducible) |
| `--comment <text>` / `--comment-file <path>` | — | Archive comment (text, or raw bytes from a file, `-` = stdin; exclusive; ≤ 65 535 bytes) |
| `--entry-comment <name>=<text>` | — | Per-entry comment (repeatable) |
| `--preserve-mode` | off | Store POSIX mode bits (never setuid / setgid / sticky) |
| `--store-ext png,jpg,zip` | — | Store (no deflate) entries with these extensions — matched by file extension, so an extensionless EPUB `mimetype` is not caught; give it `"method": "store"` in a `--from-manifest` entry |
| `--stream` | off | Constant-memory writer, data-descriptor layout; entries > 4 GiB refused (`ZIP_UNSUPPORTED_ZIP64_STREAMING`) |
| `--chunk-size <size>` | `65536` | Output chunk size for the chunked writer (`--stream` or `--stdin-name`) |
| `--parallel` | off | Deflate across a worker pool (`zipnative/worker`), byte-identical per tier. Refused (exit 2) under `--pure-codecs` unless `--deterministic` is also given, and with a `--codec` module that registers method 0 / 8 or exports `deflateImpl` without `--deterministic` — the workers never see the module |
| `--workers <n>` | cores − 1, max 8 | Worker count, a non-negative integer (`0` = main thread); requires `--parallel` |
| `--min-job-size <size>` | `32k` | Minimum entry size sent to a worker; requires `--parallel` |
| `--job-timeout <ms>` | `60000` | Per-job cap (a positive integer) before inline fallback; requires `--parallel` |

The status envelope reports `entries`, `files`, `directories`, `bytes`,
`bytesIn`, `method`, `level`, `deterministic`, `tier`, `order`, `stream`,
`layout`, `parallel`, `skipped` and `diagnostics`. A `--stream` archive is
reproducible but not *canonical* (data descriptors) — `inspect --check
canonical-layout` tells the two apart.

#### `zipnative modify`

Incremental edits without recompressing untouched entries.

```bash
zipnative modify --input <a.zip> --output <b.zip> [edits] [--compact]
zipnative modify --input <a.zip> --in-place [edits]
zipnative modify --input <a.zip> -o <b.zip> --from-manifest <edits.json>
```

| Flag | Default | Description |
|---|---|---|
| `--input`, `-i` | — | Source archive |
| `--output`, `-o` | stdout | Output path |
| `--overwrite` | refuse (`E_IO`) | Replace an existing `--output` file |
| `--remove <name>` | — | Remove an entry (repeatable) |
| `--rename <from>=<to>` | — | Rename an entry (repeatable; never overwrites implicitly) |
| `--replace <name>=<path>` | — | Replace an entry's content (repeatable; `-` = stdin) |
| `--add <name>=<path>` | — | Add an entry (repeatable; a bare `<path>` uses its basename) |
| `--add-dir <name>` | — | Add an explicit directory entry (repeatable) |
| `--comment <text>` / `--comment-file <path>` | — | Set the archive comment (`""` clears; raw bytes from a file, `-` = stdin; exclusive) |
| `--from-manifest <f>` | — | JSON edits (`zipnative schema modify-manifest`) |
| `--method` / `--level` / `--deterministic` | engine defaults | Compression for **new** payloads |
| `--date epoch\|now\|<ISO>` | `epoch` | Timestamp for new payloads |
| `--compact` | off | Canonical rewrite (`saveCompact()`): removed data truly gone, still no recompression |
| `--in-place` | off | Write back to the input path (exclusive temp file + atomic rename) |

Edits apply in a fixed order regardless of argv order: remove → rename →
replace → add / add-dir → comment. The default save is **append-only**:
original bytes verbatim, edits appended, a new central directory —
removed or replaced content **remains recoverable** (data remanence), and
7-Zip's CLI is known to mis-read this layout. Pass `--compact` when either
matters. Every untouched entry is verified (CRC-32, sizes, local header
against central directory) before it is re-emitted; a lying record is
refused with `E_DATA` / `E_SECURITY` and the entry name. Encrypted
entries are copied as-is and counted in `verifySkipped`.

### Read & extract

#### `zipnative list`

List archive entries without decompressing anything.

```bash
zipnative list --input <a.zip> [options]
zipnative list <a.zip> --format ndjson --include '**/*.json'
```

| Flag | Default | Description |
|---|---|---|
| `--input`, `-i` | stdin | Archive path (positional accepted) |
| `--format`, `-f` `text\|json\|ndjson` | `text` (`json` under `--json`) | Output format |
| `--long` | off | Add mode, flags, versions, offsets, extra fields, `rawNameHex`, `commentHex` |
| `--validate lazy\|eager` | `lazy` | `eager` cross-checks every local header up front |
| `--include <glob>` / `--exclude <glob>` | — | Name filters (repeatable) |
| `--summary` | — | `{ entries, files, directories, compressedSize, uncompressedSize, zip64, encrypted }` |
| `--fields a,b.c` | — | Dot-path projection of the JSON report |

JSON shape: `zipnative schema entries`.

#### `zipnative inspect`

A forensic report with determinism and security assertions — the CI
gate. The archive is opened **eagerly**: every local header
cross-checked, the overlap table built up front.

```bash
zipnative inspect --input <a.zip> [--format json|text] [--check <assert>]...
zipnative inspect <a.zip> --check deterministic,no-encryption,safe-names --json
```

| Flag | Default | Description |
|---|---|---|
| `--input`, `-i` | stdin | Archive path (positional accepted) |
| `--format`, `-f` `text\|json` | `text` (`json` under `--json`) | Output format |
| `--entries` | off | Include every entry (long form) in the report; ignored when `--entry` is given |
| `--entry <name>` | — | Include only the named entries (repeatable; wins over `--entries`; an unknown name is `E_NOT_FOUND`) |
| `--extra` | off | Include extra-field payloads as hex |
| `--check <assert>` | — | Assertion (repeatable, comma-separable); any failure prints the report then exits 1 with `E_CHECK_FAILED` |
| `--summary` | — | `{ entries, bytes, uncompressedSize, zip64, encrypted, deterministic, canonicalLayout, diagnostics, checksPassed? }` |
| `--fields a,b.c` | — | Dot-path projection |

The `--check` vocabulary — fifteen simple assertions and six that take a
value (`canonical-layout` and `no-data-descriptor` are aliases, so twenty
distinct checks):

| Check | Passes when |
|---|---|
| `deterministic` | epoch timestamps + canonical order + UTF-8 flags (reproducible on every runtime) |
| `epoch-timestamps` · `canonical-order` · `utf8-names` | the individual determinism facts |
| `canonical-layout` / `no-data-descriptor` | buffered layout — a `--stream` archive is reproducible but not canonical |
| `no-zip64` · `zip64` | Zip64 records absent / present |
| `no-encryption` | no entry carries the encryption flag |
| `no-symlinks` | no symlink entries |
| `safe-names` | every name passes `sanitizeEntryPath()` |
| `no-duplicates` | no duplicate names |
| `no-diagnostics` | the engine emitted no diagnostic |
| `store-only` · `deflate-only` | a single method throughout |
| `max-entries=N` · `min-entries=N` | entry-count bounds |
| `max-uncompressed=<size>` · `max-ratio=N` | size and worst per-entry ratio bounds |
| `has=<name>` | the named entry exists |
| `method=store\|deflate\|<id>` | every entry uses that method |

JSON shape: `zipnative schema inspect`.

#### `zipnative cat`

Stream one or more entries to stdout.

```bash
zipnative cat --input <a.zip> --entry <name> [--entry <name>]... [-o <file>]
zipnative cat <a.zip> <name> [<name>...]
```

| Flag | Default | Description |
|---|---|---|
| `--input`, `-i` | — | Archive path |
| `--entry`, `-e` | — | Entry name (repeatable); entries are concatenated in order |
| `--output`, `-o` | stdout | Write to a file instead |
| `--overwrite` | refuse (`E_IO`) | Replace an existing `--output` file |
| `--raw` | off | Output the **compressed** payload (zero-copy), no decoding |
| `--no-verify-crc` | off | Skip the CRC-32 check at the end of the stream |

The CRC is verified at the *end* of the stream (like `unzip -p`), so
stdout may already carry bytes when `E_DATA` fires; with `--output` the
partial file is removed.

#### `zipnative extract`

Extract to a directory, secure by default — the CLI is the filesystem
trust boundary the engine refuses to be.

```bash
zipnative extract --input <a.zip> --output-dir <dir> [options]
zipnative extract release.zip -d ./out --dry-run --json
```

| Flag | Default | Description |
|---|---|---|
| `--input`, `-i` | stdin | Archive path (positional accepted) |
| `--output-dir`, `-d` | **required** | Destination (created if missing); every path re-checked with `sanitizeEntryPath()` and contained under this root |
| `--include <glob>` / `--exclude <glob>` | — | Name filters (repeatable) |
| `--entry`, `-e` `<name>` | — | Extract only the named entries (repeatable) |
| `--overwrite` | refuse (`E_IO`) | Replace existing files |
| `--on-duplicate error\|first\|last` | `error` | Two entries mapping to one sanitized path |
| `--skip-unsafe` | off | **Skip** entries whose names cannot be made safe (zip-slip, absolute, drive / UNC, NUL, ADS, device names) instead of failing — nothing unsafe is ever written |
| `--skip-unsupported` | off | Skip encrypted entries and methods with no registered codec (reason `unsupported`) |
| `--allow-symlinks` | refuse | Write a symlink entry's **target text** as a regular file (a symlink is never materialised) |
| `--skip-symlinks` | off | Drop symlink entries silently |
| `--flat` | off | Drop directories, write basenames only |
| `--buffered` | off | Use the in-memory extractor (many tiny entries) |
| `--preserve-mode` | off | Apply POSIX mode bits (never setuid / setgid / sticky) |
| `--preserve-mtime` | off | Apply the entry timestamp to each file |

Refusals are `E_SECURITY` with the engine code: `ZIP_PATH_TRAVERSAL`,
`ZIP_SYMLINK_REJECTED`, `ZIP_EXTRACT_DUPLICATE_PATH`, `ZIP_ENTRY_OVERLAP`,
`ZIP_CD_LFH_MISMATCH`. Bounds are `E_LIMIT` (`--max-entry-size`,
`--max-total-size`, `--max-ratio`, …).

#### `zipnative stream`

The forward-only reader for **unseekable** input — stdin, pipes, a
download in flight. No central directory is consulted.

```bash
curl ... | zipnative stream [--list] [--format ndjson]
curl ... | zipnative stream --output-dir <dir>
cat a.zip | zipnative stream --cat <name>
```

| Flag | Default | Description |
|---|---|---|
| `--input`, `-i` | stdin | File to read sequentially |
| `--list` | default mode | List entries as they arrive |
| `--output-dir`, `-d` | — | Extract under `<dir>` (`sanitizeEntryPath` + containment) |
| `--cat <name>` | — | Write the named entry's data to stdout (repeatable) |
| `--format`, `-f` `text\|json\|ndjson` | `text` (`ndjson` under `--json`; `json` with `--summary` / `--fields`) | Output format |
| `--long` | off | Add flags, versions and extra fields |
| `--include` / `--exclude`, `--overwrite`, `--on-duplicate`, `--flat`, `--preserve-mtime` | as `extract` | |
| `--skip-unsafe` / `--skip-unsupported` | off | Skip instead of failing |
| `--summary` / `--fields` | — | Projection of the `--format json` report |

**Trust caveat:** local headers alone — there is no central directory to
cross-check names, sizes, methods or attributes, so `--preserve-mode`,
`--allow-symlinks` and `--skip-symlinks` are unavailable here, a
`warning:` line is printed at start, and every JSON output carries
`trust: "local-headers-only"`. Prefer `list` / `extract` whenever the
whole file is available.

### Integrity & codecs

#### `zipnative verify`

Deep integrity verification in one call — the engine's
`ZipVerificationReport` verbatim.

```bash
zipnative verify --input <a.zip> [--format json|text] [--strict]
zipnative verify <a.zip> --entry manifest.json --json
```

| Flag | Default | Description |
|---|---|---|
| `--input`, `-i` | stdin | Archive path (positional accepted) |
| `--entry`, `-e` | all | Verify only the named entries (repeatable); an unknown name is `E_NOT_FOUND` before any output |
| `--format`, `-f` `text\|json` | `text` (`json` under `--json`) | Output format |
| `--summary` | — | `{ ok, entries, failed, skipped, diagnostics, selected?, error? }` |
| `--fields a,b.c` | — | Dot-path projection |

The report is `{ ok, error, entryCount, entries[{ name, ok, crcMatch,
sizeMatch, localHeaderMatch, skipped? }], diagnostics }` plus `failed`,
`skipped` and `strict`; `selected` (the requested names) is present only
under `--entry`. Without `--entry` the report is `verifyZip()` verbatim;
with it, the CLI opens the archive eagerly (the same structural pass)
and calls `verifyEntry()` on each name, so a structural refusal lands in
`error` exactly as it would from `verifyZip()`. Encrypted entries are
honestly `skipped`, never faked as verified. Exit 1 / `E_VERIFY_FAILED` when `ok`
is false; `--strict` also fails on any diagnostic. `verify` proves
integrity and structure, **not** path safety: a zip-slip archive with
valid CRCs is `ok` — gate names with `inspect --check safe-names,no-symlinks`
or `extract --dry-run` before extracting.

#### `zipnative crc32`

CRC-32 (IEEE, the ZIP checksum) of files or stdin, in 64 KiB chunks.

```bash
zipnative crc32 [<file>...] [--seed <hex>] [--expect <hex>] [--format text|json]
```

| Flag | Default | Description |
|---|---|---|
| `<file>...` / `--input`, `-i` | stdin | Files (repeatable) |
| `--seed <hex>` | `0` | Continue a running checksum from this value |
| `--expect <hex>` | — | Single input: exit 1 / `E_CHECK_FAILED` on mismatch (`detail { expectedCrc, actualCrc }`) |
| `--format`, `-f` `text\|json` | `text` (`<crc>  <bytes>  <file>`) | Output format |

#### `zipnative inflate`

Decompress a raw DEFLATE (RFC 1951) or registered-codec stream through
the engine's resumable inflater — constant memory, exact
`bytesConsumed`, trailing bytes reported as `leftover`.

```bash
zipnative inflate [--input <file>] [--output <file>] [--max-output <size>]
```

| Flag | Default | Description |
|---|---|---|
| `--input`, `-i` | stdin | Compressed input |
| `--output`, `-o` | stdout | Decompressed output |
| `--overwrite` | refuse (`E_IO`) | Replace an existing `--output` file |
| `--max-output <size>` | the effective `--max-entry-size` (1 GiB) | Hard output bound; `none` only for trusted input |
| `--method deflate\|store\|<id>` | `deflate` | Codec (ids via `--codec`) |
| `--sync` | off | Buffer the input and use the codec's `decompressSync` |
| `--allow-trailing` | off | Silence the warning about bytes after the stream end |

Errors: `ZIP_DEFLATE_CORRUPT` / `ZIP_DEFLATE_TRUNCATED` → `E_PARSE`,
`ZIP_INFLATE_OUTPUT_OVERFLOW` → `E_DATA`.

### Automation & meta

#### `zipnative batch`

Batch orchestration in two modes.

```bash
zipnative batch --input-dir <dir> --output-dir <dir> [--task create] [create flags]
zipnative batch --input-dir <dir> --task verify
zipnative batch --manifest <tasks.json> [--continue-on-error] [--allow-codec-load]
```

| Flag | Default | Description |
|---|---|---|
| `--input-dir <dir>` | — | Directory mode: `--task create` archives each immediate subdirectory to `<output-dir>/<name>.zip`; `--task verify` verifies every `*.zip` |
| `--output-dir <dir>` | — | Destination for `--task create` |
| `--task create\|verify` | `create` | Directory-mode task |
| `--overwrite` | refuse (`E_IO`) | Replace existing `<name>.zip` files |
| `--concurrency <n>` | `4` (max 64) | Parallel workers |
| `--fail-fast` | off | Stop scheduling after the first failure |
| `--method` / `--level` / `--deterministic` / `--order` / `--date` / `--comment` | — | Forwarded to every `create` task (any other `create` flag is forwarded too) |
| `--manifest <file>` | — | Manifest mode: an ordered pipeline of whitelisted commands (`create`, `list`, `inspect`, `extract`, `cat`, `verify`, `stream`, `modify`, `crc32`, `inflate`) with `@<id>` output references — `zipnative schema batch-manifest` |
| `--continue-on-error` | off | Keep running independent tasks after a failure |
| `--allow-codec-load` | off | Permit a `codec` flag inside tasks (executes user code) |
| `--format`, `-f` `text\|json` | `text` (`json` under `--json`) | Output format |
| `--summary` | — | `{ ok, command, mode, total, succeeded, failed, skipped }` |
| `--fields a,b.c` | — | Dot-path projection |

Under `--json` stdout is **one** batch document — each task's stdout is
captured into `tasks[i].report` (parsed JSON / NDJSON) or `.stdout`, so
`create` / `modify` / `cat` / `inflate` tasks must declare an `output`
and `stream --cat` is refused at validation. Path values inside a
manifest are *data* and are refused on `..`. Exit 1 carries the first
failing task's `E_*` code.

**Manifest rules** (validated in full before any task runs):

- The document is `{ "version": 1, "tasks": [ … ] }` — `version` must
  be exactly `1`, `tasks` a non-empty array of at most 1000 objects.
- Each task is `{ id, command, flags? }`. `id` is a non-empty string of
  `A–Z a–z 0–9 _ -`, unique within the manifest; `command` is one of the
  ten whitelisted commands (`batch`, `govern`, `schema`, `completion`
  and `doctor` are named as never allowed); `flags` is an object keyed
  by bare flag names (no leading dashes, no whitespace or `=`).
- Flag values are `string`, `number` (finite; rendered as text), `boolean`
  (`true` emits the bare flag, `false` omits it) or `string[]` (a
  repeatable flag). Anything else is refused.
- Relative values of the path flags (`input` / `i`, `output` / `o`,
  `output-dir` / `d`, `from-manifest`, `base`, and the path half of
  `add` / `replace`) resolve against the **manifest file's directory**
  after the same traversal check argv paths get; `-` is left alone.
- A value `@<id>` is substituted with the resolved `output` (else
  `output-dir`) of an **earlier** task; a forward or unknown reference,
  or a reference to a task that declares neither, is refused.
- A `codec` flag in any task needs `--allow-codec-load` on the `batch`
  invocation.
- Structural violations (shape, types, `version`, the task cap) are
  exit 2 / `E_USAGE`; value violations (a bad or duplicate `id`, a
  command outside the whitelist, a bad `@` reference) are exit 1 /
  `E_INPUT`; a manifest that is not JSON is `E_PARSE`.

#### `zipnative doctor`

Environment and capability preflight — always offline.

```bash
zipnative doctor [--format json|text]
```

| Flag | Default | Description |
|---|---|---|
| `--format`, `-f` `text\|json` | `text` (`json` under `--json`) | Output format |

Ten checks: `cli`, `node` (≥ 22), `zipnative` (package vs `VERSION`
export), `deflate-tier` (node-zlib expected; pure under `--pure-codecs`),
`deflate-pinned` (the tier `--deterministic` uses), `web-streams`,
`workers` (for `create --parallel`), `codecs`, `limits` (the effective
bounds, `--max-*` overrides included) and `commands`. Statuses `ok`,
`warn`, `error`; exit 0 when every check passes, 1 otherwise.

#### `zipnative schema`

Print a JSON Schema (Draft 2020-12) or the capability manifest.

```bash
zipnative schema [<subject>]     # default subject: create-manifest
zipnative schema list            # { subjects: [...] }
zipnative schema manifest        # commands, flags, codes, limits, schemas
```

Twenty-two subjects: inputs `create-manifest`, `modify-manifest`,
`batch-manifest`; outputs `entries`, `entries-summary`, `inspect`,
`inspect-summary`, `verify`, `verify-summary`, `stream`,
`stream-summary`, `batch`, `batch-summary`, `doctor`, `govern-verify`,
`crc32`; the envelopes `status`, `error`; `errors` (the `E_*` codes, the
39 `ZIP_*` → `E_*` mapping and the diagnostics); `limits`, `diagnostics`;
and `manifest`. Every `$id` is versioned:
`https://zipnative.dev/schema/cli/1.0.0/<subject>.schema.json`.

#### `zipnative completion`

Emit a shell completion script, generated from the same command table
as `--help` and `schema manifest`.

```bash
zipnative completion bash > /etc/bash_completion.d/zipnative
zipnative completion zsh  > "${fpath[1]}/_zipnative"
zipnative completion fish > ~/.config/fish/completions/zipnative.fish
zipnative completion powershell >> $PROFILE     # `pwsh` is accepted as an alias
```

Path flags (`--input`, `--output`, `--output-dir`, `--input-dir`,
`--base`, `--from-manifest`, `--manifest`, `--config`, `--codec`,
`--comment-file`) complete files; other value flags require an argument;
boolean flags take none. The shells are `bash`, `zsh`, `fish` and
`powershell` (`pwsh` emits the same PowerShell script); anything else is
exit 2.

#### `zipnative govern`

The AI-governance / human-in-the-loop contract.

```bash
zipnative govern rules                    # the human/agent protocol
zipnative govern policy [--pretty]        # the machine-readable policy (JSON)
zipnative govern verify-issue <draft.md>  # validate a draft; exit 1 / E_POLICY on violation
```

| Flag | Default | Description |
|---|---|---|
| `--input`, `-i` | positional | Draft path for `verify-issue` (`-` = stdin) |
| `--format`, `-f` `json\|text` | `text` (`json` under `--json`) | Report format for `verify-issue` (`zipnative schema govern-verify`) |

`verify-issue` fails a draft that proposes a runtime dependency or omits
a reproduction; missing recommended fields and apparent anti-goal
proposals (encryption, other formats, multi-disk, repair) are warnings.
A passing check is necessary, never sufficient — agents are draftsmen;
a human reviews and submits.

## Global options

| Flag | Default | Description |
|---|---|---|
| `--help`, `-h` | — | Global or per-command usage |
| `--version`, `-V` | — | Version; with `--json`: `{ name, version, zipnative }` |
| `--json` | — | Agent mode: JSON envelope on stderr, data on stdout (`batch`: the report is the stdout document) |
| `--pretty` | — | Indent JSON output under `--json` |
| `--dry-run` | — | Validate and plan without writing (`create`, `extract`, `modify`, `stream`, `cat`, `inflate`, `batch`) |
| `--quiet`, `-q` | — | Suppress progress and text diagnostics on stderr (never envelopes or errors) |
| `--no-color` | — | Disable ANSI colour on stderr (also `NO_COLOR`; `FORCE_COLOR` turns it on; `TERM=dumb` off) |
| `--strict` | — | Escalate the first engine diagnostic into `E_CHECK_FAILED` before any output byte (`verify`: `E_VERIFY_FAILED`) |
| `--config <file>` | nearest `.zipnativerc.json` upward | Use a specific config file |
| `--no-config` | — | Ignore any `.zipnativerc.json` |
| `--max-entries <n>` | `100000` | Central-directory entry bound (CWE-400) |
| `--max-entry-size <size>` | 1 GiB | Decompressed size of one entry (CWE-400) |
| `--max-total-size <size>` | 8 GiB | Total decompressed size (CWE-400) |
| `--max-ratio <n>` | `1024` | Uncompressed / compressed ratio (CWE-409) |
| `--max-name-bytes <size>` | `4096` | Entry-name length (CWE-400) |
| `--max-extra-bytes <size>` | `65535` | Extra-field block length (CWE-400) |
| `--max-comment-bytes <size>` | `65535` | Comment length (CWE-400) |
| `--max-cd-bytes <size>` | 256 MiB | Central-directory size (CWE-400) |
| `--max-input-size <size>` | 4 GiB | CLI-owned bound on every **buffered** read (`list`, `inspect`, `verify`, `extract`, `cat`, `modify`, `create --stdin-name`, `inflate --sync`, `govern verify-issue`); `E_LIMIT` beyond it. The streaming commands are not bounded by it |
| `--pure-codecs` | — | Skip `node:zlib`, run the pure-TS codec tier |
| `--codec <module>` | — | Load an ESM module exporting `{ codecs: ZipCodec[] }` (+ optional `inflateImpl` / `deflateImpl`). Executes user code: command line only, never from a config file. `create --parallel` refuses a module that registers method 0 / 8, or one with a `deflateImpl` unless `--deterministic` pins the encoder — the workers never see the module; sequentially the override is honoured and announced with a warning |

**Value grammars.** A `<size>` is a decimal integer with an optional
binary suffix `k`, `m`, `g` or `t` (case-insensitive), optionally
followed by `i`, `b` or `ib` — `65536`, `512k`, `1m`, `8g`, `1t`,
`1GiB` and `4gb` are all binary multiples; `none`, `inf` and `infinity`
disable the bound (a visible warning for every `--max-*` flag). A count
(`--max-entries`, `--max-ratio`, `--check max-entries=N`,
`min-entries=N`, `max-ratio=N`) is a plain non-negative integer or the
same three words — a `k` / `m` / `g` suffix is refused there. Every
`--max-*` bound, `--max-input-size` and `inflate --max-output` refuse
`0` (use `none`). The eight `--max-*` flags are the engine's
`ZipLimits`; `--max-input-size` is the CLI's own.

### Configuration file

`.zipnativerc.json` is looked up by walking **upward** from the working
directory (the nearest file wins) unless `--config <file>` names one —
in which case discovery is skipped and a file that does not exist is
exit 2 — or `--no-config` disables the mechanism (then `--config` is
ignored). The file must be a JSON object of at most 1 MB; invalid JSON,
a non-object, or a larger file is exit 2. Top-level keys are bare flag
names with global scope; a key that names a command and holds an object
is that command's section, and **a command-scoped value wins over a
global one**. Numbers are coerced to strings (`"level": 9` ⇒ `--level
9`), arrays of strings or numbers become repeatable flags, booleans are
flags; `null` or nested objects are ignored. Config only fills flags you
did not pass — an explicit flag, even a boolean, is never overridden.
`codec` is refused from any file, in any section, whether or not the
section is for the running command.

```json
{
  "no-color": true,
  "max-total-size": "32g",
  "create": { "deterministic": true, "level": 9 },
  "extract": { "overwrite": true }
}
```

## Environment

| Variable | Effect |
|---|---|
| `ZIPNATIVE_JSON=1` | same as `--json` |
| `ZIPNATIVE_DRY_RUN=1` | same as `--dry-run` |
| `ZIPNATIVE_QUIET=1` | same as `--quiet` |
| `ZIPNATIVE_STRICT=1` | same as `--strict` |
| `ZIPNATIVE_PURE_CODECS=1` | same as `--pure-codecs` |
| `ZIPNATIVE_DEBUG=1` | add the stack trace to an error |
| `NO_COLOR` / `FORCE_COLOR` / `TERM=dumb` | colour of the stderr lines |

Output is English and locale-independent: no locale is read, dates are
ISO-8601 UTC, sizes use binary units, and messages are not part of the
contract — branch on `error.code`, `error.zipCode` and `error.remedy`.

## Security posture

- **Offline, always.** No command can open a socket — no telemetry, no
  update check, no URL from any argument.
- **The extraction sink re-checks every name** with the engine's
  `sanitizeEntryPath()` and contains it under `--output-dir`; nothing
  unsafe is ever written, with or without `--skip-unsafe`. Symlinks are
  never materialised.
- **Bounds are on by default** and every one is named and CWE-tagged;
  `none` is loud. `inflate` has a hard output bound; `--max-input-size`
  caps every buffered read.
- **Overwrite is refused** (`E_IO`) unless `--overwrite`; interrupts
  remove only the file in flight.
- **`--codec` executes user code**, so it is accepted on the command
  line only — never from `.zipnativerc.json`, and only inside a `batch`
  manifest under `--allow-codec-load`.
- **Manifest paths are data.** `..` inside a `create` / `modify` / `batch`
  manifest is refused (`E_INPUT`); argv paths are the invoking user's own
  authority.

## Conformance

Every archive the CLI writes is ISO/IEC 21320-1:2015 conformant: the
CLI repository runs its own veraZIP gate — the engine's clause-by-clause
validator over a corpus of archives produced by the CLI, plus foreign
integrity passes — blocking in CI and before every publish. The
[conformance guide](conformance.html) explains the gate; conformant is
not the same as safe, which is why the extraction guards exist on top.

## Not supported

| | |
|---|---|
| **Encryption, read or write** | Engine policy in 1.x (ZipCrypto is broken). Encrypted entries are detected and listed; `verify` skips them, `extract` / `stream` refuse them unless `--skip-unsupported`; `inspect --check no-encryption` asserts their absence. Confidentiality belongs to the document layer — see [Case 5](use-cases.html#case-5--encrypt-first-then-archive). |
| Other archive formats | No 7z, RAR, tar, gzip; `--codec` is the extension point for methods other than 0 / 8 |
| Multi-disk archives | `ZIP_UNSUPPORTED_MULTI_DISK` |
| Archive repair | Reported by `verify`, never guessed |
| Streamed entries > 4 GiB | `create --stream` refuses (`ZIP_UNSUPPORTED_ZIP64_STREAMING`); buffered entries are fully Zip64 |
| Network access | None, in any mode |

## Versioning

SemVer over the fifteen commands and their flags, the exit codes, the
thirteen `E_*` classes and the `ZIP_*` → `E_*` mapping, the envelope and
report keys, the `schema` subjects, the `.zipnativerc.json` keys, the
`ZIPNATIVE_*` variables — and **the bytes written under
`--deterministic`** (a byte change is semver-major, as for the engine).
Message wording, layout and key order are not a contract.

## Further reading

- [CLI playground](../playgrounds/cli.html) — assemble any of the fifteen
  commands with live validation and copy the result.
- [Choosing your surface](choose.html) — library, CLI or MCP server, per
  capability.
- [MCP guide](mcp.html) — the same engine for AI assistants.
- [Security model](security.html) · [Errors and error codes](errors.html)
  · [The determinism contract](determinism.html).
- [`docs/data/cli-surface.json`](../data/cli-surface.json) — the
  command and flag snapshot this page is verified against; the full
  README, AGENTS.md and samples live in the
  [zipnative-cli repository](https://github.com/Nizoka/zipnative-cli).
