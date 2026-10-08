# Security model

> zipnative treats every archive as untrusted input: the default code path
> is the safe one, every parser loop runs under a named CWE-tagged bound,
> and ambiguity is refused rather than guessed at.

## Why ZIP needs this

ZIP is an attacker-friendly format: parsed from the end, tolerant of
leading and trailing garbage, metadata duplicated between the central
directory and local headers, and 16/32/64-bit size fields mixed freely.
Most historical archive CVEs are parser differentials or resource
exhaustion — both are addressed structurally here.

## The guards

| Threat | Defence | CWE |
|---|---|---|
| Zip-slip traversal (`../`, absolute, drive letters, NTFS streams) and Windows reserved device names (`CON`, `NUL`, `COM1`…) | `rejectTraversal: true` by default; `sanitizeEntryPath()` for external sinks | CWE-22 / CWE-67 |
| Decompression bombs | per-entry and total output caps, ratio bound, entry-count cap — enforced *during* inflation | CWE-400/409 |
| Symlink entries | `rejectSymlinks: true` by default | CWE-59 |
| Overlapping entries | always-on region-boundary checks | CWE-405 |
| Central-vs-local header differentials | the central directory is authoritative; method/size divergence is fatal | CWE-436 |
| Ambiguous EOCD / trailing garbage | only a self-consistent record closest to EOF is accepted | — |
| Zip64 sentinel spoofing | cross-checks against every non-sentinel classic field | CWE-1288 |
| Duplicate names | `onDuplicate: 'error'` by default | CWE-694 |
| Unbounded fetch of a compressed payload from a byte-range source (1.1) | `maxEntryCompressedSize` (1 GiB + 1 MiB) on `openZipRange()`'s whole-payload reads; the in-memory reader uses zero-copy views and never consults it | CWE-770 |
| Encrypted entries (ZipCrypto, WinZip AES, strong encryption) | detected and refused with `ZIP_UNSUPPORTED_ENCRYPTION`; `feature` names the scheme (`'aes'` since 1.1); never decrypted in 1.x | — |

The bounds (`ZipLimits`; defaults in `DEFAULT_ZIP_LIMITS`; overridden per
call with `limits: { … }`, a violation throws `ZipLimitError` naming the
limit, the configured value and the observed one):

| Limit | Default | Bounds | CWE |
|---|---|---|---|
| `maxEntries` | 100 000 | entries in the central directory and in a forward walk | CWE-400 |
| `maxEntryUncompressedSize` | 1 GiB | decompressed bytes of one entry, counted during inflation on every tier | CWE-400 |
| `maxEntryCompressedSize` | 1 GiB + 1 MiB | one compressed payload fetched whole by `openZipRange()` (the in-memory reader uses zero-copy views and never consults it) — 1.1 | CWE-770 |
| `maxTotalUncompressedSize` | 8 GiB | decompressed bytes of one extraction | CWE-400 |
| `maxCompressionRatio` | 1024 | declared uncompressed ÷ compressed size, for entries of 1 KiB and more compressed | CWE-409 |
| `maxNameBytes` | 4 096 | one entry name | CWE-400 |
| `maxExtraFieldBytes` | 65 535 | one extra-field block | CWE-400 |
| `maxCommentBytes` | 65 535 | the archive comment or one entry comment | CWE-400 |
| `maxCentralDirectoryBytes` | 256 MiB | the central directory, checked before it is read or fetched | CWE-400 |

Every bound lives on `ZipLimits`, is documented, and is caller-configurable
— raising one is an explicit decision, never a silent default.

## The forward reader's trust caveat

`iterateZipEntries()` reads local headers **alone** — there is no central
directory to cross-check names, sizes or methods, so a hostile archive can
present different content there than `openZip()` authoritatively reports.
Use it only for streams you cannot seek, and never feed its names to a
filesystem without `sanitizeEntryPath()`.

## Injected decoders and sources (1.1)

- A `nameDecoder` decodes entry names whose flag bit 11 is clear (legacy
  code pages). The decoded string goes through the same path sanitisation
  as every other name — `..`, absolute paths, NUL bytes, NTFS streams and
  device names are refused after decoding, so a decoder cannot smuggle a
  traversal.
- A `ByteRangeSource` is untrusted like the bytes it serves: every record
  the in-memory reader cross-checks is cross-checked here on the same
  code, a `size` smaller than the records imply or a short `read()` is
  `ZIP_RECORD_TRUNCATED`, the central directory is fetched only after
  `maxCentralDirectoryBytes` has been checked, and whole-payload fetches
  are bounded by `maxEntryCompressedSize`.
- An `AbortSignal` rejects with `signal.reason` only after the engine has
  released what it held — stream locks, worker pools, in-flight reads.

## What the engine never does

No filesystem access, no sockets, no `eval`, no runtime dependencies —
the supply chain is one repository, watched by CodeQL, OpenSSF Scorecard,
dependency review and an adversarial fuzzing suite on Linux, Windows and
macOS. Every workflow runs under harden-runner with SHA-pinned actions and
`npm ci --ignore-scripts`; releases are published by OIDC Trusted
Publishing with SLSA Build L2 provenance and a CycloneDX SBOM attested
alongside the tarball (`npm audit signatures` verifies).

## Reporting

Privately, via GitHub Security Advisories — see
[SECURITY.md](https://github.com/Nizoka/zipnative/blob/main/SECURITY.md).
