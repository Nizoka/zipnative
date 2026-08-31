import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.strict,
    {
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-non-null-assertion': 'warn',
            '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
            'eqeqeq': ['error', 'always'],
            'no-throw-literal': 'error',
            'no-shadow': 'off',
            '@typescript-eslint/no-shadow': 'error',
            'no-var': 'error',
            'prefer-const': 'error',
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
            'no-console': ['error', { allow: ['warn', 'error'] }],
            // Benchmark comparators (fflate, jszip, adm-zip) are devDependencies
            // fenced to bench/ — the engine itself must never import them.
            'no-restricted-imports': ['error', {
                paths: [
                    { name: 'fflate', message: 'Benchmark comparator only — never import from src/.' },
                    { name: 'jszip', message: 'Benchmark comparator only — never import from src/.' },
                    { name: 'adm-zip', message: 'Benchmark comparator only — never import from src/.' },
                ],
            }],
        },
    },
    {
        ignores: ['dist/**', 'tests/**', 'bench/**', 'scripts/**', 'recipes/**', '*.config.*'],
    },
);
