/**
 * Recipe: extract an untrusted archive in memory with the security defaults.
 * Task: safe extraction — traversal, symlinks and bombs are rejected unless
 * explicitly configured otherwise; a hostile archive throws ZipSecurityError.
 */
import { extractZip, ZipSecurityError } from 'zipnative';
import { buildDemoArchive, buildHostileArchive } from './_helpers.ts';

export default async function run(): Promise<Record<string, string>> {
    // A clean archive extracts to sanitized relative paths + data.
    const files = extractZip(buildDemoArchive(), {
        limits: { maxEntries: 10_000, maxTotalUncompressedSize: 1024 * 1024 * 1024 },
    });

    // A zip-slip archive is refused by default.
    let traversalRejected = false;
    try {
        extractZip(buildHostileArchive());
    } catch (err) {
        traversalRejected = err instanceof ZipSecurityError;
    }

    return {
        extracted: String(files.length),
        'traversal-rejected': String(traversalRejected),
    };
}
