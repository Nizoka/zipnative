import { defineConfig } from 'tsup';

export default defineConfig([
    // Main library entry. A self-contained worker bundle entry
    // ('worker/index': 'src/worker/zip-worker.ts', noExternal: [/.*/])
    // is added in milestone M4 alongside the "./worker" subpath export.
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
]);
