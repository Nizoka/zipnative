import { describe, expect, it } from 'vitest';
import { parseExtraFields, resolveUnicodePath, resolveUtMtime, resolveZip64 } from '../../src/core/zip-extra-fields.ts';
import { buildExtraField } from '../helpers/raw-zip-builder.ts';

const CLASSIC = {
    uncompressedSize: 100,
    compressedSize: 50,
    localHeaderOffset: 10,
    diskNumberStart: 0,
};

function u64le(value: number): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
    return out;
}

describe('parseExtraFields', () => {
    it('parses multiple fields and preserves raw payloads', () => {
        const extra = buildExtraField([
            { id: 0x5455, data: new Uint8Array([1, 0, 0, 0, 0]) },
            { id: 0xCAFE, data: new Uint8Array([9, 9]) },
        ]);
        const { fields, malformed } = parseExtraFields(extra);
        expect(malformed).toBe(false);
        expect(fields).toHaveLength(2);
        expect(fields[1].id).toBe(0xCAFE);
        expect([...fields[1].data]).toEqual([9, 9]);
    });

    it('flags a field overrunning its declared length', () => {
        const extra = new Uint8Array([0x01, 0x00, 0xFF, 0x00, 1, 2]); // declares 255 bytes, has 2
        const { fields, malformed } = parseExtraFields(extra);
        expect(malformed).toBe(true);
        expect(fields).toHaveLength(0);
    });

    it('tolerates 1–3 trailing padding bytes silently', () => {
        const extra = new Uint8Array([0x01, 0x00, 0x01, 0x00, 42, 0, 0]);
        const { fields, malformed } = parseExtraFields(extra);
        expect(malformed).toBe(false);
        expect(fields).toHaveLength(1);
    });
});

describe('resolveZip64 (spoof-resistant)', () => {
    it('leaves classic values untouched with no zip64 extra', () => {
        const res = resolveZip64([], CLASSIC);
        expect(res.usesZip64).toBe(false);
        expect(res.uncompressedSize).toBe(100);
        expect(res.suppliedNonSentinel).toBe(false);
    });

    it('replaces only sentinel fields, in spec order', () => {
        const big = 5_000_000_000;
        const fields = parseExtraFields(buildExtraField([
            { id: 0x0001, data: new Uint8Array([...u64le(big), ...u64le(big - 1)]) },
        ])).fields;
        const res = resolveZip64(fields, { ...CLASSIC, uncompressedSize: 0xFFFFFFFF, compressedSize: 0xFFFFFFFF });
        expect(res.usesZip64).toBe(true);
        expect(res.uncompressedSize).toBe(big);
        expect(res.compressedSize).toBe(big - 1);
        expect(res.localHeaderOffset).toBe(10); // non-sentinel: classic wins
        expect(res.suppliedNonSentinel).toBe(false);
    });

    it('reports zip64 data beyond what the sentinels license (spoof shape)', () => {
        const fields = parseExtraFields(buildExtraField([
            { id: 0x0001, data: u64le(999) }, // no field is sentinel → nothing licensed
        ])).fields;
        const res = resolveZip64(fields, CLASSIC);
        expect(res.suppliedNonSentinel).toBe(true);
        expect(res.uncompressedSize).toBe(100); // classic value wins
    });
});

describe('resolveUtMtime', () => {
    it('extracts the mtime when the flag bit is set', () => {
        const unix = 1_600_000_000;
        const data = new Uint8Array(5);
        data[0] = 0x01;
        new DataView(data.buffer).setInt32(1, unix, true);
        const date = resolveUtMtime([{ id: 0x5455, data }]);
        expect(date?.getTime()).toBe(unix * 1000);
    });

    it('returns null when mtime is absent or the field is short', () => {
        expect(resolveUtMtime([{ id: 0x5455, data: new Uint8Array([0x00, 1, 2, 3, 4]) }])).toBeNull();
        expect(resolveUtMtime([{ id: 0x5455, data: new Uint8Array([0x01]) }])).toBeNull();
        expect(resolveUtMtime([])).toBeNull();
    });
});

describe('resolveUnicodePath', () => {
    it('returns the name bytes after version and CRC', () => {
        const name = new TextEncoder().encode('résumé.txt');
        const data = new Uint8Array(5 + name.length);
        data[0] = 1;
        data.set(name, 5);
        const resolved = resolveUnicodePath([{ id: 0x7075, data }]);
        expect(resolved).not.toBeNull();
        expect(new TextDecoder().decode(resolved as Uint8Array)).toBe('résumé.txt');
    });

    it('ignores unknown versions and short payloads', () => {
        expect(resolveUnicodePath([{ id: 0x7075, data: new Uint8Array([2, 0, 0, 0, 0, 65]) }])).toBeNull();
        expect(resolveUnicodePath([{ id: 0x7075, data: new Uint8Array([1, 0]) }])).toBeNull();
    });
});
