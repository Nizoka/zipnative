import { describe, expect, it } from 'vitest';
import { createZip, externalAttributesFromUnixMode, getUnixMode, isSymlinkEntry, openZip, ZipError } from 'zipnative';

/**
 * `externalAttributesFromUnixMode()` — the write-side mirror of
 * `getUnixMode()`, which zipnative-cli and zipnative-mcp each synthesised
 * on their own before 1.1.0.
 */

const te = new TextEncoder();

describe('externalAttributesFromUnixMode', () => {
    it('matches the canonical defaults the writer uses', () => {
        expect(externalAttributesFromUnixMode(0o644)).toBe((0o100644 << 16) >>> 0);
        expect(externalAttributesFromUnixMode(0o755, { directory: true })).toBe(((0o40755 << 16) | 0x10) >>> 0);
    });

    it('round-trips through getUnixMode on a written entry', () => {
        const zip = createZip();
        zip.add('run.sh', te.encode('#!/bin/sh'), { externalAttributes: externalAttributesFromUnixMode(0o755) });
        zip.add('link', te.encode('target'), { externalAttributes: externalAttributesFromUnixMode(0o120777) });
        zip.addDirectory('bin', { externalAttributes: externalAttributesFromUnixMode(0o750, { directory: true }) });
        const reader = openZip(zip.toBytes());
        expect(getUnixMode(reader.getEntry('run.sh')!)).toBe(0o100755);
        expect(getUnixMode(reader.getEntry('link')!)).toBe(0o120777);
        expect(isSymlinkEntry(reader.getEntry('link')!)).toBe(true);
        expect(getUnixMode(reader.getEntry('bin/')!)).toBe(0o040750);
        expect(reader.getEntry('bin/')!.isDirectory).toBe(true);
    });

    it('keeps explicit type bits and the special permission bits', () => {
        expect(externalAttributesFromUnixMode(0o4755) >>> 16).toBe(0o104755);
        expect(externalAttributesFromUnixMode(0o040755) >>> 16).toBe(0o040755);
        expect(externalAttributesFromUnixMode(0o040755) & 0xffff).toBe(0);
        expect(externalAttributesFromUnixMode(0o755, { directory: true }) & 0xffff).toBe(0x10);
    });

    it('refuses a value that is not a mode', () => {
        for (const bad of [-1, 1.5, 0x10000, Number.NaN]) {
            expect(() => externalAttributesFromUnixMode(bad)).toThrow(ZipError);
        }
    });
});
