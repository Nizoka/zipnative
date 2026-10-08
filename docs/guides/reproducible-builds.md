# Reproducible builds

> Measure, canonicalise, prove. `deterministic: true` has made zipnative's
> own output reproducible since 0.2; 1.1 extends the guarantee to archives
> you did not build — a Gradle JAR, a Maven artefact, an Explorer ZIP, a
> `zip` from a CI image — with a report that says what would drift, a
> canonical rewrite that fixes it without recompression, and a transplant
> primitive that assembles artefacts from existing parts in O(bytes copied).

## Why archives drift

Two builds of the same sources rarely produce the same ZIP: tools write the
wall-clock modification time into every entry, enumerate the file system
in whatever order it returns, add tool-specific extra fields (Unix times,
NTFS times, uid/gid), and link against different zlib builds. Debian's
`strip-nondeterminism`, Gradle's `preserveFileTimestamps = false` +
`reproducibleFileOrder = true` and Maven's `project.build.outputTimestamp`
each solve it for one producer. zipnative solves it once, for any producer,
and ties the result to a written byte contract.

## 1. Measure — `analyzeDeterminism()`

```ts
import { analyzeDeterminism } from 'zipnative';

const report = analyzeDeterminism(bytes);
report.deterministic;        // the verdict
report.epochTimestamps;      // every entry at the DOS epoch?
report.canonicalOrder;       // raw name bytes ascending?
report.utf8Flags;            // bit 11 on every non-ASCII name?
report.canonicalExtras;      // no extra field other than Zip64?
report.canonicalVersionMadeBy;
report.noDataDescriptors;    // informational — a streamed layout never fails the verdict
for (const { name, concern } of report.offenders) console.log(name, concern);
// concern: 'timestamp' | 'order' | 'utf8-flag' | 'extra-field' | 'version-made-by' | 'data-descriptor'

// Timestamps are checked against the DOS epoch; for an archive canonicalised
// with a pinned date, pass that date (and the dosTimeMode it was written with):
analyzeDeterminism(bytes, { date: pinned, dosTimeMode: 'utc' });
```

The report is what the CLI's `inspect --check deterministic` and the MCP
server's `inspect_zip` re-derived from `entries()` in 1.0.0; it throws like
`openZip()` when the bytes are not a well-formed archive (a report about an
archive that cannot be opened would be meaningless) and never for
conformance concerns.

## 2. Canonicalise — `canonicalizeZip()`

```ts
import { canonicalizeZip } from 'zipnative';

const canonical = canonicalizeZip(bytes);
analyzeDeterminism(canonical).deterministic;      // true
canonicalizeZip(canonical);                        // byte-identical: idempotent
```

The canonical form, applied to every entry of any archive:

| Aspect | Rule |
|---|---|
| Entry order | sorted by raw name bytes, unsigned bytewise — the writer's default `order: 'canonical'` |
| Timestamps | the DOS epoch, or one pinned `date` (`dosTimeMode` applies) |
| Name encoding | UTF-8 with flag bit 11 for every non-ASCII name; the raw bytes are never re-encoded |
| version-made-by | the constant `0x032D` |
| Extra fields | dropped, except Zip64 (0x0001), which is recomputed |
| Comments | dropped unless `keepComments: true` (archive and entry comments alike) |
| External attributes | kept — Unix modes are content — unless `keepExternalAttributes: false` resets them to the writer's defaults |
| Payloads | copied bit for bit: no decompression, no recompression, no dependency on the codec that produced them |
| Layout | the compact layout of `saveCompact()`: no data descriptors, no SFX prefix, no dead bytes |

The same transformation is available on the modifier —
`createZipModifier(openZip(bytes)).saveCompact({ canonical: true })` or
`{ canonical: { date, keepComments, keepExternalAttributes } }` — so an
edit and a canonical rewrite are one pass.

