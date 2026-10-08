#!/usr/bin/env tsx
/**
 * zipnative — Quality gate (v1.1.0)
 * ==================================
 * The single definition of what "green" means. CI, the publish workflow,
 * the contributor docs and the agent instructions all point here instead of
 * each carrying its own list of commands, so the list cannot drift between
 * them (ci.yml and publish.yml used to repeat the steps by hand).
 *
 * Every step is an existing npm script (plus the inline checks that dist/
 * is complete and clean). The gate runs them in order, captures each one's
 * full output to `test-output/.gate/<id>.log`, and prints ONE line per
 * step — a passing run is under twenty lines, which is what makes it usable
 * from an agent loop where every line of output costs tokens. On the first
 * failure it prints the tail of that step's log and stops.
 *
 * Usage:
 *   npm run gate                        # --ci: everything except the publish-only steps
 *   npm run gate:fast                   # typecheck, lint, test, verify:docs
 *   npx tsx scripts/gate.ts --publish   # everything, what publish.yml runs
 *   npx tsx scripts/gate.ts --only lint
 *   npx tsx scripts/gate.ts --from build
 *   npx tsx scripts/gate.ts --ci --json
 *   npx tsx scripts/gate.ts --publish --require-all
 *
 * (PowerShell swallows a bare `--`, so call the script directly when passing
 * flags rather than `npm run gate -- --fast`; `npm run gate:fast` exists for
 * the common case.)
 *
 * Profiles:
 *   --fast     typecheck:all, lint, test, verify:docs
 *   --ci       every hermetic step (default): the interop matrix is left to
 *              conformance.yml, which runs it on every pull request with the
 *              tool versions recorded
 *   --publish  every step, the interop matrix included; it SKIPs with a
 *              reason when no foreign ZIP tool is installed, and publish.yml
 *              adds --require-all so that can never pass silently
 *
 * Flags:
 *   --require-all  a step that would SKIP fails instead, with
 *                  `required by --require-all: <reason>`. CI and the release
 *                  workflow pass it: a runner without a single foreign ZIP
 *                  tool must go red, never quietly skip the interop gate.
 *
 * Order matters in the ci / publish profiles: `build` runs BEFORE
 * `test:coverage`, because two suites need what it produces —
 * tests/worker/worker-integration (spawns dist/worker/zip-worker.js) and
 * tests/integration/treeshake (bundles dist/index.js). With the tests first
 * those suites would skip silently on every runner, which is exactly what
 * happened to the tree-shaking proof in 1.0.0's CI. `GATE_REQUIRE_ARTIFACTS=1`
 * makes them fail loudly when their input is missing. The fast profile keeps
 * `test` first (no build; the dist-gated suites skip there by design).
 *
 * Exit codes:
 *   0 — every selected step passed or was skipped with a reason
 *   1 — a step failed (its log tail is printed; the full log is on disk),
 *       or a step would have skipped under --require-all
 *   2 — bad usage
 */

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXTRACTORS, PRODUCERS } from '../tests/helpers/interop-tools.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = join(REPO_ROOT, 'test-output', '.gate');
const VITEST_JSON = join(LOG_DIR, 'vitest.json');
const COVERAGE_SUMMARY = join(REPO_ROOT, 'coverage', 'coverage-summary.json');
const OUTPUT_DIR = join(REPO_ROOT, 'test-output');

type Profile = 'fast' | 'ci' | 'publish';

export interface Step {
    readonly id: string;
    /** The npm script this step runs. Absent for an inline check. */
    readonly npmScript?: string;
    readonly profiles: readonly Profile[];
    /** Returns a reason to skip the step, or null to run it. */
    readonly skipWhen?: () => string | null;
    /** Extra environment for the child process. */
    readonly env?: Readonly<Record<string, string>>;
    /** In-process check; returns the failure lines, empty when it passes. */
    readonly inline?: () => readonly string[];
    /** A short figure to show next to PASS, read after the step succeeds. */
    readonly note?: () => string | null;
}

