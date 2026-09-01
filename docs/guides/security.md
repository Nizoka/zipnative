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
| Zip-slip traversal (`../`, absolute, drive letters, NTFS streams) | `rejectTraversal: true` by default; `sanitizeEntryPath()` for external sinks | CWE-22 |
| Decompression bombs | per-entry and total output caps, ratio bound, entry-count cap — enforced *during* inflation | CWE-400/409 |
| Symlink entries | `rejectSymlinks: true` by default | CWE-59 |
| Overlapping entries | always-on region-boundary checks | CWE-405 |
| Central-vs-local header differentials | the central directory is authoritative; method/size divergence is fatal | CWE-436 |
| Ambiguous EOCD / trailing garbage | only a self-consistent record closest to EOF is accepted | — |
| Zip64 sentinel spoofing | cross-checks against every non-sentinel classic field | CWE-1288 |
| Duplicate names | `onDuplicate: 'error'` by default | CWE-694 |

Every bound lives on `ZipLimits`, is documented, and is caller-configurable
— raising one is an explicit decision, never a silent default.

## The forward reader's trust caveat

`iterateZipEntries()` reads local headers **alone** — there is no central
directory to cross-check names, sizes or methods, so a hostile archive can
present different content there than `openZip()` authoritatively reports.
Use it only for streams you cannot seek, and never feed its names to a
filesystem without `sanitizeEntryPath()`.

## What the engine never does

No filesystem access, no sockets, no `eval`, no runtime dependencies —
the supply chain is one repository, watched by CodeQL, OpenSSF Scorecard
and an adversarial fuzzing suite on Linux and Windows.

## Reporting

Privately, via GitHub Security Advisories — see
[SECURITY.md](https://github.com/Nizoka/zipnative/blob/main/SECURITY.md).