**The canonical bytes are part of the frozen determinism contract.** The
golden SHA-256 hashes in
[tests/parser/zip-canonical.test.ts](https://github.com/Nizoka/zipnative/blob/main/tests/parser/zip-canonical.test.ts)
pin the output of `canonicalizeZip` over two committed foreign fixtures;
changing them is a semver-major release, exactly like the pinned encoder's
bytes.

## 3. Prove — the gate

```ts
import { createHash } from 'node:crypto';
import { analyzeDeterminism, canonicalizeZip } from 'zipnative';

const artefact = canonicalizeZip(await build());      // whatever produced it (add { date } to pin one — then pass the same date below)
if (!analyzeDeterminism(artefact).deterministic) throw new Error('canonical form broken');
const digest = createHash('sha256').update(artefact).digest('hex');
if (digest !== GOLDEN_SHA256) throw new Error(`artefact drifted: ${digest}`);
```

A canonical artefact compares byte-for-byte across runners and across the
tools that produced it. Pair it with the writer's `deterministic: true`
when zipnative is the producer (the pinned encoder makes the *compressed
bytes* identical too); canonicalisation keeps a foreign producer's
compressed bytes, so the digest holds as long as that producer's output
does — which is what `strip-nondeterminism` promises as well, and why the
report lists `extra-field` and `timestamp` concerns separately from the
codec.

## 4. Assemble — `addRaw()` and `addFromReader()`

Build artefacts are often assembled from parts that already exist as
archives: a JAR from a class archive and a resources archive, an OOXML
document from its parts, a release bundle from per-platform builds. 1.1
transplants entries without decompressing them:

```ts
import { createZip, openZip } from 'zipnative';

const out = createZip({ compression: { deterministic: true } });
const classes = openZip(classesZip);
const resources = openZip(resourcesZip);

for (const entry of classes.entries()) out.addFromReader(classes, entry);
for (const entry of resources.entries()) out.addFromReader(resources, entry, { verify: false }); // trusted source
// A payload you compressed yourself, or lifted with readEntryRaw() (the
// compressed bytes as a Uint8Array): the entry carries the metadata.
const source = classes.getEntry('META-INF/MANIFEST.MF')!;
out.addRaw('META-INF/MANIFEST.MF', classes.readEntryRaw(source), {
    method: source.compressionMethod,       // 8 = deflate, 0 = store
    crc32: source.crc32,
    uncompressedSize: source.uncompressedSize,
});

const jar = out.toBytes();   // bytes are a function of the inputs and the call order under order: 'insertion'
```

`addFromReader()` copies method, CRC, sizes, timestamp, attributes, comment
and extra fields (Zip64 excluded — recomputed), and **verifies the source
entry first**: a corrupt entry is refused with `ZIP_CRC_MISMATCH` /
`ZIP_SIZE_MISMATCH` instead of propagated. `verify: false` trusts the
source. Entries whose method has no registered codec are copied opaquely
either way — `verifyZip()` later reports them `skipped: 'unsupported-method'`.
Encrypted entries are refused, as `readEntryRaw()` refuses them. Worker
pools never dispatch a raw entry; the sequential and parallel writers
emit identical bytes.

The in-memory reader is the source; a `ZipRangeReader` exposes
`readEntryRaw()` as a promise, so transplanting from a remote archive is a
two-step `await zip.readEntryRaw(entry)` then `addRaw()`.

## Timestamps and time zones

An explicit `Date` is written as a local-time DOS field by default — the
Info-ZIP and 7-Zip convention, byte-compatible with 1.0. A build that
pins a date and must reproduce across machines sets `dosTimeMode: 'utc'`
on the writer (and on the reader, to decode the same instant back):

```ts
const zip = createZip({ defaultDate: new Date('2026-10-07T00:00:00Z'), dosTimeMode: 'utc' });
```

Out-of-range dates clamp — below 1980-01-01 to the epoch, above
2107-12-31 23:59:58 to that maximum, an invalid `Date` to the epoch — with
the `ZIP_TIMESTAMP_CLAMPED` diagnostic (fatal under `strict`); before 1.1
they produced a wrong date silently.

## See also

- [The determinism contract](determinism.html) — the three levels of
  guarantee, the frozen encoder, the canonical compaction rules.
- [Use cases, Case 3](use-cases.html#case-3--the-reproducibility-gate) —
  the reproducibility gate with zipnative as the producer.
- The [`determinism-report`](https://github.com/Nizoka/zipnative/blob/main/recipes/determinism-report.ts)
  recipe, and `zipnative inspect --check deterministic` on the CLI.
