/**
 * zipnative — documentation integrity verifier (`npm run verify:docs`)
 * ====================================================================
 * Named-rule checks that keep every version, count, artefact and page in
 * the tree consistent with the single source of truth
 * (docs/assets/ecosystem.json). Read-only; safe on a dirty tree.
 * Exit 1 with `path:line [rule] message` diagnostics on failure.
 *
 * Flags: --online (npm-registry drift), --strict (warnings → errors),
 *        --json (machine-readable report), --rules (list the rules and exit)
 *
 * Suppress one finding with a `verify-docs:allow <rule>` marker on the
 * offending line or the line above it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { buildApiJson } from './build-api-json.ts';
import { diffClaudeRules, readRuleFiles } from './build-claude-rules.ts';
import { buildLlmsFull, buildLlmsIndex, buildLlmsRecipes } from './build-llms-full.ts';
import {
    INSTRUCTIONS_DIR,
    RULES_DIR,
    checkAgentConfigParity,
    checkClaudeRulesBudget,
    checkEol,
    checkNodeVersionPin,
    checkPrTemplateParity,
    checkSkillShape,
    checkTagRuleset,
    type Finding,
} from './lib/agent-config.ts';
import { findNonEnglishProse } from './lib/prose-language.ts';

const ROOT = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const online = args.has('--online');
const strict = args.has('--strict');
const asJson = args.has('--json');

interface Problem { readonly path: string; readonly line: number; readonly rule: string; readonly message: string; readonly level: 'error' | 'warn' }
const problems: Problem[] = [];

const lf = (text: string): string => text.replace(/\r\n/g, '\n');
const read = (path: string): string => lf(readFileSync(resolve(ROOT, path), 'utf8'));
const rel = (path: string): string => relative(ROOT, path).replace(/\\/g, '/');

function lineOf(text: string, index: number): number {
    return text.slice(0, Math.max(0, index)).split('\n').length;
}

function allowed(text: string, index: number, rule: string): boolean {
    const line = lineOf(text, index);
    const lines = text.split('\n');
    const marker = `verify-docs:allow ${rule}`;
    return (lines[line - 1]?.includes(marker) ?? false) || (lines[line - 2]?.includes(marker) ?? false);
}

function report(path: string, line: number, rule: string, message: string, level: 'error' | 'warn' = 'error'): void {
    problems.push({ path, line, rule, message, level });
}

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(resolve(ROOT, dir))) {
        const path = join(dir, name).replace(/\\/g, '/');
        if (statSync(resolve(ROOT, path)).isDirectory()) out.push(...walk(path));
        else out.push(path);
    }
    return out;
}

/**
 * Every rule this script can report, with its one-line contract. The list
 * is the figure `derived.verifyDocsRules` is held to, the table
 * `--rules` prints, and the Output section's self-check: a finding under a
 * name that is not here is a bug in this script, not in the docs.
 */
const RULES: ReadonlyArray<readonly [string, string]> = [
    ['manifest-shape', 'ecosystem.json is well-formed: versions, statuses, inventories, known derived/declared keys'],
    ['package-version-sync', 'package.json, src/index.ts VERSION and the manifest agree'],
    ['citation-version-sync', 'CITATION.cff version equals package.json'],
    ['changelog-current', 'CHANGELOG.md has an [Unreleased] or the current version section'],
    ['cdn-pin', 'playground loader pins the CDN to the manifest version, no local fallback'],
    ['versions-widget', 'docs/assets/versions.js carries every manifest version'],
    ['satellite-counts', '"N commands / tools / prompts" in prose equals the satellite inventories'],
    ['surfaces-shape', 'docs/data/surfaces.json names only real exports, commands and tools; since is a semver'],
    ['cli-surface-parity', 'the CLI guide, data file and playground describe exactly the manifest commands'],
    ['mcp-surface-parity', 'the MCP guide and playground describe exactly the manifest tools and prompts'],
    ['switcher-parity', 'every playground page carries the full switcher and the hub links every page'],
    ['api-json-sync', 'docs/assets/api.json equals a fresh build (npm run docs:api)'],
    ['tsdoc-complete', 'every public export carries a TSDoc summary'],
    ['llms-sync', 'docs/llms.txt equals llms.txt'],
    ['llms-index-sync', 'llms-full.txt, llms-recipes.txt and llms-index.json equal a fresh build (npm run docs:llms)'],
    ['llms-index-quality', 'every index entry has a non-empty description and plausible sizes'],
    ['verified-on-parity', 'llms.txt, the homepage footer and llms-index.json carry the manifest verifiedOn'],
    ['errors-verified-on', 'docs/data/errors.json verifiedOn equals the manifest verifiedOn'],
    ['seo-head', 'every indexable page has title, description, canonical + hreflang, the full og: set (title, description, url = canonical, type, site_name, image) and twitter: tags'],
    ['internal-links', 'every relative link and anchor in docs, README and release notes resolves'],
    ['guide-render-sync', 'every docs/guides/*.html equals a fresh render of its .md'],
    ['anchor-parity', 'every #fragment points at a real id'],
    ['sitemap-parity', 'every indexable page is in the sitemap, every <loc> resolves, lastmod is bounded by verifiedOn'],
    ['sitemap-lastmod-vs-git', '(full clones only) lastmod is on or after the last commit of the page sources'],
    ['jsonld-version', 'JSON-LD parses; every package node carries the manifest version; an ItemList mirrors the hub cards (count, order, numberOfItems, pages exist)'],
    ['cdn-sri', 'third-party executable resources carry integrity + crossorigin'],
    ['contrast', 'theme tokens meet WCAG AA contrast'],
    ['sample-count', 'test-output/ never holds more archives than derived.sampleZips'],
    ['sample-regression', 'the byte baseline exists, is well-formed, and tracks every generated sample'],
    ['derived-counts', 'every derived.* figure equals the tree; declared.tests / coverage equal the last fresh gate run'],
    ['count-tokens', '"N exports / codes / tests / samples / guides / … / N% coverage" in prose equal the manifest'],
    ['version-token', '"<package> vX.Y.Z" in prose, the README table and the homepage badges equal the manifest'],
    ['error-parity', 'the frozen code unions, docs/data/errors.json and the errors guide agree; throw sites use literal codes'],
    ['prose-language', 'the project language is English; demonstrated content is marked demo-language:'],
    ['claude-md-budget', 'CLAUDE.md imports AGENTS.md; both <= 120 lines; Copilot file <= 16 KiB; no line > 240 chars'],
    ['governance-sources', 'ai-governance.json sources/on_demand exist; always-loaded sources < 16 KiB'],
    ['node-pin-parity', '.nvmrc, .node-version, engines.node, the CI matrix and every setup-node step agree; packageManager is npm@'],
    ['ruleset-parity', 'every required status check names a real job; sample-regression and compat-previous are required; squash-only merges; tags.json protects v*'],
    ['agent-config-parity', 'settings.json parses; every CLAUDE.md "Never Read" glob is denied; HITL Bash denies present; guard hook parses'],
    ['claude-rules-sync', '.claude/rules/ equals a fresh render of .github/instructions/ (npm run agents:rules)'],
    ['claude-rules-budget', 'CLAUDE.md + its @imports + unscoped rules <= 16 KiB; a scoped rule > 32 KiB warns'],
    ['pr-template-parity', 'every PR-template checklist item is verbatim in CONTRIBUTING.md; the template mentions npm run gate'],
    ['eol-lf', '(git checkouts only) every tracked text blob is LF — a CRLF blob fails'],
    ['skills-shape', 'every .claude/skills/*/SKILL.md names its directory, has a description, and its templates exist'],
    ['bench-parity', 'the homepage benchmark bars equal bench/RESULTS.md within 10 %'],
    ['no-control-bytes', 'no tracked text file carries a NUL byte (git would treat it as binary)'],
    ['playground-syntax', 'every inline module script of a playground page parses (node --check)'],
    ['export-named', 'every export of api.json is named in llms.txt'],
    ['limits-table', 'every ZipLimits key is a row of the limits table in SECURITY.md and the security guide'],
    ['since-tags', 'every export added since the previous release carries an @since tag'],
    ['npm-drift', '(online only) the npm registry latest equals package.json, warn otherwise'],
    ['rules-list', 'self-check: every reported rule is catalogued in RULES'],
];
const RULE_NAMES: ReadonlySet<string> = new Set(RULES.map(([name]) => name));
if (args.has('--rules')) {
    for (const [name, contract] of RULES) console.log(`${name.padEnd(24)} ${contract}`);
    process.exit(0);
}

// ── Source of truth ──────────────────────────────────────────────────
interface EcosystemPackage {
    version: string | null;
    repo?: string | null;
    status?: string;
    binary?: string;
    pinField?: string | null;
    pin?: string | null;
    commandCount?: number;
    commandGroups?: Record<string, readonly string[]>;
    toolCount?: number;
    tools?: readonly string[];
    promptCount?: number;
    prompts?: readonly string[];
    resourceTemplates?: readonly string[];
    transports?: readonly string[];
    envVars?: readonly string[];
}
interface Ecosystem {
    packages: Record<string, EcosystemPackage>;
    verifiedOn?: string;
    site?: string;
    /** Figures verify-docs recomputes from the tree (derived-counts). */
    derived?: Record<string, number | string | undefined>;
    /** Hand-maintained figures the tree can only partly check (tests, coverage, ISO canaries). */
    declared?: {
        $comment?: string;
        tests?: number;
        coverageStatements?: number;
        coverageMeasured?: number;
        iso21320?: { conformantSamples?: number; nonConformantSamples?: number };
    };
}
/** A misspelt derived key ("recipies") would silently drop its counter — reject unknown keys outright. */
const KNOWN_DERIVED: ReadonlySet<string> = new Set([
    '$comment', 'sampleZips', 'exports', 'errorCodes', 'diagnostics', 'testFiles', 'sampleGenerators',
    'guides', 'playgrounds', 'recipes', 'interopTools', 'interopValidations', 'verifyDocsRules',
]);
const ecosystem = JSON.parse(read('docs/assets/ecosystem.json')) as Ecosystem;
const truthVersion = ecosystem.packages['zipnative']?.version ?? null;
const verifiedOn = ecosystem.verifiedOn ?? null;
const site = ecosystem.site ?? null;
const pkg = JSON.parse(read('package.json')) as { version: string; name: string };
const MANIFEST = 'docs/assets/ecosystem.json';
const cliPkg = ecosystem.packages['zipnative-cli'];
const mcpPkg = ecosystem.packages['zipnative-mcp'];
const cliCommandsOf = (): readonly string[] => Object.values(cliPkg?.commandGroups ?? {}).flat();

// ── Rule: manifest-shape ─────────────────────────────────────────────
// Every package (engine + satellites) carries a coherent record; the
// satellites additionally declare the inventories every count in the
// prose is checked against (satellite-counts, *-surface-parity).
if (typeof truthVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(truthVersion)) {
    report(MANIFEST, 1, 'manifest-shape', 'packages.zipnative.version must be a semver triple');
}
if (verifiedOn === null || !/^\d{4}-\d{2}-\d{2}$/.test(verifiedOn)) {
    report(MANIFEST, 1, 'manifest-shape', 'verifiedOn must be an ISO date (documentation-audit date)');
}
if (ecosystem.derived !== undefined) {
    for (const key of Object.keys(ecosystem.derived)) {
        if (!KNOWN_DERIVED.has(key)) {
            report(MANIFEST, 1, 'manifest-shape',
                `unknown derived.${key} — a typo here silently disables its counter`);
        }
    }
}
{
    const declared = ecosystem.declared;
    if (declared === undefined) {
        report(MANIFEST, 1, 'manifest-shape', 'declared is missing — tests, coverage and the ISO canaries live there');
    } else {
        if (!Number.isInteger(declared.tests) || (declared.tests ?? 0) <= 0) {
            report(MANIFEST, 1, 'manifest-shape', 'declared.tests must be a positive integer (the whole suite, skips included)');
        }
        const floor = declared.coverageStatements;
        const measured = declared.coverageMeasured;
        if (!Number.isInteger(floor) || (floor ?? -1) < 0 || (floor ?? 101) > 100) {
            report(MANIFEST, 1, 'manifest-shape', 'declared.coverageStatements must be an integer percentage (the floor of the measured figure)');
        }
        if (typeof measured !== 'number' || (typeof floor === 'number' && Math.floor(measured) !== floor)) {
            report(MANIFEST, 1, 'manifest-shape', `declared.coverageMeasured must be the measured percentage whose floor is declared.coverageStatements (got ${String(measured)} vs ${String(floor)})`);
        }
    }
}
for (const [name, entry] of Object.entries(ecosystem.packages)) {
    const status = entry.status ?? '(missing)';
    if (!['active', 'published', 'planned'].includes(status)) {
        report(MANIFEST, 1, 'manifest-shape', `packages.${name}.status must be active | published | planned (got ${status})`);
    }
    if (status === 'planned') {
        if (entry.version !== null) report(MANIFEST, 1, 'manifest-shape', `packages.${name} is planned but carries a version`);
    } else {
        if (typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(entry.version)) {
            report(MANIFEST, 1, 'manifest-shape', `packages.${name}.version must be a semver triple`);
        }
        if (typeof entry.repo !== 'string' || !entry.repo.startsWith('https://github.com/Nizoka/')) {
            report(MANIFEST, 1, 'manifest-shape', `packages.${name}.repo must be a https://github.com/Nizoka/ URL`);
        }
    }
    const pinField = entry.pinField ?? null;
    if (pinField !== null && !['dependencies', 'peerDependencies'].includes(pinField)) {
        report(MANIFEST, 1, 'manifest-shape', `packages.${name}.pinField must be dependencies | peerDependencies | null`);
    }
    if ((pinField === null) !== ((entry.pin ?? null) === null)) {
        report(MANIFEST, 1, 'manifest-shape', `packages.${name}: pin and pinField must be both present or both null`);
    }
    if (name !== 'zipnative' && status !== 'planned' && typeof entry.binary !== 'string') {
        report(MANIFEST, 1, 'manifest-shape', `packages.${name}.binary (the bin name) is required once published`);
    }
    const dupes = (list: readonly string[]): string[] => list.filter((x, i) => list.indexOf(x) !== i);
    if (entry.commandGroups !== undefined) {
        const flat = Object.values(entry.commandGroups).flat();
        if (entry.commandCount !== flat.length) {
            report(MANIFEST, 1, 'manifest-shape', `packages.${name}.commandCount ${String(entry.commandCount)} != ${flat.length} commands listed in commandGroups`);
        }
        for (const d of dupes(flat)) report(MANIFEST, 1, 'manifest-shape', `packages.${name}: duplicate command ${d}`);
    }
    if (entry.tools !== undefined) {
        if (entry.toolCount !== entry.tools.length) {
            report(MANIFEST, 1, 'manifest-shape', `packages.${name}.toolCount ${String(entry.toolCount)} != ${entry.tools.length} tools listed`);
        }
        for (const d of dupes(entry.tools)) report(MANIFEST, 1, 'manifest-shape', `packages.${name}: duplicate tool ${d}`);
    }
    if (entry.prompts !== undefined) {
        if (entry.promptCount !== entry.prompts.length) {
            report(MANIFEST, 1, 'manifest-shape', `packages.${name}.promptCount ${String(entry.promptCount)} != ${entry.prompts.length} prompts listed`);
        }
        for (const d of dupes(entry.prompts)) report(MANIFEST, 1, 'manifest-shape', `packages.${name}: duplicate prompt ${d}`);
    }
}

