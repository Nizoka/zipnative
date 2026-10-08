import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findAllowList, parseAllowList } from '../../scripts/run-compat.ts';

// v1.1.0 — the zero-breaking-change policy, half one: every export and
// every error code of the previous release still exists, with the same
// kind, subpath and signature (SECURITY.md § Compatibility promise). The
// fixtures are the registries as tagged (`git show v1.0.0:…`), committed
// so the check runs without git history (CI's shallow checkout). Half two
// is scripts/run-compat.ts, which runs the previous suite itself.

interface ApiExport {
    readonly name: string;
    readonly kind: string;
    readonly subpath: string;
    readonly signature: string;
}
interface ApiJson { readonly exportCount: number; readonly exports: readonly ApiExport[] }
interface ErrorsJson {
    readonly errors: ReadonlyArray<{ code: string; class: string; feature?: string }>;
    readonly diagnostics: ReadonlyArray<{ code: string }>;
}

const previous = JSON.parse(readFileSync('tests/compat/api-1.0.0.json', 'utf8')) as ApiJson;
const current = JSON.parse(readFileSync('docs/assets/api.json', 'utf8')) as ApiJson;
const previousErrors = JSON.parse(readFileSync('tests/compat/errors-1.0.0.json', 'utf8')) as ErrorsJson;
const currentErrors = JSON.parse(readFileSync('docs/data/errors.json', 'utf8')) as ErrorsJson;

/**
 * Signatures of 1.0.0 exports that legitimately read differently today.
 * Each entry names the ledger line of release-notes/v1.1.0.md that records
 * the change; anything else that differs is a breaking change by policy.
 */
const SIGNATURE_LEDGER: Readonly<Record<string, string>> = {
    VERSION: 'the version constant itself',
    // C6 — `extends StreamControl`: optional per-call `signal` / `onProgress` (1.1.0); every 1.0.0 call site compiles unchanged.
    StreamOptions: 'C6',
};

const key = (e: ApiExport): string => `${e.subpath}:${e.name}`;

describe('api-compat: the 1.0.0 surface is intact', () => {
    const now = new Map(current.exports.map((e) => [key(e), e] as const));

    it('the fixture is the tagged 1.0.0 registry (77 exports, 39 codes, 11 diagnostics)', () => {
        expect(previous.exportCount).toBe(77);
        expect(previous.exports).toHaveLength(77);
        expect(previousErrors.errors).toHaveLength(39);
        expect(previousErrors.diagnostics).toHaveLength(11);
    });

    it('every 1.0.0 export still exists on the same subpath with the same kind', () => {
        const missing = previous.exports.filter((e) => !now.has(key(e))).map(key);
        expect(missing, 'exports removed since 1.0.0 — semver-major').toEqual([]);
        const kindChanged = previous.exports.filter((e) => now.get(key(e))?.kind !== e.kind).map((e) => `${key(e)}: ${e.kind} → ${now.get(key(e))?.kind}`);
        expect(kindChanged).toEqual([]);
    });

    it('every 1.0.0 signature is unchanged, or its change is in the ledger', () => {
        const drifted = previous.exports
            .filter((e) => now.get(key(e))?.signature !== e.signature && !(e.name in SIGNATURE_LEDGER))
            .map((e) => `${key(e)}:\n  1.0.0 ${e.signature}\n  now   ${now.get(key(e))?.signature ?? '(missing)'}`);
        expect(drifted, 'signatures changed since 1.0.0 without a ledger entry').toEqual([]);
        for (const name of Object.keys(SIGNATURE_LEDGER)) {
            const prev = previous.exports.find((e) => e.name === name);
            expect(prev, `${name} is in the ledger but was not a 1.0.0 export`).toBeDefined();
        }
    });

    it('the surface only grew: the manifest counts at least the 1.0.0 exports', () => {
        expect(current.exportCount).toBeGreaterThanOrEqual(previous.exportCount);
        expect(current.exports.length).toBe(current.exportCount);
    });
});

describe('api-compat: the frozen error vocabulary', () => {
    it('every 1.0.0 error code exists with the same class', () => {
        const classes = new Map(currentErrors.errors.map((e) => [e.code, e.class] as const));
        const missing = previousErrors.errors.filter((e) => !classes.has(e.code)).map((e) => e.code);
        expect(missing, 'error codes removed since 1.0.0 — semver-major').toEqual([]);
        const reclassed = previousErrors.errors.filter((e) => classes.get(e.code) !== e.class).map((e) => `${e.code}: ${e.class} → ${classes.get(e.code)}`);
        expect(reclassed, 'error classes changed since 1.0.0 — instanceof branches would break').toEqual([]);
    });

    it('every 1.0.0 diagnostic code still exists', () => {
        const codes = new Set(currentErrors.diagnostics.map((d) => d.code));
        expect(previousErrors.diagnostics.filter((d) => !codes.has(d.code)).map((d) => d.code)).toEqual([]);
    });

    it('feature vocabularies only widened', () => {
        const prev = previousErrors.errors.find((e) => e.code === 'ZIP_UNSUPPORTED_ENCRYPTION')?.feature ?? '';
        const cur = currentErrors.errors.find((e) => e.code === 'ZIP_UNSUPPORTED_ENCRYPTION')?.feature ?? '';
        for (const token of prev.split('|').map((s) => s.trim()).filter(Boolean)) {
            expect(cur, `feature '${token}' disappeared from ZIP_UNSUPPORTED_ENCRYPTION`).toContain(token);
        }
    });
});

describe('api-compat: the compat-previous allow-list', () => {
    it('names the previous tag, and every exclusion carries a sentence-long reason', () => {
        const path = findAllowList(process.cwd());
        expect(path).not.toBeNull();
        const allow = parseAllowList(readFileSync(path!, 'utf8'));
        expect(allow.tag).toBe('v1.0.0');
        for (const e of allow.exclude) {
            expect(e.reason.length).toBeGreaterThan(20);
            if (e.ledger !== undefined) expect(e.ledger).toMatch(/^C\d+$/);
        }
    });

    it('rejects an allow-list without reasons or with a malformed ledger reference', () => {
        expect(() => parseAllowList(JSON.stringify({ tag: 'v1.0.0', exclude: [{ pattern: 'x', reason: 'short' }] }))).toThrow(/reason/);
        expect(() => parseAllowList(JSON.stringify({ tag: 'v1.0.0', exclude: [{ pattern: 'x', reason: 'a reason long enough to pass', ledger: 'nope' }] }))).toThrow(/ledger/);
        expect(() => parseAllowList(JSON.stringify({ tag: '1.0.0', exclude: [] }))).toThrow(/tag/);
    });
});
