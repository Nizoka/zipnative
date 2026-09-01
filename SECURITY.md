# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub Security Advisories
(**Security → Report a vulnerability** on the repository). Do not open a public
issue for security reports. You should receive an initial response within 7 days.

## Supported versions

Only the latest published minor version receives security fixes before 1.0.

## Security model

zipnative treats **every archive as untrusted input**. The engine is designed so
that the *default* code path is the safe one.

### Threat model

ZIP is an attacker-friendly format: it is parsed from the end, tolerates leading
and trailing garbage, duplicates its metadata (central directory vs local
headers), and mixes 16/32/64-bit size fields. zipnative defends against:

| Threat | Defence | CWE |
|---|---|---|
| Zip-slip path traversal (`../`, absolute paths, drive letters, backslashes, NUL, NTFS ADS) | `rejectTraversal: true` by default; `sanitizeEntryPath()` exported for external sinks | CWE-22 |
| Decompression bombs (high ratio, nesting, entry floods) | per-entry and total output caps, compression-ratio bound, entry-count cap — all enforced *during* inflation, not after | CWE-400 / CWE-409 |
| Symlink entries redirecting extraction | `rejectSymlinks: true` by default | CWE-59 |
| Overlapping entries (one payload claimed by many entries) | always-on overlap detection over central-directory ranges | CWE-405 |
| Parser-differential smuggling (central directory disagreeing with local headers) | central directory is authoritative; method/size/CRC divergence is fatal, name divergence is diagnosed | CWE-436 |
| Ambiguous EOCD (trailing garbage, multiple candidate records) | only a self-consistent EOCD closest to EOF is accepted; ambiguity is refused, never guessed | — |
| Zip64 field spoofing (sentinel values masking lying 64-bit fields) | Zip64 records cross-checked against every non-sentinel classic field; divergence is fatal | CWE-1288 |
| Duplicate entry names (shadowing during extraction) | `onDuplicate: 'error'` by default | CWE-694 |
| Integer overflow (> 2^53 sizes/offsets) | 64-bit fields read via BigInt and rejected above `Number.MAX_SAFE_INTEGER` | CWE-190 |

Every bound is named, documented on `ZipLimits`, and caller-configurable —
raising a limit is always an explicit decision, never a silent default.

Every refusal above is thrown with a **stable machine-readable error code**
(v0.8+, e.g. `ZIP_PATH_TRAVERSAL`, `ZIP_ENTRY_OVERLAP`,
`ZIP_LIMIT_EXCEEDED`) — the frozen vocabulary lives in
[docs/data/errors.json](docs/data/errors.json) and is documented in
[docs/guides/errors.md](docs/guides/errors.md).

### Code safety

- Zero runtime dependencies — the supply chain is this repository.
- No `eval`, `Function()`, or dynamic code execution (enforced by ESLint).
- The engine never opens a socket and never touches the filesystem.
- No module-level side effects; all state lives in closure factories.
- CI runs CodeQL, OpenSSF Scorecard, `npm audit`, and an adversarial fuzzing
  suite (truncation, corruption, bombs, encoding tricks) on every push,
  on Linux and Windows.

### Known limitations

- **Encrypted archives are not supported** (read or write) through 1.0.
  ZipCrypto is cryptographically broken; supporting it would create false
  confidence. Encrypted entries are detected and fail with a typed error.
- **`removeEntry` + incremental `save()` does not erase content** (v0.4+):
  the append-only save model keeps original bytes verbatim, so removed
  entries remain recoverable from the file. `saveCompact()` is the true
  deletion path. This is documented loudly on the API.
- **The forward streaming reader (`iterateZipEntries`) trusts local headers
  alone** — there is no central directory to cross-check names, sizes or
  methods, so a hostile archive can present different content there than
  `openZip()` authoritatively reports (the upload-scanner differential,
  CWE-436 adjacent). All size limits are enforced by output counting and
  CRCs are verified, but treat forward-read metadata as unverified: use it
  only for streams you cannot seek, and never feed its names to a
  filesystem without `sanitizeEntryPath()`.

## Disclosure policy

Confirmed vulnerabilities are fixed in a patch release with a GitHub Security
Advisory and a CHANGELOG entry crediting the reporter (unless anonymity is
requested).
