---
description: "Audit zipnative for security, ISO/IEC 21320-1 conformance, determinism, cross-platform compatibility and the zero-dependency contract."
agent: "agent"
---
# Compliance Audit

Perform a comprehensive compliance audit of zipnative. Report findings with
severity (critical / warning / info), the file and line, a reproduction
command, and the recommended fix. Do not fix anything; do not open issues.

## Audit Areas

### 1. ISO/IEC 21320-1:2015 and APPNOTE conformance
- `npm run test:generate && npm run validate:zip` passes: every sample PASSes
  or FAILs exactly as `declared.iso21320` in `docs/assets/ecosystem.json` says
- Zip64 records only where a field overflows (or where `zip64: true` opts in);
  sentinels and extras in lock-step (`src/parser/zip-eocd.ts` header policy)
- Data descriptors: 16-byte form, or the 24-byte form exactly when the local
  header carries a Zip64 extra (APPNOTE §4.3.9.2)
- Entry names: UTF-8 flag honoured, CP437 fallback, injected decoder only when
  the flag is clear, sanitisation on the decoded string

### 2. Security
- Every loop over untrusted input consults a named, CWE-tagged limit in
  `src/core/zip-limits.ts`, listed in SECURITY.md; validation precedes allocation
- No `eval()`, `Function()`, sockets, filesystem or process access in `src/`
  (the gate's `dist-probe` step is the mechanical check)
- Secure-by-default extraction: zip-slip, absolute paths, drive letters, NUL,
  NTFS ADS, symlinks, duplicate paths — `tests/fuzzing/` covers each class
- Error messages name the remedy and leak no host path or secret
- No security default weakened (`rejectTraversal`, `rejectSymlinks`,
  `onDuplicate`, `ZipLimits` defaults) without a recorded human decision

### 3. Determinism
- `deterministic: true` bytes unchanged: `npm run verify:samples` green, the
  golden hash of `tests/core/zip-determinism.test.ts` untouched
- `docs/guides/determinism.md` rows match the writer (versions-needed, extras,
  descriptors, timestamps, name order, canonical form)
- `analyzeDeterminism()` agrees with the contract on every sample

### 4. Compatibility (zero breaking change)
- `docs/assets/api.json` versus the previous tag: additions only
  (`tests/tools/api-compat.test.ts`)
- The 39 error codes unchanged (`tests/core/zip-error-codes.test.ts`);
  diagnostics additive; unions widened, never narrowed
- Behaviour changes listed in the release note's Upgrade section with their
  class (bug fix / additive) and their guard

### 5. Cross-platform
- Pure TypeScript: no Node-only API in `src/` outside the string-hidden
  dynamic imports (`node:zlib`, `node:worker_threads`)
- `Uint8Array` everywhere, never `Buffer`; `ReadableStream` sources released
  without cancel
- ESM + CJS dual exports resolve (`npm run check:package`: attw + publint);
  the worker subpath loads by URL
- The gate is green on Linux, Windows and macOS (ci.yml `os` job)

### 6. Zero-dependency verification
- No runtime `dependencies` in package.json; `npm sbom --omit dev` is empty
- No `require()`/`import()` of a package name in `src/`
- `"sideEffects": false` honoured (`tests/integration/treeshake.test.ts`)

### 7. Interop
- `npm run test:interop`: six foreign extractors read every generated archive;
  six foreign producers' archives are read; every `excludeTools` entry is
  justified by the tool's actual, reproduced behaviour

### 8. Documentation and machine surfaces
- `npm run verify:docs` passes without warnings; every count in prose equals
  the manifest; `docs/data/errors.json`, `surfaces.json`, `api.json`,
  `llms-index.json` and `docs/agent-brief.md` describe what shipped
