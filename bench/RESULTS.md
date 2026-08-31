# Benchmark results

Regenerated manually per minor release (`npm run bench`); never a CI gate.

**Machine**: Windows 11 Pro (win32), Node.js v22.17.0 (V8 12.4, zlib via
node:zlib), zipnative v0.2.0, vitest bench v4.1.11.
**Comparators**: fflate 0.8.x, jszip 3.10.x, adm-zip 0.6.x (devDependencies,
bench-only).

## Scenario results (2026-09-01)

### Create archive: 1000 small entries (deflate)

| library | ops/s | vs fastest |
|---|---|---|
| fflate `zipSync` | 15.2 | **fastest** |
| adm-zip `toBuffer` | 14.3 | 1.06× slower |
| zipnative `createZip` | 7.2 | 2.11× slower |
| jszip `generateAsync` | 5.4 | 2.82× slower |

Honest read: fflate's hand-tuned pure-JS deflate wins raw creation of many
tiny files, as the README says it does. zipnative's per-entry cost is
dominated by per-call codec dispatch on tiny buffers; batching/worker
parallelism is the M4 roadmap item.

### Inventory a 10 000-entry archive (list names/sizes, no decompression)

| library | vs fastest |
|---|---|
| zipnative `openZip` + `entries()` | **fastest** |
| fflate `unzipSync` (no listing API — must decompress everything) | 1.25× slower |
| jszip `loadAsync` | 3.39× slower |
| adm-zip `getEntries` | 14.83× slower |

### Random access: read 1 entry out of 10 000

| library | vs fastest |
|---|---|
| zipnative `getEntry` + `readEntry` | **fastest** |
| fflate `unzipSync` (no partial API — full extract) | 1.04× slower |
| jszip `loadAsync` + single `file()` | 3.37× slower |
| adm-zip `readFile` | 11.83× slower |

Scaling note: this corpus uses ~150-byte entries, the *worst* case for the
random-access comparison — fflate's "extract everything" costs almost
nothing per entry. zipnative's cost is O(central directory) + one entry
regardless of payload size; with megabyte entries the gap becomes orders
of magnitude, and only zipnative (and yauzl) can do it at all without
decompressing the rest.

All zipnative numbers include its always-on security checks (overlap
boundaries, CD/local-header cross-validation, CRC verification).
