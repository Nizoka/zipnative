/**
 * zipnative — documentation integrity verifier
 * ============================================
 * Named-rule checks that every version/count quoted in the tree agrees with
 * the single source of truth (docs/assets/ecosystem.json). Never writes;
 * safe on a dirty tree. Exit 1 with `path:line [rule] message` on failure.
 *
 * Flags: --online (check npm registry drift), --strict (info → error),
 *        --json (machine-readable report)
 *
 * Rule inventory grows with the docs site (pdfnative's verifier enforces
 * ~24 rules across ~40 files; this one starts with the version-sync core).
 */
import { readFileSync } from 'node:fs';

interface Problem { readonly path: string; readonly line: number; readonly rule: string; readonly message: string }

const args = new Set(process.argv.slice(2));
const online = args.has('--online');
const asJson = args.has('--json');
const problems: Problem[] = [];

const report = (path: string, line: number, rule: string, message: string): void => {
    problems.push({ path, line, rule, message });
};

// ── Load the source of truth ─────────────────────────────────────────
const ecosystem = JSON.parse(readFileSync('docs/assets/ecosystem.json', 'utf8')) as {
    packages: Record<string, { version: string | null }>;
};
const truthVersion = ecosystem.packages['zipnative']?.version;
if (typeof truthVersion !== 'string') {
    report('docs/assets/ecosystem.json', 1, 'ecosystem-shape', 'packages.zipnative.version must be a string');
}

// ── Rule: package-version-sync ───────────────────────────────────────
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string; name: string };
if (truthVersion !== null && pkg.version !== truthVersion) {
    report('package.json', 3, 'package-version-sync',
        `package.json version ${pkg.version} != ecosystem.json ${truthVersion}`);
}

// ── Rule: citation-version-sync ──────────────────────────────────────
const citation = readFileSync('CITATION.cff', 'utf8');
const citLine = citation.split(/\r?\n/).findIndex((l) => l.startsWith('version:'));
const citVersion = citLine >= 0 ? citation.split(/\r?\n/)[citLine].replace('version:', '').trim() : null;
if (citVersion !== pkg.version) {
    report('CITATION.cff', citLine + 1, 'citation-version-sync',
        `CITATION.cff version ${citVersion ?? '(missing)'} != package.json ${pkg.version}`);
}

// ── Rule: changelog-has-unreleased-or-version ────────────────────────
const changelog = readFileSync('CHANGELOG.md', 'utf8');
if (!changelog.includes('## [Unreleased]') && !changelog.includes(`## [${pkg.version}]`)) {
    report('CHANGELOG.md', 1, 'changelog-current',
        `CHANGELOG.md has neither an [Unreleased] section nor a [${pkg.version}] section`);
}

// ── Rule: sample-count canary (asymmetric by design) ─────────────────
// On-disk count ABOVE the declared count fails (stale manifest — bump
// derived.sampleZips); BELOW only warns (normal local state after a
// partial run); zero is ignored (test-output/ is git-ignored).
{
    const declared = (ecosystem as { derived?: { sampleZips?: number } }).derived?.sampleZips;
    if (typeof declared === 'number') {
        const { existsSync, readdirSync, statSync } = await import('node:fs');
        const { join } = await import('node:path');
        const countZips = (dir: string): number => {
            let count = 0;
            for (const name of readdirSync(dir)) {
                const path = join(dir, name);
                if (statSync(path).isDirectory()) count += countZips(path);
                else if (name.endsWith('.zip')) count++;
            }
            return count;
        };
        if (existsSync('test-output')) {
            const onDisk = countZips('test-output');
            if (onDisk > declared) {
                report('docs/assets/ecosystem.json', 1, 'sample-count',
                    `test-output/ holds ${onDisk} archives but derived.sampleZips declares ${declared} — `
                    + 'a generator grew; bump the manifest');
            } else if (onDisk > 0 && onDisk < declared) {
                console.error(`verify-docs: note — test-output/ holds ${onDisk}/${declared} declared samples `
                    + '(normal after a partial run; npm run test:generate refreshes)');
            }
        }
    }
}

// ── Rule: npm-drift (online only) ────────────────────────────────────
if (online) {
    try {
        const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`);
        if (res.ok) {
            const latest = (await res.json()) as { version?: string };
            if (latest.version !== undefined && latest.version !== pkg.version) {
                report('package.json', 3, 'npm-drift',
                    `npm latest is ${latest.version}, tree says ${pkg.version} (expected during a release window only)`);
            }
        }
        // 404 = not yet published: fine.
    } catch {
        report('package.json', 3, 'npm-drift', 'could not reach the npm registry');
    }
}

// ── Output ───────────────────────────────────────────────────────────
if (asJson) {
    console.error(JSON.stringify({ ok: problems.length === 0, problems }, null, 2));
} else {
    for (const p of problems) console.error(`${p.path}:${p.line} [${p.rule}] ${p.message}`);
}
if (problems.length > 0) {
    console.error(`\nverify-docs: ${problems.length} problem(s)`);
    process.exit(1);
}
console.error('verify-docs: OK');
