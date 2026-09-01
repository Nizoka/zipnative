/**
 * Recipe: read a ZIP off a stream you cannot seek — forward, CD-less
 * iteration (v0.5.0). TRUST CAVEAT: local headers only, no central
 * directory cross-check; whenever the whole archive is available,
 * openZip() is the authoritative path.
 */
import { createZip, iterateZipEntries } from 'zipnative';

export default async function run(): Promise<Record<string, string>> {
    // Simulate a network body: an archive arriving in small chunks.
    const bytes = ((): Uint8Array => {
        const zip = createZip();
        zip.add('manifest.json', '{"name":"streamed"}');
        zip.add('data/log.txt', 'line\n'.repeat(2000));
        return zip.toBytes();
    })();
    async function* body(): AsyncGenerator<Uint8Array> {
        for (let i = 0; i < bytes.length; i += 512) {
            yield bytes.subarray(i, Math.min(i + 512, bytes.length));
        }
    }

    const names: string[] = [];
    let manifest = '';
    for await (const entry of iterateZipEntries(body())) {
        names.push(entry.header.name);
        if (entry.header.name === 'manifest.json') {
            const parts: Uint8Array[] = [];
            for await (const chunk of entry.data()) parts.push(chunk);
            manifest = new TextDecoder().decode(parts[0]);
        } else if (entry.header.compressedSize > 0) {
            await entry.skip(); // fast-forward without decompressing
        }
    }

    return {
        entries: names.sort().join(','),
        manifest,
    };
}
