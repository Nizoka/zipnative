import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FIXTURES_ROOT = 'tests/fixtures';
const MAX_FIXTURE_BYTES = 20 * 1024;

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            out.push(...walk(path));
        } else {
            out.push(path);
        }
    }
    return out;
}

describe('fixture policy (tests/fixtures/README.md)', () => {
    const files = walk(FIXTURES_ROOT).filter((p) => !p.endsWith('README.md') && !p.endsWith('.gitkeep'));

    it('every committed fixture stays under the 20 KB budget', () => {
        for (const file of files) {
            expect(statSync(file).size, `${file} exceeds the fixture budget`).toBeLessThanOrEqual(MAX_FIXTURE_BYTES);
        }
    });

    it('every committed binary fixture is listed in the provenance ledger', () => {
        const ledger = readFileSync(join(FIXTURES_ROOT, 'README.md'), 'utf8');
        for (const file of files) {
            const basename = file.split(/[\\/]/).pop() as string;
            expect(ledger.includes(basename), `${file} is missing from the provenance ledger`).toBe(true);
        }
    });

    it('the adversarial directory holds no committed files (generated-only policy)', () => {
        const adversarial = files.filter((p) => p.includes('adversarial'));
        expect(adversarial).toEqual([]);
    });
});