// ── Rule: package-version-sync / citation-version-sync ───────────────
if (truthVersion !== null && pkg.version !== truthVersion) {
    report('package.json', 3, 'package-version-sync', `package.json ${pkg.version} != ecosystem.json ${truthVersion}`);
}
{
    const citation = read('CITATION.cff');
    const citLine = citation.split('\n').findIndex((l) => l.startsWith('version:'));
    const citVersion = citLine >= 0 ? citation.split('\n')[citLine].replace('version:', '').trim() : null;
    if (citVersion !== pkg.version) {
        report('CITATION.cff', citLine + 1, 'citation-version-sync', `CITATION.cff ${citVersion ?? '(missing)'} != package.json ${pkg.version}`);
    }
    const versionLine = read('src/index.ts').match(/VERSION = '([^']+)'/);
    if (versionLine !== null && versionLine[1] !== pkg.version) {
        report('src/index.ts', 1, 'package-version-sync', `VERSION export ${versionLine[1]} != package.json ${pkg.version}`);
    }
}

// ── Rule: changelog-current ──────────────────────────────────────────
{
    const changelog = read('CHANGELOG.md');
    if (!changelog.includes('## [Unreleased]') && !changelog.includes(`## [${pkg.version}]`)) {
        report('CHANGELOG.md', 1, 'changelog-current', `no [Unreleased] and no [${pkg.version}] section`);
    }
}

// ── Rule: cdn-pin ────────────────────────────────────────────────────
// The playgrounds run the PUBLISHED package from a version-pinned CDN
// (esm.sh → jsDelivr) — the pdfnative pattern, no local bundle. The pin
// in the shared loader must track the manifest, and the pre-1.0 fallback
// (a committed copy of dist/index.js) must not creep back in.
{
    const loaderPath = 'docs/playgrounds/load-engine.js';
    if (!existsSync(resolve(ROOT, loaderPath))) {
        report(loaderPath, 1, 'cdn-pin', 'missing — every playground imports the shared CDN loader');
    } else {
        const loader = read(loaderPath);
        const pin = loader.match(/const VERSION = '([^']+)';/);
        if (pin === null || pin[1] !== truthVersion) {
            report(loaderPath, 1, 'cdn-pin', `CDN pin ${pin?.[1] ?? '(missing)'} != manifest ${String(truthVersion)} — edit the VERSION constant`);
        }
        if (loader.includes('./zipnative.js')) {
            report(loaderPath, 1, 'cdn-pin', 'the loader must not import a local bundle — the playgrounds are CDN-only since 1.0');
        }
    }
    if (existsSync(resolve(ROOT, 'docs/playgrounds/zipnative.js'))) {
        report('docs/playgrounds/zipnative.js', 1, 'cdn-pin', 'stale local bundle — the playgrounds load the published package; delete it');
    }
}

// ── Rule: versions-widget ────────────────────────────────────────────
// assets/versions.js renders live npm versions and falls back to a
// hard-coded map when the registry is unreachable; that map must equal
// the manifest, or an offline visitor reads a stale version.
{
    const path = 'docs/assets/versions.js';
    if (existsSync(resolve(ROOT, path))) {
        const js = read(path);
        for (const [name, entry] of Object.entries(ecosystem.packages)) {
            const m = js.match(new RegExp(`'${name}':\\s*\\{\\s*version:\\s*'([^']+)',\\s*pin:\\s*(null|'([^']+)')`));
            if (m === null) { report(path, 1, 'versions-widget', `FALLBACK lacks an entry for ${name}`); continue; }
            if (m[1] !== entry.version) report(path, 1, 'versions-widget', `FALLBACK ${name} version ${m[1]} != manifest ${String(entry.version)}`);
            const pin = m[3] ?? null;
            if (pin !== (entry.pin ?? null)) report(path, 1, 'versions-widget', `FALLBACK ${name} pin ${String(pin)} != manifest ${String(entry.pin ?? null)}`);
        }
    }
}

// ── Rule: satellite-counts ───────────────────────────────────────────
// "15 commands", "13 tools", "7 prompts": every such literal anywhere in
// the prose (HTML, Markdown, SVG <desc>, root docs) must equal the
// manifest inventory — the pdfnative count-drift lesson (docs.yml header).
{
    const expected: Record<string, number | undefined> = {
        commands: cliPkg?.commandCount,
        tools: mcpPkg?.toolCount,
        prompts: mcpPkg?.promptCount,
    };
    const corpus = [
        ...walk('docs').filter((p) => /\.(html|md|svg)$/.test(p) && !p.includes('llms-full') && !p.includes('llms-recipes')),
        'README.md', 'AGENTS.md', 'ROADMAP.md', 'CONTRIBUTING.md', 'llms.txt',
    ];
    // (?<![\d.]) keeps "zipnative-cli 1.0.0 commands" from reading as "0 commands".
    const pattern = /(?<![\d.])(\d+)\s+(?:production\s+|MCP\s+|CLI\s+)?(commands|tools|prompts)\b/gi;
    for (const path of corpus) {
        const text = read(path);
        for (const m of text.matchAll(pattern)) {
            const noun = m[2].toLowerCase();
            const want = expected[noun];
            if (want === undefined) continue;
            if (Number(m[1]) !== want && !allowed(text, m.index ?? 0, 'satellite-counts')) {
                report(path, lineOf(text, m.index ?? 0), 'satellite-counts',
                    `"${m[0]}" but the manifest declares ${want} ${noun} — fix the prose or the manifest`);
            }
        }
    }
}

// ── Rule: surfaces-shape ─────────────────────────────────────────────
// docs/data/surfaces.json (the capability × surface matrix) must name
// only things that exist: library calls that are real exports (api.json),
// CLI commands from the manifest's command groups, MCP tools from the
// manifest's tool list. Its verifiedOn rides with the manifest's.
{
    interface Cell { supported?: boolean; call?: string; command?: string; tool?: string; notes?: string }
    interface Surfaces { verifiedOn?: string; capabilities?: ReadonlyArray<{ id?: string; label?: string; since?: string; library?: Cell; cli?: Cell; mcp?: Cell }> }
    const path = 'docs/data/surfaces.json';
    if (!existsSync(resolve(ROOT, path))) {
        report(path, 1, 'surfaces-shape', 'missing — the choose guide needs its machine-readable twin');
    } else {
        const surfaces = JSON.parse(read(path)) as Surfaces;
        const apiNames = new Set((JSON.parse(read('docs/assets/api.json')) as { exports?: ReadonlyArray<{ name?: string }> }).exports?.map((e) => e.name ?? '') ?? []);
        const commands = new Set(cliCommandsOf());
        const tools = new Set(mcpPkg?.tools ?? []);
        if (surfaces.verifiedOn !== verifiedOn) {
            report(path, 1, 'surfaces-shape', `verifiedOn ${String(surfaces.verifiedOn)} != manifest ${String(verifiedOn)}`);
        }
        const ids = new Set<string>();
        for (const cap of surfaces.capabilities ?? []) {
            const id = cap.id ?? '(no id)';
            if (ids.has(id)) report(path, 1, 'surfaces-shape', `duplicate capability id ${id}`);
            ids.add(id);
            // since: the engine release that introduced the capability — a semver no newer than the manifest's.
            if (cap.since !== undefined) {
                if (typeof cap.since !== 'string' || !/^\d+\.\d+\.\d+$/.test(cap.since)) {
                    report(path, 1, 'surfaces-shape', `${id}.since must be a semver triple (got ${String(cap.since)})`);
                } else if (truthVersion !== null && cap.since.localeCompare(truthVersion, undefined, { numeric: true }) > 0) {
                    report(path, 1, 'surfaces-shape', `${id}.since ${cap.since} is ahead of the engine version ${truthVersion}`);
                }
            }
            for (const surface of ['library', 'cli', 'mcp'] as const) {
                const cell = cap[surface];
                if (cell === undefined || typeof cell.supported !== 'boolean') {
                    report(path, 1, 'surfaces-shape', `${id}.${surface} must carry a boolean supported`);
                    continue;
                }
                if (!cell.supported) continue;
                if (surface === 'library') {
                    // Every `name()` token must be a real export; bare prose is allowed.
                    for (const m of (cell.call ?? '').matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\(\)/g)) {
                        const readerMethods = ['entries', 'getEntry', 'readEntry', 'readEntryStream', 'readEntryRaw', 'verifyEntry', 'addStream', 'addRaw', 'addFromReader', 'stream', 'save', 'saveCompact', 'add', 'addDirectory', 'toBytes', 'skip', 'data'];
                        if (!apiNames.has(m[1]) && !readerMethods.includes(m[1])) {
                            report(path, 1, 'surfaces-shape', `${id}.library names ${m[1]}() — not an export in api.json`);
                        }
                    }
                } else if (surface === 'cli') {
                    // The first token is a command (or a global flag, which starts with --).
                    const first = (cell.command ?? '').split(/[\s/]+/)[0] ?? '';
                    if (!first.startsWith('--') && !commands.has(first)) {
                        report(path, 1, 'surfaces-shape', `${id}.cli names command '${first}' — not in the manifest's commandGroups`);
                    }
                } else {
                    const first = (cell.tool ?? '').split(/\s+/)[0] ?? '';
                    // Protocol-level or operator-level facts that are not a tool name: the
                    // wire methods, the shared inputs, the transports and the ZIPNATIVE_MCP_*
                    // environment variables the manifest lists.
                    const protocolLevel = ['tools/list', 'prompts/list', 'limits', 'strict:', 'outputMode:', 'stdio', ...(mcpPkg?.envVars ?? [])];
                    if (!tools.has(first) && !protocolLevel.includes(first)) {
                        report(path, 1, 'surfaces-shape', `${id}.mcp names tool '${first}' — not in the manifest's tools`);
                    }
                }
            }
        }
    }
}

// ── Rule: cli-surface-parity ─────────────────────────────────────────
// docs/data/cli-surface.json is the snapshot of `zipnative schema
// manifest` (itself derived from the CLI's own command table). Part 1:
// the snapshot agrees with the ecosystem manifest — same version, same
// command set, and every --max-* limit flag present among the globals.
{
    const path = 'docs/data/cli-surface.json';
    if (!existsSync(resolve(ROOT, path))) {
        report(path, 1, 'cli-surface-parity', 'missing — snapshot `npx -y zipnative-cli@<version> schema manifest`');
    } else {
        const surface = JSON.parse(read(path)) as {
            version?: string; globalFlags?: readonly string[]; globalBooleanFlags?: readonly string[];
            commands?: ReadonlyArray<{ name?: string; group?: string; flags?: readonly string[]; booleanFlags?: readonly string[] }>;
            limits?: ReadonlyArray<{ flag?: string }>;
        };
        if (surface.version !== cliPkg?.version) {
            report(path, 1, 'cli-surface-parity', `version ${String(surface.version)} != manifest zipnative-cli ${String(cliPkg?.version)}`);
        }
        const snapshotNames = (surface.commands ?? []).map((c) => c.name ?? '');
        const manifestNames = cliCommandsOf();
        for (const name of manifestNames) {
            if (!snapshotNames.includes(name)) report(path, 1, 'cli-surface-parity', `manifest command '${name}' missing from the snapshot`);
        }
        for (const name of snapshotNames) {
            if (!manifestNames.includes(name)) report(path, 1, 'cli-surface-parity', `snapshot command '${name}' missing from ecosystem.json commandGroups`);
        }
        for (const c of surface.commands ?? []) {
            const group = cliPkg?.commandGroups ?? {};
            const declared = Object.entries(group).find(([, names]) => names.includes(c.name ?? ''))?.[0];
            if (declared !== undefined && c.group !== declared) {
                report(path, 1, 'cli-surface-parity', `command '${String(c.name)}' is in group '${String(c.group)}' but the manifest says '${declared}'`);
            }
            for (const b of c.booleanFlags ?? []) {
                if (!(c.flags ?? []).includes(b)) report(path, 1, 'cli-surface-parity', `command '${String(c.name)}': boolean flag ${b} is not among its flags`);
            }
        }
        for (const limit of surface.limits ?? []) {
            if (limit.flag !== undefined && !(surface.globalFlags ?? []).includes(limit.flag)) {
                report(path, 1, 'cli-surface-parity', `limit flag ${limit.flag} missing from globalFlags`);
            }
        }
        // Part 2: the CLI guide documents every command (a `zipnative <name>`
        // heading) and names every flag — global and per command — literally,
        // plus every environment variable the manifest lists.
        const guidePath = 'docs/guides/cli.md';
        if (!existsSync(resolve(ROOT, guidePath))) {
            report(guidePath, 1, 'cli-surface-parity', 'missing — the CLI reference guide');
        } else {
            const guide = read(guidePath);
            for (const c of surface.commands ?? []) {
                if (!guide.includes(`\`zipnative ${String(c.name)}\``)) {
                    report(guidePath, 1, 'cli-surface-parity', `no heading for command '${String(c.name)}'`);
                }
                for (const flag of c.flags ?? []) {
                    if (!guide.includes(flag)) report(guidePath, 1, 'cli-surface-parity', `command '${String(c.name)}': flag ${flag} is not documented`);
                }
            }
            for (const flag of surface.globalFlags ?? []) {
                if (!guide.includes(flag)) report(guidePath, 1, 'cli-surface-parity', `global flag ${flag} is not documented`);
            }
            for (const envVar of cliPkg?.envVars ?? []) {
                if (!guide.includes(envVar)) report(guidePath, 1, 'cli-surface-parity', `environment variable ${envVar} is not documented`);
            }
        }
    }
}

