/**
 * Recipe: build a reproducible archive — identical inputs, identical SHA-256.
 * Task: content-addressable / reproducible-build output via
 * compression: { deterministic: true } (see docs/determinism.md).
 */
import { createZip } from 'zipnative';

async function sha256hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default async function run(): Promise<Record<string, string>> {
    const build = (): Uint8Array => {
        const zip = createZip({ compression: { deterministic: true } });
        zip.add('manifest.json', '{"name":"demo","version":"1.0.0"}');
        zip.add('data/payload.txt', 'reproducible '.repeat(100));
        return zip.toBytes();
    };

    const first = await sha256hex(build());
    const second = await sha256hex(build());

    return {
        identical: String(first === second),
    };
}
