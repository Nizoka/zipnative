---
description: "Untrusted-input hardening rules — bounds, traversal, bombs"
applyTo: "src/**"
---

# Security rules

Every archive is attacker-controlled. Assume adversarial bytes at every field.

- **Every loop over archive bytes** (scan, walk, decode, inflate) consults a
  named bound from `ZipLimits` (`src/core/zip-limits.ts`). Adding a loop
  means adding or citing a limit — with CWE tag, default, fuzz test, and
  SECURITY.md row in the same PR.
- Decompression output is capped by the CD-declared size: producing MORE
  than declared is `ZipDataError` (never silently truncate or grow).
  The cap is enforced *during* inflation on every tier, including native
  zlib (`maxOutputLength`) and DecompressionStream (count as you pump).
- Path handling: `sanitizeEntryPath()` in `src/parser/zip-extract.ts` is the
  ONLY traversal gate. It rejects `..` segments, absolute paths, drive
  letters, UNC prefixes, backslash separators (normalized first), NUL bytes,
  NTFS alternate data streams (`name:stream`), and empty results. Windows
  cases are not optional — the Windows CI job runs them.
- Never trust one copy of duplicated metadata: cross-check CD vs LFH vs
  descriptor vs Zip64 per the divergence table; refuse ambiguity.
- No `eval`/`Function`/`setTimeout(string)`. No sockets. No fs in the engine.
- Fuzz tests must assert: clean typed error (a `ZipError` subclass), no
  hang, bounded memory — for every truncation point and corruption class.
