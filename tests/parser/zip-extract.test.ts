import { describe, expect, it } from 'vitest';
import { extractZip, extractZipStream, sanitizeEntryPath, ZipSecurityError } from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();
const td = new TextDecoder();

describe('sanitizeEntryPath', () => {
    it('accepts and normalizes ordinary relative paths', () => {
        expect(sanitizeEntryPath('a/b/c.txt')).toBe('a/b/c.txt');
        expect(sanitizeEntryPath('./a//b/./c.txt')).toBe('a/b/c.txt');
    });

    it('rejects every traversal and absolute shape', () => {
        expect(sanitizeEntryPath('../evil.txt')).toBeNull();
        expect(sanitizeEntryPath('a/../../evil.txt')).toBeNull();
        expect(sanitizeEntryPath('/etc/passwd')).toBeNull();
        expect(sanitizeEntryPath('C:\\Windows\\evil.dll')).toBeNull();
        expect(sanitizeEntryPath('C:/Windows/evil.dll')).toBeNull();
        expect(sanitizeEntryPath('\\\\server\\share\\evil')).toBeNull();
        expect(sanitizeEntryPath('..\\evil.txt')).toBeNull();
        expect(sanitizeEntryPath('a\0b.txt')).toBeNull();
        expect(sanitizeEntryPath('file.txt:stream')).toBeNull();  // NTFS ADS
        expect(sanitizeEntryPath('')).toBeNull();
        expect(sanitizeEntryPath('.')).toBeNull();
    });

    it('normalizes backslash separators from hostile producers', () => {
        expect(sanitizeEntryPath('dir\\file.txt')).toBe('dir/file.txt');
    });
});

describe('extractZip', () => {
    const archive = () => buildRawZip([
        { name: 'a.txt', data: te.encode('alpha') },
        { name: 'sub/b.txt', data: te.encode('beta'), method: 8 },
        { name: 'sub/', data: new Uint8Array(0), externalAttributes: 0x10 },
    ]);

    it('extracts files (directories implied by paths)', () => {
        const files = extractZip(archive());
        expect(files.map((f) => f.path).sort()).toEqual(['a.txt', 'sub/b.txt']);
        expect(td.decode(files.find((f) => f.path === 'a.txt')?.data)).toBe('alpha');
        expect(td.decode(files.find((f) => f.path === 'sub/b.txt')?.data)).toBe('beta');
    });

    it('rejects zip-slip archives by default', () => {
        const hostile = buildRawZip([{ name: '../evil.txt', data: te.encode('x') }]);
        expect(() => extractZip(hostile)).toThrow(ZipSecurityError);
    });

    it('skips (never emits) traversal entries when rejectTraversal is false', () => {
        const hostile = buildRawZip([
            { name: '../evil.txt', data: te.encode('x') },
            { name: 'ok.txt', data: te.encode('fine') },
        ]);
        const files = extractZip(hostile, { rejectTraversal: false });
        expect(files.map((f) => f.path)).toEqual(['ok.txt']);
    });

    it('rejects symlink entries by default (CWE-59)', () => {
        const withLink = buildRawZip([
            // S_IFLNK (0xA000) | 0o777 in the high 16 bits
            { name: 'link', data: te.encode('/etc/passwd'), externalAttributes: ((0xA000 | 0o777) << 16) >>> 0 },
        ]);
        expect(() => extractZip(withLink)).toThrow(ZipSecurityError);
        const files = extractZip(withLink, { rejectSymlinks: false });
        expect(td.decode(files[0].data)).toBe('/etc/passwd'); // target as data, never a link
    });

    it('errors on duplicate paths by default, resolves with first/last on request', () => {
        const dupes = buildRawZip([
            { name: 'same.txt', data: te.encode('one') },
            { name: 'same.txt', data: te.encode('two') },
        ]);
        expect(() => extractZip(dupes)).toThrow(ZipSecurityError);
        expect(td.decode(extractZip(dupes, { onDuplicate: 'first' })[0].data)).toBe('one');
        expect(td.decode(extractZip(dupes, { onDuplicate: 'last' })[0].data)).toBe('two');
    });

    it('applies the filter before decompression', () => {
        const files = extractZip(archive(), { filter: (e) => e.name.endsWith('b.txt') });
        expect(files.map((f) => f.path)).toEqual(['sub/b.txt']);
    });

    it('enforces the total uncompressed budget', () => {
        const big = buildRawZip([
            { name: 'a.bin', data: new Uint8Array(2000) },
            { name: 'b.bin', data: new Uint8Array(2000) },
        ]);
        expect(() => extractZip(big, { limits: { maxTotalUncompressedSize: 3000 } }))
            .toThrow(/maxTotalUncompressedSize/);
    });
});

describe('extractZipStream', () => {
    it('streams entries with sanitized paths', async () => {
        const archive = buildRawZip([
            { name: 'big.txt', data: te.encode('streamed '.repeat(10_000)), method: 8 },
        ]);
        const seen: string[] = [];
        let totalBytes = 0;
        for await (const item of extractZipStream(archive)) {
            seen.push(item.path);
            for await (const chunk of item.stream()) {
                totalBytes += chunk.length;
            }
        }
        expect(seen).toEqual(['big.txt']);
        expect(totalBytes).toBe('streamed '.repeat(10_000).length);
    });
});
