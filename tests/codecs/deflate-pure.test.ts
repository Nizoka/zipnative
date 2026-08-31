import { createHash } from 'node:crypto';
import { deflateRawSync as zlibDeflate, inflateRawSync as zlibInflate } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ZipError } from 'zipnative';
import { deflateRawJS } from '../../src/codecs/deflate-pure.ts';
import { inflateRawJS } from '../../src/codecs/inflate-pure.ts';
import { seededRandom } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();

function randomBytes(size: number, seed: number): Uint8Array {
    const rand = seededRandom(seed);
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) buf[i] = Math.floor(rand() * 256);
    return buf;
}

function patternBytes(period: number, size: number): Uint8Array {
    const buf = new Uint8Array(size);
    for (let i = 0; i < size; i++) buf[i] = 97 + (i % period);
    return buf;
}

/**
 * Skewed Fibonacci-ratio frequencies force provisional Huffman depths
 * beyond 15 bits — the corpus that exercises the overflow fix.
 */
function fibonacciSkewed(): Uint8Array {
    const counts: number[] = [];
    let a = 1;
    let b = 1;
    for (let sym = 0; sym < 24; sym++) {
        counts.push(a);
        [a, b] = [b, Math.min(a + b, 200_000)];
    }
    const parts: number[] = [];
    for (let sym = 0; sym < counts.length; sym++) {
        for (let k = 0; k < counts[sym]; k++) parts.push(sym);
    }
    // Deterministic shuffle so runs don't collapse the tree shape.
    const rand = seededRandom(1234);
    for (let i = parts.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [parts[i], parts[j]] = [parts[j], parts[i]];
    }
    return new Uint8Array(parts);
}

const CORPORA: ReadonlyArray<{ name: string; data: Uint8Array }> = [
    { name: 'empty', data: new Uint8Array(0) },
    { name: 'one-byte', data: te.encode('a') },
    { name: 'two-bytes', data: te.encode('ab') },
    { name: 'three-bytes', data: te.encode('abc') },
    { name: 'text', data: te.encode('hello hello hello zipnative '.repeat(500)) },
    { name: 'zeros-258', data: new Uint8Array(258) },
    { name: 'zeros-259', data: new Uint8Array(259) },
    { name: 'zeros-65535', data: new Uint8Array(65_535) },
    { name: 'zeros-65536', data: new Uint8Array(65_536) },
    { name: 'zeros-1mib', data: new Uint8Array(1 << 20) },
    { name: 'random-1k', data: randomBytes(1024, 11) },
    { name: 'random-70000', data: randomBytes(70_000, 7) },
    { name: 'pattern-p1-40k', data: patternBytes(1, 40_000) },
    { name: 'pattern-p3-40k', data: patternBytes(3, 40_000) },
    { name: 'pattern-p7-70k', data: patternBytes(7, 70_000) },
    { name: 'fibonacci-skewed', data: fibonacciSkewed() },
    { name: 'sizes-257', data: randomBytes(257, 21) },
    { name: 'sizes-65534', data: randomBytes(65_534, 22) },
    { name: 'sizes-131072', data: te.encode('mixed content 123 '.repeat(7282)).subarray(0, 131_072) },
];

describe('deflateRawJS: differential round-trip through zlib inflate', () => {
    for (const { name, data } of CORPORA) {
        // Generous timeout: V8 coverage instrumentation slows the encoder's
        // tight loops ~20-50x (uninstrumented it runs 25-55 MB/s).
        it(`${name} (${data.length} B) round-trips at levels 0/1/6/9`, () => {
            for (const level of [0, 1, 6, 9]) {
                const compressed = deflateRawJS(data, level);
                const restored = new Uint8Array(zlibInflate(compressed));
                expect(restored, `${name} level ${level}`).toEqual(data);
            }
        }, 180_000);
    }

    it('every level 0-9 round-trips on the text corpus', () => {
        const data = te.encode('the quick brown fox jumps over the lazy dog. '.repeat(300));
        for (let level = 0; level <= 9; level++) {
            expect(new Uint8Array(zlibInflate(deflateRawJS(data, level)))).toEqual(data);
        }
    });
});

describe('deflateRawJS: self round-trip through our own inflate', () => {
    for (const { name, data } of CORPORA) {
        it(`${name} round-trips through inflateRawJS at level 6`, () => {
            const compressed = deflateRawJS(data, 6);
            expect(inflateRawJS(compressed, Math.max(1, data.length))).toEqual(data);
        });
    }
});

