import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Workflow, supply-chain and contributor invariants ─────────────────
//
// None of this is visible to the type checker or to the test suite proper:
// a floating action tag, a checkout that keeps the job token, a release job
// that quietly skips the interop matrix, an npm client that drifts between
// two publishes, a required status check whose job id was renamed. Each is
// locked here as a plain-text assertion on the files that carry it.

const ROOT = process.cwd();
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const workflowFiles = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml')).sort();
const readWorkflow = (f: string): string => readFileSync(join(WORKFLOWS, f), 'utf8');
// The Linux runners are case-sensitive while a Windows or macOS checkout is
// not: a path that differs from the committed name only by case reads fine
// here and ENOENTs on `ci (22)` / `ci (24)`. realpathSync.native yields the
// on-disk spelling, so a case slip fails on every platform.
const readText = (...parts: string[]): string => {
    let dir = ROOT;
    for (const part of parts) {
        if (!readdirSync(dir).includes(part)) {
            const actual = readdirSync(dir).find((f) => f.toLowerCase() === part.toLowerCase());
            throw new Error(`${parts.join('/')}: "${part}" is spelled "${actual ?? '(absent)'}" on disk — Linux checkouts are case-sensitive`);
        }
        dir = join(dir, part);
    }
    return readFileSync(dir, 'utf8');
};

const HARDEN_RUNNER = 'step-security/harden-runner@';

/** Every `- name:`/`- uses:` step block of every job, in order, keyed by job id. */
function jobSteps(text: string): Map<string, string[]> {
    const jobs = new Map<string, string[]>();
    const jobsAt = text.search(/^jobs:\s*$/m);
    if (jobsAt < 0) return jobs;
    let job: string | null = null;
    let steps: string[] | null = null;
    for (const line of text.slice(jobsAt).split('\n').slice(1)) {
        const jobHead = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
        if (jobHead) { job = jobHead[1]; steps = null; continue; }
        if (/^    steps:\s*$/.test(line) && job) { steps = []; jobs.set(job, steps); continue; }
        if (steps === null) continue;
        if (/^      - /.test(line)) steps.push(line);
        else if (/^ {8,}\S/.test(line) && steps.length > 0) steps[steps.length - 1] += `\n${line}`;
    }
    return jobs;
}

interface Ruleset {
    rules: Array<{ type: string; parameters?: { required_status_checks?: Array<{ context: string }> } }>;
}

function requiredChecks(): string[] {
    const ruleset = JSON.parse(readText('.github', 'rulesets', 'main.json')) as Ruleset;
    return ruleset.rules.find((r) => r.type === 'required_status_checks')?.parameters?.required_status_checks?.map((c) => c.context) ?? [];
}

// ── Actions: pinned, hardened, credential-free ───────────────────────

describe('every workflow', () => {
    const allFiles = workflowFiles.map((f) => ({ label: f, text: readWorkflow(f) }));

    it('pins every action to a 40-hex commit SHA with a version comment', () => {
        for (const { label, text } of allFiles) {
            const uses = [...text.matchAll(/^\s*(?:- )?uses:\s*(\S+)[^\n]*$/gm)];
            expect(uses.length, `${label} declares no action`).toBeGreaterThan(0);
            for (const m of uses) {
                const ref = m[1];
                if (ref.startsWith('./')) continue; // local composite action
                expect(ref, `${label}: ${ref}`).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
                expect(m[0], `${label}: ${ref} lacks a "# vX.Y.Z" comment`).toMatch(/#\s*v\d+\.\d+\.\d+\s*$/);
            }
        }
    });

    it('every actions/checkout step disables persist-credentials', () => {
        for (const { label, text } of allFiles) {
            const re = /uses: actions\/checkout@[^\n]*\n((?:[ \t]+[^\n]*\n)*)/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
                const block = m[1].split('\n').filter((l) => l.trim() !== '' && !/^\s+- /.test(l));
                expect(block.some((l) => /persist-credentials:\s*false/.test(l)), `${label}: checkout keeps credentials`).toBe(true);
            }
        }
    });

    it('declares top-level permissions and a timeout on every job', () => {
        for (const { label, text } of allFiles) {
            expect(text, `${label}: no top-level permissions`).toMatch(/^permissions:/m);
            const jobs = jobSteps(text);
            for (const job of jobs.keys()) {
                const body = new RegExp(`^  ${job}:\\s*\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\s*$|(?![\\s\\S]))`, 'm').exec(text)?.[1] ?? '';
                expect(body, `${label} › ${job}: no timeout-minutes`).toMatch(/timeout-minutes:\s*\d+/);
            }
        }
    });
});

