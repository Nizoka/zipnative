import { describe, it, expect } from 'vitest';
import {
    OUTPUT_DIR, BASELINE_PATH,
    walkZips, fingerprintAll, loadBaseline, compareToBaseline,
    chainSince, unexpectedDuplicates, IDENTICAL_SAMPLE_GROUPS,
    type Fingerprint, type Baseline,
} from '../../scripts/lib/sample-fingerprint.ts';

// v1.1.0 — sample regression gate.
//
// The sample corpus lives in the git-ignored `test-output/`, which only
// `npm run test:generate` populates. This suite therefore SKIPS when the
// corpus is absent (mirroring how `validate:zip` skips when no foreign tool
// is installed) and is blocking in the dedicated CI workflow
// (sample-regression.yml), which generates the samples first.

const samples = [...walkZips(OUTPUT_DIR)];
const haveCorpus = samples.length > 0;

describe.runIf(haveCorpus)('sample regression baseline', () => {
    it('every tracked sample still emits what its reference release emitted', () => {
        const baseline = loadBaseline();
        expect(baseline, `missing baseline at ${BASELINE_PATH}`).not.toBeNull();

        const { entries, unreadable } = fingerprintAll();
        expect(unreadable, 'samples that could not be fingerprinted').toEqual([]);

        const { changed, removed } = compareToBaseline(entries, baseline!);
        expect(changed, 'samples whose output changed').toEqual([]);
        expect(removed, 'baseline entries with no generated sample').toEqual([]);
        // `added` is deliberately not asserted: a sample introduced by the
        // release under development has no earlier reference to be held to.
        // `verify-samples --strict` is the opt-in gate for that.
    });

    it('never holds two samples meant to differ to the same bytes', () => {
        const baseline = loadBaseline()!;
        expect(unexpectedDuplicates(baseline.entries)).toEqual([]);
        expect(unexpectedDuplicates(fingerprintAll().entries)).toEqual([]);
        for (const group of IDENTICAL_SAMPLE_GROUPS) {
            for (const path of group) expect(baseline.entries[path], `${path} listed as identical but absent`).toBeDefined();
        }
    });

    it('records the timezone the baseline was built with', () => {
        const baseline = loadBaseline()!;
        expect(baseline.timezone).toBe('UTC');
    });

    it('anchors every entry to the release its reference was captured at', () => {
        const baseline = loadBaseline()!;
        const semver = /^\d+\.\d+\.\d+$/;
        for (const [path, entry] of Object.entries(baseline.entries)) {
            expect(entry.since, `${path} has no \`since\``).toMatch(semver);
        }
    });

    it('never stamps an entry with a release later than the baseline itself', () => {
        const baseline = loadBaseline()!;
        const rank = (v: string): number => {
            const [a, b, c] = v.split('.').map(Number);
            return a * 1e6 + b * 1e3 + c;
        };
        const ceiling = rank(baseline.baselineVersion);
        for (const [path, entry] of Object.entries(baseline.entries)) {
            expect(rank(entry.since), `${path} claims a reference from the future`).toBeLessThanOrEqual(ceiling);
        }
    });
});

describe('chainSince', () => {
    const fp = (hash: string): Fingerprint => ({ hash, size: 1 });
    const previous: Baseline = {
        $comment: '', baselineVersion: '1.0.0', provenance: '', timezone: 'UTC',
        entries: { 'a.zip': { hash: 'aa', size: 1, since: '1.0.0' }, 'b.zip': { hash: 'bb', size: 1, since: '1.0.0' } },
    };

    it('keeps `since` for an unchanged sample and re-anchors a changed one', () => {
        const out = chainSince({ 'a.zip': fp('aa'), 'b.zip': fp('b2'), 'c.zip': fp('cc') }, previous, '1.1.0');
        expect(out['a.zip'].since).toBe('1.0.0');
        expect(out['b.zip'].since).toBe('1.1.0');
        expect(out['c.zip'].since).toBe('1.1.0');
    });

    it('sorts entries by path so the manifest diff is stable', () => {
        const out = chainSince({ 'z.zip': fp('z'), 'a.zip': fp('a') }, null, '1.1.0');
        expect(Object.keys(out)).toEqual(['a.zip', 'z.zip']);
    });

    it('flags duplicates outside the allowed identical groups', () => {
        const dupes = unexpectedDuplicates({ 'x.zip': fp('same'), 'y.zip': fp('same'), 'w.zip': fp('other') });
        expect(dupes).toEqual([['x.zip', 'y.zip']]);
        const allowed = unexpectedDuplicates({
            [IDENTICAL_SAMPLE_GROUPS[0][0]]: fp('same'),
            [IDENTICAL_SAMPLE_GROUPS[0][1]]: fp('same'),
        });
        expect(allowed).toEqual([]);
    });
});
