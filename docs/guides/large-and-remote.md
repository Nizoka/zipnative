# Large and remote archives

> Open an archive of any size — on S3, behind an HTTP `Range` server, in a
> browser `File`, on a local file handle — with the memory of its central
> directory. The engine never fetches: you inject a byte-range source, it
> asks for exactly the bytes a read needs, and every security check of the
> in-memory reader applies unchanged. Cancellation and progress ride on
> every asynchronous call; the Zip64 streaming opt-in covers the writing
> side above 4 GiB.

## The byte-range source

`openZipRange()` (1.1) takes a `ByteRangeSource` instead of bytes:

```ts
import { openZipRange, type ByteRangeSource } from 'zipnative';

const source: ByteRangeSource = {
    size: contentLength,                       // the archive's total size, known up front
    async read(offset, length) {               // exactly these bytes, as a Uint8Array
        const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
        if (res.status !== 206) throw new Error(`range request refused: ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
    },
};

const zip = await openZipRange(source);
console.log(zip.entryCount, zip.isZip64);
for (const entry of zip.entries()) console.log(entry.name, entry.uncompressedSize);

const manifest = await zip.readEntry('META-INF/manifest.json');   // CRC-verified
for await (const chunk of zip.readEntryStream('data/large.parquet')) {
    // 256 KiB ranged reads, decoded chunk by chunk — memory stays O(chunk)
}
```

What the reader fetches, and nothing else:

| Step | Bytes requested |
|---|---|
| open | one tail window — the end-of-central-directory record, its Zip64 locator and record when present: the APPNOTE scan window (a 64 KiB comment plus the records) plus 64 KiB of slack, about 195 KiB at most, or the whole archive when it is smaller |
| `entries()` | the central directory, once — after `maxCentralDirectoryBytes` has been checked against the declared size, never before |
| `readEntry` / `readEntryStream` | the entry's local header (30 bytes plus its name and extra fields), then its compressed payload — whole for `readEntry`, in 256 KiB ranges for `readEntryStream` |
| `readEntryRaw` / `verifyEntry` | the local header and the whole compressed payload |

Every cross-check `openZip()` performs runs here on the same code: the
overlap defence over central-directory ranges, the local-header
comparison (method divergence fatal, size and CRC divergence fatal without
a data descriptor, name divergence diagnosed), the Zip64 sentinel rules,
the declared-size and compression-ratio limits, and the output counting
during inflation. A source that lies — a `size` smaller than the records
imply, a `read()` that returns fewer bytes than asked — is reported as
`ZIP_RECORD_TRUNCATED`, never papered over.

### Adapters

The engine ships no transport, by doctrine (no sockets, no filesystem).
Each adapter is a few lines in your code:

```ts
// Browser File / Blob
const fromBlob = (blob: Blob): ByteRangeSource => ({
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
});

// Node file handle
import { open } from 'node:fs/promises';
const handle = await open('archive.zip', 'r');
const fromHandle: ByteRangeSource = {
    size: (await handle.stat()).size,
    async read(offset, length) {
        const buf = new Uint8Array(length);
        const { bytesRead } = await handle.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
    },
};

// S3-style object storage
const fromObject = (client: { getRange(o: number, l: number): Promise<Uint8Array> }, size: number): ByteRangeSource => ({
    size,
    read: (offset, length) => client.getRange(offset, length),
});
```

`rangeSourceFromBytes(bytes)` wraps an in-memory archive for tests and
parity checks — the test suite opens the whole sample corpus through both
readers and asserts identical entries, bytes, diagnostics and error codes.

### One new limit

`readEntry`, `readEntryRaw` and `verifyEntry` allocate the compressed
payload as one buffer from an untrusted length, so they consult a limit
the in-memory reader does not need (its payloads are zero-copy views):
`maxEntryCompressedSize`, default 1 GiB + 1 MiB (the uncompressed cap plus
deflate's worst-case expansion), CWE-770. Raise it explicitly for trusted
sources; `readEntryStream` never needs it.

## Cancellation and progress

Every asynchronous call takes `signal` and `onProgress` (1.1). They
live on the options of the call that creates the operation —
`extractZipStream(bytes, options)`, `iterateZipEntries(source, options)`,
`openZip(bytes, options)` / `openZipRange(source, options)` for every read
of that reader, `createZip(options)` / `createParallelZip(options)` for
every `stream()` and `toBytes()` of that writer — and, per call, on
`readEntryStream(entry, options)` and `stream(options)`, where they
override the factory's for that call only.

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(new Error('deadline')), 30_000);

const zip = await openZipRange(source, {
    signal: controller.signal,
    onProgress: ({ entriesDone, entriesTotal, bytesIn, bytesOut }) => render(entriesDone, entriesTotal, bytesIn, bytesOut),
});
```

