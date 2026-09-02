/**
 * ESM / tree-shaking proof over the PUBLISHED bundle: importing one small
 * export must not drag the writer or the codecs along, and a bare
 * side-effect import must shake to (near) nothing — the empirical form of
 * `"sideEffects": false` + zero module-level side effects. Bundles are
 * built with esbuild (the same engine tsup uses, pinned via
 * overrides.esbuild), aliasing the package name at the repo ROOT so
 * esbuild resolves through package.json (exports map + sideEffects flag),
 * exactly like a consumer's bundler would. Requires a prior
 * `npm run build` — skipped when dist is absent (like the worker
 * integration suite).
 */
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const hasDist = existsSync(resolve(ROOT, 'dist/index.js'));

async function bundle(contents: string): Promise<string> {
    const result = await build({
        stdin: { contents, resolveDir: ROOT, loader: 'ts' },
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        // Resolve the package name at the repo root: package.json's
        // exports map and sideEffects flag apply, as they would for a
        // consumer installing from npm.
        alias: { zipnative: ROOT },
        treeShaking: true,
        minify: false,
        logLevel: 'silent',
    });
    return result.outputFiles[0].text;
}

describe.skipIf(!hasDist)('tree-shaking proof (dist-gated)', () => {
    it('a single small import does not drag the writer or the codecs along', async () => {
        const named = await bundle("export { crc32 } from 'zipnative';");
        const full = await bundle("export * from 'zipnative';");

        // The heavy subsystems must be absent from the crc32-only bundle.
        for (const marker of ['deflateRawJS', 'inflateRawJS', 'archiveSegments', 'createZipModifier']) {
            expect(named.includes(marker), `crc32-only bundle must not contain ${marker}`).toBe(false);
        }
        // And it must be a small fraction of the full surface (measured
        // ~5%; the generous bound catches structural regressions only).
        expect(full.length).toBeGreaterThan(50_000);
        expect(named.length / full.length).toBeLessThan(0.15);
    });

    it('a bare side-effect import shakes to nothing (sideEffects: false honoured)', async () => {
        const bare = await bundle("import 'zipnative';");
        // esbuild keeps only whitespace/comments when the package declares
        // sideEffects: false and the entry has no module-level effects.
        expect(bare.trim().length).toBeLessThan(200);
    });

    it('the published entry is real ESM with named exports', async () => {
        const full = await bundle("export * from 'zipnative';");
        expect(full).toContain('export {');
        expect(full).not.toContain('module.exports');
    });
});
