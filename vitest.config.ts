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
        ],
    },
    test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        globals: false,
        // Interop tests spawn real external producers (pwsh Compress-Archive
        // takes seconds to cold-start) and coverage instrumentation slows the
        // streaming codec paths; the default 5 s flakes on both.
        testTimeout: 30_000,
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: [
                // Barrel files: pure re-exports, no executable statements worth counting.
                'src/index.ts',
                'src/core/index.ts',
                'src/codecs/index.ts',
                'src/parser/index.ts',
                // Pure type modules: interfaces and type aliases only, erased at compile.
                'src/types/zip-types.ts',
            ],
            thresholds: {
                statements: 85,
                branches: 78,
                functions: 85,
                lines: 85,
            },
        },
    },
});
