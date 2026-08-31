/**
 * zipnative — scenario benchmarks (`npm run bench`)
 * =================================================
 * Comparators (fflate, jszip, adm-zip) are devDependencies fenced to
 * bench/ — never imported from src/ (ESLint no-restricted-imports).
 *
 * Policy (bench/README.md): scenarios measure what zipnative is FOR —
 * random access, lazy central-directory walks, bounded-memory creation.
 * Raw deflate throughput drag races are out of scope; fflate's deflate
 * is faster and the README says so.
 */
import AdmZip from 'adm-zip';
import { unzipSync, zipSync } from 'fflate';
import JSZip from 'jszip';
import { bench, describe } from 'vitest';
import { createZip, openZip } from 'zipnative';

const te = new TextEncoder();

// ── Shared corpora, built once ───────────────────────────────────────

function smallFiles(count: number): Record<string, Uint8Array> {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < count; i++) {
        files[`files/f${i.toString(36)}.txt`] = te.encode(`content of file number ${i} `.repeat(4));
    }
    return files;
}

const SMALL_1K = smallFiles(1000);

function buildLargeArchive(entryCount: number): Uint8Array {
    const zip = createZip();
    for (let i = 0; i < entryCount; i++) {
        zip.add(`entries/e${i.toString(36)}.txt`, te.encode(`entry ${i} payload `.repeat(8)));
    }
    return zip.toBytes();
}

const ARCHIVE_10K = buildLargeArchive(10_000);
const TARGET_ENTRY = 'entries/e2s5.txt'; // deep in the archive

// ── Scenario 1: create 1000 small entries ────────────────────────────

describe('create archive: 1000 small entries', () => {
    bench('zipnative createZip', () => {
        const zip = createZip();
        for (const [name, data] of Object.entries(SMALL_1K)) {
            zip.add(name, data);
        }
        zip.toBytes();
    });

    bench('fflate zipSync', () => {
        zipSync(SMALL_1K);
    });

    bench('jszip generateAsync', async () => {
        const zip = new JSZip();
        for (const [name, data] of Object.entries(SMALL_1K)) {
            zip.file(name, data);
        }
        await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    });

    bench('adm-zip toBuffer', () => {
        const zip = new AdmZip();
        for (const [name, data] of Object.entries(SMALL_1K)) {
            zip.addFile(name, Buffer.from(data));
        }
        zip.toBuffer();
    });
});

// ── Scenario 2: open + list a 10k-entry archive (CD walk only) ───────

describe('inventory 10k-entry archive (no decompression)', () => {
    bench('zipnative openZip + entries()', () => {
        const reader = openZip(ARCHIVE_10K);
        let count = 0;
        for (const _entry of reader.entries()) count++;
        if (count !== 10_000) throw new Error('bad count');
    });

    bench('fflate unzipSync (must decompress everything)', () => {
        const files = unzipSync(ARCHIVE_10K);
        if (Object.keys(files).length !== 10_000) throw new Error('bad count');
    });

    bench('jszip loadAsync', async () => {
        const zip = await JSZip.loadAsync(ARCHIVE_10K);
        if (Object.keys(zip.files).length !== 10_000) throw new Error('bad count');
    });

    bench('adm-zip getEntries', () => {
        const zip = new AdmZip(Buffer.from(ARCHIVE_10K));
        if (zip.getEntries().length !== 10_000) throw new Error('bad count');
    });
});

// ── Scenario 3: random access — read ONE entry of 10k ────────────────

describe('random access: read 1 entry out of 10k', () => {
    bench('zipnative getEntry + readEntry', () => {
        const reader = openZip(ARCHIVE_10K);
        reader.readEntry(TARGET_ENTRY);
    });

    bench('fflate unzipSync (no partial API — full extract)', () => {
        const files = unzipSync(ARCHIVE_10K);
        if (files[TARGET_ENTRY] === undefined) throw new Error('missing');
    });

    bench('jszip loadAsync + single file', async () => {
        const zip = await JSZip.loadAsync(ARCHIVE_10K);
        await zip.file(TARGET_ENTRY)?.async('uint8array');
    });

    bench('adm-zip readFile', () => {
        const zip = new AdmZip(Buffer.from(ARCHIVE_10K));
        zip.readFile(TARGET_ENTRY);
    });
});
