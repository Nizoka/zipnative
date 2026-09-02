/**
 * zipnative — sample-generation I/O helpers
 * =========================================
 * Shared context for `scripts/generate-samples.ts` and the modules in
 * `scripts/generators/` (the pdfnative contributor-samples model).
 *
 * Every archive written through `writeSafe` is immediately re-opened with
 * zipnative's own eager reader — a sample that our strictest read path
 * rejects never lands on disk unnoticed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { extractZip, openZip, ZipError } from '../../src/index.ts';

export const OUTPUT_DIR = resolve(import.meta.dirname, '..', '..', 'test-output');

export interface SampleResult {
    readonly file: string;
    readonly size: number;
    readonly entries: number;
}

export interface GenerateContext {
    readonly outputDir: string;
    readonly results: SampleResult[];
    /**
     * Write one sample. `filepath` is absolute; `filename` is the short
     * display label for the report (free-form — put per-sample facts in it).
     * EBUSY (the archive is open in Explorer/7-Zip) warns and skips; every
     * other error aborts the run.
     */
    readonly writeSafe: (filepath: string, filename: string, bytes: Uint8Array) => void;
    /**
     * Write one DELIBERATELY-REFUSED sample (the refusals corpus). The
     * inverse self-validation: the archive MUST fail the named operation
     * with exactly `expectedCode`, or the generator aborts — a refusal
     * sample that stopped being refused is a regression.
     */
    readonly writeRefusal: (
        filepath: string,
        filename: string,
        bytes: Uint8Array,
        via: 'openZip' | 'extractZip' | 'readEntry',
        expectedCode: string,
    ) => void;
    /** Write a non-archive companion file (e.g. a JSON manifest) verbatim. */
    readonly writeCompanion: (filepath: string, bytes: Uint8Array) => void;
}

export function createContext(): GenerateContext {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const results: SampleResult[] = [];
    return {
        outputDir: OUTPUT_DIR,
        results,
        writeSafe: (filepath: string, filename: string, bytes: Uint8Array): void => {
            // Self-validation: our own eager reader must accept every sample.
            const reader = openZip(bytes, { validate: 'eager', onDiagnostic: () => undefined });
            try {
                mkdirSync(dirname(filepath), { recursive: true });
                writeFileSync(filepath, bytes);
            } catch (err: unknown) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code === 'EBUSY') {
                    console.warn(`⚠ Skipped ${filename} (file is open in another program)`);
                    return;
                }
                throw err;
            }
            results.push({ file: filename, size: bytes.length, entries: reader.entryCount });
        },
        writeRefusal: (filepath: string, filename: string, bytes: Uint8Array, via, expectedCode): void => {
            let observed: string | null = null;
            try {
                if (via === 'openZip') {
                    openZip(bytes, { validate: 'eager', onDiagnostic: () => undefined });
                } else if (via === 'extractZip') {
                    extractZip(bytes, { onDiagnostic: () => undefined });
                } else {
                    const reader = openZip(bytes, { onDiagnostic: () => undefined });
                    for (const entry of reader.entries()) reader.readEntry(entry);
                }
            } catch (err) {
                observed = err instanceof ZipError ? err.code : `(non-ZipError: ${String(err)})`;
            }
            if (observed !== expectedCode) {
                throw new Error(`refusal sample ${filename}: expected ${expectedCode} via ${via}, got ${observed ?? 'NO ERROR'}`);
            }
            mkdirSync(dirname(filepath), { recursive: true });
            writeFileSync(filepath, bytes);
            results.push({ file: `${filename} → ${expectedCode}`, size: bytes.length, entries: 0 });
        },
        writeCompanion: (filepath: string, bytes: Uint8Array): void => {
            mkdirSync(dirname(filepath), { recursive: true });
            writeFileSync(filepath, bytes);
        },
    };
}

export function printSummary(results: readonly SampleResult[], outputDir: string): void {
    const formatSize = (size: number): string =>
        size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
    console.log(`\nSamples written to ${outputDir}\n`);
    console.log(`┌${'─'.repeat(46)}┬${'─'.repeat(9)}┬${'─'.repeat(12)}┐`);
    console.log(`│ ${'File'.padEnd(44)} │ ${'Entries'.padStart(7)} │ ${'Size'.padStart(10)} │`);
    console.log(`├${'─'.repeat(46)}┼${'─'.repeat(9)}┼${'─'.repeat(12)}┤`);
    for (const result of results) {
        console.log(`│ ${result.file.padEnd(44).slice(0, 44)} │ ${String(result.entries).padStart(7)} │ ${formatSize(result.size).padStart(10)} │`);
    }
    console.log(`└${'─'.repeat(46)}┴${'─'.repeat(9)}┴${'─'.repeat(12)}┘`);
    console.log(`Total: ${results.length} archives generated`);
}