describe('deflateRawJS: determinism (the frozen contract)', () => {
    it('two independent calls produce identical bytes', () => {
        for (const { data } of CORPORA) {
            for (const level of [1, 6, 9]) {
                expect(deflateRawJS(data, level)).toEqual(deflateRawJS(data, level));
            }
        }
    });

    // Golden SHA-256 table: generated once at implementation time and
    // frozen. ANY diff here is a breaking change to the deterministic:
    // true byte contract (semver-major) — see docs/determinism.md.
    const GOLDENS: ReadonlyArray<{ corpus: string; level: number; sha256: string }> = [
        { corpus: 'empty', level: 6, sha256: '9b4fb24edd6d1d8830e272398263cdbf026b97392cc35387b991dc0248a628f9' },
        { corpus: 'text', level: 0, sha256: '7f1d6e359fc650e1be242fc0a5c22613b9860d68b469b42f7044820233a7871c' },
        { corpus: 'text', level: 1, sha256: '60ef58d54937c9a5f9bf382d94f15556a12fe8db41db7765ae62515a4aea3297' },
        { corpus: 'text', level: 6, sha256: '60de4b6722bb4ff3b93963db8c3a87be5a9c7c8ae08f9b74a7e5a546b1bd188f' },
        { corpus: 'text', level: 9, sha256: '60de4b6722bb4ff3b93963db8c3a87be5a9c7c8ae08f9b74a7e5a546b1bd188f' },
        { corpus: 'zeros-65536', level: 6, sha256: 'ee1a636b8e202d0601ca01a83aef55baf721429f0fc4d879fe92661b2aa2ddf0' },
        { corpus: 'random-70000', level: 6, sha256: 'c3def4a697c5d4fafc2570fadcf6565d1b9aa01d92e54bd5a45a9583cd17ba64' },
        { corpus: 'pattern-p7-70k', level: 6, sha256: '3ab4860939075e627256961707d58e796211c20f306a3597d1e793497e21d423' },
        { corpus: 'fibonacci-skewed', level: 6, sha256: '75494436c07b7844a3b978aa8234ed685f57d40c55c07be229e3442ac9b3ba41' },
        { corpus: 'sizes-131072', level: 9, sha256: '5f7d331aed8321390f5c2f9636e18fa69e3c4d9adee190c60fefaa0e56d6387d' },
    ];

    for (const golden of GOLDENS) {
        it(`golden: ${golden.corpus} @ level ${golden.level}`, () => {
            const data = CORPORA.find((c) => c.name === golden.corpus)?.data as Uint8Array;
            const hash = createHash('sha256').update(deflateRawJS(data, golden.level)).digest('hex');
            expect(hash).toBe(golden.sha256);
        });
    }
});

describe('deflateRawJS: compression quality and structure', () => {
    it('stays within 5% of zlib -6 on compressible corpora', () => {
        for (const name of ['text', 'pattern-p7-70k', 'sizes-131072']) {
            const data = CORPORA.find((c) => c.name === name)?.data as Uint8Array;
            const ours = deflateRawJS(data, 6).length;
            const zlibs = zlibDeflate(data, { level: 6 }).length;
            expect(ours, `${name}: ${ours} vs zlib ${zlibs}`).toBeLessThanOrEqual(Math.ceil(zlibs * 1.05));
        }
    });

    it('never exceeds the stored bound on incompressible data', () => {
        const data = CORPORA.find((c) => c.name === 'random-70000')?.data as Uint8Array;
        const ours = deflateRawJS(data, 6).length;
        expect(ours).toBeLessThanOrEqual(data.length + 5 * Math.ceil(data.length / 65_535) + 8);
    });

    it('empty input at level >= 1 is exactly the 2-byte fixed EOB block', () => {
        expect([...deflateRawJS(new Uint8Array(0), 6)]).toEqual([0x03, 0x00]);
    });

    it('level 0 output size is exact: n + 5 per stored piece', () => {
        expect(deflateRawJS(new Uint8Array(70_000), 0).length).toBe(70_000 + 2 * 5);
        expect(deflateRawJS(new Uint8Array(0), 0).length).toBe(5);
    });

    it('long zero runs compress to almost nothing (length-258 matches)', () => {
        expect(deflateRawJS(new Uint8Array(100_000), 6).length).toBeLessThan(200);
    });

    it('level 9 is never dramatically worse than level 1 on text', () => {
        const data = CORPORA.find((c) => c.name === 'text')?.data as Uint8Array;
        const l9 = deflateRawJS(data, 9).length;
        const l1 = deflateRawJS(data, 1).length;
        expect(l9).toBeLessThanOrEqual(Math.ceil(l1 * 1.01));
    });
});

describe('deflateRawJS: API validation', () => {
    it('rejects invalid levels with a remedy', () => {
        for (const level of [-1, 10, 3.5, NaN]) {
            expect(() => deflateRawJS(new Uint8Array(1), level)).toThrow(ZipError);
            expect(() => deflateRawJS(new Uint8Array(1), level)).toThrow(/zipnative: deflate level/);
        }
    });
});
