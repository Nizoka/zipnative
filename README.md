# zipnative

**A safe, deterministic, streaming ZIP engine for modern apps — and for the agents that operate them.**

![Zero runtime dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![TypeScript strict mode](https://img.shields.io/badge/TypeScript-strict-blue)
![91.7 percent statement coverage](https://img.shields.io/badge/coverage-91.7%25-brightgreen)
![Node 22 or newer](https://img.shields.io/badge/node-%E2%89%A522-blue)
![MIT license](https://img.shields.io/badge/license-MIT-blue)

Zero runtime dependencies. 100% TypeScript. One API across Node.js ≥ 22, browsers, Deno, Bun and Workers. Built for the archives that actually matter in 2026 — OOXML, EPUB, JAR/VSIX, and multi-gigabyte data drops that must never be buffered whole — under the same engineering doctrine as [pdfnative](https://github.com/Nizoka/pdfnative).

> **Status: pre-1.0.** The engine is feature-complete — read (v0.1), deterministic write (v0.2), incremental modification (v0.4), workers + forward streaming (v0.5), resumable inflater (v0.6), the expanded interop gate and guide renderer (v0.7), and the **frozen machine-readable error-code vocabulary** (v0.8). The [roadmap](ROADMAP.md) continues with the final API-freeze release candidate toward 1.0. Documentation: [zipnative.dev](https://zipnative.dev) (site sources in [docs/](docs/), interactive [playgrounds](docs/playgrounds/) included).

## Why zipnative?

Most ZIP libraries make you choose between speed, safety and capability. zipnative's positioning is different:

- **Safe by default.** Extraction refuses path traversal (zip-slip), symlink entries, duplicate names and decompression bombs unless you explicitly opt out. Every parser loop runs under a named, CWE-tagged, caller-configurable bound. Ambiguous archives (conflicting end-of-central-directory records, Zip64 field spoofing, overlapping entries) are rejected, not guessed at.
- **Random access.** Read one entry from a 4 GB archive without extracting — or even scanning — the rest. The central directory is parsed lazily; entry payloads are zero-copy subarrays.
- **Streaming.** Iterate entries and decompress through async iterables with bounded memory. Designed for serverless and Cloudflare Workers, not just long-lived servers.
- **Deterministic.** Reproducible-build mode with a [written determinism contract](docs/guides/determinism.md): same inputs, same SHA-256 on every runtime via the pinned pure-TS deflate encoder. Canonical entry ordering, pinned timestamps, no environment leakage.
- **Incremental modification.** Replace, remove, add or rename entries and `save()` without recompressing the untouched 99% of the archive — the append-only overlay model proven in pdfnative's PDF incremental updates. `saveCompact()` is the true-deletion path (removed content is otherwise still recoverable — [documented loudly](SECURITY.md)).
- **Agent-pilotable.** Every thrown error carries a **stable machine-readable `err.code`** from a frozen 39-code vocabulary (v0.8+ — registry in [docs/data/errors.json](docs/data/errors.json), guide in [docs/guides/errors.md](docs/guides/errors.md)): branch on the code, never on message text. Plus remedy-bearing messages, a structured diagnostics channel, executable recipes, four documented [production use cases](docs/guides/use-cases.md), `llms.txt`, and a human-in-the-loop AI governance policy.

### Comparison (honest version)

|  | zipnative | fflate | jszip | yauzl/yazl | adm-zip |
|---|---|---|---|---|---|
| Zero runtime dependencies | ✅ | ✅ | ❌ | ❌ | ❌ |
| Random access (1 entry without full parse) | ✅ | ❌ | ❌ | yauzl ✅ | ❌ |
| Streaming read + write | ✅ | partial (low-level) | ❌ (memory-bound) | read *or* write per lib | ❌ |
| Safe-extract defaults (slip/bomb/ambiguity) | ✅ | DIY | DIY | DIY | historical CVEs |
| Deterministic output (documented contract) | ✅ | DIY | ❌ | ❌ | ❌ |
| Modify in place, no recompression | ✅ | ❌ | rewrite-all | ❌ | partial |
| Browser + Node + Deno + Bun + Workers | ✅ | ✅ | ✅ | Node-only | Node-only |
| Raw deflate throughput | good (platform zlib) | **best** | slow | good | poor |

fflate keeps the raw-deflate-speed crown and we do not chase it: zipnative uses the platform's native codecs (`node:zlib`, `CompressionStream`) behind a pluggable seam, and wins on *scenarios* — random access, bounded-memory streaming, in-place updates — not drag races.

## Installation

```bash
npm install zipnative
```

## Quick start

```ts
import { openZip, extractZip } from 'zipnative';

// Open an archive — lazy: only the central directory is located, nothing decompressed.
const zip = openZip(bytes);

console.log(zip.entryCount);
for (const entry of zip.entries()) {
    console.log(entry.name, entry.uncompressedSize);
}

// Random access: decompress exactly one entry, CRC-verified.
const manifest = zip.readEntry('manifest.json');

// Stream a large entry with bounded memory.
for await (const chunk of zip.readEntryStream('video.mp4')) {
    // ...
}

// Secure extraction (in memory — filesystem sinks belong to zipnative-cli).
const files = extractZip(bytes, {
    limits: { maxEntries: 10_000, maxTotalUncompressedSize: 1024 * 1024 * 1024 },
    // rejectTraversal: true and rejectSymlinks: true are the DEFAULTS.
});
```

Creating archives (v0.2):

```ts
import { createZip } from 'zipnative';

const zip = createZip({
    // Pin the pure-TS encoder: identical inputs → identical SHA-256,
    // on every runtime. See docs/guides/determinism.md.
    compression: { deterministic: true },
});
zip.add('manifest.json', JSON.stringify(manifest));
zip.add('assets/logo.png', logoBytes, { compression: { method: 'store' } });
zip.addDirectory('assets');

const bytes = zip.toBytes();          // sync, buffered
// — or, with bounded memory (serverless/Workers), byte-identical output:
for await (const chunk of zip.stream({ chunkSize: 64 * 1024 })) {
    // send chunk...
}

// Large content from an async source (data-descriptor layout):
zip.addStream('video.bin', chunkSource);
```

Modifying an existing archive (v0.4):

```ts
import { createZipModifier, openZip } from 'zipnative';

const modifier = createZipModifier(openZip(bytes));
modifier.replaceEntry('word/document.xml', newDocumentXml);
modifier.addEntry('docProps/custom.xml', customProps);
modifier.removeEntry('word/obsolete.xml');

// Append-only: untouched entries are never recompressed; the original
// bytes are preserved verbatim (removed content stays recoverable!).
const updated = modifier.save();
// True deletion + compact canonical layout, still no recompression:
const compacted = modifier.saveCompact();
```

Parallel creation across worker threads (v0.5, `zipnative/worker`):

```ts
import { createParallelZip } from 'zipnative/worker';

const zip = createParallelZip(); // pool sized from your cores, capped at 8
zip.add('a.bin', bigBufferA);    // entries deflate concurrently
zip.add('b.bin', bigBufferB);
const bytes = await zip.toBytes(); // async — the one signature difference

// Byte-identical to createZip() for the same inputs (per compression
// tier; unconditional with compression: { deterministic: true }).
// Worker failures degrade gracefully — the archive never fails for
// infrastructure reasons.
```

Reading an unseekable stream (v0.5 — pipes, uploads, serverless bodies):

```ts
import { iterateZipEntries } from 'zipnative';

for await (const entry of iterateZipEntries(request.body)) {
    console.log(entry.header.name, entry.header.uncompressedSize);
    if (wanted(entry.header.name)) {
        for await (const chunk of entry.data()) { /* bounded memory */ }
    } else if (entry.header.compressedSize > 0) {
        await entry.skip();
    }
}
// TRUST CAVEAT: forward iteration reads local headers alone — no central
// directory cross-check. Use openZip() whenever the full archive is
// available; it is the authoritative path.
```

**Bundler notes for `zipnative/worker`**: the worker script is resolved as `new URL('./zip-worker.js', import.meta.url)`, which Vite and webpack 5 detect and bundle automatically. If your bundler cannot (or your CSP restricts worker sources), pass `workerUrl` explicitly — e.g. `createParallelZip({ workerUrl: new URL('zip-worker.js', yourAssetBase) })` — pointing at a copy of the script served from your origin (locate it with `import.meta.resolve('zipnative/worker/zip-worker.js')` — a dedicated subpath export since 0.8). On runtimes without workers the same code runs entirely on the calling thread.

Everything public is exported from the single entry point; if it is not in `zipnative`'s root import, it is private.

## Security model

zipnative treats every archive as untrusted input. The guards, their defaults and their CWE mappings are documented in [SECURITY.md](SECURITY.md). Highlights:

- decompression output capped per entry and in total, with a compression-ratio bound (CWE-400/409);
- path traversal rejected — `..` segments, absolute paths, drive letters, backslashes, NUL bytes, NTFS alternate data streams (CWE-22);
- symlink entries rejected by default (CWE-59);
- overlapping entries and central-directory/local-header disagreement rejected (parser-differential smuggling);
- Zip64 sentinel spoofing cross-checked; ambiguous EOCD placement refused;
- the engine never opens a socket, never touches the filesystem, and never evals.

## Known limitations

- `iterateZipEntries` reads data-descriptor entries (flag bit 3) for plain deflate since v0.6 — including zipnative's own `addStream()` output and bsdtar-style archives. Still refused: store+bit3 (not self-delimiting), encrypted+bit3, and custom-codec+bit3; `skip()` on a bit-3 entry costs a full decompress-and-discard.
- Codec injection (`setDeflateImpl`, `registerCodec`) on the main entry does not propagate to the `zipnative/worker` bundle (separate module state); parallel/sequential byte-identity is promised for the built-in tiers.
- `save()` keeps every original byte: removed/replaced content remains recoverable in the output (use `saveCompact()` for true deletion); `saveCompact()` drops SFX prefixes; archives with duplicate entry names cannot be modified incrementally.
- `addStream` entries beyond 4 GiB are rejected with a typed error — buffer via `add()`; the Zip64-streaming opt-in design is a 0.9 roadmap item. Buffered entries, entry counts and archive offsets are fully Zip64.
- Since v0.8.1, default extraction also refuses entries whose names are **Windows reserved device names** (`CON`, `NUL`, `COM1`…`LPT9` — CWE-67) or that collapse to nothing (`.`, `./`). Archives authored on POSIX systems containing files like `aux.h` therefore throw by default on **every** platform; pass `rejectTraversal: false` to skip such entries instead.
- Without `CompressionStream` on the runtime (or when `deterministic: true` is requested), stream-entry compression buffers the entry before compressing — a documented memory caveat.
- Number fields above `Number.MAX_SAFE_INTEGER` (≈ 9 PB) are rejected; the public API uses `number`, not `bigint`.
- Default deflate output is byte-stable per environment but not across zlib builds; pin `compression: { deterministic: true }` for cross-runtime identity — the full contract lives in [docs/guides/determinism.md](docs/guides/determinism.md).

## What zipnative will NOT do

- **No encryption, read or write, through 1.0.** ZipCrypto is cryptographically broken (Biham–Kocher); writing it would be harm dressed as a feature. AES (AE-2) may come post-1.0 behind an injected crypto provider. Encrypted entries are *detected* (`entry.isEncrypted`) and reads fail with a typed `ZipUnsupportedError`.
- **No other archive formats.** No 7z, RAR, tar, gzip; no zstd/bzip2/LZMA codecs built in (the codec registry is the extension point).
- **No multi-disk/spanned archives** — detected and refused cleanly.
- **No filesystem I/O in the engine.** Extraction returns data plus sanitized paths; writing files to disk is the CLI's job.
- **No archive repair/salvage** (rebuilding a central directory from local headers) — v1 errors cleanly instead of guessing.
- **No network access, ever.**

## Ecosystem

| Package | Purpose | Status |
|---|---|---|
| `zipnative` | core engine (this repo) | active |
| `zipnative-cli` | command-line tool, agent-grade JSON contract | planned post-1.0 |
| `zipnative-mcp` | MCP server for AI agents | planned post-1.0 |

The core stays dependency-free by exiling every dependency-bearing integration to a satellite repo — the pdfnative ecosystem pattern.

## Development

```bash
npm ci
npm run typecheck:all   # src + tests + scripts
npm run lint
npm run test:coverage
npm run build
npm run test:interop    # validate generated archives with unzip/7z/Expand-Archive/jar
```

Conventions live in [AGENTS.md](AGENTS.md) and `.github/instructions/`. Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Origin

zipnative is the second library in the *native* family, applying the architecture proven by [pdfnative](https://github.com/Nizoka/pdfnative): zero dependencies, closure factories instead of classes, append-only incremental modification, a shared segment generator guaranteeing buffered and streaming output are byte-identical, determinism as a product feature, and CWE-tagged bounds on every untrusted-input loop.

## License

[MIT](LICENSE)
