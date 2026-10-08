import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    analyzeDeterminism,
    canonicalizeZip,
    createZip,
    createZipModifier,
    getUnixMode,
    openZip,
    verifyZip,
} from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

/**
 * `saveCompact({ canonical: true })` / `canonicalizeZip()` — the
 * reproducible-builds "fix": any producer's archive, zipnative's canonical
 * layout, no recompression. Held to three properties: `analyzeDeterminism`
 * is true afterwards, the operation is idempotent, and every payload
 * survives bit for bit (the content still verifies).
 */

const te = new TextEncoder();
const td = new TextDecoder();
const FIXTURES = resolve('tests/fixtures/interop');

/** A deliberately non-canonical archive from the raw (foreign) builder. */
function messy(): Uint8Array {
    const ut = new Uint8Array([0x55, 0x54, 0x05, 0x00, 0x01, 0x40, 0xe2, 0x01, 0x00]);
    return buildRawZip([
        { name: 'zeta.txt', data: te.encode('last by name, first by position'), method: 8, dosDate: 0x5a21, dosTime: 0x4000, extraCentral: ut, comment: te.encode('note'), versionMadeBy: 0x0014 },
        { name: new Uint8Array([0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74]), data: te.encode('cp437 café'), versionMadeBy: 0x031e, externalAttributes: (0o100755 << 16) >>> 0 },
        { name: 'alpha/', data: new Uint8Array(0), externalAttributes: ((0o040700 << 16) | 0x10) >>> 0 },
    ], { comment: te.encode('archive comment') });
}