describe('every workflow job', () => {
    it('starts with harden-runner in audit mode (macOS exempt: the action does not support it)', () => {
        for (const f of workflowFiles) {
            const jobs = jobSteps(readWorkflow(f));
            expect(jobs.size, `${f}: no job with steps`).toBeGreaterThan(0);
            for (const [job, steps] of jobs) {
                expect(steps[0], `${f} › ${job}: first step`).toContain(HARDEN_RUNNER);
                expect(steps[0], `${f} › ${job}: egress policy`).toMatch(/egress-policy:\s*audit/);
            }
        }
    });

    it('installs dependencies with --ignore-scripts', () => {
        for (const f of workflowFiles) {
            for (const m of readWorkflow(f).matchAll(/run: npm ci\b[^\n]*/g)) {
                expect(m[0], `${f}`).toContain('npm ci --ignore-scripts');
            }
        }
    });

    it('selects Node from .nvmrc or an explicit CI matrix, never a floating range', () => {
        for (const f of workflowFiles) {
            const text = readWorkflow(f);
            for (const m of text.matchAll(/node-version:[ \t]*([^\n]+?)[ \t]*$/gm)) {
                expect(m[1], `${f}: ${m[0]}`).toMatch(/^(?:\$\{\{ matrix\.node-version \}\}|\[22, 24\])$/);
            }
            if (/actions\/setup-node@/.test(text)) {
                expect(text, `${f}: setup-node without .nvmrc or a matrix`).toMatch(/node-version-file:\s*\.nvmrc|node-version:\s*\$\{\{ matrix\.node-version \}\}/);
            }
        }
    });
});

// ── The gate is the only definition of green ─────────────────────────

