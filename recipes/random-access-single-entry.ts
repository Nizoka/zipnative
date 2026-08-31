/**
 * Recipe: read exactly one entry from an archive, CRC-verified.
 * Task: pull a manifest out of a large archive without extracting the rest —
 * the random-access path OOXML/EPUB/JAR tooling and AI agents rely on.
 */
import { openZip } from 'zipnative';
import { buildDemoArchive } from './_helpers.ts';

export default async function run(): Promise<Record<string, string>> {
    const bytes = buildDemoArchive();
    const zip = openZip(bytes);

    const entry = zip.getEntry('hello.txt');
    if (entry === null) throw new Error('recipe: hello.txt missing from the demo archive');

    const content = new TextDecoder().decode(zip.readEntry(entry));
    const verification = zip.verifyEntry(entry);

    return {
        content,
        verified: String(verification.ok),
    };
}
