import { defineConfig } from 'tsup';

export default defineConfig([
    // Main library entry.
    {
        entry: { index: 'src/index.ts' },
        format: ['esm', 'cjs'],
        dts: true,
        sourcemap: true,
        clean: true,
        splitting: false,
        treeshake: true,
        minify: false,
        target: 'es2020',
        outDir: 'dist',
    },
    // "./worker" subpath: the parallel-writer control API. `shims: true`
    // provides import.meta.url in the CJS build (worker-script resolution).
    {
        entry: { 'worker/index': 'src/worker/index.ts' },
        format: ['esm', 'cjs'],
        dts: true,
        sourcemap: true,
        clean: false,
        splitting: false,
        treeshake: true,
        minify: false,
        target: 'es2020',
        outDir: 'dist',
        shims: true,
    },
    // The worker SCRIPT: loaded by URL, never imported. noExternal bundles
    // the whole codec stack so the script resolves nothing at runtime.
    {
        entry: { 'worker/zip-worker': 'src/worker/zip-worker.ts' },
        format: ['esm'],
        dts: false,
        sourcemap: true,
        clean: false,
        splitting: false,
        treeshake: true,
        minify: false,
        target: 'es2020',
        outDir: 'dist',
        noExternal: [/.*/],
    },
]);
