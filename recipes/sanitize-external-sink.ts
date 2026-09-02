/**
 * Recipe: `sanitizeEntryPath` — the single traversal gate, exported for
 * external filesystem sinks (a future CLI, your own extractor). Join the
 * RESULT under your root — never the raw name. `null` means the name
 * cannot be made safe: traversal, absolute paths, drive letters, NTFS
 * streams, Windows reserved device names.
 */
import { sanitizeEntryPath } from 'zipnative';

export default async function run(): Promise<Record<string, string>> {
    const verdicts = [
        'docs/readme.md',        // clean relative path → passes unchanged
        './a/./b.txt',           // dot segments collapse
        '../escape.txt',         // traversal → null
        'C:/windows/system32',   // drive letter → null
        'aux.txt',               // reserved device name (CWE-67) → null
    ].map((name) => `${name}=${sanitizeEntryPath(name) ?? 'REFUSED'}`);

    return {
        clean: sanitizeEntryPath('docs/readme.md') ?? 'REFUSED',
        collapsed: sanitizeEntryPath('./a/./b.txt') ?? 'REFUSED',
        traversal: sanitizeEntryPath('../escape.txt') ?? 'REFUSED',
        device: sanitizeEntryPath('aux.txt') ?? 'REFUSED',
        summary: String(verdicts.length),
    };
}