describe('ci.yml', () => {
    const ci = readWorkflow('ci.yml');

    it('keeps the job ids and matrices the ruleset requires', () => {
        expect(ci).toMatch(/^  ci:\s*$/m);
        expect(ci).toMatch(/^  os:\s*$/m);
        expect(ci).toMatch(/node-version:\s*\[22, 24\]/);
        expect(ci).toMatch(/os:\s*\[windows-latest, macos-latest\]/);
        expect(requiredChecks()).toEqual(expect.arrayContaining(['ci (22)', 'ci (24)', 'os (windows-latest)', 'os (macos-latest)', 'compat-previous']));
        expect(ci).toMatch(/^  compat-previous:\s*$/m);
    });

    it('compat-previous fetches only the previous tag, anonymously, and runs the previous suite through the npm script', () => {
        const job = /^  compat-previous:[\s\S]*?(?=^  [a-z-]+:\s*$|(?![\s\S]))/m.exec(ci)?.[0] ?? '';
        expect(job).toMatch(/persist-credentials: false/);
        expect(job).toMatch(/git fetch --no-tags --depth=1 origin "\+refs\/tags\/\$\{TAG\}:refs\/tags\/\$\{TAG\}"/);
        expect(job).toMatch(/node-version-file: \.nvmrc/);
        expect(job).toMatch(/run: npm run compat:previous/);
        expect(job).not.toMatch(/fetch-depth: 0/);
    });

    it('has no path filter: its jobs are required checks that must always report', () => {
        expect(ci).not.toMatch(/^s+paths(-ignore)?:/m);
    });

    it('runs the gate with --require-all and audits outside it', () => {
        expect(ci).toMatch(/run: npx tsx scripts\/gate\.ts --ci --require-all/);
        expect(ci).toMatch(/run: npm audit --audit-level=high/);
        expect(ci).toMatch(/if: failure\(\)[\s\S]*upload-artifact[\s\S]*test-output\/\.gate\//);
    });

    it('lists no gate step by hand', () => {
        for (const step of ['typecheck:all', 'test:coverage', 'verify:samples', 'validate:zip', 'test:interop', 'check:package', 'verify:docs', 'npm run build', 'npm run lint']) {
            expect(ci, step).not.toMatch(new RegExp(`run: (npm run )?${step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
        }
    });
});

describe('conformance.yml', () => {
    const conformance = readWorkflow('conformance.yml');

    it('runs the samples, baseline, ISO validator and interop matrix through the gate on Linux and Windows', () => {
        expect(conformance).toMatch(/^  interop-linux:\s*$/m);
        expect(conformance).toMatch(/^  interop-windows:\s*$/m);
        expect(requiredChecks()).toEqual(expect.arrayContaining(['interop-linux', 'interop-windows']));
        const gateRuns = [...conformance.matchAll(/run: npx tsx scripts\/gate\.ts --publish --from test:generate --require-all/g)];
        expect(gateRuns).toHaveLength(2);
        expect(conformance).not.toMatch(/^s+paths:/m);
    });

    it('records the foreign tool versions before testing against them', () => {
        for (const [, steps] of jobSteps(conformance)) {
            const versions = steps.findIndex((s) => /Record tool versions/.test(s));
            const gate = steps.findIndex((s) => /scripts\/gate\.ts/.test(s));
            expect(versions).toBeGreaterThanOrEqual(0);
            expect(versions).toBeLessThan(gate);
        }
    });

    it('runs the large-archive suite only here, behind ZIPNATIVE_BIG_TESTS', () => {
        expect(conformance).toMatch(/ZIPNATIVE_BIG_TESTS:\s*'1'/);
        for (const f of workflowFiles.filter((x) => x !== 'conformance.yml')) {
            expect(readWorkflow(f), f).not.toContain('ZIPNATIVE_BIG_TESTS');
        }
    });
});

describe('publish.yml', () => {
    const publish = readWorkflow('publish.yml');
    const jobs = jobSteps(publish);
    const jobBody = (id: string): string => new RegExp(`^  ${id}:\\s*\\n([\\s\\S]*?)(?=^  [a-z-]+:\\s*$|(?![\\s\\S]))`, 'm').exec(publish)?.[1] ?? '';
    const index = (steps: readonly string[], needle: string | RegExp): number =>
        steps.findIndex((s) => (typeof needle === 'string' ? s.includes(needle) : needle.test(s)));

    it('mints an OIDC token at job level only, in the two jobs that need it, and never reads an NPM_TOKEN secret', () => {
        expect(publish).toMatch(/^permissions:\s*\n\s*contents:\s*read\s*$/m);
        expect(publish).not.toMatch(/^id-token:/m);
        expect(publish).not.toMatch(/secrets\.NPM_TOKEN/);
        const holders = ['verify', 'publish', 'attest'].filter((id) => /^\s{6}id-token:\s*write/m.test(jobBody(id)));
        expect(holders).toEqual(['publish', 'attest']);
    });

    it('runs nothing from the repository under a publishing token: the gate, npm ci and npx live in verify only', () => {
        for (const id of ['publish', 'attest']) {
            const steps = (jobs.get(id) ?? []).join('\n');
            expect(steps, id).not.toMatch(/scripts\/gate\.ts|npm ci\b|npm run |npx /);
        }
        expect((jobs.get('verify') ?? []).join('\n')).toMatch(/npm ci --ignore-scripts/);
        expect(jobBody('verify')).not.toMatch(/^\s{6}id-token:/m);
        // The publish job checks out one file — .nvmrc — and nothing a dev dependency could touch.
        expect((jobs.get('publish') ?? []).join('\n')).toMatch(/sparse-checkout: \.nvmrc\b/);
        expect((jobs.get('attest') ?? []).join('\n')).not.toMatch(/actions\/checkout@/);
    });

    it('publishes from the npm-publish environment, one release at a time', () => {
        expect(publish.match(/^\s*environment:\s*npm-publish\s*$/gm)).toHaveLength(1);
        expect(jobBody('publish')).toMatch(/environment:\s*npm-publish/);
        expect(publish).toMatch(/concurrency:\s*\n\s*group:\s*publish\s*\n\s*cancel-in-progress:\s*false/);
    });

    it('pins the npm client to one exact 11.x release, at least 11.5.1, in verify before npm ci and in publish before npm publish', () => {
        const pins = [...publish.matchAll(/npm install -g npm@(\S+)/g)].map((m) => m[1]);
        expect(pins.length).toBeGreaterThanOrEqual(2);
        expect(new Set(pins).size).toBe(1);
        expect(pins[0]).toMatch(/^\d+\.\d+\.\d+$/);
        const [major, minor, patch] = pins[0].split('.').map(Number);
        expect(major === 11 && (minor > 5 || (minor === 5 && patch >= 1))).toBe(true);
        expect(publish).toContain(`test "$(npm --version)" = "${pins[0]}"`);
        const verify = jobs.get('verify') ?? [];
        expect(index(verify, 'npm install -g npm@')).toBeLessThan(index(verify, 'npm ci --ignore-scripts'));
        const pub = jobs.get('publish') ?? [];
        expect(index(pub, 'npm install -g npm@')).toBeLessThan(index(pub, /run: npm publish/));
    });

    it('builds on the .nvmrc Node line and publishes the handed-on tarball with provenance', () => {
        expect(publish).toMatch(/node-version-file:\s*\.nvmrc/);
        expect(publish).not.toMatch(/^\s+node-version:\s*\d/m);
        expect(publish).toMatch(/run: npm publish "\.\/zipnative-\$\{VERSION\}\.tgz" --provenance --access public\s*$/m);
        expect(publish).toMatch(/run: npm publish "\.\/zipnative-\$\{VERSION\}\.tgz" --provenance --access public --dry-run\s*$/m);
        expect(publish).toMatch(/run: npm pack --dry-run/);
        const pub = jobs.get('publish') ?? [];
        const real = pub.find((s) => /run: npm publish "[^"]+" --provenance --access public\s*$/m.test(s)) ?? '';
        const dry = pub.find((s) => /--dry-run\s*$/m.test(s)) ?? '';
        expect(real).toMatch(/if: \$\{\{ !inputs\.dry-run \}\}/);
        expect(dry).toMatch(/if: \$\{\{ inputs\.dry-run \}\}/);
    });

    it('restores no dependency cache in any release job', () => {
        const setups = publish.match(/uses: actions\/setup-node@/g) ?? [];
        const disabled = publish.match(/^\s+package-manager-cache: false\s*$/gm) ?? [];
        expect(setups.length).toBeGreaterThan(0);
        expect(disabled).toHaveLength(setups.length);
        expect(publish).not.toMatch(/cache:\s*npm/);
    });

    it('refuses to publish from anything but the matching tag, waived only by the dry-run input', () => {
        expect(publish).toMatch(/GITHUB_REF_TYPE}" != "tag"/);
        expect(publish).toMatch(/does not match package\.json version/);
        expect(publish).toMatch(/DRY_RUN: \$\{\{ inputs\.dry-run \}\}/);
        expect(publish).toMatch(/dry-run:\s*\n\s*description:/);
        expect(publish).toMatch(/type: boolean\s*\n\s*default: true/);
    });

    it('verify fetches the previous tag, runs the full publish gate, then packs once and hands the artifact on', () => {
        const steps = jobs.get('verify') ?? [];
        const fetch = index(steps, 'git fetch --no-tags --depth=1 origin "+refs/tags/${TAG}:refs/tags/${TAG}"');
        const gate = index(steps, 'run: npx tsx scripts/gate.ts --publish --require-all');
        const dry = index(steps, 'run: npm pack --dry-run');
        const pack = index(steps, 'npm pack --json');
        const upload = index(steps, 'uses: actions/upload-artifact@');
        expect([fetch, gate, dry, pack, upload].every((i) => i >= 0)).toBe(true);
        expect(fetch).toBeLessThan(gate);
        expect(gate).toBeLessThan(dry);
        expect(dry).toBeLessThan(pack);
        expect(pack).toBeLessThan(upload);
        expect(steps[pack]).toMatch(/npm sbom --sbom-format cyclonedx --omit dev --package-lock-only/);
        expect(steps[pack]).toMatch(/sha256sum/);
        expect(steps[upload]).toMatch(/name: release/);
        expect(steps[upload]).toMatch(/if-no-files-found: error/);
        expect(steps[upload]).toMatch(/retention-days: 7/);
        for (const hand of ['npm run validate:zip', 'npm run test:interop', 'npm run verify:samples', 'npm run test:coverage', 'npm run typecheck:all', 'npm run verify:docs']) {
            expect(publish, hand).not.toContain(`run: ${hand}`);
        }
    });

    it('hands one artifact from verify to publish to attest, digest-checked at each hop', () => {
        expect(publish.match(/uses: actions\/upload-artifact@/g)).toHaveLength(1);
        expect(publish.match(/uses: actions\/download-artifact@[0-9a-f]{40}/g)).toHaveLength(2);
        expect(publish.match(/name: release/g)).toHaveLength(3);
        const pub = jobs.get('publish') ?? [];
        expect(index(pub, 'uses: actions/download-artifact@')).toBeLessThan(index(pub, 'sha256sum --check --strict'));
        expect(index(pub, 'sha256sum --check --strict')).toBeLessThan(index(pub, /run: npm publish/));
        expect(jobBody('publish')).toMatch(/needs\.verify\.outputs\.sha256/);
        expect(jobBody('publish')).toMatch(/needs\.verify\.outputs\.integrity/);
        expect(jobBody('attest')).toMatch(/needs\.publish\.outputs\.sha256/);
        expect((jobs.get('attest') ?? []).join('\n')).toMatch(/sha256sum --check --strict/);
    });

    it('has an attest job with exactly three permissions that attests the published tarball and the SBOM', () => {
        const body = jobBody('attest');
        expect(body).not.toBe('');
        expect(body).toMatch(/needs:\s*publish/);
        expect(body).toMatch(/if: \$\{\{ !inputs\.dry-run \}\}/);
        const perms = /permissions:\s*\n((?:\s{6}[a-z-]+:\s*\w+\s*\n)+)/.exec(body);
        expect(perms).not.toBeNull();
        const granted = perms![1].trim().split('\n').map((l) => l.trim()).sort();
        expect(granted).toEqual(['attestations: write', 'contents: write', 'id-token: write']);
        expect(body).toMatch(/npm view "zipnative@\$\{VERSION\}" dist\.integrity/);
        expect(body).toMatch(/cmp "registry\/zipnative-\$\{VERSION\}\.tgz" "release\/zipnative-\$\{VERSION\}\.tgz"/);
        expect(body).toMatch(/uses: actions\/attest-build-provenance@[0-9a-f]{40}/);
        expect(body).toMatch(/gh release view "v\$\{VERSION\}"[\s\S]*gh release upload "v\$\{VERSION\}"[^\n]*--clobber/);
        expect(body).not.toMatch(/gh release create/);
        expect(body).not.toMatch(/npm run build|run: npm pack\s*$/m);
        expect(publish).not.toMatch(/cyclonedx-npm/);
    });

    it('lists the endpoints for the future block policy', () => {
        for (const host of ['api.github.com', 'registry.npmjs.org', 'fulcio.sigstore.dev', 'rekor.sigstore.dev', 'tuf-repo-cdn.sigstore.dev']) {
            expect(publish).toContain(host);
        }
    });
});

describe('package.json publish settings', () => {
    const pkg = JSON.parse(readText('package.json')) as {
        publishConfig?: Record<string, unknown>;
        scripts: Record<string, string>;
        packageManager?: string;
        engines?: { node?: string };
    };

    it('declares public access with provenance and a pinned package manager', () => {
        expect(pkg.publishConfig).toEqual({ access: 'public', provenance: true });
        expect(pkg.packageManager).toMatch(/^npm@\d+\.\d+\.\d+$/);
        expect(pkg.engines?.node).toBe('>=22');
    });

    it('exposes the gate, the sample baseline and the opt-in git hooks', () => {
        expect(pkg.scripts['gate']).toBe('npx tsx scripts/gate.ts');
        expect(pkg.scripts['gate:fast']).toBe('npx tsx scripts/gate.ts --fast');
        expect(pkg.scripts['verify:samples']).toBe('npx tsx scripts/verify-samples.ts');
        expect(pkg.scripts['agents:rules']).toBe('npx tsx scripts/build-claude-rules.ts');
        expect(pkg.scripts['hooks:install']).toBe('node scripts/install-git-hooks.mjs');
        expect(pkg.scripts['hooks:uninstall']).toBe('node scripts/install-git-hooks.mjs --uninstall');
        expect(existsSync(join(ROOT, '.githooks', 'pre-commit'))).toBe(true);
        expect(existsSync(join(ROOT, '.githooks', 'pre-push'))).toBe(true);
    });
});

// ── Dependency hygiene ───────────────────────────────────────────────

describe('dependency review and audit', () => {
    it('reviews every pull request for high vulnerabilities and licences', () => {
        const review = readWorkflow('dependency-review.yml');
        expect(review).toMatch(/^on:\s*\n\s*pull_request:/m);
        expect(review).toMatch(/uses: actions\/dependency-review-action@[0-9a-f]{40}/);
        expect(review).toMatch(/fail-on-severity:\s*high/);
        expect(review).toMatch(/allow-licenses:\s*MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, CC0-1.0, Unlicense/);
        expect(review).toMatch(/comment-summary-in-pr:\s*on-failure/);
    });

    it('audits the lockfile weekly', () => {
        const audit = readWorkflow('audit.yml');
        expect(audit).toMatch(/schedule:\s*\n\s*- cron:/);
        expect(audit).toMatch(/workflow_dispatch:/);
        expect(audit).toMatch(/run: npm ci --ignore-scripts/);
        expect(audit).toMatch(/run: npm audit --audit-level=high/);
    });

    it('.npmrc, .nvmrc and .node-version carry the contributor defaults', () => {
        expect(readText('.npmrc')).toBe('ignore-scripts=true\nfund=false\naudit-level=high\n');
        expect(readText('.nvmrc').trim()).toBe('22');
        expect(readText('.node-version')).toBe('22\n');
    });

    it('keeps Dependabot off the majors the pins own', () => {
        const dependabot = readText('.github', 'dependabot.yml');
        for (const name of ['@types/node', 'tsx', 'typescript', 'vitest', 'tsup']) {
            expect(dependabot, name).toMatch(new RegExp(`dependency-name: "${name.replace('/', '\\/')}"\\s*\\n\\s*update-types: \\["version-update:semver-major"\\]`));
        }
    });

    it('guards the sample baseline with an always-reporting workflow', () => {
        const wf = readWorkflow('sample-regression.yml');
        expect(wf).toMatch(/^  sample-regression:\s*$/m);
        expect(wf).not.toMatch(/^\s+paths:/m);
        expect(wf).toMatch(/run: npm run test:generate/);
        expect(wf).toMatch(/run: npx tsx scripts\/verify-samples\.ts\s*$/m);
        expect(requiredChecks()).toContain('sample-regression');
    });

    it('protects release tags with a ruleset', () => {
        const tags = JSON.parse(readText('.github', 'rulesets', 'tags.json')) as {
            target: string; conditions: { ref_name: { include: string[] } }; rules: Array<{ type: string }>;
        };
        expect(tags.target).toBe('tag');
        expect(tags.conditions.ref_name.include).toEqual(['refs/tags/v*']);
        expect(tags.rules.map((r) => r.type).sort()).toEqual(['deletion', 'non_fast_forward', 'update']);
    });
});

// ── Contributor checklist parity ─────────────────────────────────────

describe('pull request template', () => {
    it('lists the gate and the same items as CONTRIBUTING.md, word for word', () => {
        const template = readText('.github', 'pull_request_template.md');
        const contributing = readText('CONTRIBUTING.md');
        const section = /## Pull Request Checklist\s*\n([\s\S]*?)\n## /.exec(contributing);
        expect(section).not.toBeNull();
        const items = section![1].split('\n').filter((l) => l.startsWith('- [ ]'));
        expect(items.length).toBeGreaterThan(5);
        // Links are rewritten to reach CONTRIBUTING.md from .github/; the wording is identical.
        const normalise = (s: string): string => s.replace(/\]\((?:\.\.\/CONTRIBUTING\.md)?#/g, '](#');
        for (const item of items) expect(normalise(template), item.slice(0, 60)).toContain(normalise(item));
        const templateItems = template.split('\n').filter((l) => l.startsWith('- [ ]'));
        expect(templateItems.map(normalise).sort()).toEqual(items.map(normalise).sort());
        expect(template).toMatch(/`npm run gate` passes/);
        for (const mention of ['release-notes/vX.Y.Z.md', 'rebaseline', 'Downstream integration notes', 'api-compat']) {
            expect(template).toContain(mention);
        }
    });
});
