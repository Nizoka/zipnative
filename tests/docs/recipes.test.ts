import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface RecipeSpec {
    readonly file: string;
    readonly task: string;
    readonly surface: readonly string[];
    readonly since: string;
    readonly expects: readonly string[];
}

const index = JSON.parse(readFileSync('recipes/index.json', 'utf8')) as { recipes: RecipeSpec[] };

describe('recipes are executable documentation', () => {
    for (const spec of index.recipes) {
        it(`${spec.file}: ${spec.task}`, async () => {
            const mod = await import(/* @vite-ignore */ `../../recipes/${spec.file}`) as { default: () => Promise<Record<string, string>> };
            expect(typeof mod.default, `${spec.file} must default-export a run function`).toBe('function');
            const result = await mod.default();
            for (const expectation of spec.expects) {
                const eq = expectation.indexOf('=');
                const key = expectation.slice(0, eq);
                const value = expectation.slice(eq + 1);
                expect(result[key], `${spec.file} expects ${expectation}`).toBe(value);
            }
        });
    }

    it('declares at least one recipe', () => {
        expect(index.recipes.length).toBeGreaterThan(0);
    });
});
