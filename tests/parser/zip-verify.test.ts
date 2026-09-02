/**
 * verifyZip: the one-call deep-validation report (0.9). Contract under
 * test: never throws for archive problems, structural refusals become
 * report.error with the frozen code, unverifiable entries are `skipped`
 * (never fake corruption), diagnostics are collected.
 */
import { describe, expect, it } from 'vitest';
import { createZip, registerCodec, verifyZip, ZipError } from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();

describe('verifyZip', () => {
    it('a clean archive verifies ok with per-entry detail', () => {
        const zip = createZip();
        zip.add('a.txt', te.encode('alpha'));
        zip.add('b/c.txt', te.encode('beta'));
        const report = verifyZip(zip.toBytes());
        expect(report.ok).toBe(true);
        expect(report.error).toBeNull();
        expect(report.entryCount).toBe(2);
        expect(report.entries).toHaveLength(2);
        for (const entry of report.entries) {
            expect(entry).toMatchObject({ ok: true, crcMatch: true, sizeMatch: true, localHeaderMatch: true });
            expect(entry.skipped).toBeUndefined();
        }
        expect(report.diagnostics).toEqual([]);
    });

    it('a corrupted payload fails its entry and the archive', () => {
        const archive = buildRawZip([
            { name: 'good.txt', data: te.encode('fine') },
            { name: 'bad.bin', data: te.encode('payload-payload'), method: 8, corruptDataAt: 2 },
        ]);
        const report = verifyZip(archive);
        expect(report.ok).toBe(false);
        expect(report.error).toBeNull(); // structure is fine — content is not
        const bad = report.entries.find((e) => e.name === 'bad.bin');
        expect(bad?.ok).toBe(false);
        expect(bad?.crcMatch).toBe(false);
        expect(report.entries.find((e) => e.name === 'good.txt')?.ok).toBe(true);
    });

    it('a non-archive becomes report.error with the frozen code — never a throw', () => {
        const report = verifyZip(te.encode('this is not a zip at all, just prose'.repeat(4)));
        expect(report.ok).toBe(false);
        expect(report.error?.code).toBe('ZIP_EOCD_NOT_FOUND');
        expect(report.error?.message).toMatch(/^zipnative: /);
        expect(report.entries).toEqual([]);
    });

    it('an encrypted entry is skipped, not reported corrupt', () => {
        const archive = buildRawZip([
            { name: 'open.txt', data: te.encode('readable') },
            { name: 'locked.txt', data: te.encode('sealed'), flags: 0x0001 },
        ]);
        const report = verifyZip(archive);
        const locked = report.entries.find((e) => e.name === 'locked.txt');
        expect(locked?.skipped).toBe('encrypted');
        expect(locked?.localHeaderMatch).toBe(true);
        // A skipped entry does not fail the archive by itself.
        expect(report.ok).toBe(true);
    });

    it('a stream-only registered codec is skipped with its reason', () => {
        registerCodec({
            method: 93,
            name: 'stream-only-test',
            decompressStream: async function* (data) { yield data; },
        });
        const archive = buildRawZip([{ name: 'x.bin', data: te.encode('zz'), method: 93 }]);
        const report = verifyZip(archive);
        expect(report.entries[0].skipped).toBe('stream-only-codec');
        expect(report.ok).toBe(true);
    });

    it('collects the parse diagnostics (SFX prefix)', () => {
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('x') }], {
            prepend: te.encode('#!/bin/sh stub\n'),
        });
        const report = verifyZip(archive);
        expect(report.ok).toBe(true);
        expect(report.diagnostics.some((d) => d.code === 'ZIP_PREPENDED_DATA')).toBe(true);
    });

    it('limits apply — a refusal is a report, not a throw', () => {
        const archive = buildRawZip([
            { name: 'a.txt', data: te.encode('x') },
            { name: 'b.txt', data: te.encode('y') },
        ]);
        const report = verifyZip(archive, { limits: { maxEntries: 1 } });
        expect(report.ok).toBe(false);
        expect(report.error?.code).toBe('ZIP_LIMIT_EXCEEDED');
    });

    it('an invalid limits object still throws — a caller bug, not an archive property', () => {
        expect(() => verifyZip(new Uint8Array(0), { limits: { maxEntries: -5 } }))
            .toThrow(ZipError);
    });
});
