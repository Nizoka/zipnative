#!/usr/bin/env tsx
/**
 * zipnative — ISO/IEC 21320-1:2015 conformance validator ("veraZIP")
 * ===================================================================
 * The authority gate: validates every generated sample archive in
 * test-output/ against ISO/IEC 21320-1:2015 (Document Container File —
 * the ISO-standardised ZIP profile, Library of Congress fdd000361),
 * clause by clause, the way veraPDF validates a closed ISO constraint
 * list for PDF/A. No open-source ISO 21320-1 validator existed before
 * this one (JHOVE has no ZIP module — every ZIP falls through to
 * BYTESTREAM; `zip -T` is documented as an alias of `unzip -tqq`).
 *
 * INDEPENDENT BY CONSTRUCTION: this script raw-parses the bytes with
 * its own EOCD/CD/LFH reader and NEVER imports src/ — a validator that
 * shared the engine's parser would attest the engine with the engine
 * (same anti-circularity rule as tests/helpers/raw-zip-builder.ts).
 *
 * Three levels:
 *   0. ISO/IEC 21320-1 clause checks + APPNOTE well-formedness
 *      cross-checks (CD↔LFH agreement, offsets, overlap) — the checks
 *      lenient extractors forgive.
 *   1. Foreign integrity pass (`unzip -t`, `7z t`, `python -m zipfile
 *      -t`, `tar -tf`, `jar tf`) over the conformant corpus when the
 *      tools exist — never simulated, absent tools are SKIPped.
 *   2. The differential-extraction matrix stays in run-interop.ts (the
 *      posture Archivematica applies to ZIP packages: independent
 *      extraction + fixity).
 *
 * Expectations are explicit: conformant samples MUST pass; the archives
 * listed in EXPECTED_NONCONFORMANT (hostile constructions from the
 * refusals/forward-trust corpora) MUST fail with the named check id.
 * Note the deliberate nuance: zip-slip and friends are ISO-CONFORMANT
 * — a spec-valid archive can still be hostile, which is exactly why
 * zipnative's extraction guards exist on top of conformance.
 *
 * The scanned counts are canaried against `declared.iso21320` in
 * docs/assets/ecosystem.json (the pdfnative pdfaSamples pattern).
 *
 * Exit codes:
 *   0 — every expectation met and the canary agrees.
 *   1 — an unexpected pass/fail, a canary mismatch, a level-1 integrity
 *       failure, or a missing corpus (run `npm run test:generate`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { EXTRACTORS } from '../tests/helpers/interop-tools.ts';

const ROOT = resolve(import.meta.dirname, '..');
const CORPUS = resolve(ROOT, 'test-output');

// ── Signatures (little-endian u32) ───────────────────────────────────
const SIG_LFH = 0x04034b50;
const SIG_CFH = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_Z64_LOCATOR = 0x07064b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_ARCHIVE_EXTRA = 0x08064b50;
const SIG_DIGITAL_SIGNATURE = 0x05054b50;

// GP flag bits ISO/IEC 21320-1 forbids (APPNOTE 4.4.4 annotation):
// bit 0 (encryption), bits 4–10, bits 12–15. Allowed: 1, 2 (deflate
// options), 3 (data descriptor — explicitly permitted), 11 (UTF-8).
const FORBIDDEN_GP_BITS = 0xf7f1;

/** Archives that MUST fail, with the check id that must be among the failures. */
const EXPECTED_NONCONFORMANT: Readonly<Record<string, string>> = {
    'refusals/overlap.zip': 'WF/ENTRY-OVERLAP',
    'refusals/cd-mismatch.zip': 'WF/CD-COUNT',
    'refusals/declared-bomb.zip': 'WF/LFH-SIZE-MISMATCH',
    'forward-trust/lfh-cd-name-mismatch.zip': 'WF/LFH-NAME-MISMATCH',
};

/** Hostile archives that are nonetheless spec-valid — worth a note. */
const CONFORMANT_BUT_REFUSED = new Set([
    'refusals/zip-slip.zip', 'refusals/device-name.zip', 'refusals/duplicate-paths.zip',
]);

/**
 * Level-1 exclusions, `tool@platform`-qualified like run-interop's
 * excludeTools (bare tool id = every platform):
 * - bsdtar on Windows mangles non-ASCII names (the same documented
 *   limitation the interop gate carries for unicode-names).
 * - 7-Zip's CLI refuses archives it must open with an offset (prepended
 *   SFX data) with a fatal exit code — in `t` AND `x`, observed with
 *   both 23.01 (Linux) and 26.02 (Windows) on the CI runner images. A
 *   documented tool limitation, not a corpus defect: unzip, bsdtar,
 *   python and jar all extract the same archive byte-identically in the
 *   interop matrix, and the level-0 raw parser validates it here.
 */
