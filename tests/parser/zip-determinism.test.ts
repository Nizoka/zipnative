import { describe, expect, it } from 'vitest';
import { analyzeDeterminism, canonicalizeZip, createZip, createZipModifier, openZip, ZipError, ZipFormatError } from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

/**
 * `analyzeDeterminism()` — the engine-owned verdict both satellites used to
 * re-derive from the public entry fields. Positive cases come from
 * zipnative's own writer (the contract it is held to), negative cases from
 * the raw builder (a foreign producer's shapes), one rule at a time.
 */

const te = new TextEncoder();

async function collect(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const c of gen) parts.push(c);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
}

describe('analyzeDeterminism', () => {
    it('createZip output is deterministic on every rule, data descriptors absent', () => {
        const zip = createZip();
        zip.add('b.txt', te.encode('beta'));
        zip.add('a/é.txt', te.encode('alpha'));
        zip.addDirectory('dir');
        const report = analyzeDeterminism(zip.toBytes());
        expect(report).toEqual({
            deterministic: true, epochTimestamps: true, canonicalOrder: true, utf8Flags: true,
            canonicalExtras: true, canonicalVersionMadeBy: true, noDataDescriptors: true,
            entryCount: 3, offenders: [],
        });
    });

    it('addStream output is deterministic too — the descriptor is reported, never counted against', async () => {
        const zip = createZip();
        zip.addStream('s.txt', (async function* () { yield te.encode('streamed'); })());
        const report = analyzeDeterminism(await collect(zip.stream()));
        expect(report.deterministic).toBe(true);
        expect(report.noDataDescriptors).toBe(false);
        expect(report.offenders).toEqual([{ name: 's.txt', concern: 'data-descriptor' }]);
    });

    it('an explicit date, insertion order and a wall-clock default each break exactly their rule', () => {
        const dated = createZip({ defaultDate: new Date(2024, 0, 1) });
        dated.add('a.txt', te.encode('x'));
        expect(analyzeDeterminism(dated.toBytes())).toMatchObject({ deterministic: false, epochTimestamps: false, offenders: [{ name: "a.txt", concern: "timestamp" }] });

        const unordered = createZip({ order: 'insertion' });
        unordered.add('b.txt', te.encode('x'));
        unordered.add('a.txt', te.encode('y'));
        const r = analyzeDeterminism(unordered.toBytes());
        expect(r.canonicalOrder).toBe(false);
        expect(r.deterministic).toBe(false);
        expect(r.offenders).toEqual([{ name: 'a.txt', concern: 'order' }]);
    });

    it('a foreign producer: CP437 non-ASCII name, a UT extra and a DOS version-made-by', () => {
        const ut = new Uint8Array([0x55, 0x54, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]); // UT mtime = epoch
        const archive = buildRawZip([
            { name: new Uint8Array([0x6e, 0x61, 0xef, 0x76, 0x65]), data: te.encode('x'), extraCentral: ut, versionMadeBy: 0x0014 },
        ]);
        const report = analyzeDeterminism(archive);
        expect(report.utf8Flags).toBe(false);
        expect(report.canonicalExtras).toBe(false);
        expect(report.canonicalVersionMadeBy).toBe(false);
        expect(report.deterministic).toBe(false);
        expect(report.offenders.map((o) => o.concern).sort()).toEqual(['extra-field', 'utf8-flag', 'version-made-by']);
    });

    it('the modifier: save() keeps the verdict of its source, saveCompact() re-canonicalises order', () => {
        const unordered = createZip({ order: 'insertion' });
        unordered.add('b.txt', te.encode('x'));
        unordered.add('a.txt', te.encode('y'));
        const reader = openZip(unordered.toBytes());
        expect(analyzeDeterminism(createZipModifier(reader).saveCompact()).canonicalOrder).toBe(true);
    });

    it('Zip64 extras are canonical; an empty archive is deterministic; garbage throws like openZip', () => {
        const big = createZip();
        for (let i = 0; i < 66_000; i++) big.add(`e/${i.toString(36)}`, 'x', { compression: { method: 'store' } });
        expect(analyzeDeterminism(big.toBytes()).deterministic).toBe(true);
        expect(analyzeDeterminism(createZip().toBytes())).toMatchObject({ deterministic: true, entryCount: 0 });
        expect(() => analyzeDeterminism(te.encode('not a zip'))).toThrow(ZipFormatError);
        expect(() => analyzeDeterminism(createZip().toBytes(), { limits: { maxEntries: -1 } })).toThrow(ZipError);
    });
});

describe('analyzeDeterminism — a pinned date (D-12)', () => {
    it('an archive canonicalised with a date is deterministic when the report is given the same date', () => {
        const zip = createZip({ order: 'insertion' });
        zip.add('zeta.txt', 'z');
        zip.add('alpha.txt', 'a');
        const date = new Date(Date.UTC(2024, 4, 6, 7, 8, 10));
        const pinned = canonicalizeZip(zip.toBytes(), { date, dosTimeMode: 'utc' });
        expect(analyzeDeterminism(pinned).deterministic).toBe(false);
        expect(analyzeDeterminism(pinned).offenders.every((o) => o.concern === 'timestamp')).toBe(true);
        const report = analyzeDeterminism(pinned, { date, dosTimeMode: 'utc' });
        expect(report.deterministic).toBe(true);
        expect(report.epochTimestamps).toBe(true);
        // A different pinned date is not the archive's date.
        expect(analyzeDeterminism(pinned, { date: new Date(Date.UTC(2025, 0, 1)), dosTimeMode: 'utc' }).deterministic).toBe(false);
    });
});
