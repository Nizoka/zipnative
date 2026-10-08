# Use cases

> **Five production architectures, each built from parts the ecosystem
> already ships** — one-entry reads that never touch the payload,
> extraction behind always-on guards, byte-reproducible release
> artifacts, forward streaming with no Node in sight, and confidentiality
> delegated to the document layer because the archive layer has no
> password by design. Every arrow in the diagrams below is a public,
> shipped API — nothing here is aspirational.

The [quickstart](quickstart.html) tells you *what* each call does; this
guide shows *how they compose*. Each case names its exact building
blocks, shows the load-bearing code, and states its limits.

## Case 1 — The manifest peek

Most pipelines that "check an archive" decompress all of it to read one
file: the `[Content_Types].xml` of a DOCX, the `extension.vsixmanifest`
of a VSIX, the `manifest.json` of a build output. At ten thousand
entries that is gigabytes of inflate work to answer a two-kilobyte
question. `openZip()` inverts the cost model: the central directory is
parsed lazily as the index it already is, payloads stay zero-copy
subarray views, and **only the one entry you read is ever decompressed —
CRC-verified, with every security check still on**.

![Architecture: a stored artifact archive of ten thousand entries flows into zipnative's openZip, which walks only the central directory lazily with zero-copy views, then readEntry pulls the single manifest entry, CRC-verified. The output is the two-kilobyte answer used to classify, index or route the archive. A dashed loop notes that everything else in the archive is never decompressed. A green band states the cost is proportional to the central directory plus the one entry, with security checks always on; a closing band states the honest limit — openZip needs the archive bytes in memory, remote range transport is the caller's concern.](../assets/use-case-manifest-peek.svg)

```ts
import { openZip, ZipError } from 'zipnative';

const zip = openZip(bytes);                    // lazy: only the trailer is parsed
const entry = zip.getEntry('[Content_Types].xml');
if (entry === null) return reject('not an OOXML package');

const manifest = zip.readEntry(entry);         // ONE entry inflated, CRC-verified
route(classify(manifest));                     // the other 9 999 stay compressed
```

What you gain, concretely:

- **Latency** — classifying is O(central directory) + O(one entry),
  not O(archive). On the 10 000-entry benchmark corpus, inventory plus
  one read is the scenario zipnative wins outright.
- **Memory** — payloads are `subarray` views of the input; nothing is
  copied until you decompress it.
- **Safety** — the peek runs behind the same overlap detection,
  CD/local-header cross-validation and CWE-tagged limits as a full
  extraction. A hostile archive fails with a stable `err.code`, not
  with a wrong answer.

Honest limits: `openZip()` needs the archive bytes in memory — fetching
a remote tail with HTTP range requests is your transport's job (the
engine never opens a socket), and archives above
`Number.MAX_SAFE_INTEGER` offsets are refused rather than approximated.

## Case 2 — Untrusted-upload intake

Accepting user archives is the classic parser-attack surface: zip-slip
paths, decompression bombs, symlink redirects, overlapping entries,
Zip64 field spoofing. The usual mitigation is a checklist the intake
service must remember to implement. zipnative inverts the default:
**`extractZip()` refuses all of it out of the box, and every refusal
throws a typed error whose stable
[`err.code`](errors.html) routes the archive to quarantine without
string matching**.

