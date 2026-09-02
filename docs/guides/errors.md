# Errors and error codes

> Every error zipnative throws carries a stable, machine-readable `code` —
> branch on it, never on message text. The vocabulary below is frozen from
> 0.8.0: removing or renaming a code is semver-major; additions are
> semver-minor.

## The contract

Every thrown error is a `ZipError` (or one of its five subclasses), and
every one carries three stable signals:

- **`err.code`** — a `ZipErrorCode` literal from the closed union in
  `src/types/zip-errors.ts`. This is the machine key: it survives message
  rewording and localization of your own wrappers.
- **`err.name` / `instanceof`** — the class, for coarse routing
  (`ZipSecurityError` means an active-attack shape; `ZipLimitError` means
  a configurable bound fired).
- **`err.message`** — always starts with `zipnative: ` and names the
  remedy. For humans and logs, never for branching.

The machine-readable registry lives at
[`docs/data/errors.json`](../data/errors.json) — one entry per code with
its class, cause and remedy. The `error-parity` rule of `verify:docs`
keeps registry, source unions and this guide in bidirectional sync.

```ts
import { openZip, ZipError } from 'zipnative';

try {
  const reader = openZip(bytes);
} catch (err) {
  if (err instanceof ZipError) {
    switch (err.code) {
      case 'ZIP_EOCD_NOT_FOUND':   return notAZip();
      case 'ZIP_LIMIT_EXCEEDED':   return tooBig(err);
      case 'ZIP_PATH_TRAVERSAL':   return quarantine(err);
      default:                     return fail(err.code, err.message);
    }
  }
  throw err;
}
```

## When to branch on `instanceof` vs `code`

Use `instanceof` when the *policy* is per-class: everything
`ZipSecurityError` goes to quarantine, everything `ZipLimitError` retries
with raised limits on trusted input. Use `code` when the *cause* matters:
`ZIP_CRC_MISMATCH` (corrupt payload) deserves a different message than
`ZIP_DESCRIPTOR_MISMATCH` (hostile stream shape), though both are
`ZipDataError`.

## The vocabulary

### `ZipError` (base — usage and invariant faults)

| Code | Raised when |
|---|---|
| `ZIP_INVALID_OPTION` | An option value fails validation (compression level, chunk size, argument shape). |
| `ZIP_INPUT_TOO_LARGE` | The pure-TS deflate encoder received more than 2 GiB in one call. |
| `ZIP_ENTRY_NOT_FOUND` | A named entry is absent where one is required. Names are case-sensitive. |
| `ZIP_ENTRY_EXISTS` | A named entry is present where absence is required (add over existing; rename onto existing). |
| `ZIP_API_MISUSE` | A usage contract was violated: `toBytes()` with `addStream()` entries, drain-order violations, single-shot reuse. |
| `ZIP_STRICT_DIAGNOSTIC` | `strict: true` escalated a conformance diagnostic; the message embeds the diagnostic code. |
| `ZIP_INTERNAL` | An internal invariant broke — a zipnative bug; report it with a reproduction. |

### `ZipFormatError` (structurally invalid archives)

| Code | Raised when |
|---|---|
| `ZIP_EOCD_NOT_FOUND` | No self-consistent end-of-central-directory record: not a ZIP, truncated, or hostile trailing bytes (zipnative refuses to guess). |
| `ZIP_EOCD_INCONSISTENT` | The EOCD contradicts the layout: entry counts disagree, or the central directory overlaps the record. |
| `ZIP_ZIP64_LOCATOR_MISSING` | Zip64 sentinels are set but the locator record is absent. |
| `ZIP_ZIP64_EOCD_MISPLACED` | The zip64 EOCD is not where the locator points. |
| `ZIP_CD_INCONSISTENT` | The central-directory walk contradicts its declared counts or size. |
| `ZIP_RECORD_TRUNCATED` | A record or an entry's payload overruns the available bytes. |
| `ZIP_SIGNATURE_MISMATCH` | An expected PK signature is absent at a declared position. |
| `ZIP_STREAM_TRUNCATED` | A forward byte stream ended mid-record or mid-entry. |
| `ZIP_VALUE_UNREPRESENTABLE` | A 64-bit field exceeds `Number.MAX_SAFE_INTEGER`. |
| `ZIP_INVALID_ENTRY_NAME` | A writer-side name violates the rules (empty, NUL, backslash, absolute, `..`). |
| `ZIP_DUPLICATE_ENTRY_NAME` | Duplicate names where uniqueness is required (writer `add()`, modifier source archives). |
| `ZIP_DEFLATE_TRUNCATED` | A deflate stream ends mid-block. |
| `ZIP_DEFLATE_CORRUPT` | A deflate stream is structurally invalid (Huffman codes, symbols, back-references, block types). |

