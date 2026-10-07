# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub Security Advisories
(**Security → Report a vulnerability** on the repository). Do not open a public
issue for security reports. You should receive an initial response within 7 days.

## Supported versions

| Version | Supported |
|---|---|
| 1.1.x | ✅ |
| 1.0.x | ✅ (security fixes) |
| < 1.0 (git tags, never published to npm) | ❌ |

Only the latest published minor version receives security fixes.

## Release integrity

Packages are published from CI via **npm Trusted Publishing (OIDC)** with
**provenance attestations** — verify with `npm audit signatures`. A CycloneDX
SBOM is attached to every GitHub Release. Nobody publishes from a laptop
(`publishConfig.provenance` makes a local `npm publish` fail).

### Supply chain

Every workflow runs under `step-security/harden-runner` (egress audited),
every action is pinned to a commit SHA (Dependabot owns the bumps),
dependencies install with `npm ci --ignore-scripts` (`.npmrc` makes it the
default locally too), pull requests pass dependency review with a
licence allow-list, and a weekly `npm audit` runs on the lockfile. The
publish job runs in the `npm-publish` environment behind a required
reviewer, re-runs the full gate, and publishes with a pinned npm through
OIDC; a separate `attest` job generates SLSA Build L2 provenance for the
tarball and the CycloneDX SBOM (`actions/attest-build-provenance`) and
attaches both to the GitHub Release. Branch and tag rulesets are
committed under `.github/rulesets/`. The engine itself has no runtime
dependencies, so the published artefact's transitive closure is empty.

## Compatibility promise (semver, 1.0+)

- The public API surface ([docs/assets/api.json](docs/assets/api.json)) is
  frozen: removals and behavioral breaks are semver-major.
- The **39-code error vocabulary** ([docs/data/errors.json](docs/data/errors.json))
  is frozen: removing or renaming a `err.code` is semver-major; additions are
  semver-minor.
- The `deterministic: true` **output bytes are part of the contract**:
  changing them is semver-major
  (`ecosystem.json → deterministic_bytes_are_semver_major`); since 1.1 the
  canonical bytes of `canonicalizeZip()` / `saveCompact({ canonical: true })`
  are under the same contract.
- Minor releases are additive: 1.1.0 grew the public surface from 77 to
  106 exports and removed none, every new behaviour is opt-in, and the byte
  baseline of the 33 pre-existing samples (`npm run verify:samples`) proves
  existing output unchanged; the `compat-previous` CI job runs the previous
  release's own test suite against every change. Each release note carries
  a compatibility ledger listing every observable change.

## Security model

zipnative treats **every archive as untrusted input**. The engine is designed so
that the *default* code path is the safe one.

### Threat model

ZIP is an attacker-friendly format: it is parsed from the end, tolerates leading
and trailing garbage, duplicates its metadata (central directory vs local
headers), and mixes 16/32/64-bit size fields. zipnative defends against:

| Threat | Defence | CWE |
|---|---|---|
| Zip-slip path traversal (`../`, absolute paths, drive letters, backslashes, NUL, NTFS ADS, Windows reserved device names — `CON`/`NUL`/`COM1`…) | `rejectTraversal: true` by default; `sanitizeEntryPath()` exported for external sinks | CWE-22 / CWE-67 |
| Decompression bombs (high ratio, nesting, entry floods) | per-entry and total output caps, compression-ratio bound, entry-count cap — all enforced *during* inflation, not after | CWE-400 / CWE-409 |
| Symlink entries redirecting extraction | `rejectSymlinks: true` by default | CWE-59 |
| Overlapping entries (one payload claimed by many entries) | always-on overlap detection over central-directory ranges | CWE-405 |
| Parser-differential smuggling (central directory disagreeing with local headers) | central directory is authoritative; method/size/CRC divergence is fatal, name divergence is diagnosed | CWE-436 |
| Ambiguous EOCD (trailing garbage, multiple candidate records) | only a self-consistent EOCD closest to EOF is accepted; ambiguity is refused, never guessed | — |
| Zip64 field spoofing (sentinel values masking lying 64-bit fields) | Zip64 records cross-checked against every non-sentinel classic field; divergence is fatal | CWE-1288 |
| Duplicate entry names (shadowing during extraction) | `onDuplicate: 'error'` by default | CWE-694 |
| Integer overflow (> 2^53 sizes/offsets) | 64-bit fields read via BigInt and rejected above `Number.MAX_SAFE_INTEGER` | CWE-190 |
| Unbounded allocation for a compressed payload fetched from a byte-range source (1.1) | `maxEntryCompressedSize` (default 1 GiB + 1 MiB) bounds `openZipRange()`'s whole-payload reads; the in-memory reader uses zero-copy views and never consults it | CWE-770 |
| Lying byte-range source (understated `size`, short reads) | every record cross-checked as under `openZip()`; short reads and size lies are `ZIP_RECORD_TRUNCATED`; the central directory is fetched only after `maxCentralDirectoryBytes` is checked | CWE-20 |
| Traversal smuggled through an injected name decoder (1.1) | path sanitisation runs on the decoded string; a decoder cannot bypass `sanitizeEntryPath()` | CWE-22 |

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
- Every archive zipnative writes is validated clause by clause against
  ISO/IEC 21320-1:2015 by an engine-independent validator
  (`npm run validate:zip`), blocking in CI and before every publish — see
  the [conformance guide](docs/guides/conformance.md). Conformance is not
  safety: hostile-but-spec-valid archives (zip-slip et al.) are exactly why
  the guards above exist.

### Known limitations

- **Encrypted archives are not supported** (read or write) in 1.x.
  ZipCrypto is cryptographically broken; supporting it would create false
  confidence. Encrypted entries are detected and fail with a typed error
  whose `feature` names the scheme — `'zipcrypto'`, `'aes'` (WinZip AES,
  labelled since 1.1, a 2.0 candidate) or `'strong-encryption'`.
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
