import { describe, expect, it } from 'vitest';
import { extractZip, sanitizeEntryPath, ZipSecurityError } from 'zipnative';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();

/** Traversal shapes seen in real-world zip-slip exploits. */
const HOSTILE_NAMES = [
    '../../../etc/passwd',
    '..\\..\\..\\windows\\system32\\evil.dll',
    '/etc/cron.d/evil',
    'C:\\ProgramData\\evil.exe',
    'C:/ProgramData/evil.exe',
    '\\\\attacker-server\\share\\payload',
    'good/../../escape.txt',
    'null\0byte.txt',
    'desktop.ini:hidden-stream',
];

describe('fuzzing: zip-slip', () => {
    it('sanitizeEntryPath rejects every hostile shape', () => {
        for (const name of HOSTILE_NAMES) {
            expect(sanitizeEntryPath(name), `should reject: ${name}`).toBeNull();
        }
    });

    it('extractZip throws ZipSecurityError for each hostile name by default', () => {
        for (const name of HOSTILE_NAMES) {
            const archive = buildRawZip([{ name, data: te.encode('payload') }]);
            expect(() => extractZip(archive), `should throw for: ${name}`).toThrow(ZipSecurityError);
        }
    });

    it('mixed archives keep the safe entries when traversal rejection is opted out', () => {
        const archive = buildRawZip([
            { name: 'safe/file.txt', data: te.encode('keep me') },
            { name: '../escape.txt', data: te.encode('drop me') },
        ]);
        const files = extractZip(archive, { rejectTraversal: false });
        expect(files.map((f) => f.path)).toEqual(['safe/file.txt']);
    });

    it('normalized lookalikes stay inside the root', () => {
        // These are odd but safe after normalization — must NOT throw.
        const archive = buildRawZip([
            { name: './docs//readme.md', data: te.encode('a') },
            { name: 'a/./b.txt', data: te.encode('b') },
        ]);
        const files = extractZip(archive);
        expect(files.map((f) => f.path).sort()).toEqual(['a/b.txt', 'docs/readme.md']);
    });
});