### `ZipSecurityError` (active-attack shapes — CWE-tagged)

| Code | CWE | Raised when |
|---|---|---|
| `ZIP_ENTRY_OVERLAP` | CWE-405 | Two entries share bytes. Always rejected; no opt-out. |
| `ZIP_CD_LFH_MISMATCH` | CWE-436 | Local header contradicts the central directory on the method. |
| `ZIP_ZIP64_CONTRADICTION` | CWE-1288 | A zip64 value contradicts a non-sentinel classic field. |
| `ZIP_PATH_TRAVERSAL` | CWE-22 / CWE-67 | An entry name escapes the extraction root (zip-slip) or is a Windows reserved device name (`CON`, `NUL`, `COM1`…). |
| `ZIP_SYMLINK_REJECTED` | CWE-59 | A symlink entry under `rejectSymlinks` (the default). |
| `ZIP_EXTRACT_DUPLICATE_PATH` | CWE-694 | Duplicate output paths under `onDuplicate: 'error'` (the default). |

### `ZipDataError` (content integrity)

| Code | Raised when |
|---|---|
| `ZIP_CRC_MISMATCH` | Decompressed bytes fail the declared CRC-32; `expectedCrc`/`actualCrc` carry both values. |
| `ZIP_SIZE_MISMATCH` | Sizes contradict: declared vs measured, or local vs central metadata. |
| `ZIP_INFLATE_OUTPUT_OVERFLOW` | Inflate produced more than the declared or permitted output. |
| `ZIP_DESCRIPTOR_MISMATCH` | No data-descriptor form matches the measured CRC and sizes of a bit-3 entry. |
| `ZIP_DECOMPRESSION_FAILED` | The active codec failed mid-decompression on a corrupt payload. |

### `ZipLimitError` (configurable security bounds)

Carries `limit` (the `ZipLimits` key), `configured` and `observed`.

| Code | Raised when |
|---|---|
| `ZIP_LIMIT_EXCEEDED` | A configured bound was exceeded — raise `limits.<key>` explicitly if the archive is trusted. |
| `ZIP_LIMIT_INVALID` | The limits override itself is invalid (unknown key, non-positive value); `configured`/`observed` are `NaN`. |

### `ZipUnsupportedError` (deliberate refusals)

Carries `feature` from the closed `ZipUnsupportedFeature` vocabulary:
`'zipcrypto'`, `'strong-encryption'`, `'multi-disk'`, `'zip64-streaming'`,
`'cd-less-descriptor'`, or `` `method:${n}` ``.

| Code | Raised when |
|---|---|
| `ZIP_UNSUPPORTED_ENCRYPTION` | An entry is encrypted — unsupported in 1.x by policy; check `entry.isEncrypted` to route around it. |
| `ZIP_UNSUPPORTED_METHOD` | A compression method has no registered codec — `registerCodec()` one. |
| `ZIP_UNSUPPORTED_MULTI_DISK` | The archive is multi-disk/spanned — an explicit anti-goal. |
| `ZIP_UNSUPPORTED_ZIP64_STREAMING` | An `addStream()` entry exceeds 4 GiB — buffer via `add()` or split. |
| `ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR` | Forward reading met a bit-3 entry it cannot delimit (store/encrypted/custom codec) — use `openZip()`. |
| `ZIP_UNSUPPORTED_CODEC_MODE` | A registered codec supports only the other access mode — the message names the compliant call. |

## Diagnostics are not errors

Non-fatal conformance concerns (odd-but-tolerated shapes, determinism
losses) never throw by default — they flow through the diagnostics
channel with their own closed 11-code vocabulary (`ZipDiagnosticCode`),
documented alongside the errors in
[`docs/data/errors.json`](../data/errors.json). `strict: true` escalates
the first diagnostic into a thrown `ZipError` with code
`ZIP_STRICT_DIAGNOSTIC`; `onDiagnostic` receives every diagnostic
un-deduplicated.

## See also

- [Security model](security.html) — the threat table behind the
  `ZipSecurityError` and `ZipLimitError` families.
- [The determinism contract](determinism.html) — the diagnostics that
  flag reproducibility losses.