// ── Skip conditions ─────────────────────────────────────────────────

/**
 * The interop gate needs at least one foreign producer or extractor;
 * `run-interop.ts` exits 1 when none ran. Probing here lets the gate SKIP
 * with a reason on a bare machine (and FAIL under --require-all) instead of
 * reporting a red step that only means "nothing to test against".
 */
function foreignZipToolPresent(): boolean {
    return PRODUCERS.some(p => p.describe() !== null) || EXTRACTORS.some(e => e.describe() !== null);
}

// ── Notes (figures shown next to PASS) ──────────────────────────────

function testCount(): string | null {
    if (!existsSync(VITEST_JSON)) return null;
    // The whole suite, skipped tests included — the figure `declared.tests`
    // in docs/assets/ecosystem.json is held to.
    const report = JSON.parse(readFileSync(VITEST_JSON, 'utf8')) as { numTotalTests?: number; numPassedTests?: number };
    const total = report.numTotalTests ?? report.numPassedTests;
    return typeof total === 'number' ? `${total} tests` : null;
}

function coverageFigure(): string | null {
    if (!existsSync(COVERAGE_SUMMARY)) return null;
    const summary = JSON.parse(readFileSync(COVERAGE_SUMMARY, 'utf8')) as {
        total?: { statements?: { pct?: number } };
    };
    const pct = summary.total?.statements?.pct;
    return typeof pct === 'number' ? `${pct.toFixed(1)}% stmts` : null;
}

function joinNotes(...parts: Array<string | null>): string | null {
    const kept = parts.filter((p): p is string => p !== null);
    return kept.length > 0 ? kept.join(', ') : null;
}

function sampleCount(): string | null {
    let n = 0;
    walkFiles(OUTPUT_DIR, (p) => {
        // Dot-directories (.gate logs, the .compat extraction) are never samples.
        const inside = p.slice(OUTPUT_DIR.length).split('\\').join('/');
        if (p.endsWith('.zip') && !inside.includes('/.')) n++;
    });
    return n > 0 ? `${n} archives` : null;
}

// ── Inline checks ───────────────────────────────────────────────────

/** Files `npm run build` must leave behind for the package to be complete. */
const DIST_FILES = [
    'dist/index.js',
    'dist/index.cjs',
    'dist/index.d.ts',
    'dist/index.d.cts',
    'dist/worker/index.js',
    'dist/worker/index.cjs',
    'dist/worker/index.d.ts',
    'dist/worker/index.d.cts',
    'dist/worker/zip-worker.js',
    'dist/worker/zip-worker.d.ts',
] as const;

function walkFiles(dir: string, visit: (path: string) => void): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
        if (entry === '.gate') continue;
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walkFiles(p, visit);
        else visit(p);
    }
}

function distCheck(): readonly string[] {
    return DIST_FILES.filter(f => !existsSync(join(REPO_ROOT, f))).map(f => `missing: ${f}`);
}

/**
 * What the emitted bundle must never contain. The engine's only sanctioned
 * console call is `console.warn` inside the diagnostics sink
 * (src/core/zip-diagnostics.ts, the ONE module allowed to call it); a
 * `console.log`/`console.error` means a debug line leaked. `eval` and
 * `new Function` are banned by the project charter ("no sockets, no eval —
 * ever"), and a `tests/` or `scripts/` directory under dist/ means a tsup
 * regression that would ship fixtures and tooling to npm. Pure, so
 * tests/tools/gate.test.ts can feed it synthetic files.
 */