describe('canonicalizeZip', () => {
    it('turns a messy foreign archive into the canonical form, payloads intact', () => {
        const before = analyzeDeterminism(messy());
        expect(before.deterministic).toBe(false);
        const out = canonicalizeZip(messy());
        const after = analyzeDeterminism(out);
        expect(after).toMatchObject({ deterministic: true, epochTimestamps: true, canonicalOrder: true, utf8Flags: true, canonicalExtras: true, canonicalVersionMadeBy: true, offenders: [] });
        const reader = openZip(out);
        expect([...reader.entries()].map((e) => e.name)).toEqual(['alpha/', 'café.txt', 'zeta.txt']);
        expect(td.decode(reader.readEntry('café.txt'))).toBe('cp437 café');
        expect(reader.getEntry('café.txt')!.nameEncoding).toBe('utf-8');
        expect(reader.getEntry('zeta.txt')!.compressionMethod).toBe(8); // not recompressed
        expect(reader.getEntry('zeta.txt')!.comment.length).toBe(0);
        expect(reader.comment.length).toBe(0);
        expect(getUnixMode(reader.getEntry('café.txt')!)).toBe(0o100755); // attributes kept by default
        expect(verifyZip(out).ok).toBe(true);
    });

    it('is idempotent', () => {
        const once = canonicalizeZip(messy());
        expect(canonicalizeZip(once)).toEqual(once);
    });

    it('a zipnative archive is already canonical: the rewrite is byte-identical', () => {
        const zip = createZip();
        zip.add('b.txt', te.encode('beta'));
        zip.add('a.txt', te.encode('alpha'));
        zip.addDirectory('d');
        const bytes = zip.toBytes();
        expect(canonicalizeZip(bytes)).toEqual(bytes);
    });

    it('honours date (with dosTimeMode), keepComments and keepExternalAttributes', () => {
        const dated = canonicalizeZip(messy(), { date: new Date('2020-06-01T12:00:00Z'), dosTimeMode: 'utc', keepComments: true, keepExternalAttributes: false });
        const reader = openZip(dated, { dosTimeMode: 'utc' });
        const r = analyzeDeterminism(dated);
        expect(r.epochTimestamps).toBe(false);
        expect(r.offenders.every((o) => o.concern === 'timestamp')).toBe(true);
        expect(reader.getEntry('zeta.txt')!.lastModified.toISOString()).toBe('2020-06-01T12:00:00.000Z');
        expect(td.decode(reader.getEntry('zeta.txt')!.comment)).toBe('note');
        expect(td.decode(reader.comment)).toBe('archive comment');
        expect(getUnixMode(reader.getEntry('café.txt')!)).toBe(0o100644);
        expect(getUnixMode(reader.getEntry('alpha/')!)).toBe(0o040755);
    });

    it('through the modifier, canonical composes with edits and a rename', () => {
        const mod = createZipModifier(openZip(messy()));
        mod.removeEntry('alpha/');
        mod.renameEntry('zeta.txt', 'omega.txt');
        mod.addEntry('new.txt', te.encode('fresh'));
        const out = mod.saveCompact({ canonical: true });
        expect([...openZip(out).entries()].map((e) => e.name)).toEqual(['café.txt', 'new.txt', 'omega.txt']);
        expect(analyzeDeterminism(out).deterministic).toBe(true);
        expect(td.decode(openZip(out).readEntry('omega.txt'))).toBe('last by name, first by position');
    });

    it('an encrypted entry keeps its flags and extras (its envelope), the rest is canonical', () => {
        const aes = new Uint8Array([0x01, 0x99, 0x07, 0x00, 0x02, 0x00, 0x41, 0x45, 0x03, 0x08, 0x00]);
        const archive = buildRawZip([
            { name: 'sealed.bin', data: te.encode('ciphertext-stand-in'), method: 99, flags: 0x0001, extraLocal: aes, extraCentral: aes, dosDate: 0x5a21 },
        ]);
        const out = canonicalizeZip(archive);
        const entry = openZip(out).getEntry('sealed.bin')!;
        expect(entry.isEncrypted).toBe(true);
        expect(entry.extraFields.some((f) => f.id === 0x9901)).toBe(true);
        expect(entry.dosDate).toBe(0x0021);
        expect(analyzeDeterminism(out).canonicalExtras).toBe(false); // honest: the AES record stays
    });

    it('canonicalises the committed foreign fixtures and keeps their content extractable', () => {
        for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.zip'))) {
            const bytes = new Uint8Array(readFileSync(resolve(FIXTURES, file)));
            const out = canonicalizeZip(bytes);
            expect(analyzeDeterminism(out).deterministic, file).toBe(true);
            expect(canonicalizeZip(out), file).toEqual(out);
            const original = openZip(bytes);
            const rewritten = openZip(out);
            for (const entry of original.entries()) {
                if (entry.isDirectory) continue;
                expect(rewritten.readEntry(entry.name), `${file}:${entry.name}`).toEqual(original.readEntry(entry.name));
            }
        }
    });
});

// The frozen canonical bytes (determinism guide, "Canonical compaction"):
// the SHA-256 of canonicalizeZip() over a committed foreign fixture, pinned
// like the encoder goldens in tests/core/zip-determinism.test.ts. The input
// is foreign (not our writer's), the transform copies payloads bit for bit,
// so this hash is a pure function of the fixture and the canonical rules.
// Changing it is a semver-major release.
describe('canonicalizeZip — the frozen canonical bytes', () => {
    const GOLDEN: Readonly<Record<string, string>> = {
        'bsdtar-basic.zip': 'b2e6189e25d8a99cb39c6167f033f4db8859657a37f0cd78f28eadcfa18cb31e',
        'powershell-compress-archive-basic.zip': 'f333be4f3002b3a37bbb1baca2e0aa9b7649fda1d7c0fdd664bb7c44ccaa9590',
    };
    for (const [file, expected] of Object.entries(GOLDEN)) {
        it(`${file}: canonical bytes hash to the golden SHA-256`, () => {
            const bytes = new Uint8Array(readFileSync(resolve(FIXTURES, file)));
            const canonical = canonicalizeZip(bytes);
            const digest = createHash('sha256').update(canonical).digest('hex');
            expect(digest, `canonical bytes of ${file} changed — a semver-major event`).toBe(expected);
            expect(createHash('sha256').update(canonicalizeZip(canonical)).digest('hex')).toBe(expected);
        });
    }
});
