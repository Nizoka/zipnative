import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * The executable-documentation recipes in `recipes/` import from 'zipnative'
 * exactly as a consumer would; this alias points that specifier at the
 * in-repo sources so the recipe suite always exercises the current tree.
 */
const rootUrl = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
    resolve: {
        alias: [
            { find: /^zipnative$/, replacement: rootUrl('./src/index.ts') },
            { find: /^zipnative\/worker$/, replacement: rootUrl('./src/worker/index.ts') },
        ],
    },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        globals: false,
        // The DOS timestamp conversion reads a Date with the host's local
        // calendar by default (dosTimeMode: 'local'); pinning the zone makes
        // the suite a pure function of the sources on every machine. Tests
        // that exercise other zones set process.env.TZ themselves.
        env: { TZ: 'UTC' },
        // Forks (not threads): a per-file process is what lets a test flip
        // process.env.TZ or inject a codec without leaking into its
        // neighbours, and it matches the gate's expectations (scripts/gate.ts).
        pool: 'forks',
        // Interop tests spawn real external producers (pwsh Compress-Archive
        // takes seconds to cold-start) and coverage instrumentation slows the
        // streaming codec paths; the default 5 s flakes on both.
        testTimeout: 30_000,
        // Under the gate (scripts/gate.ts sets GATE=1) a JSON report lands
        // next to the step logs so the gate can print the test count; the
        // default reporter stays for humans.
        reporters: process.env.GATE === '1'
            ? ['default', ['json', { outputFile: rootUrl('./test-output/.gate/vitest.json') }]]
            : process.env.GITHUB_ACTIONS === 'true'
                ? ['dot', 'github-actions']
                : ['default'],
        // Interop producers and the fixture-parity suites prepare archives in
        // beforeAll; the default 10 s hook timeout flakes on a loaded machine.
        hookTimeout: 30_000,
        coverage: {
            provider: 'v8',
            // json-summary is what scripts/gate.ts prints and what verify-docs
            // (derived-counts) holds declared.coverage* to — without it the
            // published coverage figure is checked by nothing.
            reporter: ['text-summary', 'json-summary', 'html'],
            include: ['src/**/*.ts'],
            exclude: [
                // Barrel files: pure re-exports, no executable statements worth counting.
                'src/index.ts',
                'src/core/index.ts',
                'src/codecs/index.ts',
                'src/parser/index.ts',
                // Pure type modules: interfaces and type aliases only, erased at compile.
                'src/types/zip-types.ts',
                'src/worker/worker-protocol.ts',
                // The worker SCRIPT executes inside real worker threads (the
                // dist-gated integration suite), where v8 coverage cannot
                // instrument it; its logic is the deflate facade + crc32,
                // both fully covered on the main thread.
                'src/worker/zip-worker.ts',
                // Runtime-environment probing (worker_threads vs Web Worker
                // spawning): the Node path runs only in the dist-gated
                // integration suite; unit tests inject fake handles instead.
                'src/worker/worker-adapter.ts',
            ],
            thresholds: {
                statements: 88,
                branches: 80,
                functions: 85,
                lines: 90,
            },
        },
    },
});