An abort rejects with `signal.reason` — the platform convention, not a new
ZIP error code — after the engine has released what it held: a
`ReadableStream` lock is released without cancelling the stream (the
0.9 contract, so the caller can resume or close it), worker pools are
closed, no read is left in flight. A signal that is already aborted
rejects before the first byte is requested. Synchronous calls ignore
`signal` by construction — there is nothing to interrupt — and the option
is documented as such rather than silently accepted.

`ZipProgress` is monotonic: `entriesDone` and `bytesOut` only grow,
`entriesTotal` is `null` on the forward reader (the count is not known
until the central directory) and exact everywhere else. A skipped entry
counts as done. The parallel writer's `toBytes()` reports one step per
settled entry, then the archive length; `stream()` reports every chunk.

## Writing above 4 GiB: the Zip64 streaming opt-in

Buffered entries (`add()`) promote to Zip64 automatically. A streamed entry
(`addStream()`) cannot: its sizes are unknown when its local header is
written, and the classic data-descriptor layout cannot represent 4 GiB.
Since 1.1 an entry opts in:

```ts
const zip = createZip();
zip.addStream('backup.tar', chunks, { zip64: true });   // only for entries that MAY exceed 4 GiB
for await (const chunk of zip.stream()) sink.write(chunk);
```

The opted-in entry writes the APPNOTE 4.3.9.2 layout: version 45 in both
records, sentinel sizes and a Zip64 extra field with both sizes zero in
the local header, a 24-byte data descriptor, and a central record whose
Zip64 extra carries both final sizes (the offset only when it overflows).
Every random-access extractor of the interop matrix (unzip, 7-Zip, bsdtar,
Python, `jar`, `Expand-Archive`) reads it; a *streaming* reader that
sizes the descriptor from the measured lengths — Java's `ZipInputStream`
is the known one — cannot read an opted-in entry that stayed below 4 GiB.
That is inherent to any speculative Zip64 layout (Info-ZIP's `zip -fz`
has the same property), which is why the option is per entry and the
TSDoc says "only for entries that may exceed 4 GiB".

Without the opt-in, a stream that crosses 4 GiB is still refused with
`ZIP_UNSUPPORTED_ZIP64_STREAMING`, before the crossing chunk is emitted.
Under `deterministic: true` the pinned encoder buffers each stream entry
and caps it at 2 GiB (`ZIP_INPUT_TOO_LARGE`): the opt-in is for `store` or
the default tier.

## Reading what you wrote

- `openZip()` and `openZipRange()` read every Zip64 form, opted-in entries
  included; `verifyZip()` reports them `ok`.
- `iterateZipEntries()` streams deflate entries with data descriptors —
  the opt-in layout included — and still refuses store + bit 3 (not
  self-delimiting) and encrypted entries.
- The `zip64/zip64-streamed.zip` sample is validated clause by clause by
  the ISO/IEC 21320-1 gate and extracted byte-for-byte by the interop
  matrix on every release.

## See also

- [Security model](security.html) — the limits table and the injected
  decoders and sources section.
- [The determinism contract](determinism.html) — what the opt-in changes in
  the emitted bytes.
- The [`remote-range` recipe](https://github.com/Nizoka/zipnative/blob/main/recipes/remote-range.ts)
  and the [remote playground](../playgrounds/remote.html), which counts the
  range reads live.
