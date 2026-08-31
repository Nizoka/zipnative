# Benchmarks

Run with `npm run bench` (vitest bench). Results are committed as prose in
`RESULTS.md` with machine/Node/zlib versions, regenerated manually per minor
release — benchmarks are **never** a blocking CI gate.

## Comparators

`fflate`, `jszip` and `adm-zip` appear here as devDependencies **for
benchmarking only** — they are never imported from `src/` (enforced by the
`no-restricted-imports` ESLint rule). They are added to package.json in
milestone M2, when there is a writer to measure.

## Policy

Benchmark scenarios measure what zipnative is *for* — random access to one
entry of a large archive, central-directory walk of a 10k-entry archive,
streaming a 100 MB entry with peak-RSS recorded, in-place single-entry
update. Raw deflate throughput drag races vs fflate are out of scope by
policy: fflate's hand-tuned deflate is faster and we say so in the README.