// ── Rule: cli-surface-parity, part 3 — the CLI playground ────────────
// docs/playgrounds/cli.html embeds its command table as JSON. Per
// command the flag SET must equal the snapshot's (every flag exposed,
// none invented), the global set must equal the snapshot's globals minus
// --help/--version, and `kind: "bool"` must coincide with the CLI's
// boolean-flag table (a value flag rendered as a checkbox would emit a
// command the CLI parses differently).
{
    const pagePath = 'docs/playgrounds/cli.html';
    const snapPath = 'docs/data/cli-surface.json';
    if (existsSync(resolve(ROOT, pagePath)) && existsSync(resolve(ROOT, snapPath))) {
        const page = read(pagePath);
        const block = page.match(/<script type="application\/json" id="cli-surface">([\s\S]*?)<\/script>/);
        if (block === null) {
            report(pagePath, 1, 'cli-surface-parity', 'missing the #cli-surface JSON block');
        } else {
            interface PageFlag { flag: string; kind: string }
            interface PageSurface { version?: string; dryRunCommands?: string[]; global?: PageFlag[]; commands?: Array<{ name: string; flags: PageFlag[] }> }
            const snap = JSON.parse(read(snapPath)) as {
                version?: string; globalFlags?: string[]; globalBooleanFlags?: string[]; dryRunCommands?: string[];
                commands?: Array<{ name?: string; flags?: string[]; booleanFlags?: string[] }>;
            };
            let surface: PageSurface;
            try { surface = JSON.parse(block[1]) as PageSurface; } catch { report(pagePath, lineOf(page, block.index ?? 0), 'cli-surface-parity', 'invalid JSON in #cli-surface'); surface = {}; }
            const line = lineOf(page, block.index ?? 0);
            if (surface.version !== snap.version) report(pagePath, line, 'cli-surface-parity', `page version ${String(surface.version)} != snapshot ${String(snap.version)}`);
            const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));
            if (!same(surface.dryRunCommands ?? [], snap.dryRunCommands ?? [])) report(pagePath, line, 'cli-surface-parity', 'dryRunCommands differ from the snapshot');
            const pageGlobals = (surface.global ?? []).map((f) => f.flag);
            const snapGlobals = (snap.globalFlags ?? []).filter((f) => f !== '--help' && f !== '--version');
            for (const f of snapGlobals) if (!pageGlobals.includes(f)) report(pagePath, line, 'cli-surface-parity', `global flag ${f} is not in the builder`);
            for (const f of pageGlobals) if (!snapGlobals.includes(f)) report(pagePath, line, 'cli-surface-parity', `builder global flag ${f} is not in the snapshot`);
            for (const f of surface.global ?? []) {
                const isBool = (snap.globalBooleanFlags ?? []).includes(f.flag);
                if ((f.kind === 'bool') !== isBool) report(pagePath, line, 'cli-surface-parity', `global flag ${f.flag}: kind ${f.kind} but the CLI says ${isBool ? 'boolean' : 'value'}`);
            }
            const snapByName = new Map((snap.commands ?? []).map((c) => [c.name ?? '', c]));
            for (const c of surface.commands ?? []) {
                const s = snapByName.get(c.name);
                if (s === undefined) { report(pagePath, line, 'cli-surface-parity', `builder command '${c.name}' is not in the snapshot`); continue; }
                const pageFlags = c.flags.map((f) => f.flag);
                for (const f of s.flags ?? []) if (!pageFlags.includes(f)) report(pagePath, line, 'cli-surface-parity', `command '${c.name}': flag ${f} is not in the builder`);
                for (const f of pageFlags) if (!(s.flags ?? []).includes(f)) report(pagePath, line, 'cli-surface-parity', `command '${c.name}': builder flag ${f} is not in the snapshot`);
                for (const f of c.flags) {
                    const isBool = (s.booleanFlags ?? []).includes(f.flag);
                    if ((f.kind === 'bool') !== isBool) report(pagePath, line, 'cli-surface-parity', `command '${c.name}': ${f.flag} kind ${f.kind} but the CLI says ${isBool ? 'boolean' : 'value'}`);
                }
            }
            for (const name of snapByName.keys()) if (!(surface.commands ?? []).some((c) => c.name === name)) report(pagePath, line, 'cli-surface-parity', `snapshot command '${name}' is not in the builder`);
        }
    }
}

// ── Rule: mcp-surface-parity ─────────────────────────────────────────
// The MCP guide documents every tool (a `### \`tool\`` heading), names
// every prompt, resource template and environment variable the manifest
// lists — the inventory the ecosystem manifest declares is the inventory
// the site describes.
{
    const guidePath = 'docs/guides/mcp.md';
    if (!existsSync(resolve(ROOT, guidePath))) {
        report(guidePath, 1, 'mcp-surface-parity', 'missing — the MCP reference guide');
    } else {
        const guide = read(guidePath);
        for (const tool of mcpPkg?.tools ?? []) {
            if (!guide.includes(`### \`${tool}\``)) report(guidePath, 1, 'mcp-surface-parity', `no heading for tool '${tool}'`);
        }
        for (const prompt of mcpPkg?.prompts ?? []) {
            if (!guide.includes(`\`${prompt}\``)) report(guidePath, 1, 'mcp-surface-parity', `prompt '${prompt}' is not documented`);
        }
        for (const template of mcpPkg?.resourceTemplates ?? []) {
            if (!guide.includes(template)) report(guidePath, 1, 'mcp-surface-parity', `resource template ${template} is not documented`);
        }
        for (const envVar of mcpPkg?.envVars ?? []) {
            if (!guide.includes(envVar)) report(guidePath, 1, 'mcp-surface-parity', `environment variable ${envVar} is not documented`);
        }
        // Part 3: the MCP playground's card catalogue names exactly the
        // manifest's tools, in tools/list order, and lists every prompt.
        const pagePath = 'docs/playgrounds/mcp.html';
        if (existsSync(resolve(ROOT, pagePath))) {
            const page = read(pagePath);
            const ids = [...page.matchAll(/^\s*id: '([a-z0-9_]+)',/gm)].map((m) => m[1]);
            const want = mcpPkg?.tools ?? [];
            if (ids.join(',') !== want.join(',')) {
                report(pagePath, 1, 'mcp-surface-parity', `card ids [${ids.join(', ')}] != manifest tools in order [${want.join(', ')}]`);
            }
            for (const prompt of mcpPkg?.prompts ?? []) {
                if (!page.includes(`<code>${prompt}</code>`)) report(pagePath, 1, 'mcp-surface-parity', `prompt '${prompt}' is not listed on the playground`);
            }
        }
        // Tool names that look real but are not in the manifest are phantoms.
        for (const m of guide.matchAll(/`([a-z]+_[a-z_]+)`/g)) {
            const name = m[1];
            const known = [...(mcpPkg?.tools ?? []), ...(mcpPkg?.prompts ?? [])];
            const nonTools = ['server_discover', 'tools_list', 'prompts_list', 'resources_list', 'resources_read', 'resources_templates_list', 'tools_call', 'prompts_get'];
            if (/^(inspect|list|read|verify|extract|scan|sanitize|create|modify|compute|inflate|describe|draft)_/.test(name)
                && !known.includes(name) && !nonTools.includes(name) && !allowed(guide, m.index ?? 0, 'mcp-surface-parity')) {
                report(guidePath, lineOf(guide, m.index ?? 0), 'mcp-surface-parity', `'${name}' looks like a tool but is not in the manifest`);
            }
        }
    }
}

// ── Rule: switcher-parity ────────────────────────────────────────────
// Every playground page carries a hand-synced sub-nav listing every
// playground page (the pdfnative pattern, ported): the link set must
// equal the page set, the page itself is marked aria-current, and the
// hub's card grid links every page too.
{
    const dir = 'docs/playgrounds';
    const pages = walk(dir).filter((p) => p.endsWith('.html') && !p.endsWith('index.html')).map((p) => p.replace(/\\/g, '/').split('/').pop() ?? '');
    for (const page of pages) {
        const path = `${dir}/${page}`;
        const html = read(path);
        const nav = html.match(/<nav class="playground-switcher"[\s\S]*?<\/nav>/);
        if (nav === null) { report(path, 1, 'switcher-parity', 'no <nav class="playground-switcher">'); continue; }
        const links = [...nav[0].matchAll(/<a href="\.\/([a-z-]+\.html)"([^>]*)>/g)];
        const linked = links.map((m) => m[1]);
        for (const p of pages) if (!linked.includes(p)) report(path, lineOf(html, nav.index ?? 0), 'switcher-parity', `switcher lacks ${p}`);
        for (const l of linked) if (!pages.includes(l)) report(path, lineOf(html, nav.index ?? 0), 'switcher-parity', `switcher links ${l}, which is not a playground page`);
        const current = links.filter((m) => m[2].includes('aria-current="page"')).map((m) => m[1]);
        if (current.length !== 1 || current[0] !== page) report(path, lineOf(html, nav.index ?? 0), 'switcher-parity', `aria-current="page" must mark exactly ${page} (got ${current.join(', ') || 'none'})`);
    }
    const hub = read(`${dir}/index.html`);
    for (const p of pages) {
        if (!hub.includes(`class="pg-card" href="${p}"`)) report(`${dir}/index.html`, 1, 'switcher-parity', `hub has no card for ${p}`);
    }
}

// ── Rule: api-json-sync ──────────────────────────────────────────────
{
    const rebuilt = `${JSON.stringify(buildApiJson(ROOT), null, 2)}\n`;
    if (rebuilt !== read('docs/assets/api.json')) {
        report('docs/assets/api.json', 1, 'api-json-sync', 'stale — run `npm run docs:api`');
    }
}

// ── Rule: tsdoc-complete ─────────────────────────────────────────────
// Every public export must carry a TSDoc summary — api.json's `summary`
// is extracted, never guessed, so a null means the source has no doc
// comment. Frozen surface (1.0): an undocumented export is a defect.
{
    const api = JSON.parse(read('docs/assets/api.json')) as {
        exports?: ReadonlyArray<{ name?: string; subpath?: string; summary?: string | null }>;
    };
    for (const exp of api.exports ?? []) {
        if (exp.summary === null || exp.summary === undefined || exp.summary === '') {
            report('docs/assets/api.json', 1, 'tsdoc-complete',
                `export '${exp.subpath ?? '.'}:${exp.name ?? '(unnamed)'}' has no TSDoc summary — document it at the declaration site`);
        }
    }
}

// ── Rule: llms-sync / llms-index-sync ────────────────────────────────
{
    if (read('llms.txt') !== read('docs/llms.txt')) {
        report('docs/llms.txt', 1, 'llms-sync', 'docs/llms.txt differs from the root llms.txt — run `npm run docs:llms` (the site serves from docs/)');
    }
    if (buildLlmsFull(ROOT) !== read('docs/llms-full.txt')) {
        report('docs/llms-full.txt', 1, 'llms-sync', 'stale — run `npm run docs:llms`');
    }
    if (buildLlmsRecipes(ROOT) !== read('docs/llms-recipes.txt')) {
        report('docs/llms-recipes.txt', 1, 'llms-sync', 'stale — run `npm run docs:llms`');
    }
    if (buildLlmsIndex(ROOT) !== read('docs/llms-index.json')) {
        report('docs/llms-index.json', 1, 'llms-index-sync', 'stale — run `npm run docs:llms`');
    }
}

// ── Rule: llms-index-quality (a deterministic generator bug passes ───
//    the sync rules forever; read the index as CONTENT) ───────────────
{
    const index = JSON.parse(read('docs/llms-index.json')) as {
        guides: Array<{ title: string; summary: string; markdown: string }>;
    };
    for (const guide of index.guides) {
        const where = 'docs/llms-index.json';
        if (guide.summary.trim().length === 0) {
            report(where, 1, 'llms-index-quality', `guide ${guide.markdown}: empty summary`);
        } else {
            if (!/[.!?…]$/.test(guide.summary.trim())) {
                report(where, 1, 'llms-index-quality', `guide ${guide.markdown}: summary does not end in punctuation`);
            }
            if (guide.summary.length < 40 || guide.summary.length > 400) {
                report(where, 1, 'llms-index-quality', `guide ${guide.markdown}: summary length ${guide.summary.length} outside 40–400`);
            }
            if (guide.summary.includes('**') || guide.summary.includes('](')) {
                report(where, 1, 'llms-index-quality', `guide ${guide.markdown}: unstripped Markdown in summary`);
            }
        }
        if (guide.title.endsWith('.md')) {
            report(where, 1, 'llms-index-quality', `guide ${guide.markdown}: title fell back to the filename`);
        }
    }
}

// ── Rule: verified-on-parity ─────────────────────────────────────────
if (verifiedOn !== null) {
    for (const path of ['llms.txt', 'docs/llms.txt']) {
        if (!read(path).includes(`Verified on: ${verifiedOn}`)) {
            report(path, 1, 'verified-on-parity', `missing "Verified on: ${verifiedOn}" stamp`);
        }
    }
    if (!read('docs/index.html').includes(`verified on ${verifiedOn}`)) {
        report('docs/index.html', 1, 'verified-on-parity', `footer must carry "verified on ${verifiedOn}"`);
    }
    if (!read('docs/llms-index.json').includes(`"verifiedOn": "${verifiedOn}"`)) {
        report('docs/llms-index.json', 1, 'verified-on-parity', `verifiedOn must equal ${verifiedOn}`);
    }
}

// ── Rule: errors-verified-on ─────────────────────────────────────────
// The error registry carries its own audit stamp; it rides with the
// manifest's like surfaces.json's does (surfaces-shape), or an agent
// reading errors.json alone would trust a date nobody re-checked.
if (verifiedOn !== null && existsSync(resolve(ROOT, 'docs/data/errors.json'))) {
    const stamp = (JSON.parse(read('docs/data/errors.json')) as { verifiedOn?: string }).verifiedOn;
    if (stamp !== verifiedOn) {
        report('docs/data/errors.json', 1, 'errors-verified-on', `verifiedOn ${String(stamp)} != manifest ${verifiedOn} — re-audit raisedWhen/remedy against src/ and restamp`);
    }
}