export function probeDist(files: ReadonlyArray<{ readonly path: string; readonly text: string }>): string[] {
    const failures: string[] = [];
    let warnCalls = 0;
    for (const { path, text } of files) {
        const rel = path.replace(/\\/g, '/');
        if (/(^|\/)dist\/(tests|scripts|recipes|bench)\//.test(rel)) failures.push(`${rel}: only src/ may be emitted into dist/`);
        if (!rel.endsWith('.js') && !rel.endsWith('.cjs')) continue;
        if (/\bconsole\.(log|error|info|debug)\s*\(/.test(text)) failures.push(`${rel}: console.${/console\.(\w+)/.exec(text)?.[1]}() leaked into the bundle — diagnostics go through zip-diagnostics.ts`);
        if (/\beval\s*\(/.test(text) || /\bnew\s+Function\s*\(/.test(text)) failures.push(`${rel}: eval()/new Function() are banned by the charter`);
        if (/\brequire\(["'](net|http|https|child_process|fs)["']\)/.test(text)) failures.push(`${rel}: the engine must not touch sockets, processes or the filesystem`);
        warnCalls += (text.match(/\bconsole\.warn\s*\(/g) ?? []).length;
    }
    // index.js, index.cjs, worker/index.js, worker/index.cjs and the worker
    // script each bundle the diagnostics sink once at most.
    if (warnCalls > files.filter(f => /\.(js|cjs)$/.test(f.path)).length) {
        failures.push(`console.warn() appears ${warnCalls} times across the bundles — more than one sink per bundle`);
    }
    return failures;
}

function distProbe(): readonly string[] {
    const dist = join(REPO_ROOT, 'dist');
    if (!existsSync(dist)) return ['dist/ is missing (run build first)'];
    const files: Array<{ path: string; text: string }> = [];
    walkFiles(dist, (p) => {
        if (p.endsWith('.map')) return;
        files.push({ path: relative(REPO_ROOT, p), text: /\.(js|cjs)$/.test(p) ? readFileSync(p, 'utf8') : '' });
    });
    return probeDist(files);
}

// ── The gate ────────────────────────────────────────────────────────

export const STEPS: readonly Step[] = [
    { id: 'typecheck:all', npmScript: 'typecheck:all', profiles: ['fast', 'ci', 'publish'] },
    { id: 'lint', npmScript: 'lint', profiles: ['fast', 'ci', 'publish'] },
    {
        id: 'test', npmScript: 'test', profiles: ['fast'],
        env: { GATE: '1' }, note: testCount,
    },
    { id: 'build', npmScript: 'build', profiles: ['ci', 'publish'] },
    { id: 'dist-check', profiles: ['ci', 'publish'], inline: distCheck },
    { id: 'dist-probe', profiles: ['ci', 'publish'], inline: distProbe },
    {
        id: 'test:coverage', npmScript: 'test:coverage', profiles: ['ci', 'publish'],
        env: { GATE: '1', GATE_REQUIRE_ARTIFACTS: '1' }, note: () => joinNotes(testCount(), coverageFigure()),
    },
    { id: 'check:package', npmScript: 'check:package', profiles: ['ci', 'publish'] },
    { id: 'verify:docs', npmScript: 'verify:docs', profiles: ['fast', 'ci', 'publish'] },
    // The previous release's own suite against today's src/ — the behavioural
    // half of the zero-breaking-change policy (tests/tools/api-compat.test.ts
    // is the surface half). CI runs it as its own required job; the publish
    // profile repeats it so a release never ships on a stale CI run.
    { id: 'compat:previous', npmScript: 'compat:previous', profiles: ['publish'] },
    { id: 'test:generate', npmScript: 'test:generate', profiles: ['ci', 'publish'], note: sampleCount },
    { id: 'verify:samples', npmScript: 'verify:samples', profiles: ['ci', 'publish'] },
    { id: 'validate:zip', npmScript: 'validate:zip', profiles: ['ci', 'publish'] },
    {
        id: 'test:interop', npmScript: 'test:interop', profiles: ['publish'],
        skipWhen: () => (foreignZipToolPresent() ? null : 'no foreign ZIP tool installed (unzip, 7z, bsdtar, python, jar or PowerShell)'),
    },
];

// ── Running a step ──────────────────────────────────────────────────

/**
 * Run an npm script with its stdout and stderr interleaved into one log
 * file. `npm_execpath` is set whenever this script itself was started by
 * npm, and running that CLI under the current node keeps the whole gate on
 * one toolchain; outside npm (a bare `tsx scripts/gate.ts`) fall back to
 * whatever `npm` is on PATH — through a shell, since on Windows that is an
 * `npm.cmd` shim which Node refuses to spawn directly.
 */
function runNpmScript(script: string, logPath: string, extraEnv: Readonly<Record<string, string>>): number {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, NO_COLOR: '1', FORCE_COLOR: '0' };
    const fd = openSync(logPath, 'w');
    try {
        const npmCli = process.env.npm_execpath;
        const common: SpawnSyncOptions = { cwd: REPO_ROOT, env, stdio: ['ignore', fd, fd], windowsHide: true };
        const result = npmCli && existsSync(npmCli)
            ? spawnSync(process.execPath, [npmCli, 'run', script], common)
            : spawnSync('npm', ['run', script], { ...common, shell: true });
        if (result.error) throw result.error;
        return result.status ?? 1;
    } finally {
        closeSync(fd);
    }
}

function runInline(check: () => readonly string[], logPath: string): number {
    const failures = check();
    const fd = openSync(logPath, 'w');
    try {
        writeSync(fd, failures.length === 0 ? 'ok\n' : `${failures.join('\n')}\n`);
    } finally {
        closeSync(fd);
    }
    return failures.length === 0 ? 0 : 1;
}

function tail(file: string, lines: number): string[] {
    if (!existsSync(file)) return [];
    const all = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd().split('\n');
    return all.slice(-lines);
}

// ── CLI ─────────────────────────────────────────────────────────────

interface Options {
    readonly profile: Profile;
    readonly only: string | null;
    readonly from: string | null;
    readonly json: boolean;
    /** Turn every SKIP into a FAIL (CI and the release workflow). */
    readonly requireAll: boolean;
}

function usage(): string {
    return [
        'Usage: npx tsx scripts/gate.ts [--fast | --ci | --publish] [--only <id>] [--from <id>] [--require-all] [--json]',
        '',
        `Steps: ${STEPS.map(s => s.id).join(', ')}`,
    ].join('\n');
}

export function parseArgs(argv: readonly string[]): Options | { error: string } {
    let profile: Profile | null = null;
    let only: string | null = null;
    let from: string | null = null;
    let json = false;
    let requireAll = false;
    const ids = new Set(STEPS.map(s => s.id));

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--fast' || a === '--ci' || a === '--publish') {
            const p = a.slice(2) as Profile;
            if (profile !== null && profile !== p) return { error: `--${profile} and ${a} are mutually exclusive` };
            profile = p;
        } else if (a === '--only' || a === '--from') {
            const id = argv[i + 1];
            if (id === undefined || id.startsWith('--')) return { error: `${a} needs a step id` };
            if (!ids.has(id)) return { error: `unknown step "${id}"` };
            if (a === '--only') only = id; else from = id;
            i++;
        } else if (a === '--json') {
            json = true;
        } else if (a === '--require-all') {
            requireAll = true;
        } else {
            return { error: `unknown argument "${a}"` };
        }
    }
    return { profile: profile ?? 'ci', only, from, json, requireAll };
}

interface StepOutcome {
    readonly id: string;
    readonly status: 'pass' | 'fail' | 'skip';
    readonly seconds: number;
    readonly note: string | null;
}

export function selectSteps(opts: Pick<Options, 'profile' | 'only' | 'from'>): readonly Step[] {
    if (opts.only !== null) return STEPS.filter(s => s.id === opts.only);
    let selected = STEPS.filter(s => s.profiles.includes(opts.profile));
    if (opts.from !== null) {
        const at = selected.findIndex(s => s.id === opts.from);
        if (at < 0) {
            // The step exists but is not in this profile: run the profile
            // from the position it would occupy in the full table.
            const full = STEPS.findIndex(s => s.id === opts.from);
            selected = selected.filter(s => STEPS.indexOf(s) >= full);
        } else {
            selected = selected.slice(at);
        }
    }
    return selected;
}

function main(): number {
    const parsed = parseArgs(process.argv.slice(2));
    if ('error' in parsed) {
        process.stderr.write(`gate: ${parsed.error}\n${usage()}\n`);
        return 2;
    }
    const opts = parsed;
    const steps = selectSteps(opts);
    const width = Math.max(...STEPS.map(s => s.id.length));
    const say = (line: string): void => { if (!opts.json) process.stdout.write(`${line}\n`); };

    mkdirSync(LOG_DIR, { recursive: true });
    const outcomes: StepOutcome[] = [];
    const startedAt = Date.now();
    say(`gate --${opts.profile}: ${steps.length} step(s)`);

    let failedAt: string | null = null;
    for (const step of steps) {
        const reason = step.skipWhen?.() ?? null;
        if (reason !== null) {
            if (opts.requireAll) {
                const note = `required by --require-all: ${reason}`;
                outcomes.push({ id: step.id, status: 'fail', seconds: 0, note });
                say(`FAIL  ${step.id.padEnd(width)}          ${note}`);
                failedAt = step.id;
                break;
            }
            outcomes.push({ id: step.id, status: 'skip', seconds: 0, note: reason });
            say(`SKIP  ${step.id.padEnd(width)}          (${reason})`);
            continue;
        }

        const logPath = join(LOG_DIR, `${step.id.replace(/[^a-z0-9-]/gi, '-')}.log`);
        // A stale report from an earlier run must never be reported as this run's.
        if (step.env?.GATE === '1') rmSync(VITEST_JSON, { force: true });
        if (step.id === 'test:coverage') rmSync(COVERAGE_SUMMARY, { force: true });

        const t0 = Date.now();
        const status = step.inline
            ? runInline(step.inline, logPath)
            : runNpmScript(step.npmScript ?? step.id, logPath, step.env ?? {});
        const seconds = (Date.now() - t0) / 1000;
        const clock = `${seconds.toFixed(1)}s`.padStart(7);

        if (status === 0) {
            const note = step.note?.() ?? null;
            outcomes.push({ id: step.id, status: 'pass', seconds, note });
            say(`PASS  ${step.id.padEnd(width)}  ${clock}${note ? `  ${note}` : ''}`);
            continue;
        }

        const rel = relative(REPO_ROOT, logPath).replace(/\\/g, '/');
        outcomes.push({ id: step.id, status: 'fail', seconds, note: `exit ${status}; log: ${rel}` });
        say(`FAIL  ${step.id.padEnd(width)}  ${clock}  exit ${status}`);
        for (const line of tail(logPath, 12)) say(`      ${line}`);
        say(`      (full log: ${rel})`);
        failedAt = step.id;
        break;
    }

    const total = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (opts.json) {
        process.stdout.write(`${JSON.stringify({ ok: failedAt === null, profile: opts.profile, steps: outcomes }, null, 2)}\n`);
    } else if (failedAt !== null) {
        process.stdout.write(`gate: failed at ${failedAt}\n`);
    } else {
        const passed = outcomes.filter(o => o.status === 'pass').length;
        const skipped = outcomes.filter(o => o.status === 'skip').length;
        process.stdout.write(`gate: ${passed} passed, ${skipped} skipped in ${total} s\n`);
    }
    return failedAt === null ? 0 : 1;
}

// Only run when executed directly, so tests/tools/gate.test.ts can import
// the pure parts (STEPS, parseArgs, selectSteps, probeDist) without
// starting a gate.
const invokedDirectly = process.argv[1] !== undefined
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());
