# zipnative

**A safe, deterministic, streaming ZIP engine for modern apps — and for the agents that operate them.**

Zero runtime dependencies. 100% TypeScript. One API across Node.js ≥ 22, browsers, Deno, Bun and Workers. Built for the archives that actually matter in 2026 — OOXML, EPUB, JAR/VSIX, and multi-gigabyte data drops that must never be buffered whole — under the same engineering doctrine as [pdfnative](https://github.com/Nizoka/pdfnative).

> **Status: pre-1.0.** The read path (v0.1) is implemented and hardened; the deterministic writer, incremental modification and worker parallelism follow the [roadmap](ROADMAP.md). APIs may change before 1.0.

## Why zipnative?

Most ZIP libraries make you choose between speed, safety and capability. zipnative's positioning is different:

- **Safe by default.** Extraction refuses path traversal (zip-slip), symlink entries, duplicate names and decompression bombs unless you explicitly opt out. Every parser loop runs under a named, CWE-tagged, caller-configurable bound. Ambiguous archives (conflicting end-of-central-directory records, Zip64 field spoofing, overlapping entries) are rejected, not guessed at.
- **Random access.** Read one entry from a 4 GB archive without extracting — or even scanning — the rest. The central directory is parsed lazily; entry payloads are zero-copy subarrays.
- **Streaming.** Iterate entries and decompress through async iterables with bounded memory. Designed for serverless and Cloudflare Workers, not just long-lived servers.
- **Deterministic** *(v0.2)*. Reproducible-build mode with a written determinism contract: same inputs, same SHA-256. Canonical entry ordering, pinned timestamps, no environment leakage.
- **Incremental modification** *(v0.4)*. Replace, remove or add entries and save without recompressing the untouched 99% of the archive — the append-only overlay model proven in pdfnative's PDF incremental updates.
- **Agent-pilotable.** Typed errors with the remedy in the message, a structured diagnostics channel, executable recipes, `llms.txt`, and a human-in-the-loop AI governance policy.

### Comparison (honest version)

|  | zipnative | fflate | jszip | yauzl/yazl | adm-zip |
|---|---|---|---|---|---|
| Zero runtime dependencies | ✅ | ✅ | ❌ | ❌ | ❌ |
| Random access (1 entry without full parse) | ✅ | ❌ | ❌ | yauzl ✅ | ❌ |
| Streaming read + write | ✅ | partial (low-level) | ❌ (memory-bound) | read *or* write per lib | ❌ |
| Safe-extract defaults (slip/bomb/ambiguity) | ✅ | DIY | DIY | DIY | historical CVEs |
| Deterministic output (documented contract) | ✅ (v0.2) | DIY | ❌ | ❌ | ❌ |
| Modify in place, no recompression | ✅ (v0.4) | ❌ | rewrite-all | ❌ | partial |
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

- The v0.1 release is **read-only**: `openZip`, `readEntry`, `readEntryStream`, `extractZip`. Writing, modification and workers land per the [roadmap](ROADMAP.md).
- Number fields above `Number.MAX_SAFE_INTEGER` (≈ 9 PB) are rejected; the public API uses `number`, not `bigint`.
- Deflate output is byte-stable per environment but not across zlib builds unless the deterministic pure-TS encoder is pinned (v0.2 — the contract will be documented in `docs/determinism.md` before anyone can depend on it).

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
