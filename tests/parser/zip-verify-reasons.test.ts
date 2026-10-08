import { describe, expect, it } from 'vitest';
import {
    iterateZipEntries,
    openZip,
    registerCodec,
    verifyZip,
    ZipUnsupportedError,
} from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

/**
 * Issue #12 — `verifyEntry()` names WHY an entry could not be verified
 * instead of returning four falses, and its `localHeaderMatch` is real for
 * encrypted entries (1.0.0 fabricated it: `verifyZip` hard-coded `true`,
 * `verifyEntry` reported `false` because the encryption refusal fired
 * before the cross-check). Issue-adjacent: the encryption refusal names
 * the scheme honestly — a WinZip AES entry is `'aes'`, not `'zipcrypto'`.
 */

const te = new TextEncoder();

async function* streamOf(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
    yield bytes;
}

/** WinZip AE-2 extra: vendor version 2, vendor "AE", strength 3 (256-bit), real method 8. */
const AES_EXTRA = new Uint8Array([0x01, 0x99, 0x07, 0x00, 0x02, 0x00, 0x41, 0x45, 0x03, 0x08, 0x00]);

describe('verifyEntry skip reasons (#12)', () => {
    it('an encrypted entry with a consistent local header: skipped, header checked, not ok', () => {
        const archive = buildRawZip([{ name: 'locked.txt', data: te.encode('sealed'), flags: 0x0001 }]);
        const v = openZip(archive).verifyEntry('locked.txt');
        expect(v).toEqual({ ok: false, crcMatch: false, sizeMatch: false, localHeaderMatch: true, skipped: 'encrypted' });
    });

    it('an encrypted entry whose local header contradicts the central directory is NOT header-matched', () => {
        const archive = buildRawZip([{ name: 'locked.txt', data: te.encode('sealed'), flags: 0x0001, lfhCrcOverride: 0xDEADBEEF }]);
        const v = openZip(archive).verifyEntry('locked.txt');
        expect(v.skipped).toBe('encrypted');
        expect(v.localHeaderMatch).toBe(false);
        // The archive-level verdict follows: a tampered header fails the
        // archive even though its content is undecryptable (1.0.0 said ok).
        const report = verifyZip(archive);
        expect(report.entries[0].localHeaderMatch).toBe(false);
        expect(report.ok).toBe(false);
    });

    it('an unregistered method: skipped as unsupported-method, and the archive still fails (as in 1.0.0)', () => {
        const archive = buildRawZip([
            { name: 'ok.txt', data: te.encode('fine') },
            { name: 'odd.bin', data: te.encode('zz'), method: 91 },
        ]);
        const v = openZip(archive).verifyEntry('odd.bin');
        expect(v).toEqual({ ok: false, crcMatch: false, sizeMatch: false, localHeaderMatch: true, skipped: 'unsupported-method' });
        const report = verifyZip(archive);
        expect(report.entries.find((e) => e.name === 'odd.bin')?.skipped).toBe('unsupported-method');
        expect(report.entries.find((e) => e.name === 'ok.txt')?.ok).toBe(true);
        expect(report.ok).toBe(false);
    });

    it('a stream-only registered codec: skipped with its reason, header checked, archive ok', () => {
        registerCodec({
            method: 92,
            name: 'stream-only-reasons',
            decompressStream: async function* (data) { yield data; },
        });
        const archive = buildRawZip([{ name: 'x.bin', data: te.encode('zz'), method: 92 }]);
        const v = openZip(archive).verifyEntry('x.bin');
        expect(v.skipped).toBe('stream-only-codec');
        expect(v.localHeaderMatch).toBe(true);
        expect(verifyZip(archive).ok).toBe(true);
    });

    it('verifyZip is exactly verifyEntry per entry, plus the name (delegation pinned)', () => {
        const archive = buildRawZip([
            { name: 'a.txt', data: te.encode('alpha'), method: 8 },
            { name: 'b.bin', data: te.encode('beta'), method: 8, corruptDataAt: 3 },
            { name: 'c.txt', data: te.encode('gamma'), flags: 0x0001 },
        ]);
        const reader = openZip(archive);
        const report = verifyZip(archive);
        for (const entry of reader.entries()) {
            expect(report.entries.find((e) => e.name === entry.name)).toEqual({ name: entry.name, ...reader.verifyEntry(entry) });
        }
        expect(report.ok).toBe(false);
    });

    it('a verified entry carries no skipped field at all', () => {
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('alpha'), method: 8 }]);
        const v = openZip(archive).verifyEntry('a.txt');
        expect(v).toEqual({ ok: true, crcMatch: true, sizeMatch: true, localHeaderMatch: true });
        expect('skipped' in v).toBe(false);
    });
});

describe('encryption scheme label', () => {
    const scheme = (fn: () => unknown): string => {
        try {
            fn();
        } catch (err) {
            if (err instanceof ZipUnsupportedError) return err.feature;
            throw err;
        }
        throw new Error('expected a refusal');
    };

    it('WinZip AES (method 99 + 0x9901 extra) is labelled aes, never zipcrypto', () => {
        const archive = buildRawZip([{
            name: 'aes.bin', data: te.encode('ciphertext-stand-in'), method: 99, flags: 0x0001,
            extraLocal: AES_EXTRA, extraCentral: AES_EXTRA,
        }]);
        const reader = openZip(archive);
        expect(scheme(() => reader.readEntry('aes.bin'))).toBe('aes');
        expect(scheme(() => reader.readEntryRaw('aes.bin'))).toBe('aes');
        expect(verifyZip(archive).entries[0].skipped).toBe('encrypted');
    });

    it('the 0x9901 extra alone (method field still 8) is aes too', () => {
        const archive = buildRawZip([{
            name: 'aes.bin', data: te.encode('x'), method: 8, flags: 0x0001, extraCentral: AES_EXTRA,
        }]);
        expect(scheme(() => openZip(archive).readEntry('aes.bin'))).toBe('aes');
    });

    it('flag bit 0 alone stays zipcrypto; bit 6 is strong-encryption', () => {
        const zc = buildRawZip([{ name: 'z.bin', data: te.encode('x'), flags: 0x0001 }]);
        expect(scheme(() => openZip(zc).readEntry('z.bin'))).toBe('zipcrypto');
        const strong = buildRawZip([{ name: 's.bin', data: te.encode('x'), flags: 0x0041 }]);
        expect(scheme(() => openZip(strong).readEntry('s.bin'))).toBe('strong-encryption');
    });

    it('the forward reader labels the same way', async () => {
        const archive = buildRawZip([{
            name: 'aes.bin', data: te.encode('x'), method: 99, flags: 0x0001, extraLocal: AES_EXTRA, extraCentral: AES_EXTRA,
        }]);
        for await (const entry of iterateZipEntries(streamOf(archive))) {
            expect(entry.header.isEncrypted).toBe(true);
            expect(scheme(() => entry.data())).toBe('aes');
            await entry.skip();
        }
    });
});