// ── HTML corpus ──────────────────────────────────────────────────────
const htmlPages = walk('docs').filter((p) => p.endsWith('.html'));

// ── Rule: seo-head ───────────────────────────────────────────────────
for (const page of htmlPages) {
    const html = read(page);
    if (html.includes('name="robots"') && html.includes('noindex')) continue;
    if (!/<html\s+lang="/.test(html)) report(page, 1, 'seo-head', 'missing <html lang>');
    const canonicals = [...html.matchAll(/<link rel="canonical" href="([^"]+)"/g)];
    if (canonicals.length !== 1) {
        report(page, 1, 'seo-head', `expected exactly one canonical, found ${canonicals.length}`);
    } else {
        const canonical = canonicals[0][1];
        if (!canonical.startsWith('https://')) report(page, 1, 'seo-head', 'canonical must be absolute https');
        for (const hreflang of ['en', 'x-default']) {
            const m = html.match(new RegExp(`<link rel="alternate" hreflang="${hreflang}" href="([^"]+)"`));
            if (m === null || m[1] !== canonical) {
                report(page, 1, 'seo-head', `hreflang="${hreflang}" must exist and equal the canonical byte-for-byte`);
            }
        }
    }
    if (!html.includes('og:locale" content="en_US"')) report(page, 1, 'seo-head', 'missing og:locale=en_US');
    const description = html.match(/<meta name="description" content="([^"]*)"/);
    if (description === null || description[1].trim().length === 0) {
        report(page, 1, 'seo-head', 'missing or empty meta description');
    }
    // The full Open Graph set: a share card without og:title/og:description
    // falls back to whatever the crawler guesses, and og:url must be the
    // canonical so shares of ?query / #fragment variants collapse to one.
    for (const prop of ['og:title', 'og:description', 'og:type', 'og:site_name', 'og:image']) {
        if (!new RegExp(`<meta property="${prop}" content="[^"]+"`).test(html)) report(page, 1, 'seo-head', `missing ${prop}`);
    }
    const ogUrl = html.match(/<meta property="og:url" content="([^"]+)"/);
    if (ogUrl === null) report(page, 1, 'seo-head', 'missing og:url');
    else if (canonicals.length === 1 && ogUrl[1] !== canonicals[0][1]) report(page, 1, 'seo-head', `og:url ${ogUrl[1]} must equal the canonical ${canonicals[0][1]}`);
    for (const name of ['twitter:card', 'twitter:title', 'twitter:description']) {
        if (!new RegExp(`<meta name="${name}" content="[^"]+"`).test(html)) report(page, 1, 'seo-head', `missing ${name}`);
    }
}

// ── Rule: internal-links ─────────────────────────────────────────────
{
    const corpus = [
        ...htmlPages,
        ...walk('docs').filter((p) => p.endsWith('.md')),
        'README.md', 'ROADMAP.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md', 'AGENTS.md',
        ...walk('release-notes').filter((p) => p.endsWith('.md')),
    ].filter((p) => !p.includes('llms-full') && !p.includes('llms-recipes'));
    for (const page of corpus) {
        const text = read(page);
        const refs: Array<[string, number]> = [];
        for (const m of text.matchAll(/(?:href|src)="([^"]+)"/g)) refs.push([m[1], m.index ?? 0]);
        for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) refs.push([m[1], m.index ?? 0]);
        for (const [target, index] of refs) {
            if (/^(https?:|mailto:|#|data:)/.test(target) || target.includes('${') || target.includes('{{')) continue;
            const clean = target.split('#')[0];
            if (clean === '') continue;
            const base = dirname(resolve(ROOT, page));
            const candidate = resolve(base, clean);
            const asIndex = resolve(candidate, 'index.html');
            if (!existsSync(candidate) && !existsSync(asIndex)) {
                if (!allowed(text, index, 'internal-links')) {
                    report(page, lineOf(text, index), 'internal-links', `broken reference: ${target}`);
                }
            }
        }
    }
}

// ── Rule: guide-render-sync (rebuilds each shell in memory) ──────────
{
    const { applyGuideRender, listGuideShells } = await import('./build-guides.ts');
    for (const htmlName of listGuideShells(ROOT)) {
        const relPath = `docs/guides/${htmlName}`;
        const committed = read(relPath);
        if (!committed.includes('<!-- guide:render:start -->')) {
            report(relPath, 1, 'guide-render-sync', 'article is not pre-rendered — run `npm run docs:guides`');
            continue;
        }
        if (committed !== lf(applyGuideRender(ROOT, htmlName))) {
            report(relPath, 1, 'guide-render-sync',
                'stale — the committed render differs from its Markdown source; run `npm run docs:guides`');
        }
    }
}

// ── Rule: anchor-parity (fragments resolve to real ids) ──────────────
{
    const idsOf = (path: string): Set<string> => {
        const ids = new Set<string>();
        for (const m of read(path).matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
        return ids;
    };
    for (const page of htmlPages) {
        const html = read(page);
        for (const m of html.matchAll(/href="([^"#]*)#([^"]+)"/g)) {
            const [, target, fragment] = m;
            if (/^https?:/.test(target)) continue;
            let resolvedTarget = page;
            if (target !== '') {
                let abs = resolve(dirname(resolve(ROOT, page)), target.replace(/\.md$/, '.html'));
                if (!existsSync(abs)) continue; // internal-links reports the missing file
                // Directory URLs ('../#features') serve their index.html.
                if (statSync(abs).isDirectory()) abs = resolve(abs, 'index.html');
                if (!existsSync(abs)) continue;
                resolvedTarget = rel(abs);
            }
            if (!idsOf(resolvedTarget).has(fragment)) {
                if (!allowed(html, m.index ?? 0, 'anchor-parity')) {
                    report(page, lineOf(html, m.index ?? 0), 'anchor-parity',
                        `fragment #${fragment} not found in ${resolvedTarget}`);
                }
            }
        }
    }
}

// ── Rule: sitemap-parity ─────────────────────────────────────────────
if (site !== null && verifiedOn !== null) {
    const sitemap = read('docs/sitemap.xml');
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    for (const loc of locs) {
        const path = loc.replace(`${site}/`, '').split('#')[0];
        const resolved = path === '' ? 'docs/index.html' : `docs/${path}`;
        if (!existsSync(resolve(ROOT, resolved)) && !existsSync(resolve(ROOT, resolved, 'index.html'))) {
            report('docs/sitemap.xml', lineOf(sitemap, sitemap.indexOf(loc)), 'sitemap-parity', `<loc> does not resolve: ${loc}`);
        }
    }
    for (const page of htmlPages) {
        const html = read(page);
        if (html.includes('noindex')) continue;
        const url = `${site}/${rel(resolve(ROOT, page)).replace(/^docs\//, '')}`.replace(/\/index\.html$/, '/');
        const alternate = `${site}/${rel(resolve(ROOT, page)).replace(/^docs\//, '')}`;
        if (!locs.includes(url) && !locs.includes(alternate)) {
            report(page, 1, 'sitemap-parity', `indexable page missing from sitemap.xml (${alternate})`);
        }
    }
    for (const m of sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) {
        const date = m[1];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            report('docs/sitemap.xml', lineOf(sitemap, m.index ?? 0), 'sitemap-parity', `lastmod not ISO-8601: ${date}`);
            continue;
        }
        const stamp = Date.parse(date);
        const audit = Date.parse(verifiedOn);
        if (stamp > audit) report('docs/sitemap.xml', lineOf(sitemap, m.index ?? 0), 'sitemap-parity', `lastmod ${date} is after verifiedOn ${verifiedOn}`);
        if (audit - stamp > 45 * 86_400_000) report('docs/sitemap.xml', lineOf(sitemap, m.index ?? 0), 'sitemap-parity', `lastmod ${date} more than 45 days before verifiedOn`);
    }
}

// ── Rule: jsonld-version ─────────────────────────────────────────────
for (const page of htmlPages) {
    const html = read(page);
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
        let parsed: { '@graph'?: Array<Record<string, unknown>> };
        try {
            parsed = JSON.parse(m[1]) as typeof parsed;
        } catch {
            report(page, lineOf(html, m.index ?? 0), 'jsonld-version', 'invalid JSON-LD');
            continue;
        }
        // Walk every node (top-level or @graph) plus nested `about` nodes:
        // any node NAMED after a manifest package must carry that package's
        // version — the #library node and the satellite `about` nodes alike.
        const nodes: Array<Record<string, unknown>> = parsed['@graph'] ?? [parsed as Record<string, unknown>];
        const checkVersion = (node: Record<string, unknown>): void => {
            const id = typeof node['@id'] === 'string' ? node['@id'] : '';
            const name = typeof node['name'] === 'string' ? node['name'] : '';
            const pkgEntry = ecosystem.packages[name];
            const expected = id.endsWith('#library') ? truthVersion : (pkgEntry?.version ?? null);
            if (expected !== null && node['softwareVersion'] !== undefined && node['softwareVersion'] !== expected) {
                report(page, lineOf(html, m.index ?? 0), 'jsonld-version',
                    `${name || id} softwareVersion ${String(node['softwareVersion'])} != manifest ${expected}`);
            }
            if (id.endsWith('#library') && node['softwareVersion'] === undefined) {
                report(page, lineOf(html, m.index ?? 0), 'jsonld-version', '#library node lacks softwareVersion');
            }
        };
        // An ItemList (a hub's mainEntity) is a machine-readable copy of the
        // hub's cards: the 1.1.0 playgrounds hub listed 7 of its 8 pages for
        // a whole release because nothing compared the two. The list must
        // name every same-directory page the hub links to, in card order,
        // with consecutive positions and a numberOfItems equal to its length.
        const dir = page.slice(0, page.lastIndexOf('/') + 1);
        const cards = [...html.matchAll(/href="([a-z0-9-]+\.html)"/g)].map((c) => c[1]).filter((f, i, all) => f !== 'index.html' && all.indexOf(f) === i);
        const checkItemList = (list: Record<string, unknown>): void => {
            const items = Array.isArray(list['itemListElement']) ? (list['itemListElement'] as Array<Record<string, unknown>>) : [];
            if (list['numberOfItems'] !== items.length) {
                report(page, lineOf(html, m.index ?? 0), 'jsonld-version', `ItemList numberOfItems ${String(list['numberOfItems'])} != ${items.length} itemListElement entries`);
            }
            const files = items.map((item, i) => {
                if (item['position'] !== i + 1) report(page, lineOf(html, m.index ?? 0), 'jsonld-version', `ItemList position ${String(item['position'])} at index ${i} — positions must be 1..n in order`);
                const url = typeof item['url'] === 'string' ? item['url'] : '';
                const file = url.slice(url.lastIndexOf('/') + 1);
                if (!existsSync(resolve(ROOT, dir + file))) report(page, lineOf(html, m.index ?? 0), 'jsonld-version', `ItemList item "${String(item['name'])}" points to ${url} — no such page beside the hub`);
                return file;
            });
            if (cards.length > 0 && files.join(' ') !== cards.join(' ')) {
                report(page, lineOf(html, m.index ?? 0), 'jsonld-version', `ItemList [${files.join(', ')}] must equal the hub's cards in order [${cards.join(', ')}]`);
            }
        };
        for (const node of nodes) {
            checkVersion(node);
            const about = node['about'];
            if (about !== null && typeof about === 'object') checkVersion(about as Record<string, unknown>);
            const entity = node['mainEntity'];
            if (entity !== null && typeof entity === 'object' && (entity as Record<string, unknown>)['@type'] === 'ItemList') checkItemList(entity as Record<string, unknown>);
            if (node['@type'] === 'ItemList') checkItemList(node);
            const type = node['@type'];
            if ((type === 'WebSite' || type === 'SoftwareSourceCode' || type === 'TechArticle') && node['inLanguage'] === undefined) {
                report(page, lineOf(html, m.index ?? 0), 'jsonld-version', `${String(type)} node lacks inLanguage`);
            }
        }
    }
}

// ── Rule: cdn-sri — third-party EXECUTABLE/style resources only ──────
//    (canonical/hreflang/alternate links are self-references, not loads)
for (const page of htmlPages) {
    const html = read(page);
    const resources = [
        ...html.matchAll(/<script[^>]*\bsrc="(https?:\/\/[^"]+)"[^>]*>/g),
        ...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*\bhref="(https?:\/\/[^"]+)"[^>]*>/g),
        ...html.matchAll(/<link[^>]*\bhref="(https?:\/\/[^"]+)"[^>]*rel="stylesheet"[^>]*>/g),
    ];
    for (const m of resources) {
        const tag = m[0];
        if (!tag.includes('integrity=') || !tag.includes('crossorigin')) {
            report(page, lineOf(html, m.index ?? 0), 'cdn-sri', `third-party resource without integrity+crossorigin: ${m[1]}`);
        }
    }
}

