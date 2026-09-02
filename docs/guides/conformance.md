# Conformance and validation

> ZIP has no veraPDF — so zipnative ships the closest thing: the first open
> clause-by-clause ISO/IEC 21320-1:2015 validator, layered over a
> six-parser differential extraction matrix. This page is the authority
> story: what "valid" means for a ZIP archive, who checks it, and what a
> pass actually proves.

## Why there was no veraPDF for ZIP

PDF/A has veraPDF: an authoritative validator that checks a closed ISO
constraint list. ZIP has nothing comparable, for two verifiable reasons:

- **JHOVE has no ZIP module.** The digital-preservation validator's module
  list (v1.34, 2025) covers AIFF, GIF, HTML, JPEG, PDF, TIFF, WAVE, XML and
  friends — not ZIP. A ZIP fed to JHOVE falls through to BYTESTREAM, which
  reports *every* byte sequence as well-formed: a gate that cannot fail.
- **`zip -T` is an alias.** Info-ZIP's own manual documents `-T` as running
  `unzip -tqq` on the archive — it adds no validation power over `unzip -t`,
  which itself only re-reads entries and checks CRCs.

What the archival community actually does is telling: Archivematica, the
reference preservation workflow, validates ZIP packages by **independent
extraction plus fixity** — exactly the differential matrix zipnative has run
since v0.2.0. And the ISO-standardised ZIP profile, **ISO/IEC 21320-1:2015
(Document Container File)** — recognised by the Library of Congress
(fdd000361) and the basis of what OOXML and EPUB constrain — had **no
open-source validator at all**. So zipnative built one.

## Level 0 — the ISO/IEC 21320-1:2015 validator

`npm run validate:zip` ([scripts/validate-zip.ts](https://github.com/Nizoka/zipnative/blob/main/scripts/validate-zip.ts))
checks every generated sample archive against the standard's closed
constraint list, veraPDF-style: each failure is tagged with the clause that
rejects it (`ISO21320-1/APPNOTE-4.4.5`, `WF/LFH-NAME-MISMATCH`, …).

**Independent by construction**: the validator raw-parses the bytes with its
own EOCD/central-directory/local-header reader and never imports zipnative's
engine — a validator that shared the engine's parser would attest the engine
with the engine.

Two families of checks:

1. **APPNOTE well-formedness** — the cross-checks lenient extractors skip:
   central directory ↔ local header agreement (method, name, sizes, CRC),
   exact offsets, entry counts, overlapping entries, data-descriptor
   validation against the authoritative central-directory values.
2. **The ISO profile** — the normative annotations ISO/IEC 21320-1 applies
   to PKWARE APPNOTE 6.3.3:

| Clause | Constraint |
|---|---|
| 4.3.3 / 4.4.1.5 | No multi-volume, split or spanned archives |
| 4.3.6 / 4.3.8 | No encryption of file data |
| 4.3.9.6 / 4.3.10 | No central-directory encryption, no archive decryption header |
| 4.3.13 | No digital-signature record |
| 4.4.3 | Version needed to extract ≤ 45; ZIP64 version 1 may be used, version 2 shall not |
| 4.4.4 | General-purpose bits 0, 4–10 and 12–15 shall not be set (bit 3, data descriptors, **is** permitted); non-ASCII names/comments require bit 11, and bit 11 requires valid UTF-8 |
| 4.4.5 | Compression method 0 (stored) or 8 (deflated) only |
| Note 1 | Volume labels, Deflate64, DCL Implode and patched data are excluded |

The rows group the standard's clauses; the emitted tags name the closest
structural clause (entry encryption fires as `APPNOTE-4.3.8`,
archive-decryption structures as `APPNOTE-4.3.10`, masked headers under
the forbidden bits of `APPNOTE-4.4.4`). The standard's remaining Table-1
rows disregard whole APPNOTE sections (manifest files, the encryption
chapters) and need no byte-level check.

**Every archive zipnative writes conforms to this profile** — validated
over the full sample corpus (29 conformant archives), enforced by blocking
gates on Linux and Windows CI and re-run before every npm publish.

The expectations are two-sided: the corpus also carries **4 deliberately
non-conformant archives** (from the [refusals corpus](security.html) and the
forward-trust sample) that MUST fail with their declared clause — proof the
gate can reject. A coverage canary pins both counts against
`docs/assets/ecosystem.json`, so a sample can neither appear nor vanish
silently.

### Conformant does not mean safe

Three of the hostile refusal archives — zip-slip, a Windows device name, and
duplicate paths — are **perfectly ISO-conformant**: the standard constrains
the container's structure, not the meaning of entry names. That is precisely
why zipnative's [secure-by-default extraction guards](security.html) exist on
top of conformance, and why the validator prints
`conformant but refused by zipnative` for them instead of pretending the
profile catches what it does not.

## Level 1 — foreign integrity pass

The same run re-tests every conformant sample with the independent integrity
checkers available on the machine (`unzip -t`, `7z t`,
`python -m zipfile -t`, `tar -tf`, `jar tf`). Absent tools are reported as
SKIP — never simulated. The Linux CI runner has all of them; the Windows
runner contributes 7-Zip, bsdtar, Python and jar. Exit codes are read per
each tool's own contract: Info-ZIP unzip's documented exit 1 ("warning
errors … but processing completed successfully anyway" — fires on an empty
zipfile and on SFX prefixes) counts as a pass; codes where the tools put
real format and CRC errors fail. Tool limitations are carried as
documented per-file exclusions rather than loosened exit codes: bsdtar on
Windows mangles non-ASCII names, and 7-Zip's CLI (23.01 and 26.02 alike)
refuses archives it must open with an offset — SFX prefixes — in `t` and
`x` both; unzip, bsdtar, Python and jar extract that same archive
byte-identically in the level-2 matrix, so the content stays proven.

One exclusion is a finding in its own right: on an **append-only updated
archive** (the incremental `save()` layout, where the superseded central
directory legitimately remains inside the file), 7-Zip extracts the
**stale** replaced payload and misses the appended entry — it does not
honour the authoritative final central directory the way the five other
tools and zipnative's strict reader do. That is the multi-reader
parser-differential this project's security model warns about, observed
on a mainstream tool; consumers of incremental output that must
interoperate with 7-Zip should ship `saveCompact()` output instead.

## Level 2 — the differential extraction matrix

`npm run test:interop` ([scripts/run-interop.ts](https://github.com/Nizoka/zipnative/blob/main/scripts/run-interop.ts))
is the empirical layer, blocking since v0.2.0: an 11-case archive matrix
built through the public API is extracted and **byte-compared** by every
available mainstream extractor (PowerShell `Expand-Archive`, bsdtar,
Info-ZIP unzip, 7-Zip, Python `zipfile`, `jar`) on Linux and Windows — and
in the other direction, zipnative reads foreign producers' archives
byte-for-byte. This is the same validation posture Archivematica applies to
ZIP packages: independent extraction and fixity, across six parser
implementations.

## Running it locally

```bash
npm run test:generate   # writes the 33-sample corpus to test-output/
npm run validate:zip    # levels 0 + 1 (ISO profile + foreign integrity)
npm run test:interop    # level 2 (differential extraction matrix)
```

`validate:zip` needs no external installation — level 0 is pure byte
parsing; level 1 uses whatever integrity tools your machine has and skips
the rest visibly.

## Where it blocks

- `.github/workflows/conformance.yml` — both gates, on Linux **and**
  Windows, on every engine-touching push and pull request.
- `.github/workflows/publish.yml` — both gates re-run between the GitHub
  Release and `npm publish`: a release can never publish samples the
  reference validator rejects.
