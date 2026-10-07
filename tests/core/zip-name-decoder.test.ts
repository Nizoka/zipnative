import { describe, expect, it } from 'vitest';
import {
    extractZip,
    iterateZipEntries,
    openZip,
    verifyZip,
    ZipSecurityError,
    type ZipDiagnostic,
} from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

/**
 * `nameDecoder` (1.1.0): legacy code pages through the platform's
 * TextDecoder, zero tables shipped. Security-critical path: the extraction
 * guards run on the DECODED string, so a decoder cannot smuggle a traversal.
 */

const te = new TextEncoder();
const SHIFT_JIS = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x2f, 0x93, 0xc7, 0x82, 0xdd, 0x95, 0xa8, 0x2e, 0x74, 0x78, 0x74]); // 日本語/読み物.txt
const CP866 = new Uint8Array([0xaf, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2, 0x2e, 0x74, 0x78, 0x74]); // привет.txt
const sjis = (b: Uint8Array): string => new TextDecoder('shift_jis').decode(b);
const cp866 = (b: Uint8Array): string => new TextDecoder('ibm866').decode(b);

async function* streamOf(bytes: Uint8Array): AsyncGenerator<Uint8Array> { yield bytes; }

describe('nameDecoder', () => {
    it('decodes a Shift-JIS name on every read path, reported as custom', async () => {
        const archive = buildRawZip([{ name: SHIFT_JIS, data: te.encode('x') }]);
        const entry = [...openZip(archive, { nameDecoder: sjis }).entries()][0];
        expect(entry.name).toBe('日本語/読み物.txt');
        expect(entry.nameEncoding).toBe('custom');
        expect(entry.rawName).toEqual(SHIFT_JIS);
        for await (const e of iterateZipEntries(streamOf(archive), { nameDecoder: sjis })) {
            expect(e.header.name).toBe('日本語/読み物.txt');
            expect(e.header.nameEncoding).toBe('custom');
            await e.skip();
        }
        expect(extractZip(archive, { nameDecoder: sjis })[0].path).toBe('日本語/読み物.txt');
        expect(verifyZip(archive).entries[0].name).not.toBe('日本語/読み物.txt'); // verifyZip takes no decoder: CP437
    });

    it('without a decoder the 1.0.0 behaviour stands: CP437', () => {
        const archive = buildRawZip([{ name: CP866, data: te.encode('x') }]);
        const plain = [...openZip(archive).entries()][0];
        expect(plain.nameEncoding).toBe('cp437');
        expect(plain.name).not.toBe('привет.txt');
        const decoded = [...openZip(archive, { nameDecoder: cp866 }).entries()][0];
        expect(decoded.name).toBe('привет.txt');
        expect(openZip(archive, { nameDecoder: cp866 }).getEntry('привет.txt')).not.toBeNull();
    });

    it('is never consulted for UTF-8-flagged names, and is the fallback for invalid UTF-8 under the flag', () => {
        let calls = 0;
        const counting = (b: Uint8Array): string => { calls++; return sjis(b); };
        const utf8 = buildRawZip([{ name: '日本語.txt', data: te.encode('x'), flags: 0x0800 }]);
        const entry = [...openZip(utf8, { nameDecoder: counting }).entries()][0];
        expect(entry.name).toBe('日本語.txt');
        expect(entry.nameEncoding).toBe('utf-8');
        expect(calls).toBe(0);

        const seen: ZipDiagnostic[] = [];
        const lying = buildRawZip([{ name: SHIFT_JIS, data: te.encode('x'), flags: 0x0800 }]);
        const fallback = [...openZip(lying, { nameDecoder: counting, onDiagnostic: (d) => seen.push(d) }).entries()][0];
        expect(fallback.name).toBe('日本語/読み物.txt');
        expect(fallback.nameEncoding).toBe('custom');
        expect(seen.map((d) => d.code)).toEqual(['ZIP_INVALID_UTF8_NAME']);
    });

    it('the extraction guards run on the decoded name: a decoder cannot smuggle a traversal', () => {
        const archive = buildRawZip([{ name: 'harmless.txt', data: te.encode('x') }]);
        const hostile = (): string => '../../etc/passwd';
        expect(() => extractZip(archive, { nameDecoder: hostile })).toThrow(ZipSecurityError);
        const ads = (): string => 'file.txt:stream';
        expect(() => extractZip(archive, { nameDecoder: ads })).toThrow(ZipSecurityError);
        const nul = (): string => 'a\u0000b';
        expect(() => extractZip(archive, { nameDecoder: nul })).toThrow(ZipSecurityError);
        // With rejectTraversal: false the hostile name is skipped, never emitted.
        expect(extractZip(archive, { nameDecoder: hostile, rejectTraversal: false })).toEqual([]);
    });

    it("a decoder's own failure is the caller's error, not a zipnative code", () => {
        const archive = buildRawZip([{ name: CP866, data: te.encode('x') }]);
        const strict = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b);
        expect(() => [...openZip(archive, { nameDecoder: strict }).entries()]).toThrow(TypeError);
    });
});
