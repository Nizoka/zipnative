import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STEPS, parseArgs, probeDist, selectSteps } from '../../scripts/gate.ts';

/**
 * `scripts/gate.ts` is the single definition of "green". Its step table is
 * what CI, the publish workflow and the contributor docs point at, so the
 * table's shape is a contract: ids unique, profiles nested, the steps that
 * consume an artefact ordered after the step that produces it.
 */

const ids = STEPS.map((s) => s.id);
const inProfile = (profile: 'fast' | 'ci' | 'publish'): string[] => STEPS.filter((s) => s.profiles.includes(profile)).map((s) => s.id);
const before = (list: readonly string[], a: string, b: string): void => {
    expect(list, `${a} and ${b} both selected`).toEqual(expect.arrayContaining([a, b]));
    expect(list.indexOf(a), `${a} must run before ${b}`).toBeLessThan(list.indexOf(b));
};

describe('gate step table', () => {
    it('has unique ids that are npm scripts or inline checks', () => {
        expect(new Set(ids).size).toBe(ids.length);
        const scripts = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
        for (const step of STEPS) {
            if (step.inline) expect(step.npmScript, step.id).toBeUndefined();
            else expect(scripts[step.npmScript ?? step.id], `${step.id}: no npm script`).toBeDefined();
        }
    });

    it('nests the profiles: fast (minus test) ⊂ ci ⊂ publish', () => {
        const fast = inProfile('fast');
        const ci = inProfile('ci');
        const publish = inProfile('publish');
        for (const id of fast.filter((x) => x !== 'test')) expect(ci, id).toContain(id);
        for (const id of ci) expect(publish, id).toContain(id);
        expect(ci).not.toContain('test');
        expect(fast).toContain('test');
        expect(fast).not.toContain('build');
    });

    it('orders producers before consumers in the ci and publish profiles', () => {
        for (const profile of ['ci', 'publish'] as const) {
            const list = inProfile(profile);
            before(list, 'build', 'dist-check');
            before(list, 'build', 'dist-probe');
            before(list, 'build', 'test:coverage');
            before(list, 'build', 'check:package');
            before(list, 'test:generate', 'verify:samples');
            before(list, 'test:generate', 'validate:zip');
        }
        before(inProfile('publish'), 'test:generate', 'test:interop');
    });

    it('fails loudly when a dist-gated suite finds no bundle', () => {
        const coverage = STEPS.find((s) => s.id === 'test:coverage');
        expect(coverage?.env).toMatchObject({ GATE: '1', GATE_REQUIRE_ARTIFACTS: '1' });
        const test = STEPS.find((s) => s.id === 'test');
        expect(test?.env).toEqual({ GATE: '1' });
    });

    it('keeps the interop matrix out of the hermetic ci profile and skippable only with a reason', () => {
        const interop = STEPS.find((s) => s.id === 'test:interop');
        expect(interop?.profiles).toEqual(['publish']);
        expect(typeof interop?.skipWhen).toBe('function');
        expect(STEPS.find((s) => s.id === 'validate:zip')?.skipWhen).toBeUndefined();
    });
});

describe('gate argument parsing and step selection', () => {
    it('defaults to the ci profile', () => {
        expect(parseArgs([])).toMatchObject({ profile: 'ci', only: null, from: null, json: false, requireAll: false });
    });

    it('rejects conflicting profiles, unknown steps and unknown flags', () => {
        expect(parseArgs(['--fast', '--ci'])).toEqual({ error: '--fast and --ci are mutually exclusive' });
        expect(parseArgs(['--only', 'nope'])).toEqual({ error: 'unknown step "nope"' });
        expect(parseArgs(['--only'])).toEqual({ error: '--only needs a step id' });
        expect(parseArgs(['--bogus'])).toEqual({ error: 'unknown argument "--bogus"' });
        expect(parseArgs(['--fast', '--fast'])).toMatchObject({ profile: 'fast' });
    });

    it('--only selects one step, --from resumes a profile', () => {
        expect(selectSteps({ profile: 'ci', only: 'lint', from: null }).map((s) => s.id)).toEqual(['lint']);
        const fromBuild = selectSteps({ profile: 'ci', only: null, from: 'build' }).map((s) => s.id);
        expect(fromBuild[0]).toBe('build');
        expect(fromBuild).not.toContain('lint');
        // A step outside the profile resumes from its position in the full table.
        const fromInterop = selectSteps({ profile: 'ci', only: null, from: 'test:interop' }).map((s) => s.id);
        expect(fromInterop).toEqual([]);
        const fromGenerate = selectSteps({ profile: 'publish', only: null, from: 'test:generate' }).map((s) => s.id);
        expect(fromGenerate).toEqual(['test:generate', 'verify:samples', 'validate:zip', 'test:interop']);
    });
});

describe('dist probe', () => {
    const clean = [
        { path: 'dist/index.js', text: 'export function openZip(){}\n// one sink\nfunction warn(m){console.warn(m)}\n' },
        { path: 'dist/index.cjs', text: 'module.exports = {}\n' },
        { path: 'dist/index.d.ts', text: 'export declare function openZip(): void;\n' },
    ];

    it('accepts a clean bundle', () => {
        expect(probeDist(clean)).toEqual([]);
    });

    it('refuses console.log / console.error leaks, eval, Node I/O and foreign directories', () => {
        expect(probeDist([{ path: 'dist/index.js', text: 'console.log("debug")' }])).toEqual([expect.stringContaining('console.log()')]);
        expect(probeDist([{ path: 'dist/index.js', text: 'console.error("x")' }])).toEqual([expect.stringContaining('console.error()')]);
        expect(probeDist([{ path: 'dist/index.js', text: 'eval("1")' }])).toEqual([expect.stringContaining('eval()')]);
        expect(probeDist([{ path: 'dist/index.js', text: 'new Function("a")' }])).toEqual([expect.stringContaining('eval()')]);
        expect(probeDist([{ path: 'dist/index.cjs', text: 'require("fs")' }])).toEqual([expect.stringContaining('filesystem')]);
        expect(probeDist([{ path: 'dist/tests/x.js', text: '' }])).toEqual([expect.stringContaining('only src/')]);
        expect(probeDist([{ path: 'dist/scripts/x.d.ts', text: '' }])).toEqual([expect.stringContaining('only src/')]);
    });

    it('allows at most one console.warn sink per bundle', () => {
        expect(probeDist([{ path: 'dist/index.js', text: 'console.warn(1); console.warn(2)' }])).toEqual([expect.stringContaining('console.warn()')]);
        expect(probeDist([{ path: 'dist/index.js', text: 'console.warn(1)' }, { path: 'dist/worker/zip-worker.js', text: 'console.warn(1)' }])).toEqual([]);
    });
});
