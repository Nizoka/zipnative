# Quickstart

> Install zipnative and cover the four core workflows — reading with random
> access, secure extraction, deterministic creation, and incremental
> modification — in about five minutes.

## Install

```bash
npm install zipnative
```

Node ≥ 22, browsers, Deno, Bun and Workers share one API. Zero runtime
dependencies — what you install is what runs.

## Read with random access

```ts
import { openZip } from 'zipnative';

const zip = openZip(bytes);          // lazy: only the trailer is located
console.log(zip.entryCount);

for (const entry of zip.entries()) {
    console.log(entry.name, entry.uncompressedSize);
}

const manifest = zip.readEntry('manifest.json'); // one entry, CRC-verified
for await (const chunk of zip.readEntryStream('video.bin')) {
    // bounded memory for large entries
}
```

## Extract securely

```ts
import { extractZip } from 'zipnative';

const files = extractZip(bytes);
// Traversal, symlinks, duplicate names and decompression bombs are
// rejected BY DEFAULT — opting out is always explicit.
for (const file of files) {
    console.log(file.path, file.data.length); // path is sanitized, relative
}
```

The engine never touches a filesystem; join `file.path` under your own
root (see the [security guide](security.html)).

## Create — reproducibly

```ts
import { createZip } from 'zipnative';

const zip = createZip({ compression: { deterministic: true } });
zip.add('data.json', JSON.stringify(payload));
zip.add('raw.bin', bytes, { compression: { method: 'store' } });

const archive = zip.toBytes();       // sync
// or, with bounded memory and byte-identical output:
for await (const chunk of zip.stream()) { /* send */ }
```

Identical inputs give identical SHA-256 on every runtime — the
[determinism contract](determinism.html).

## Modify without recompressing

```ts
import { createZipModifier, openZip } from 'zipnative';

const mod = createZipModifier(openZip(bytes));
mod.replaceEntry('config.json', '{"version":2}');
mod.removeEntry('obsolete.log');

const updated = mod.save();          // append-only: untouched entries untouched
const compact = mod.saveCompact();   // true deletion, still no recompression
```

Note: `save()` keeps every original byte — removed content remains
recoverable; `saveCompact()` is the deletion path.

## Going further

- Parallel creation across worker threads: `import { createParallelZip } from 'zipnative/worker'`.
- Reading unseekable streams: `iterateZipEntries(source)` — local headers
  only, so prefer `openZip()` whenever the whole archive is available.
- Every error message starts with `zipnative:` and names the remedy.