// ── Rule: contrast (WCAG on the theme tokens) ────────────────────────
{
    const css = read('docs/style.css');
    const luminance = (hex: string): number => {
        const value = hex.replace('#', '');
        const channel = (i: number): number => {
            const c = parseInt(value.slice(i * 2, i * 2 + 2), 16) / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
    };
    const ratio = (a: string, b: string): number => {
        const la = luminance(a);
        const lb = luminance(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const blocks = [...css.matchAll(/(:root|\[data-theme="dark"\])\s*\{([^}]+)\}/g)];
    for (const block of blocks) {
        const tokens = new Map<string, string>();
        for (const m of block[2].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
            tokens.set(m[1], m[2]);
        }
        for (const fg of ['c-text-muted', 'c-text-dim']) {
            for (const bg of ['c-bg', 'c-surface', 'c-bg-card']) {
                const fgHex = tokens.get(fg);
                const bgHex = tokens.get(bg);
                if (fgHex !== undefined && bgHex !== undefined && ratio(fgHex, bgHex) < 4.5) {
                    report('docs/style.css', lineOf(css, block.index ?? 0), 'contrast',
                        `${block[1]}: --${fg} on --${bg} is ${ratio(fgHex, bgHex).toFixed(2)}:1 (< 4.5:1 WCAG AA)`);
                }
            }
        }
    }
}

// ── Rule: sample-count (asymmetric by design) ────────────────────────
{
    const declared = ecosystem.derived?.sampleZips;
    if (typeof declared === 'number' && existsSync(resolve(ROOT, 'test-output'))) {
        // Dot-directories (.gate logs, the .compat extraction) are never samples.
        const onDisk = walk('test-output').filter((p) => p.endsWith('.zip') && !p.includes('/.')).length;
        if (onDisk > declared) {
            report('docs/assets/ecosystem.json', 1, 'sample-count',
                `test-output/ holds ${onDisk} archives but derived.sampleZips declares ${declared} — a generator grew; bump the manifest`);
        } else if (onDisk > 0 && onDisk < declared) {
            report('docs/assets/ecosystem.json', 1, 'sample-count',
                `test-output/ holds ${onDisk}/${declared} declared samples (normal after a partial run)`, 'warn');
        }
    }
}

// ── Rule: error-parity ───────────────────────────────────────────────
// The frozen code vocabulary (src/types/zip-errors.ts + zip-types.ts) and
// the registry docs/data/errors.json must agree bidirectionally, class
// membership included, and every code must be documented in the errors
// guide. Also: every throw site must pass a literal 'ZIP_*' code (a
// computed code would defeat the freeze).
{
    const errorsSource = read('src/types/zip-errors.ts');
    // The union terminator is the quote-adjacent semicolon of the last
    // member (`'ZIP_X';`) — a bare first-`;` would stop inside a comment.
    const unionOf = (name: string): { codes: string[]; line: number } => {
        const m = errorsSource.match(new RegExp(`export type ${name} =([\\s\\S]*?'ZIP_[A-Z0-9_]+';)`));
        if (m === null) {
            report('src/types/zip-errors.ts', 1, 'error-parity', `union ${name} not found`);
            return { codes: [], line: 1 };
        }
        const codes = [...m[1].matchAll(/'(ZIP_[A-Z0-9_]+)'/g)].map((x) => x[1]);
        return { codes, line: lineOf(errorsSource, m.index ?? 0) };
    };
    const CLASS_UNIONS: ReadonlyArray<[string, string]> = [
        ['ZipBaseErrorCode', 'ZipError'],
        ['ZipFormatErrorCode', 'ZipFormatError'],
        ['ZipSecurityErrorCode', 'ZipSecurityError'],
        ['ZipDataErrorCode', 'ZipDataError'],
        ['ZipLimitErrorCode', 'ZipLimitError'],
        ['ZipUnsupportedErrorCode', 'ZipUnsupportedError'],
    ];
    const codeToClass = new Map<string, string>();
    for (const [union, cls] of CLASS_UNIONS) {
        for (const code of unionOf(union).codes) codeToClass.set(code, cls);
    }

    interface ErrorRegistry {
        errors?: ReadonlyArray<{ code?: string; class?: string; raisedWhen?: string; remedy?: string }>;
        diagnostics?: ReadonlyArray<{ code?: string }>;
    }
    const registryPath = 'docs/data/errors.json';
    if (!existsSync(resolve(ROOT, registryPath))) {
        report(registryPath, 1, 'error-parity', 'missing — the error-code registry is part of the freeze contract');
    } else {
        const registry = JSON.parse(read(registryPath)) as ErrorRegistry;
        const registered = new Map<string, string>();
        for (const entry of registry.errors ?? []) {
            if (typeof entry.code !== 'string' || typeof entry.class !== 'string'
                || typeof entry.raisedWhen !== 'string' || typeof entry.remedy !== 'string') {
                report(registryPath, 1, 'error-parity', `entry ${entry.code ?? '(no code)'} must carry code, class, raisedWhen and remedy`);
                continue;
            }
            if (registered.has(entry.code)) {
                report(registryPath, 1, 'error-parity', `duplicate registry entry for ${entry.code}`);
            }
            registered.set(entry.code, entry.class);
        }
        for (const [code, cls] of codeToClass) {
            const regClass = registered.get(code);
            if (regClass === undefined) {
                report(registryPath, 1, 'error-parity', `code ${code} exists in the source union but is missing from the registry`);
            } else if (regClass !== cls) {
                report(registryPath, 1, 'error-parity', `code ${code} is registered as ${regClass} but the source union places it on ${cls}`);
            }
        }
        for (const code of registered.keys()) {
            if (!codeToClass.has(code)) {
                report(registryPath, 1, 'error-parity', `registry code ${code} does not exist in any source union — stale entry`);
            }
        }

        // Diagnostics parity against the closed ZipDiagnosticCode union.
        const typesSource = read('src/types/zip-types.ts');
        const diagUnion = typesSource.match(/export type ZipDiagnosticCode =([\s\S]*?'ZIP_[A-Z0-9_]+';)/);
        const diagCodes = new Set([...(diagUnion?.[1] ?? '').matchAll(/'(ZIP_[A-Z0-9_]+)'/g)].map((x) => x[1]));
        const diagRegistered = new Set((registry.diagnostics ?? []).map((d) => d.code ?? ''));
        for (const code of diagCodes) {
            if (!diagRegistered.has(code)) report(registryPath, 1, 'error-parity', `diagnostic ${code} missing from the registry`);
        }
        for (const code of diagRegistered) {
            if (!diagCodes.has(code)) report(registryPath, 1, 'error-parity', `registry diagnostic ${code} does not exist in ZipDiagnosticCode`);
        }

        // Guide completeness: every registered error code appears in the guide.
        const guidePath = 'docs/guides/errors.md';
        if (!existsSync(resolve(ROOT, guidePath))) {
            report(guidePath, 1, 'error-parity', 'missing — the errors guide documents the frozen vocabulary');
        } else {
            const guide = read(guidePath);
            for (const code of registered.keys()) {
                if (!guide.includes(code)) {
                    report(guidePath, 1, 'error-parity', `code ${code} is not documented in the errors guide`);
                }
            }
            for (const mention of guide.matchAll(/\bZIP_[A-Z0-9_]+\b/g)) {
                const name = mention[0];
                if (!registered.has(name) && !diagCodes.has(name)) {
                    report(guidePath, lineOf(guide, mention.index ?? 0), 'error-parity', `guide names unknown code ${name}`);
                }
            }
        }
    }

    // Literal-code discipline at every throw site in src/.
    for (const path of walk('src').filter((p) => p.endsWith('.ts'))) {
        const text = read(path);
        for (const site of text.matchAll(/new Zip\w*Error\(\s*(?![`'"]ZIP_)[^)\s]/g)) {
            if (allowed(text, site.index ?? 0, 'error-parity')) continue;
            report(path, lineOf(text, site.index ?? 0), 'error-parity',
                'error constructed without a literal ZIP_* code as its first argument — computed codes defeat the freeze');
        }
    }
}

// ── Documentation corpus (count-tokens, version-token, prose-language) ─
// llms-full.txt and llms-recipes.txt are generated from files already in
// the corpus; scanning a concatenation would double-report every finding
// at line numbers nobody can act on. CHANGELOG.md and release-notes/ are
// history and quote superseded figures on purpose.
const DOC_FILES: readonly string[] = [
    ...walk('docs').filter((p) => /\.(html|md|svg|txt|js|xml)$/.test(p) && !p.endsWith('llms-full.txt') && !p.endsWith('llms-recipes.txt')),
    ...['README.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md', 'ROADMAP.md', 'llms.txt']
        .filter((p) => existsSync(resolve(ROOT, p))),
];
// The satellite guides and playgrounds quote THEIR packages' figures.
const COMPANION_DOC = /^docs\/(?:guides|playgrounds)\/(?:cli|mcp)\.(?:md|html)$/;

// ── Rule: derived-counts ─────────────────────────────────────────────
// Every derived.* figure is recomputed from the tree and must match
// exactly; declared.tests and declared.coverage* are held to the last
// gate run when its report is newer than every test file (an older one
// predates a test added since and would fail the wrong side). A manifest
// nobody checks is a second copy of the prose — the pdfnative 1.8.0 lesson
// (mutating declared.tests to 9999 passed every rule).
{
    const listDir = (dir: string, test: (f: string) => boolean): string[] =>
        existsSync(resolve(ROOT, dir)) ? readdirSync(resolve(ROOT, dir)).filter(test) : [];
    const unionSize = (source: string, name: string): number => {
        const m = source.match(new RegExp(`export type ${name} =([\\s\\S]*?'ZIP_[A-Z0-9_]+';)`));
        return new Set([...(m?.[1] ?? '').matchAll(/'(ZIP_[A-Z0-9_]+)'/g)].map((x) => x[1])).size;
    };
    const errorsSource = read('src/types/zip-errors.ts');
    const errorCodes = ['ZipBaseErrorCode', 'ZipFormatErrorCode', 'ZipSecurityErrorCode', 'ZipDataErrorCode', 'ZipLimitErrorCode', 'ZipUnsupportedErrorCode']
        .reduce((sum, union) => sum + unionSize(errorsSource, union), 0);
    const apiJson = JSON.parse(read('docs/assets/api.json')) as { exports?: ReadonlyArray<unknown> };
    const interopSource = existsSync(resolve(ROOT, 'tests/helpers/interop-tools.ts')) ? read('tests/helpers/interop-tools.ts') : '';
    const [producersPart = '', extractorsPart = ''] = interopSource.split('export const EXTRACTORS');
    const toolIds = (part: string): number => [...part.matchAll(/^\s+id: '([a-z0-9-]+)',/gm)].length;
    const writeCases = [...read('scripts/run-interop.ts').matchAll(/^\s+name: '([a-z0-9-]+)',$/gm)].length;
    const recipesIndex = JSON.parse(read('recipes/index.json')) as { recipes?: ReadonlyArray<{ file?: string }> };
    const recipeFiles = listDir('recipes', (f) => f.endsWith('.ts') && !f.startsWith('_'));
    if ((recipesIndex.recipes?.length ?? 0) !== recipeFiles.length) {
        report('recipes/index.json', 1, 'derived-counts', `index lists ${recipesIndex.recipes?.length ?? 0} recipes but recipes/ holds ${recipeFiles.length} .ts files`);
    }
    const testFiles = walk('tests').filter((p) => p.endsWith('.test.ts'));
    const actualDerived: Record<string, number> = {
        exports: apiJson.exports?.length ?? 0,
        errorCodes,
        diagnostics: unionSize(read('src/types/zip-types.ts'), 'ZipDiagnosticCode'),
        testFiles: testFiles.length,
        sampleGenerators: listDir('scripts/generators', (f) => f.endsWith('.ts')).length,
        guides: listDir('docs/guides', (f) => f.endsWith('.md')).length,
        // Live playgrounds only — a retired one survives as a noindex redirect stub.
        playgrounds: listDir('docs/playgrounds', (f) => f.endsWith('.html') && f !== 'index.html'
            && !/name=["']robots["'][^>]*noindex/i.test(read(`docs/playgrounds/${f}`))).length,
        recipes: recipeFiles.length,
        interopTools: toolIds(extractorsPart),
        interopValidations: toolIds(producersPart) + writeCases,
        verifyDocsRules: RULES.length,
    };
    for (const key of Object.keys(actualDerived)) {
        if (!KNOWN_DERIVED.has(key)) report('scripts/verify-docs.ts', 1, 'manifest-shape', `derived-counts computes ${key} but KNOWN_DERIVED does not list it`);
    }
    for (const [key, actual] of Object.entries(actualDerived)) {
        const want = ecosystem.derived?.[key];
        if (want === undefined) {
            report(MANIFEST, 1, 'derived-counts', `derived.${key} is missing — the tree has ${actual}; count-tokens needs it`);
        } else if (want !== actual) {
            report(MANIFEST, 1, 'derived-counts', `derived.${key} says ${String(want)} but the tree has ${actual} — update the manifest, not the docs`);
        }
    }
    const newestTest = testFiles.reduce((max, p) => Math.max(max, statSync(resolve(ROOT, p)).mtimeMs), 0);
    const fresh = (path: string): boolean => existsSync(resolve(ROOT, path)) && statSync(resolve(ROOT, path)).mtimeMs >= newestTest;
    const vitestJson = 'test-output/.gate/vitest.json';
    if (fresh(vitestJson)) {
        let total: number | undefined;
        try {
            total = (JSON.parse(read(vitestJson)) as { numTotalTests?: number }).numTotalTests;
        } catch {
            total = undefined;
        }
        if (typeof total === 'number' && total > 0 && ecosystem.declared?.tests !== total) {
            report(MANIFEST, 1, 'derived-counts', `declared.tests says ${String(ecosystem.declared?.tests)} but the last gate run counted ${total} tests — update the manifest (and every doc quoting it)`);
        }
    }
    const coverageSummary = 'coverage/coverage-summary.json';
    if (fresh(coverageSummary)) {
        let pct: number | undefined;
        try {
            pct = (JSON.parse(read(coverageSummary)) as { total?: { statements?: { pct?: number } } }).total?.statements?.pct;
        } catch {
            pct = undefined;
        }
        if (typeof pct === 'number') {
            if (ecosystem.declared?.coverageStatements !== Math.floor(pct)) {
                report(MANIFEST, 1, 'derived-counts', `declared.coverageStatements says ${String(ecosystem.declared?.coverageStatements)} but the last coverage run measured ${pct} % — update the manifest`);
            }
            if (typeof ecosystem.declared?.coverageMeasured === 'number' && Math.abs(ecosystem.declared.coverageMeasured - pct) > 0.05) {
                report(MANIFEST, 1, 'derived-counts', `declared.coverageMeasured says ${ecosystem.declared.coverageMeasured} but the last coverage run measured ${pct} % — update the manifest`);
            }
        }
    }
}

// ── Rule: count-tokens ───────────────────────────────────────────────
// "106 exports", "39-code error vocabulary", "685 tests", "93.9% statement
// coverage", "38-sample corpus": every such token in the corpus equals its
// manifest counter. Nothing policed 77 / 39 / 385+ / 93.9 % before 1.1.0,
// and the same sentence carried different figures across README, homepage
// and llms.txt. Coverage is bounded, not matched: a doc may state the
// floor ("93%+") or the measured figure ("93.9 %"), never more. Historical
// prose opts out with `verify-docs:allow count-tokens`.
{
    interface CountToken {
        readonly pattern: RegExp;
        readonly source: string;
        readonly mode: 'equal' | 'floor';
        /** Skip a match whose trailing 80 characters match this (disambiguation). */
        readonly unless?: RegExp;
        readonly requireIn?: readonly string[];
    }
    const COUNT_TOKENS: readonly CountToken[] = [
        { pattern: /(?<![\d.])(\d+)\+?[ -]exports?\b/g, source: 'derived.exports', mode: 'equal', requireIn: ['README.md', 'docs/agent-brief.md'] },
        { pattern: /(?<![\d.])(\d+)[ -]code\b(?=[^\n]{0,80}ZipDiagnosticCode)/g, source: 'derived.diagnostics', mode: 'equal' },
        { pattern: /(?<![\d.])(\d+)\s+diagnostic(?:\s+codes?)?\b/g, source: 'derived.diagnostics', mode: 'equal' },
        { pattern: /(?<![\d.])(\d+)[ -](?:frozen[ -])?(?:error[ -])?codes?\b/g, source: 'derived.errorCodes', mode: 'equal', unless: /^[^\n]{0,80}(?:diagnostic|ZipDiagnosticCode)/ },
        { pattern: /(?<![\d.])(\d+)\+?\s+tests\b/g, source: 'declared.tests', mode: 'equal', requireIn: ['AGENTS.md', 'README.md'] },
        // The homepage metric tiles separate the number from its noun with markup.
        { pattern: /class="metric-value">(\d+)\+?<\/div>\s*<div class="metric-label">Tests</g, source: 'declared.tests', mode: 'equal', requireIn: ['docs/index.html'] },
        { pattern: /class="metric-value">(\d+(?:\.\d+)?)\s?%<\/div>\s*<div class="metric-label">Coverage/g, source: 'declared.coverageStatements', mode: 'floor' },
        { pattern: /class="metric-value">(\d+)<\/div>\s*<div class="metric-label">Foreign interop tools/g, source: 'derived.interopTools', mode: 'equal' },
        { pattern: /class="metric-value">(\d+)<\/div>\s*<div class="metric-label">Frozen error codes/g, source: 'derived.errorCodes', mode: 'equal' },
        { pattern: /(?<![\d.])(\d+)\+?\s+test files\b/g, source: 'derived.testFiles', mode: 'equal' },
        { pattern: /\bacross\s+(\d+)\+?\s+(?:test\s+)?files\b/g, source: 'derived.testFiles', mode: 'equal' },
        { pattern: /(?<![\d.])(\d+(?:\.\d+)?)\s?(?:%|percent)\+?\s+(?:statement\s+)?coverage\b/g, source: 'declared.coverageStatements', mode: 'floor' },
        { pattern: /(?<![\d.])(\d+(?:\.\d+)?)\s?%\+?\s+statements\b/g, source: 'declared.coverageStatements', mode: 'floor' },
        { pattern: /(?<![\d.])(\d+)[ -]samples?\b/g, source: 'derived.sampleZips', mode: 'equal' },
        { pattern: /(?<![\d.])(\d+)\s+(?:sample|demonstration)\s+archives\b/g, source: 'derived.sampleZips', mode: 'equal' },
        { pattern: /(?<![\d.])(\d+)\s+(?:sample\s+)?generators\b/g, source: 'derived.sampleGenerators', mode: 'equal' },
        { pattern: /(?<![\d.])(\d+)\s+(?:documented\s+)?guides\b/g, source: 'derived.guides', mode: 'equal' },
        { pattern: /\b(\d+|five|six|seven|eight|nine|ten)\s+(?:interactive\s+|live\s+|zero-install\s+|hands-on\s+)?playgrounds\b/gi, source: 'derived.playgrounds', mode: 'equal' },
        { pattern: /(?<![\d.])(\d+)\s+(?:executable\s+)?recipes\b/g, source: 'derived.recipes', mode: 'equal' },
        { pattern: /(?<![\d.])(\d+)\s+(?:interop\s+)?validations\b/g, source: 'derived.interopValidations', mode: 'equal' },
        { pattern: /\b(\d+|five|six|seven|eight)[ -](?:foreign|external|independent)[ -](?:tools?|parsers?|extractors?)\b|\b(\d+|five|six|seven|eight)-parser\b/gi, source: 'derived.interopTools', mode: 'equal' },
    ];
    const NUMERALS: Record<string, number> = { five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const manifestRef = (source: string): number | undefined => {
        const [table, key] = source.split('.');
        const record = table === 'derived' ? ecosystem.derived : (ecosystem.declared as Record<string, unknown> | undefined);
        const value = record?.[key];
        return typeof value === 'number' ? value : undefined;
    };
    const corpus = DOC_FILES.filter((f) => !COMPANION_DOC.test(f));
    for (const token of COUNT_TOKENS) {
        const expected = manifestRef(token.source);
        if (expected === undefined) {
            report(MANIFEST, 1, 'manifest-shape', `${token.source} is missing — count-tokens needs it to police "${token.pattern.source}"`);
            continue;
        }
        const seenIn = new Set<string>();
        for (const file of corpus) {
            const text = read(file);
            token.pattern.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = token.pattern.exec(text)) !== null) {
                const raw = m[1] ?? m[2] ?? '';
                if (token.unless !== undefined && token.unless.test(text.slice(m.index + m[0].length, m.index + m[0].length + 80))) continue;
                seenIn.add(file);
                const found = NUMERALS[raw.toLowerCase()] ?? Number(raw);
                if (!Number.isFinite(found)) continue;
                const measured = ecosystem.declared?.coverageMeasured;
                if (token.mode === 'floor' && raw.includes('.') && typeof measured === 'number') {
                    // A decimal claims a measurement, not a floor: it must equal declared.coverageMeasured.
                    if (Math.abs(found - measured) > 0.001 && !allowed(text, m.index, 'count-tokens')) {
                        report(file, lineOf(text, m.index), 'count-tokens', `"${m[0].trim()}" — the manifest says the measured figure is ${measured} % (declared.coverageMeasured)`);
                    }
                    continue;
                }
                const ok = token.mode === 'equal' ? found === expected : Math.floor(found) <= expected;
                if (ok || allowed(text, m.index, 'count-tokens')) continue;
                const verdict = token.mode === 'equal'
                    ? `the manifest says ${expected} (${token.source})`
                    : `the manifest floor is ${expected} % (${token.source}) — a doc may not claim more coverage than was measured`;
                report(file, lineOf(text, m.index), 'count-tokens', `"${m[0].trim()}" — ${verdict}`);
            }
        }
        for (const required of token.requireIn ?? []) {
            if (!existsSync(resolve(ROOT, required))) {
                report(required, 1, 'count-tokens', `missing — it must state the ${token.source} count`);
            } else if (!seenIn.has(required)) {
                report(required, 1, 'count-tokens', `never states the ${token.source} count ("${expected}") — it is the figure agents quote`);
            }
        }
    }
}

// ── Rule: version-token ──────────────────────────────────────────────
// A package name with a nearby semver that disagrees with the manifest is
// the most damaging drift a doc can carry ("zipnative-mcp 1.0.0 is …"
// outliving a release). Range specifiers (^1.0.0), floors (≥ 1.1.0) and
// clause numbers (§4.5.3) are skipped by lookbehind; the gap between name
// and version must not cross a quote, slash, paren or sentence boundary.
// Two structural forms the prose regex cannot reach: the README ecosystem
// table (`[\`zipnative\`](url) | … | 1.0.0 |`) and the homepage badges
// (`data-zn-badge="zipnative">v1.0.0<`, which JavaScript overwrites at
// runtime but a non-JS fetcher reads as is). "both X.Y.Z" / "all three
// packages …, X.Y.Z" are claims about the satellites and must hold for
// every package they cover.
{
    const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const check = (file: string, text: string, pattern: RegExp, name: string, version: string): void => {
        pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(text)) !== null) {
            if (m[1] === version || allowed(text, m.index, 'version-token')) continue;
            report(file, lineOf(text, m.index), 'version-token', `"${m[0].trim()}" — the manifest says ${name} is ${version}`);
        }
    };
    for (const [name, pkgEntry] of Object.entries(ecosystem.packages)) {
        if (typeof pkgEntry.version !== 'string') continue;
        const escaped = escape(name);
        const patterns = [
            // "zipnative" must not match inside "zipnative-cli".
            new RegExp(`\\b${escaped}(?![\\w-])[^\\n'"\`/().]{0,60}?(?<![\\^~\\d.§])(?<![<>≥≤=]\\s{0,3})\\bv?(\\d+\\.\\d+\\.\\d+)\\b`, 'g'),
            new RegExp(`\\[\`${escaped}\`\\]\\([^)]*\\)\\s*\\|[^|\\n]*\\|\\s*\\*{0,2}v?(\\d+\\.\\d+\\.\\d+)\\*{0,2}\\s*\\|`, 'g'),
            new RegExp(`data-zn-badge=["']${escaped}["'][^>]*>\\s*v?(\\d+\\.\\d+\\.\\d+)\\s*<`, 'g'),
        ];
        for (const file of DOC_FILES) {
            const text = read(file);
            for (const pattern of patterns) check(file, text, pattern, name, pkgEntry.version);
        }
    }
    const satellites = Object.entries(ecosystem.packages).filter(([n]) => n !== pkg.name);
    const everyone = Object.entries(ecosystem.packages);
    const CLAIMS: ReadonlyArray<readonly [RegExp, ReadonlyArray<readonly [string, EcosystemPackage]>, string]> = [
        [/\bboth\s+(?:at\s+|on\s+)?v?(\d+\.\d+\.\d+)\b/g, satellites, 'both satellites'],
        [/\ball three packages[^,\n]{0,40},\s*v?(\d+\.\d+\.\d+)\b/g, everyone, 'all three packages'],
        [/\bCurrent version:\s*v?(\d+\.\d+\.\d+)\b/g, everyone.filter(([n]) => n === pkg.name), pkg.name],
    ];
    for (const file of DOC_FILES) {
        const text = read(file);
        for (const [pattern, covered, label] of CLAIMS) {
            pattern.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = pattern.exec(text)) !== null) {
                const claimed = m[1];
                const wrong = covered.filter(([, p]) => p.version !== claimed).map(([n, p]) => `${n} is ${String(p.version)}`);
                if (wrong.length === 0 || allowed(text, m.index, 'version-token')) continue;
                report(file, lineOf(text, m.index), 'version-token', `"${m[0].trim()}" claims ${label} are ${claimed} but ${wrong.join(', ')}`);
            }
        }
    }
}

// ── Rule: prose-language ─────────────────────────────────────────────
// The project language is English. Another language is allowed only as
// demonstrated content (a legacy code-page sample, a foreign-tool
// transcript), marked `demo-language:` on or above the line;
// scripts/lib/prose-language.ts is the shared detector.
{
    const corpus = [
        ...DOC_FILES,
        ...(existsSync(resolve(ROOT, 'release-notes')) ? walk('release-notes').filter((p) => p.endsWith('.md')) : []),
        ...walk('recipes').filter((p) => p.endsWith('.ts')),
        ...walk('scripts/generators').filter((p) => p.endsWith('.ts')),
        ...(existsSync(resolve(ROOT, 'bench/RESULTS.md')) ? ['bench/RESULTS.md'] : []),
    ];
    for (const file of corpus) {
        const text = read(file);
        for (const finding of findNonEnglishProse(text, file, { suppress: 'verify-docs:allow prose-language' })) {
            report(file, finding.line, 'prose-language',
                `${finding.reason}: "${finding.snippet}" — write it in English, or mark demonstrated content with \`demo-language: <tag> (reason)\` on or above the line`);
        }
    }
}

// ── Rule: sample-regression ──────────────────────────────────────────
// The byte baseline (tests/regression/baselines/samples.sha256.json) is
// the release's safety net: it must exist, every entry must carry a
// SHA-256, a size and a `since` no newer than the manifest version, and —
// once the corpus is generated — every sample must be tracked. A missing
// entry only warns (a release-in-progress sample is untracked until its
// rebaseline); `--strict` makes the release PR carry it.
{
    const path = 'tests/regression/baselines/samples.sha256.json';
    const semverLe = (a: string, b: string): boolean => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
        }
        return true;
    };
    if (!existsSync(resolve(ROOT, path))) {
        report(path, 1, 'sample-regression', 'missing — the byte baseline is the release safety net (npm run test:generate && npx tsx scripts/verify-samples.ts --update)');
    } else {
        interface Baseline { baselineVersion?: string; entries?: Record<string, { hash?: string; size?: number; since?: string }> }
        let baseline: Baseline = {};
        try {
            baseline = JSON.parse(read(path)) as Baseline;
        } catch (err) {
            report(path, 1, 'sample-regression', `not valid JSON — ${(err as Error).message}`);
        }
        const entries = Object.entries(baseline.entries ?? {});
        if (entries.length === 0) report(path, 1, 'sample-regression', 'no entries — regenerate the samples and rebaseline');
        if (typeof baseline.baselineVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(baseline.baselineVersion)) {
            report(path, 1, 'sample-regression', 'baselineVersion must be a semver triple');
        } else if (truthVersion !== null && !semverLe(baseline.baselineVersion, truthVersion)) {
            report(path, 1, 'sample-regression', `baselineVersion ${baseline.baselineVersion} is ahead of the manifest's ${truthVersion}`);
        }
        for (const [name, entry] of entries) {
            if (typeof entry.hash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.hash) || typeof entry.size !== 'number'
                || typeof entry.since !== 'string' || !/^\d+\.\d+\.\d+$/.test(entry.since)) {
                report(path, 1, 'sample-regression', `${name}: every entry carries hash (SHA-256 hex), size and since (semver)`);
            } else if (truthVersion !== null && !semverLe(entry.since, truthVersion)) {
                report(path, 1, 'sample-regression', `${name}: since ${entry.since} is ahead of the manifest's ${truthVersion}`);
            }
        }
        const declaredSamples = ecosystem.derived?.sampleZips;
        if (typeof declaredSamples === 'number' && entries.length > declaredSamples) {
            report(path, 1, 'sample-regression', `baseline holds ${entries.length} entries but derived.sampleZips declares ${declaredSamples} — a sample was removed; rebaseline`);
        }
        if (typeof declaredSamples === 'number' && entries.length < declaredSamples) {
            report(path, 1, 'sample-regression', `${declaredSamples - entries.length} of ${declaredSamples} declared samples have no baseline entry — rebaseline (verify-samples --update) in the release PR, since: ${truthVersion ?? '?'}`, 'warn');
        }
        if (existsSync(resolve(ROOT, 'test-output'))) {
            const onDisk = walk('test-output').filter((p) => p.endsWith('.zip') && !p.includes('/.')).map((p) => p.replace(/^test-output\//, ''));
            const tracked = new Set(entries.map(([n]) => n));
            if (onDisk.length > 0 && typeof declaredSamples === 'number' && onDisk.length >= declaredSamples) {
                for (const [name] of entries) {
                    if (!onDisk.includes(name)) report(path, 1, 'sample-regression', `${name} is in the baseline but no generator writes it — drop the entry (verify-samples --update)`);
                }
            }
            for (const f of onDisk) {
                if (!tracked.has(f)) report(path, 1, 'sample-regression', `${f} is generated but untracked — rebaseline in the release PR`, 'warn');
            }
        }
    }
}

// ── Rule: claude-md-budget ───────────────────────────────────────────
// The agent entry files are loaded into every session's context, so their
// size is a tax on every task. CLAUDE.md must start by importing AGENTS.md
// (one source of truth, not a fork), both stay under 120 lines, the
// Copilot file under 16 KiB, and no line exceeds 240 characters.
{
    const MAX_LINE = 240;
    const budgets: Array<{ file: string; maxLines?: number; maxBytes?: number; firstLine?: string }> = [
        { file: 'CLAUDE.md', maxLines: 120, firstLine: '@AGENTS.md' },
        { file: 'AGENTS.md', maxLines: 120 },
        { file: '.github/copilot-instructions.md', maxBytes: 16384 },
    ];
    for (const budget of budgets) {
        if (!existsSync(resolve(ROOT, budget.file))) {
            report(budget.file, 1, 'claude-md-budget', 'missing — every agent entry file must exist');
            continue;
        }
        const text = read(budget.file);
        const lines = text.split('\n');
        const lineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
        if (budget.maxLines !== undefined && lineCount > budget.maxLines) {
            report(budget.file, 1, 'claude-md-budget', `${lineCount} lines — the budget is ${budget.maxLines}; move detail to .github/instructions/`);
        }
        const bytes = Buffer.byteLength(text, 'utf8');
        if (budget.maxBytes !== undefined && bytes > budget.maxBytes) {
            report(budget.file, 1, 'claude-md-budget', `${bytes} bytes — the budget is ${budget.maxBytes}; move detail to .github/instructions/`);
        }
        lines.forEach((line, i) => {
            if (line.length > MAX_LINE) report(budget.file, i + 1, 'claude-md-budget', `line is ${line.length} characters — the limit is ${MAX_LINE}`);
        });
        if (budget.firstLine !== undefined) {
            const first = lines.find((l) => l.trim() !== '')?.trim();
            if (first !== budget.firstLine) {
                report(budget.file, 1, 'claude-md-budget', `first non-empty line is "${first ?? ''}" — it must be "${budget.firstLine}" so Claude Code loads AGENTS.md instead of a fork of it`);
            }
        }
    }
}

// ── Rule: governance-sources ─────────────────────────────────────────
// .github/ai-governance.json tells agents which files to load before
// proposing a change. A path that no longer exists teaches them nothing,
// and an always-loaded set over 16 KiB taxes every session.
{
    const GOVERNANCE = '.github/ai-governance.json';
    const MAX_SOURCES_BYTES = 16 * 1024;
    if (existsSync(resolve(ROOT, GOVERNANCE))) {
        let policy: { capability_manifest?: { sources?: unknown; on_demand?: unknown } } = {};
        try {
            policy = JSON.parse(read(GOVERNANCE)) as typeof policy;
        } catch (err) {
            report(GOVERNANCE, 1, 'governance-sources', `not valid JSON — ${(err as Error).message}`);
        }
        const asPaths = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
        let total = 0;
        for (const [list, entries] of [['sources', asPaths(policy.capability_manifest?.sources)], ['on_demand', asPaths(policy.capability_manifest?.on_demand)]] as const) {
            for (const p of entries) {
                const full = resolve(ROOT, p);
                if (!existsSync(full)) {
                    report(GOVERNANCE, 1, 'governance-sources', `capability_manifest.${list} names "${p}", which does not exist`);
                } else if (list === 'sources' && statSync(full).isFile()) {
                    total += statSync(full).size;
                }
            }
        }
        if (total >= MAX_SOURCES_BYTES) {
            report(GOVERNANCE, 1, 'governance-sources', `capability_manifest.sources total ${total} bytes — the always-loaded set must stay under ${MAX_SOURCES_BYTES}; move a file to on_demand`);
        }
    }
}

// ── Rule: node-pin-parity ────────────────────────────────────────────
// One Node pin, four readers: .nvmrc (setup-node in every workflow),
// .node-version (the other version managers), engines.node (npm) and the
// CI matrix, which deliberately spans versions but must include the pin.
{
    let pinnedMajor: number | null = null;
    if (!existsSync(resolve(ROOT, '.nvmrc'))) {
        report('.nvmrc', 1, 'node-pin-parity', 'missing — every workflow reads its Node version from it');
    } else {
        const raw = read('.nvmrc').trim();
        const m = /^v?(\d+)/.exec(raw);
        if (!m) report('.nvmrc', 1, 'node-pin-parity', `"${raw}" is not a Node version`);
        else pinnedMajor = Number(m[1]);
    }
    const pkgJson = JSON.parse(read('package.json')) as { engines?: { node?: string }; packageManager?: string };
    const enginesMajor = /(\d+)/.exec(pkgJson.engines?.node ?? '')?.[1];
    if (enginesMajor === undefined) {
        report('package.json', 1, 'node-pin-parity', 'engines.node is missing or names no major version');
    } else if (pinnedMajor !== null && Number(enginesMajor) !== pinnedMajor) {
        report('package.json', 1, 'node-pin-parity', `engines.node "${pkgJson.engines?.node ?? ''}" but .nvmrc pins ${pinnedMajor} — the two majors must agree`);
    }
    if (typeof pkgJson.packageManager !== 'string' || !pkgJson.packageManager.startsWith('npm@')) {
        report('package.json', 1, 'node-pin-parity', `packageManager must be present and start with "npm@" (found ${JSON.stringify(pkgJson.packageManager ?? null)})`);
    }
    let ciMatrix: number[] = [];
    for (const name of readdirSync(resolve(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f))) {
        const relPath = `.github/workflows/${name}`;
        const text = read(relPath);
        const uses = [...text.matchAll(/uses:\s*actions\/setup-node@/g)];
        if (uses.length === 0) continue;
        const withFile = [...text.matchAll(/node-version-file:\s*\.nvmrc\b/g)].length;
        if (withFile >= uses.length) continue;
        const matrix = /node-version:\s*\$\{\{\s*matrix\.node-version\s*\}\}/.test(text) && /node-version:\s*\[([^\]]*)\]/.exec(text);
        if (name === 'ci.yml' && matrix) {
            ciMatrix = matrix[1].split(',').map((s) => Number(s.trim().replace(/['"]/g, ''))).filter((n) => Number.isFinite(n));
            if (pinnedMajor !== null && !ciMatrix.includes(pinnedMajor)) {
                report(relPath, lineOf(text, matrix.index), 'node-pin-parity', `matrix [${matrix[1].trim()}] does not include the .nvmrc major ${pinnedMajor}`);
            }
            continue;
        }
        report(relPath, lineOf(text, uses[0].index), 'node-pin-parity', 'actions/setup-node must read `node-version-file: .nvmrc` (only ci.yml may span a matrix)');
    }
    const nodeVersion = existsSync(resolve(ROOT, '.node-version')) ? read('.node-version') : null;
    for (const f of checkNodeVersionPin({ nodeVersion, enginesNode: pkgJson.engines?.node ?? null, ciMatrix })) {
        report(f.file, f.line, 'node-pin-parity', f.message, f.severity === 'error' ? 'error' : 'warn');
    }
}

// ── Rule: ruleset-parity ─────────────────────────────────────────────
// .github/rulesets/main.json is the committed copy of the branch
// protection; its required status checks are matched by NAME against the
// jobs the workflows define. A context naming no job blocks every PR, or
// the committed copy lies. sample-regression must be required.
{
    const RULESET = '.github/rulesets/main.json';
    if (existsSync(resolve(ROOT, RULESET))) {
        let ruleset: { rules?: Array<{ type?: string; parameters?: { required_status_checks?: Array<{ context?: string }>; allowed_merge_methods?: unknown } }> } = {};
        let parsed = true;
        try {
            ruleset = JSON.parse(read(RULESET)) as typeof ruleset;
        } catch (err) {
            parsed = false;
            report(RULESET, 1, 'ruleset-parity', `not valid JSON — ${(err as Error).message}`);
        }
        if (parsed) {
            const jobs = new Set<string>();
            const matrixValues = new Map<string, Set<string>>();
            for (const name of readdirSync(resolve(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f))) {
                let inJobs = false;
                let current: string | null = null;
                for (const line of read(`.github/workflows/${name}`).split('\n')) {
                    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
                    if (!inJobs) continue;
                    if (/^\S/.test(line)) { inJobs = false; continue; }
                    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
                    if (id) {
                        current = id[1];
                        jobs.add(current);
                        matrixValues.set(current, new Set());
                        continue;
                    }
                    if (current === null) continue;
                    const jobName = /^ {4}name:\s*(.+?)\s*$/.exec(line);
                    if (jobName) jobs.add(jobName[1].replace(/^["']|["']$/g, ''));
                    const list = /^ {8}[A-Za-z0-9_-]+:\s*\[([^\]]*)\]\s*$/.exec(line);
                    if (list) for (const v of list[1].split(',')) matrixValues.get(current)?.add(v.trim().replace(/['"]/g, ''));
                }
            }
            const contexts: string[] = [];
            for (const rule of ruleset.rules ?? []) {
                if (rule.type !== 'required_status_checks') continue;
                for (const check of rule.parameters?.required_status_checks ?? []) {
                    if (typeof check.context === 'string') contexts.push(check.context);
                }
            }
            for (const context of contexts) {
                if (jobs.has(context)) continue;
                const m = /^(.+?)\s*\((.+)\)$/.exec(context);
                if (m && jobs.has(m[1]) && m[2].split(',').every((v) => matrixValues.get(m[1])?.has(v.trim()))) continue;
                report(RULESET, 1, 'ruleset-parity', `required status check "${context}" names no job in .github/workflows/ — every PR to main would block on it`);
            }
            if (!contexts.includes('sample-regression')) {
                report(RULESET, 1, 'ruleset-parity', '"sample-regression" is not a required status check — the byte baseline must block merges');
            }
            if (!contexts.includes('compat-previous')) {
                report(RULESET, 1, 'ruleset-parity', '"compat-previous" is not a required status check — the previous release\'s suite must block merges');
            }
            // CONTRIBUTING § Release says squash-merge: the committed ruleset must say the same.
            const methods = (ruleset.rules ?? []).find((r) => r.type === 'pull_request')?.parameters?.allowed_merge_methods;
            if (!Array.isArray(methods) || methods.length !== 1 || methods[0] !== 'squash') {
                report(RULESET, 1, 'ruleset-parity', `allowed_merge_methods must be ["squash"] (got ${JSON.stringify(methods ?? null)}) — CONTRIBUTING promises a linear squash history`);
            }
        }
    }
    const tags = existsSync(resolve(ROOT, '.github/rulesets/tags.json')) ? read('.github/rulesets/tags.json') : null;
    for (const f of checkTagRuleset(tags)) report(f.file, f.line, 'ruleset-parity', f.message, f.severity === 'error' ? 'error' : 'warn');
}

// ── Rules: agent-config-parity, claude-rules-sync, claude-rules-budget,
//           pr-template-parity, eol-lf, skills-shape ─────────────────────
// The Claude Code configuration is a second copy of the governance policy:
// the "Never Read" bullet of CLAUDE.md and the deny list of settings.json,
// the HITL commands and the guard hook, the instruction files and the
// rules generated from them, the skills and the templates they hand to
// agents. Each pair drifts silently. The checks are pure functions in
// scripts/lib/agent-config.ts; this block only reads files and spawns
// `node --check` and `git ls-files --eol`.
{
    const relay = (findings: readonly Finding[], rule: string): void => {
        for (const f of findings) report(f.file, f.line, rule, f.message, f.severity === 'error' ? 'error' : 'warn');
    };
    const readOr = (p: string): string | null => (existsSync(resolve(ROOT, p)) ? read(p) : null);
    const claudeMd = readOr('CLAUDE.md') ?? '';

    const hookPath = resolve(ROOT, '.claude/hooks/guard.mjs');
    const hookExists = existsSync(hookPath);
    const hookCheck = hookExists ? spawnSync(process.execPath, ['--check', hookPath], { encoding: 'utf8', windowsHide: true }) : null;
    relay(checkAgentConfigParity({
        settingsText: readOr('.claude/settings.json'),
        claudeMd,
        hook: { exists: hookExists, checkStatus: hookCheck?.status ?? null, checkStderr: hookCheck?.stderr ?? '' },
    }), 'agent-config-parity');

    const diff = diffClaudeRules(ROOT);
    for (const bad of diff.invalid) report(`${INSTRUCTIONS_DIR}/${bad.source}`, 1, 'claude-rules-sync', `${bad.error} — the generator refuses it`);
    for (const f of diff.missing) report(`${RULES_DIR}/${f}`, 1, 'claude-rules-sync', 'missing — run `npm run agents:rules`');
    for (const f of diff.stale) report(`${RULES_DIR}/${f}`, 1, 'claude-rules-sync', 'differs from its instruction file — edit the .github/instructions/ source, then run `npm run agents:rules`');
    for (const f of diff.extra) report(`${RULES_DIR}/${f}`, 1, 'claude-rules-sync', 'has no instruction source — delete it, or add the .github/instructions/<area>.instructions.md it should come from');

    relay(checkClaudeRulesBudget({ claudeMd, resolveImport: (name) => readOr(name), rules: readRuleFiles(ROOT) }), 'claude-rules-budget');

    relay(checkPrTemplateParity(readOr('.github/PULL_REQUEST_TEMPLATE.md') ?? readOr('.github/pull_request_template.md'), readOr('CONTRIBUTING.md') ?? ''), 'pr-template-parity');

    const gitOut = (...gitArgs: string[]): string | null => {
        const r = spawnSync('git', ['-C', ROOT, ...gitArgs], { encoding: 'utf8', windowsHide: true });
        return r.status === 0 ? r.stdout : null;
    };
    const top = gitOut('rev-parse', '--show-toplevel')?.trim().replace(/\\/g, '/');
    if (top !== undefined && top === ROOT.replace(/\\/g, '/')) {
        relay(checkEol(gitOut('ls-files', '--eol') ?? ''), 'eol-lf');
    }

    const skillsDir = resolve(ROOT, '.claude/skills');
    if (existsSync(skillsDir)) {
        for (const dir of readdirSync(skillsDir).sort()) {
            if (!statSync(join(skillsDir, dir)).isDirectory()) continue;
            relay(checkSkillShape({
                dir,
                text: readOr(`.claude/skills/${dir}/SKILL.md`),
                existsInSkill: (name) => existsSync(join(skillsDir, dir, name)),
                existsInRepo: (p) => existsSync(resolve(ROOT, p)),
            }), 'skills-shape');
        }
    }
}

// ── Rule: sitemap-lastmod-vs-git ─────────────────────────────────────
// sitemap-parity bounds lastmod by verifiedOn but cannot see a page edited
// AFTER its lastmod was written. Where git history is available (a full
// local clone — the maintainer's gate, not CI's shallow checkout, where a
// grafted HEAD would date every file today), each <url>'s lastmod must be
// on or after the last commit touching any of its source files.
if (verifiedOn !== null) {
    const git = (...gitArgs: string[]): string | null => {
        const r = spawnSync('git', ['-C', ROOT, ...gitArgs], { encoding: 'utf8', windowsHide: true });
        return r.status === 0 ? r.stdout : null;
    };
    const toplevel = git('rev-parse', '--show-toplevel')?.trim().replace(/\\/g, '/');
    const shallow = git('rev-parse', '--is-shallow-repository')?.trim();
    if (toplevel !== undefined && toplevel === ROOT.replace(/\\/g, '/') && shallow === 'false') {
        const xml = read('docs/sitemap.xml');
        const tracked = new Set((git('ls-files', '--', 'docs') ?? '').split(/\r?\n/).filter(Boolean));
        const lastCommit = new Map<string, string>();
        let date = '';
        for (const raw of (git('log', '--format=%x01%cs', '--name-only', '--', 'docs') ?? '').split(/\r?\n/)) {
            if (raw.startsWith('\u0001')) { date = raw.slice(1).trim(); continue; }
            const file = raw.trim();
            if (file && !lastCommit.has(file)) lastCommit.set(file, date);
        }
        const sourcesOf = (loc: string): string[] => {
            let path = loc.replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '');
            if (path === '' || path.endsWith('/')) path += 'index.html';
            const out = [`docs/${path}`];
            const guide = /^guides\/([^/]+)\.html$/.exec(path);
            if (guide && guide[1] !== 'index') out.push(`docs/guides/${guide[1]}.md`);
            return out;
        };
        for (const urlBlock of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
            const loc = /<loc>\s*([^<]+?)\s*<\/loc>/.exec(urlBlock[1])?.[1];
            const lastmod = /<lastmod>\s*(\d{4}-\d{2}-\d{2})\s*<\/lastmod>/.exec(urlBlock[1])?.[1];
            if (!loc || !lastmod) continue;
            const line = lineOf(xml, urlBlock.index);
            for (const src of sourcesOf(loc)) {
                if (!tracked.has(src)) continue;
                const committed = lastCommit.get(src);
                if (committed !== undefined && committed > lastmod) {
                    report('docs/sitemap.xml', line, 'sitemap-lastmod-vs-git', `${loc} lastmod ${lastmod} but ${src} was last committed ${committed} — re-audit the page and set lastmod to ${committed} (bounded by verifiedOn ${verifiedOn})`);
                }
            }
        }
    }
}

// ── Rule: bench-parity ───────────────────────────────────────────────
// The homepage benchmark bars and bench/RESULTS.md are two statements of
// the same measurement. RESULTS.md is the source: each homepage
// .bench-value must equal the figure recorded there for the library its
// .bench-label names, in the scenario its group title names — an op/s
// figure within 10 %, a "N× slower" ratio within 10 %, "fastest" verbatim.
if (existsSync(resolve(ROOT, 'bench/RESULTS.md'))) {
    const md = read('bench/RESULTS.md');
    const scenarioOf = (title: string): string | null =>
        /create/i.test(title) ? 'create' : /inventory/i.test(title) ? 'inventory' : /random access/i.test(title) ? 'random' : null;
    const recorded = new Map<string, { kind: 'ops' | 'ratio' | 'fastest'; value: number }>();
    let scenario: string | null = null;
    for (const line of md.split('\n')) {
        if (line.startsWith('### ')) { scenario = scenarioOf(line); continue; }
        if (scenario === null) continue;
        const row = /^\|\s*([a-z][a-z-]*)[^|]*\|(.*)\|\s*$/.exec(line);
        if (!row || row[1] === 'library') continue;
        const cells = row[2].split('|').map((c) => c.trim());
        const first = cells[0] ?? '';
        const entry = /^\*{0,2}fastest\*{0,2}$/i.test(first) ? { kind: 'fastest' as const, value: 0 }
            : /^([\d.]+)×/.test(first) ? { kind: 'ratio' as const, value: parseFloat(first) }
                : /^[\d.]+$/.test(first) ? { kind: 'ops' as const, value: parseFloat(first) }
                    : null;
        if (entry !== null) recorded.set(`${scenario}|${row[1]}`, entry);
    }
    const html = read('docs/index.html');
    const groups = [...html.matchAll(/<div class="bench-group-title">([^<]+)<\/div>([\s\S]*?)(?=<div class="bench-group-title">|<\/div>\s*<p class="bench-note">)/g)];
    let checked = 0;
    for (const group of groups) {
        const key = scenarioOf(group[1]);
        const groupLine = lineOf(html, group.index);
        if (key === null) { report('docs/index.html', groupLine, 'bench-parity', `group "${group[1].trim()}" names no scenario of bench/RESULTS.md`); continue; }
        for (const row of group[2].matchAll(/<div class="bench-label">([^<]+)<\/div>[\s\S]*?<div class="bench-value">([^<]+)<\/div>/g)) {
            const lib = row[1].trim().toLowerCase();
            const shown = row[2].trim();
            const line = lineOf(html, group.index + (row.index ?? 0));
            const want = recorded.get(`${key}|${lib}`);
            if (want === undefined) { report('docs/index.html', line, 'bench-parity', `no row for "${row[1].trim()}" under the ${key} scenario in bench/RESULTS.md`); continue; }
            checked++;
            const num = parseFloat(shown);
            const ok = want.kind === 'fastest' ? /^fastest$/i.test(shown)
                : Number.isFinite(num) && Math.abs(num - want.value) / want.value <= 0.1
                    && (want.kind === 'ops' ? /op\/s/.test(shown) : /×/.test(shown));
            if (!ok) report('docs/index.html', line, 'bench-parity', `"${row[1].trim()}" shows "${shown}" but bench/RESULTS.md records ${want.kind === 'fastest' ? 'fastest' : want.kind === 'ops' ? `${want.value} op/s` : `${want.value}× slower`}`);
        }
    }
    if (checked === 0 && recorded.size > 0) report('docs/index.html', 1, 'bench-parity', 'no .bench-value rows matched — has the markup changed?');
}

// ── Rule: no-control-bytes ───────────────────────────────────────────
// A NUL byte in a tracked text file makes git treat the file as binary:
// no diff in a pull request, no blame, no merge. One slipped into
// scripts/build-api-json.ts in 1.1.0 (a template literal holding U+0000)
// and reviewers saw "Binary file changed" for a release-critical script.
{
    const corpus = [
        ...walk('src').filter((p) => /\.(ts|mts|cts|js|mjs|cjs|json|md)$/.test(p)),
        ...walk('scripts').filter((p) => /\.(ts|mts|cts|js|mjs|cjs|json|md)$/.test(p)),
        ...walk('tests').filter((p) => /\.(ts|mts|cts|js|mjs|cjs|json|md)$/.test(p) && !p.includes('/fixtures/')),
        ...walk('docs').filter((p) => /\.(md|txt|html|js|json|xml|svg|css)$/.test(p) && !p.endsWith('llms-full.txt')),
        ...walk('recipes').filter((p) => p.endsWith('.ts')),
        ...walk('.github').filter((p) => /\.(yml|yaml|md|json)$/.test(p)),
        ...['README.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'AGENTS.md', 'CLAUDE.md', 'ROADMAP.md', 'SUPPORT.md', 'CODE_OF_CONDUCT.md', 'llms.txt', 'package.json']
            .filter((p) => existsSync(resolve(ROOT, p))),
    ];
    for (const file of corpus) {
        const bytes = readFileSync(resolve(ROOT, file));
        const at = bytes.indexOf(0);
        if (at >= 0) {
            const line = bytes.subarray(0, at).toString('utf8').split('\n').length;
            report(file, line, 'no-control-bytes', 'contains a NUL byte (U+0000) — git treats the file as binary; write it as the \\u0000 escape');
        }
    }
}

// ── Rule: playground-syntax ──────────────────────────────────────────
// Every playground page carries its logic in an inline module script that
// nothing compiles: a syntax error ships a dead page that looks fine in a
// diff. node --check parses each extracted module (pdfnative rule, ported).
{
    const tmp = mkdtempSync(join(tmpdir(), 'zipnative-playground-'));
    try {
        for (const page of walk('docs/playgrounds').filter((p) => p.endsWith('.html'))) {
            const html = read(page);
            let n = 0;
            for (const m of html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)) {
                n++;
                const file = join(tmp, `${page.split('/').pop()?.replace(/\.html$/, '') ?? 'page'}-${n}.mjs`);
                writeFileSync(file, m[1]);
                const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
                if (r.status !== 0) {
                    const detail = (r.stderr ?? '').split('\n').find((l) => /SyntaxError|Error/.test(l)) ?? 'node --check failed';
                    report(page, lineOf(html, m.index ?? 0), 'playground-syntax', `inline module script ${n} does not parse — ${detail.trim()}`);
                }
            }
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

// ── Rule: export-named ───────────────────────────────────────────────
// llms.txt is the one document an agent is sure to read: every public
// export must be named there at least once. The 1.1.0 audit found 66 of
// 104 names absent — option types, constants, the codec tiers.
{
    const names = new Set((JSON.parse(read('docs/assets/api.json')) as { exports?: ReadonlyArray<{ name?: string }> }).exports?.map((e) => e.name ?? '') ?? []);
    const llms = read('llms.txt');
    const missing = [...names].filter((n) => n !== '' && !new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(llms)).sort();
    for (const n of missing) report('llms.txt', 1, 'export-named', `export ${n} is named nowhere in llms.txt — add it to the section of the surface it belongs to`);
}

// ── Rule: limits-table ───────────────────────────────────────────────
// src/core/zip-limits.ts promises its table is mirrored in SECURITY.md;
// every key of DEFAULT_ZIP_LIMITS must be a row of the limits table in
// SECURITY.md and in the security guide, with the default beside it.
{
    const source = read('src/core/zip-limits.ts');
    const block = /export const DEFAULT_ZIP_LIMITS[^{]*\{([\s\S]*?)\n\};/.exec(source)?.[1] ?? '';
    const keys = [...block.matchAll(/^\s*([A-Za-z]+):/gm)].map((m) => m[1]);
    if (keys.length === 0) report('src/core/zip-limits.ts', 1, 'limits-table', 'DEFAULT_ZIP_LIMITS not found');
    for (const file of ['SECURITY.md', 'docs/guides/security.md']) {
        const text = read(file);
        for (const key of keys) {
            if (!new RegExp(`^\\| \`${key}\` \\|`, 'm').test(text)) {
                report(file, 1, 'limits-table', `no table row for the limit \`${key}\` — every ZipLimits key is documented with its default and CWE in both tables`);
            }
        }
    }
}

// ── Rule: since-tags ─────────────────────────────────────────────────
// Every export added after the previous release carries an @since tag in
// the TSDoc block above its declaration — the only machine-checkable
// record of which release a symbol needs (api.json carries the summary).
{
    const previous = existsSync(resolve(ROOT, 'tests/compat'))
        ? readdirSync(resolve(ROOT, 'tests/compat')).filter((f) => /^api-\d+\.\d+\.\d+\.json$/.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop()
        : undefined;
    if (previous !== undefined) {
        const old = new Set((JSON.parse(read(`tests/compat/${previous}`)) as { exports: ReadonlyArray<{ name: string; subpath: string }> }).exports.map((e) => `${e.subpath}:${e.name}`));
        const current = (JSON.parse(read('docs/assets/api.json')) as { exports: ReadonlyArray<{ name: string; subpath: string; module: string }> }).exports;
        for (const e of current) {
            if (old.has(`${e.subpath}:${e.name}`) || old.has(`.:${e.name}`)) continue;
            const text = read(e.module);
            const decl = new RegExp(`^export\\s+(?:declare\\s+)?(?:async\\s+)?(?:interface|type|function|const|class)\\s+${e.name}\\b`, 'm').exec(text);
            if (decl === null) continue; // re-exported under another declaration shape; api-json-sync covers existence
            const before = text.slice(0, decl.index);
            const doc = /\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*$/.exec(before);
            if (doc === null || !/@since\s+\d+\.\d+\.\d+/.test(doc[1])) {
                report(e.module, lineOf(text, decl.index), 'since-tags', `${e.name} was added after ${previous.replace(/^api-|\.json$/g, '')} but its TSDoc carries no @since tag`);
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
                    `npm latest ${latest.version} vs tree ${pkg.version} (expected only during a release window)`, 'warn');
            }
        }
    } catch {
        report('package.json', 3, 'npm-drift', 'could not reach the npm registry', 'warn');
    }
}

// ── Output ───────────────────────────────────────────────────────────
for (const p of [...problems]) {
    if (!RULE_NAMES.has(p.rule)) {
        report('scripts/verify-docs.ts', 1, 'rules-list', `rule "${p.rule}" reported a finding but is not catalogued in RULES — add it so derived.verifyDocsRules and --rules stay true`);
    }
}
const errors = problems.filter((p) => p.level === 'error' || (strict && p.level === 'warn'));
const warnings = problems.filter((p) => p.level === 'warn' && !strict);
if (asJson) {
    console.error(JSON.stringify({ ok: errors.length === 0, problems }, null, 2));
} else {
    for (const p of [...errors, ...warnings]) {
        console.error(`${p.path}:${p.line} [${p.rule}] ${p.level === 'warn' ? '(warn) ' : ''}${p.message}`);
    }
}
if (errors.length > 0) {
    console.error(`\nverify-docs: ${errors.length} problem(s) — fix the docs, or update docs/assets/ecosystem.json if the manifest is what is wrong.`);
    process.exit(1);
}
console.error(`verify-docs: OK (${warnings.length} warning(s))`);