const INTEGRITY_EXCLUDE: Readonly<Record<string, readonly string[]>> = {
    'names-encoding/unicode-utf8.zip': ['bsdtar@win32'],
    'edge-cases/sfx-prefixed.zip': ['7z'],
};

interface Finding {
    readonly check: string;   // 'ISO21320-1/APPNOTE-4.4.5' | 'WF/…'
    readonly detail: string;
}

interface Report {
    readonly file: string;    // posix-relative to test-output/
    readonly entries: number;
    readonly failures: Finding[];
    readonly notes: string[];
}

const u16 = (b: Uint8Array, p: number): number => b[p] | (b[p + 1] << 8);
const u32 = (b: Uint8Array, p: number): number =>
    (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, p: number): number => {
    const lo = u32(b, p);
    const hi = u32(b, p + 4);
    return hi * 0x1_0000_0000 + lo;
};

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
function isValidUtf8(bytes: Uint8Array): boolean {
    try { utf8Strict.decode(bytes); return true; } catch { return false; }
}
const hasHighByte = (bytes: Uint8Array): boolean => bytes.some((x) => x > 0x7f);

/** Validate one archive. Returns null when the file cannot be parsed at all. */
function validateArchive(bytes: Uint8Array, file: string): Report {
    const failures: Finding[] = [];
    const notes: string[] = [];
    const fail = (check: string, detail: string): void => { failures.push({ check, detail }); };

    // ── EOCD: self-consistent record closest to EOF ──────────────────
    let eocdPos = -1;
    const scanFloor = Math.max(0, bytes.length - 22 - 65535);
    for (let p = bytes.length - 22; p >= scanFloor; p--) {
        if (u32(bytes, p) === SIG_EOCD && p + 22 + u16(bytes, p + 20) === bytes.length) {
            eocdPos = p;
            break;
        }
    }
    if (eocdPos < 0) {
        fail('WF/EOCD-NOT-FOUND', 'no self-consistent end-of-central-directory record');
        return { file, entries: 0, failures, notes };
    }

    const diskNumber = u16(bytes, eocdPos + 4);
    const cdStartDisk = u16(bytes, eocdPos + 6);
    let entriesOnDisk = u16(bytes, eocdPos + 8);
    let totalEntries = u16(bytes, eocdPos + 10);
    let cdSize = u32(bytes, eocdPos + 12);
    let cdOffset = u32(bytes, eocdPos + 16);

    // ── Zip64 EOCD (version 1 is permitted; version 2 fails 4.4.3) ───
    const needsZip64 = totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
    if (needsZip64) {
        const locPos = eocdPos - 20;
        if (locPos < 0 || u32(bytes, locPos) !== SIG_Z64_LOCATOR) {
            fail('WF/ZIP64-LOCATOR', 'sentinel EOCD fields but no zip64 locator');
            return { file, entries: 0, failures, notes };
        }
        if (u32(bytes, locPos + 16) !== 1) {
            fail('ISO21320-1/APPNOTE-4.3.3', `total number of disks is ${u32(bytes, locPos + 16)} — archives shall not span volumes`);
        }
        let z64Pos = u64(bytes, locPos + 8);
        if (u32(bytes, z64Pos) !== SIG_Z64_EOCD) {
            // Prepended data shifts every stored offset; scan back from the locator.
            let found = -1;
            for (let p = locPos - 56; p >= Math.max(0, locPos - 1048576); p--) {
                if (u32(bytes, p) === SIG_Z64_EOCD) { found = p; break; }
            }
            if (found < 0) {
                fail('WF/ZIP64-EOCD', 'zip64 locator points at no zip64 EOCD record');
                return { file, entries: 0, failures, notes };
            }
            z64Pos = found;
        }
        const z64VersionNeeded = u16(bytes, z64Pos + 14);
        if (z64VersionNeeded > 45) {
            fail('ISO21320-1/APPNOTE-4.4.3', `zip64 EOCD version needed to extract is ${z64VersionNeeded} — only ZIP64 version 1 (45) may be used`);
        }
        totalEntries = u64(bytes, z64Pos + 32);
        entriesOnDisk = u64(bytes, z64Pos + 24);
        cdSize = u64(bytes, z64Pos + 40);
        cdOffset = u64(bytes, z64Pos + 48);
    }

    // ── 4.3.3 / 4.4.1.5: no splitting or spanning ────────────────────
    if ((diskNumber !== 0 && diskNumber !== 0xffff) || (cdStartDisk !== 0 && cdStartDisk !== 0xffff)) {
        fail('ISO21320-1/APPNOTE-4.3.3', `disk numbers ${diskNumber}/${cdStartDisk} — archives shall not be split or spanned`);
    }
    if (entriesOnDisk !== totalEntries) {
        fail('ISO21320-1/APPNOTE-4.4.1.5', `entries on this disk (${entriesOnDisk}) != total entries (${totalEntries})`);
    }

    // ── Prepended data (SFX stubs): stored offsets are base-relative ─
    const actualCdPos = needsZip64
        ? (() => { // CD ends where the zip64 EOCD begins
            const locPos = eocdPos - 20;
            let z = u64(bytes, locPos + 8);
            if (u32(bytes, z) !== SIG_Z64_EOCD) {
                for (let p = locPos - 56; p >= 0; p--) { if (u32(bytes, p) === SIG_Z64_EOCD) { z = p; break; } }
            }
            return z - cdSize;
        })()
        : eocdPos - cdSize;
    const shift = actualCdPos - cdOffset;
    if (shift < 0) {
        fail('WF/CD-OFFSET', `central directory claimed at ${cdOffset} but the file layout places it at ${actualCdPos}`);
        return { file, entries: 0, failures, notes };
    }
    if (shift > 0) notes.push(`${shift} bytes of prepended data (SFX stub) — offsets shifted accordingly`);
    if (u32(bytes, actualCdPos) !== SIG_CFH && totalEntries > 0) {
        fail('WF/CD-OFFSET', `no central-file-header signature at the central directory start (${actualCdPos})`);
        return { file, entries: 0, failures, notes };
    }

    // ── 4.3.13: no digital signature record after the CD ─────────────
    const cdEnd = actualCdPos + cdSize;
    if (cdEnd + 4 <= bytes.length && u32(bytes, cdEnd) === SIG_DIGITAL_SIGNATURE) {
        fail('ISO21320-1/APPNOTE-4.3.13', 'digital signature record present after the central directory');
    }

    // ── Walk the central directory ───────────────────────────────────
    interface CdEntry {
        readonly name: Uint8Array; readonly flags: number; readonly method: number;
        readonly crc: number; readonly compressedSize: number; readonly uncompressedSize: number;
        readonly localOffset: number; readonly versionNeeded: number; readonly externalAttrs: number;
        readonly comment: Uint8Array; readonly usesZip64: boolean;
    }
    const entries: CdEntry[] = [];
    let pos = actualCdPos;
    let walked = 0;
    while (pos < cdEnd && walked < totalEntries) {
        if (pos + 46 > bytes.length || u32(bytes, pos) !== SIG_CFH) break;
        const nameLen = u16(bytes, pos + 28);
        const extraLen = u16(bytes, pos + 30);
        const commentLen = u16(bytes, pos + 32);
        const name = bytes.subarray(pos + 46, pos + 46 + nameLen);
        const extra = bytes.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen);
        const comment = bytes.subarray(pos + 46 + nameLen + extraLen, pos + 46 + nameLen + extraLen + commentLen);
        let compressedSize = u32(bytes, pos + 20);
        let uncompressedSize = u32(bytes, pos + 24);
        let localOffset = u32(bytes, pos + 42);
        // Zip64 extended-information extra (0x0001): fields appear in
        // order for exactly the sentinel-valued classic fields.
        let usesZip64 = false;
        for (let e = 0; e + 4 <= extra.length;) {
            const id = u16(extra, e);
            const len = u16(extra, e + 2);
            if (id === 0x0001) {
                usesZip64 = true;
                let f = e + 4;
                if (uncompressedSize === 0xffffffff && f + 8 <= e + 4 + len) { uncompressedSize = u64(extra, f); f += 8; }
                if (compressedSize === 0xffffffff && f + 8 <= e + 4 + len) { compressedSize = u64(extra, f); f += 8; }
                if (localOffset === 0xffffffff && f + 8 <= e + 4 + len) { localOffset = u64(extra, f); f += 8; }
            }
            e += 4 + len;
        }
        entries.push({
            name, flags: u16(bytes, pos + 8), method: u16(bytes, pos + 10),
            crc: u32(bytes, pos + 16), compressedSize, uncompressedSize,
            localOffset, versionNeeded: u16(bytes, pos + 6),
            externalAttrs: u32(bytes, pos + 38), comment, usesZip64,
        });
        pos += 46 + nameLen + extraLen + commentLen;
        walked++;
    }
    if (walked !== totalEntries) {
        fail('WF/CD-COUNT', `EOCD declares ${totalEntries} entries but the central directory holds ${walked}`);
    }
    if (pos !== cdEnd && walked === totalEntries) {
        fail('WF/CD-SIZE', `central directory records span ${pos - actualCdPos} bytes but the EOCD declares ${cdSize}`);
    }

    // ── Per-entry ISO clauses + LFH cross-checks ─────────────────────
    const spans: Array<{ start: number; end: number; name: string }> = [];
    const nameOf = (raw: Uint8Array): string => {
        try { return utf8Strict.decode(raw); } catch { return `<${raw.length} bytes>`; }
    };
    for (const entry of entries) {
        const label = nameOf(entry.name);

        // 4.4.5: compression method 0 (stored) or 8 (deflated) only.
        if (entry.method !== 0 && entry.method !== 8) {
            fail('ISO21320-1/APPNOTE-4.4.5', `entry '${label}' uses compression method ${entry.method} — only 0 (stored) and 8 (deflated) are permitted`);
        }
        // 4.4.3: version needed to extract ≤ 45.
        if (entry.versionNeeded > 45) {
            fail('ISO21320-1/APPNOTE-4.4.3', `entry '${label}' needs version ${entry.versionNeeded} — shall not exceed 45`);
        }
        // 4.4.4: forbidden general-purpose bits (bit 0 = encryption → also 4.3.8).
        if ((entry.flags & 0x0001) !== 0) {
            fail('ISO21320-1/APPNOTE-4.3.8', `entry '${label}' is encrypted — file data shall not be encrypted`);
        }
        if ((entry.flags & FORBIDDEN_GP_BITS & ~0x0001) !== 0) {
            fail('ISO21320-1/APPNOTE-4.4.4', `entry '${label}' sets forbidden general-purpose bits 0x${(entry.flags & FORBIDDEN_GP_BITS).toString(16)}`);
        }
        // 4.4.4: UTF-8 discipline for names and comments.
        const utf8Flagged = (entry.flags & 0x0800) !== 0;
        if (!utf8Flagged && (hasHighByte(entry.name) || hasHighByte(entry.comment))) {
            fail('ISO21320-1/APPNOTE-4.4.4', `entry '${label}' has non-ASCII name/comment bytes without the UTF-8 flag (bit 11)`);
        }
        if (utf8Flagged && (!isValidUtf8(entry.name) || (entry.comment.length > 0 && !isValidUtf8(entry.comment)))) {
            fail('ISO21320-1/APPNOTE-4.4.4', `entry '${label}' sets bit 11 but its name/comment is not valid UTF-8`);
        }
        // APPNOTE note 1: volume labels are excluded from the profile.
        if ((entry.externalAttrs & 0x08) !== 0) {
            fail('ISO21320-1/APPNOTE-NOTE-1', `entry '${label}' carries the DOS volume-label attribute`);
        }

        // ── Local header cross-checks (what lenient extractors skip) ─
        const lfhPos = entry.localOffset + shift;
        if (lfhPos + 30 > bytes.length || u32(bytes, lfhPos) !== SIG_LFH) {
            fail('WF/LFH-SIGNATURE', `entry '${label}' points at ${entry.localOffset} where no local file header exists`);
            continue;
        }
        const lfhFlags = u16(bytes, lfhPos + 6);
        const lfhMethod = u16(bytes, lfhPos + 8);
        const lfhCrc = u32(bytes, lfhPos + 14);
        const lfhCompressed = u32(bytes, lfhPos + 18);
        const lfhUncompressed = u32(bytes, lfhPos + 22);
        const lfhNameLen = u16(bytes, lfhPos + 26);
        const lfhExtraLen = u16(bytes, lfhPos + 28);
        const lfhName = bytes.subarray(lfhPos + 30, lfhPos + 30 + lfhNameLen);
        const lfhVersionNeeded = u16(bytes, lfhPos + 4);

        if (lfhVersionNeeded > 45) {
            fail('ISO21320-1/APPNOTE-4.4.3', `entry '${label}' local header needs version ${lfhVersionNeeded} — shall not exceed 45`);
        }
        if ((lfhFlags & FORBIDDEN_GP_BITS) !== 0) {
            fail('ISO21320-1/APPNOTE-4.4.4', `entry '${label}' local header sets forbidden general-purpose bits`);
        }
        if (lfhMethod !== entry.method) {
            fail('WF/LFH-METHOD-MISMATCH', `entry '${label}': central directory says method ${entry.method}, local header says ${lfhMethod}`);
        }
        if (lfhName.length !== entry.name.length || !lfhName.every((x, i) => x === entry.name[i])) {
            fail('WF/LFH-NAME-MISMATCH', `entry '${label}': local header carries a different name ('${nameOf(lfhName)}')`);
        }
        const usesDescriptor = (lfhFlags & 0x0008) !== 0;
        const dataStart = lfhPos + 30 + lfhNameLen + lfhExtraLen;
        let dataEnd = dataStart + entry.compressedSize;
        if (!usesDescriptor) {
            // Resolve the LFH's own zip64 sizes when sentinelled.
            let lc = lfhCompressed;
            let lu = lfhUncompressed;
            if (lc === 0xffffffff || lu === 0xffffffff) {
                const lfhExtra = bytes.subarray(lfhPos + 30 + lfhNameLen, dataStart);
                for (let e = 0; e + 4 <= lfhExtra.length;) {
                    const id = u16(lfhExtra, e);
                    const len = u16(lfhExtra, e + 2);
                    if (id === 0x0001 && len >= 16) { lu = u64(lfhExtra, e + 4); lc = u64(lfhExtra, e + 12); }
                    e += 4 + len;
                }
            }
            if (lc !== entry.compressedSize || lu !== entry.uncompressedSize) {
                fail('WF/LFH-SIZE-MISMATCH', `entry '${label}': central directory sizes ${entry.compressedSize}/${entry.uncompressedSize} disagree with local header ${lc}/${lu}`);
            }
            if (lfhCrc !== entry.crc) {
                fail('WF/LFH-CRC-MISMATCH', `entry '${label}': central directory CRC 0x${entry.crc.toString(16)} disagrees with local header 0x${lfhCrc.toString(16)}`);
            }
        } else {
            // Bit 3 is PERMITTED by ISO 21320-1. Validate the trailing
            // descriptor against the authoritative CD values.
            const sizeLen = entry.usesZip64 ? 8 : 4;
            const readSize = entry.usesZip64 ? u64 : u32;
            let matched = false;
            for (const sigLen of [4, 0]) {
                const p = dataEnd + sigLen;
                if (p + 4 + 2 * sizeLen > bytes.length) continue;
                if (sigLen === 4 && u32(bytes, dataEnd) !== SIG_DESCRIPTOR) continue;
                const dCrc = u32(bytes, p);
                const dComp = readSize(bytes, p + 4);
                const dUnc = readSize(bytes, p + 4 + sizeLen);
                if (dCrc === entry.crc && dComp === entry.compressedSize && dUnc === entry.uncompressedSize) {
                    matched = true;
                    dataEnd = p + 4 + 2 * sizeLen;
                    break;
                }
            }
            if (!matched) {
                fail('WF/DESCRIPTOR-MISMATCH', `entry '${label}': no data descriptor matching the central directory values follows the payload`);
            }
        }
        spans.push({ start: lfhPos, end: dataEnd, name: label });
    }

    // ── Overlap detection (CWE-405 well-formedness) ──────────────────
    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) {
        if (spans[i].start < spans[i - 1].end) {
            fail('WF/ENTRY-OVERLAP', `entries '${spans[i - 1].name}' and '${spans[i].name}' claim overlapping byte ranges`);
        }
    }

    // ── 4.3.9.6 / 4.3.10: archive (de|en)cryption structures ─────────
    const lastSpanEnd = spans.length > 0 ? spans[spans.length - 1].end : shift;
    if (lastSpanEnd + 4 <= actualCdPos && u32(bytes, lastSpanEnd) === SIG_ARCHIVE_EXTRA) {
        fail('ISO21320-1/APPNOTE-4.3.10', 'archive extra-data / decryption header record precedes the central directory');
    }

    return { file, entries: entries.length, failures, notes };
}