![Architecture: a user upload, hostile until proven otherwise, flows into zipnative's extractZip with its defaults on — zip-slip, decompression bombs, symlinks, overlapping entries and Zip64 spoofing are all checked. Two branches leave the guard box: the green path, when every guard passes, yields clean path-and-data pairs joined under the caller's own root; the red path, when any guard trips, throws a typed error whose stable err.code routes the archive to quarantine with an audit log. An indigo card notes the CWE-tagged ZipLimits bounds are raised only explicitly. The closing band states the honest limit — extraction is in-memory; writing to disk is the sink's job.](../assets/use-case-untrusted-intake.svg)

```ts
import { extractZip, ZipError } from 'zipnative';

try {
  const files = extractZip(upload, {
    limits: { maxTotalUncompressedSize: 512 * 1024 * 1024 }, // explicit, audited
  });
  for (const f of files) store(join(ROOT, f.path), f.data);  // path is sanitized
} catch (err) {
  if (err instanceof ZipError) {
    quarantine(upload, err.code);            // ZIP_PATH_TRAVERSAL, ZIP_LIMIT_EXCEEDED…
    audit.log({ code: err.code, message: err.message });
    return;
  }
  throw err;
}
```

The dispatch above is the whole intake policy: security refusals carry
codes like `ZIP_PATH_TRAVERSAL` or `ZIP_ENTRY_OVERLAP`
(`ZipSecurityError`), resource refusals carry `ZIP_LIMIT_EXCEEDED` with
the offending `limit` key and both values — so the audit log is
machine-readable for free.

Honest limits: extraction is in-memory — the engine never touches a
filesystem, so writing to disk (and choosing the root) is your sink's
job; `sanitizeEntryPath()` is exported for external sinks that need the
same path rules. Encrypted entries are detected, never decrypted.

## Case 3 — The reproducibility gate

A release archive that cannot be rebuilt byte-for-byte cannot be
audited: nobody can prove the published artifact matches the reviewed
commit. Zip tools leak timestamps, entry order and encoder versions
into their output, so "rebuild and compare" normally fails for boring
reasons. With `deterministic: true`, zipnative's output bytes depend on
the input files and nothing else — **so one committed SHA-256 turns the
release artifact into an asserted artifact, on any CI runner**.

![Architecture: the source tree at a commit flows into zipnative's createZip with deterministic true — pinned pure-TS encoder, epoch timestamps, canonical entry order — producing a release archive whose bytes depend only on its inputs. The archive's SHA-256 is computed and compared against the golden checksum committed in the repository. Two branches leave the comparison: the green path, on a match, publishes the artifact; the red path, on drift, fails the build — an unreviewed content change or a broken determinism contract has been caught. A green band states the guarantee: identical inputs give identical SHA-256 on every runtime, and changing the emitted bytes is a semver-major event. The closing band states the honest limit — the guarantee is scoped to deterministic true; the default tier is stable per environment only.](../assets/use-case-repro-gate.svg)

```ts
import { createZip } from 'zipnative';
import { createHash } from 'node:crypto';

const zip = createZip({ compression: { deterministic: true } });
for (const [name, data] of releaseFiles) zip.add(name, data);
const archive = zip.toBytes();                 // same inputs → same bytes, anywhere

const digest = createHash('sha256').update(archive).digest('hex');
if (digest !== GOLDEN_SHA256) {
  throw new Error(`release.zip drifted: ${digest} != ${GOLDEN_SHA256}`);
}                                              // promote the golden in-PR when intended
```

Changing the golden is a reviewed diff like any other; an *unintended*
change — a file that slipped into the artifact, an encoder change —
fails the build on every platform, because the pinned pure-TS encoder
produces identical bytes on Linux, Windows and macOS runners alike. The
contract is [written down](determinism.html) and golden-tested in
zipnative's own suite; changing the emitted bytes is semver-major.

Honest limits: the byte guarantee is scoped to `deterministic: true` —
the default tier uses the platform's zlib and is byte-stable per
environment only. `defaultDate: 'now'` opts out of reproducibility and
says so with a diagnostic; an explicit `Date` is a local-time field unless
`dosTimeMode: 'utc'` is set.

For an artefact you did not build — a Gradle JAR, a Maven archive, an
Explorer ZIP — `canonicalizeZip()` (1.1) rewrites it into the same
canonical form without recompression and `analyzeDeterminism()` reports
what would otherwise drift: the
[reproducible builds guide](reproducible-builds.html).

## Case 4 — Streaming intake at the edge

Edge runtimes have no filesystem, tight memory, and no Node APIs — and
uploads arrive as unseekable body streams, which rules out every
ZIP library that wants a file or a full buffer. `iterateZipEntries()`
reads the stream *forward*, entry by entry, in bounded memory — **and
because the resumable pure-TS inflater reports exactly where each
compressed stream ends, even data-descriptor archives (the shape
streaming producers emit) delimit correctly without a central
directory**.

![Architecture: a client uploads an archive as an unseekable body stream to an edge worker with no Node APIs. Inside the worker, zipnative's iterateZipEntries consumes the stream forward entry by entry — bounded memory, CRC verified, data-descriptor entries supported — while skip discards entries the route does not need without buffering them. Selected entries stream onward to object storage or a processing queue. A green band states the portability guarantee: the same API runs on Workers, Deno, Bun, browsers and Node, with zero dependencies and Fetch-native types. The closing band states the honest limit — forward reading trusts local headers alone; openZip on the complete archive remains the authoritative path.](../assets/use-case-edge-stream.svg)

```ts
import { iterateZipEntries } from 'zipnative';

export default {
  async fetch(request: Request): Promise<Response> {
    let kept = 0;
    for await (const entry of iterateZipEntries(bodyChunks(request))) {
      if (!wanted(entry.header.name)) { await entry.skip(); continue; }
      await bucket.put(entry.header.name, collect(entry.data())); // CRC-verified
      kept++;
    }
    return Response.json({ kept });              // the archive was never held whole
  },
};
```

The same code runs unchanged on Cloudflare Workers, Deno Deploy, Bun
and Node ≥ 22 — zero dependencies means there is nothing to polyfill,
and capability detection (not platform builds) picks the fastest
available inflate tier.

Honest limits: forward reading trusts local headers alone — there is no
central directory to cross-check, so `openZip()` on the complete
archive remains the authoritative path, and the [security
guide](security.html) spells out the trust caveat. store+bit3 and
encrypted+bit3 entries are structurally undelimitable and are refused
with `ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR`.

## Case 5 — Encrypt first, then archive

"Does zipnative support password-protected archives?" is the first
question many teams ask, and the answer is a deliberate **no** — in
every surface, read or write. ZipCrypto, the format's legacy cipher, is
cryptographically broken (Biham–Kocher, a known-plaintext attack that
recovers the keys from a few kilobytes), so shipping it would be harm
dressed as a feature; AES-in-ZIP is a vendor extension, not part of the
ISO/IEC 21320-1 profile the engine writes, and is not in 1.x (a 2.0
candidate; since 1.1 such entries are at least labelled `feature: 'aes'`
rather than `'zipcrypto'`). Yet
confidentiality is a real requirement. The pattern that satisfies it is
to **encrypt the documents, not the envelope** — with the tool that
already owns the secret — and let zipnative package the ciphertext:
**the archive stays deterministic, verifiable and readable by any ZIP
tool, while every payload stays opaque to anyone without the document
password**.

![Architecture: plain documents flow into a document-layer encryption step — pdfnative's mergePdfs with an AES-256 encrypt option, an Office workbook password, or any tool that owns the secret — and come out as encrypted files whose bytes are opaque. Those files flow into zipnative's createZip with deterministic compression, which packages them into a release archive: names and sizes visible, payloads opaque, identical SHA-256 on every runtime, checkable with verifyZip and inspect --check no-encryption. A red struck edge from a "ZIP password?" card shows that no secret ever enters the archive layer — none, by design, because ZipCrypto is broken and AES-in-ZIP is not in 1.x. A green band states what you gain: every payload is opaque without the document password while the archive stays deterministic, verifiable and safe to extract with any ZIP tool. The closing band states the honest limits — entry names and sizes stay visible, a ZIP is an envelope not a vault, and encrypted payloads do not compress, so store them.](../assets/use-case-encrypt-delegate.svg)

In application code, [pdfnative](https://pdfnative.dev) (the sibling
engine, zero dependencies too) encrypts a PDF with AES-256 in one call,
and zipnative packages the result — the two never exchange a secret:

```ts
import { mergePdfs } from 'pdfnative';
import { createZip, verifyZip } from 'zipnative';

// 1. Confidentiality — the document layer owns the password (mergePdfs is synchronous).
const sealed = mergePdfs([{ bytes: reportPdf }], {
  encrypt: { ownerPassword: process.env.OWNER_PASS!, userPassword: process.env.USER_PASS!,
             algorithm: 'aes256', permissions: { print: true, copy: false } },
});

// 2. Packaging — zipnative sees ciphertext and nothing else.
const zip = createZip({ compression: { deterministic: true } });
zip.add('report.pdf', sealed, { compression: { method: 'store' } }); // ciphertext does not compress
zip.add('ledger.xlsx', workbookEncryptedByOffice, { compression: { method: 'store' } });
const archive = zip.toBytes();                 // same SHA-256 on every runtime

// 3. Proof — structure and integrity, without a single key.
const report = verifyZip(archive);
if (!report.ok) throw new Error(report.error!.code);
```

The same pipeline from a shell, with the two CLIs — the password travels
in an environment variable, never on a command line, and the archive is
gated before it ships:

```bash
export PDFNATIVE_ENCRYPT_OWNER_PASS="$(cat /run/secrets/owner)"
# the pdfnative-cli package installs the `pdfnative` binary (or: npx pdfnative-cli encrypt …)
pdfnative encrypt --input report.pdf --output sealed/report.pdf --algorithm aes-256 --permissions print
zipnative create sealed/ --output release.zip --deterministic --store-ext pdf,xlsx
zipnative inspect release.zip --check deterministic,no-encryption,safe-names --json
zipnative verify release.zip --json
```

What you gain, concretely:

- **Real cryptography** — AES-256 from a document engine that was
  designed for it, with owner and user passwords and a permission set,
  instead of a 1990s stream cipher bolted onto the container.
- **A deterministic, verifiable archive** — `deterministic: true` still
  holds because the ciphertext is just bytes; `verifyZip()` and
  `inspect --check no-encryption` prove the envelope without any key,
  so the reproducibility gate of Case 3 applies unchanged.
- **Tool-agnostic delivery** — every ZIP tool on every platform lists and
  extracts the archive; only the recipients with the document password
  open the documents. No "which unzip supports AES?" support ticket.
- **One secret owner** — the key never touches the archive layer, the
  CI job or the MCP server; `entry.isEncrypted` stays `false` and the
  CLI's `--check no-encryption` asserts it.

Honest limits: entry names and sizes stay visible — a ZIP is an
envelope, not a vault; if the *existence* of `severance-terms.pdf` is
the secret, encrypt the whole archive with `age`, GPG or your KMS, not
its entries. Encrypted payloads do not compress, so store them
(`method: 'store'`, or the CLI's `--store-ext`) rather than paying
deflate for nothing. And the pattern needs a document format with real
encryption: PDF and OOXML have one; a plain `.csv` does not, and belongs
in the whole-archive case.

## Picking parts, not a platform

Each case is assembled from surfaces that also work alone, so none of
them locks you in: the manifest peek (Case 1) is just `openZip` +
`readEntry`; the reproducibility gate (Case 3) adds nothing but a hash
of `createZip`'s output; the edge intake (Case 4) is one async iterator
over the same entries the buffered reader would yield; the encrypt-first
pipeline (Case 5) is Case 3 fed with ciphertext. Every case also runs
from the [CLI](cli.html) or an [MCP client](mcp.html) — the
[choosing guide](choose.html) maps each call to its command and tool.
Start with the case closest to your bottleneck and borrow pieces from
the others.

## See also

- [Quickstart](quickstart.html) — the four core workflows behind Cases
  1–3, runnable in five minutes.
- [Security model](security.html) — the threat table and CWE-tagged
  bounds Case 2 leans on, and Case 4's trust caveat in full.
- [The determinism contract](determinism.html) — the three guarantee
  levels behind Case 3's one-hash assertion, unchanged in Case 5.
- [Errors and error codes](errors.html) — the frozen `err.code`
  vocabulary Case 2 dispatches on.
- [CLI guide](cli.html) · [MCP guide](mcp.html) — the two other surfaces
  Case 5 runs on.
- [api.json](../assets/api.json) — the mechanically extracted export
  surface every case is built from.
