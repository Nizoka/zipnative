/**
 * Recipe: deep-verify an archive in one call (v0.9.0). `verifyZip` never
 * throws for archive problems — structural refusals become
 * `report.error` with the frozen err.code, per-entry CRC/size checks
 * land in `report.entries`, diagnostics are collected. The
 * machine-readable answer to "can I trust these bytes?".
 */
import { createZip, verifyZip } from 'zipnative';

export default async function run(): Promise<Record<string, string>> {
    const zip = createZip();
    zip.add('manifest.json', '{"ok":true}');
    zip.add('data/payload.bin', 'payload '.repeat(1000));
    const bytes = zip.toBytes();

    const good = verifyZip(bytes);

    // Corrupt one byte inside the first entry's compressed payload and
    // verify again — same call, no try/catch anywhere.
    const corrupted = bytes.slice();
    corrupted[60] ^= 0xff;
    const bad = verifyZip(corrupted);

    const notZip = verifyZip(new TextEncoder().encode('not an archive at all'.repeat(4)));

    return {
        'good-ok': String(good.ok),
        'good-entries': String(good.entries.filter((e) => e.ok).length),
        'bad-ok': String(bad.ok),
        'not-zip-code': notZip.error?.code ?? '(none)',
    };
}