// ── Corpus walk ──────────────────────────────────────────────────────
function walk(dir: string): string[] {
    const out: string[] = [];
    for (const item of readdirSync(dir)) {
        const p = resolve(dir, item);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (item.toLowerCase().endsWith('.zip')) out.push(p);
    }
    return out;
}

function main(): void {
    if (!existsSync(CORPUS)) {
        console.error('validate-zip: test-output/ not found — run `npm run test:generate` first.');
        process.exit(1);
    }
    const files = walk(CORPUS).sort();
    if (files.length === 0) {
        console.error('validate-zip: no .zip samples in test-output/ — run `npm run test:generate` first.');
        process.exit(1);
    }

    let unexpected = 0;
    let conformant = 0;
    let nonConformant = 0;
    const conformantFiles: string[] = [];

    console.error(`validate-zip: ISO/IEC 21320-1:2015 conformance over ${files.length} archive(s)\n`);
    for (const path of files) {
        const rel = relative(CORPUS, path).replace(/\\/g, '/');
        const report = validateArchive(readFileSync(path), rel);
        const expectedFail = EXPECTED_NONCONFORMANT[rel];

        if (report.failures.length === 0) {
            conformant++;
            conformantFiles.push(path);
            if (expectedFail !== undefined) {
                unexpected++;
                console.log(`UNEXPECTED-PASS ${rel} — expected ${expectedFail} to fire`);
            } else {
                const note = CONFORMANT_BUT_REFUSED.has(rel)
                    ? ' (conformant but refused by zipnative — spec-valid does not mean safe; see refusals.json)'
                    : '';
                console.log(`PASS  ${rel} (${report.entries} entries)${note}`);
            }
        } else {
            nonConformant++;
            const codes = report.failures.map((f) => f.check);
            if (expectedFail !== undefined && codes.includes(expectedFail)) {
                console.log(`EXPECTED-FAIL ${rel} — ${expectedFail} fired as declared`);
            } else {
                unexpected++;
                console.log(`FAIL  ${rel}`);
                for (const f of report.failures.slice(0, 5)) console.log(`      ${f.check}: ${f.detail}`);
                if (report.failures.length > 5) console.log(`      … ${report.failures.length - 5} more`);
            }
        }
        for (const n of report.notes) console.log(`      note: ${n}`);
    }

    // ── Coverage canary (the pdfnative pdfaSamples pattern) ──────────
    const ecosystem = JSON.parse(readFileSync(resolve(ROOT, 'docs/assets/ecosystem.json'), 'utf8')) as {
        declared?: { iso21320?: { conformantSamples?: number; nonConformantSamples?: number } };
    };
    const declared = ecosystem.declared?.iso21320;
    if (declared === undefined
        || declared.conformantSamples !== conformant
        || declared.nonConformantSamples !== nonConformant) {
        unexpected++;
        console.error(`\nCoverage canary: scanned ${conformant} conformant + ${nonConformant} declared-non-conformant `
            + `sample(s) but docs/assets/ecosystem.json declares `
            + `${declared?.conformantSamples ?? '(missing)'} + ${declared?.nonConformantSamples ?? '(missing)'}.`
            + '\nAdded or removed a sample? Update declared.iso21320. Neither? Generation or validation regressed.');
    }

    // ── Level 1: foreign integrity pass over the conformant corpus ───
    console.error('');
    for (const tool of EXTRACTORS) {
        if (tool.test === undefined) continue;
        const description = tool.describe();
        if (description === null) {
            console.error(`SKIP  integrity ${tool.id} (not available)`);
            continue;
        }
        let ok = 0;
        let excluded = 0;
        const failed: string[] = [];
        for (const path of conformantFiles) {
            const rel = relative(CORPUS, path).replace(/\\/g, '/');
            const exclusions = INTEGRITY_EXCLUDE[rel] ?? [];
            if (exclusions.includes(tool.id) || exclusions.includes(`${tool.id}@${process.platform}`)) {
                excluded++;
                continue;
            }
            if (tool.test(path)) ok++;
            else failed.push(rel);
        }
        if (failed.length === 0) {
            const skipNote = excluded > 0 ? ` (${excluded} documented exclusion(s))` : '';
            console.error(`OK    integrity ${tool.id}: ${ok}/${conformantFiles.length - excluded}${skipNote} — ${description}`);
        } else {
            unexpected += failed.length;
            console.error(`FAIL  integrity ${tool.id}: ${failed.length} archive(s) rejected — ${failed.join(', ')}`);
            console.error(`      reproduce locally with the tool's own test command on the file(s) above; `
                + `exit codes are read per tool contract (tests/helpers/interop-tools.ts, docs/guides/conformance.md)`);
        }
    }

    console.error(`\nvalidate-zip: ${conformant} conformant, ${nonConformant} declared non-conformant, ${unexpected} unexpected result(s)`);
    process.exit(unexpected === 0 ? 0 : 1);
}

main();
