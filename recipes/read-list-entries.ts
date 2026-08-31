/**
 * Recipe: open an archive and list entries without decompressing anything.
 * Task: inventory a ZIP's contents cheaply — only the central directory is
 * parsed; no entry data is touched.
 */
import { openZip } from 'zipnative';
import { buildDemoArchive } from './_helpers.ts';

export default async function run(): Promise<Record<string, string>> {
    const bytes = buildDemoArchive();

    const zip = openZip(bytes);
    const names: string[] = [];
    for (const entry of zip.entries()) {
        names.push(entry.name);
    }

    return {
        entryCount: String(zip.entryCount),
        names: names.join(','),
    };
}
