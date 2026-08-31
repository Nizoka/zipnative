---
description: "Performance rules — zero-copy, laziness, no drag races"
applyTo: "src/**,bench/**"
---

# Performance rules

- **Zero-copy discipline**: slices of the source archive are `subarray`
  views. The only sanctioned copies are decompression output and the final
  assembled archive.
- **Laziness discipline**: `openZip` locates the EOCD and validates counts —
  nothing else. CFH records parse on iteration; the name index Map builds on
  first `getEntry`; overlap ranges build on first read (or `validate:
  'eager'`). Don't front-load work the caller may never need.
- Streaming writers free buffers as segments are emitted; peak memory for
  stream-sourced entries is O(chunk), not O(entry).
- Hot loops (CRC, inflate, scan) use typed arrays and local variable
  binding; no closures allocated per byte.
- **No deflate drag races**: the engine's speed story is platform codecs +
  architecture (random access, lazy CD, zero-copy). A benchmark PR whose
  headline is a % vs fflate on raw deflate throughput is out of scope by
  policy (see AGENT_RULES). Benchmark scenarios instead: single-entry random
  access, 10k-entry CD walk, streaming memory ceiling, in-place update.
