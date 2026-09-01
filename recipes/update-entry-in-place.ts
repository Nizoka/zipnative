/**
 * Recipe: update one entry of an existing archive without recompressing
 * the rest — the incremental modifier (v0.4.0).
 * Task: replace a 2 KB config inside a large archive; save() appends
 * (original bytes untouched), saveCompact() rewrites for true deletion.
 */
import { createZip, createZipModifier, openZip } from 'zipnative';

export default async function run(): Promise<Record<string, string>> {
    // An existing archive (in production: bytes you loaded from storage).
    const original = ((): Uint8Array => {
        const zip = createZip({ compression: { deterministic: true } });
        zip.add('config.json', '{"version":1}');
        zip.add('assets/large.bin', 'untouched payload '.repeat(5000));
        return zip.toBytes();
    })();

    const modifier = createZipModifier(openZip(original));
    modifier.replaceEntry('config.json', '{"version":2}');
    const updated = modifier.save(); // append-only: no recompression of large.bin

    const prefixIntact = updated.subarray(0, original.length).every((b, i) => b === original[i]);
    const reader = openZip(updated, { onDiagnostic: () => undefined });
    const config = new TextDecoder().decode(reader.readEntry('config.json'));

    return {
        'prefix-intact': String(prefixIntact),
        config,
    };
}
