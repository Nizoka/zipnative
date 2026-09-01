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
import { openZip } from '../../src/index.ts';

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
