/**
 * zipnative — documentation integrity verifier (`npm run verify:docs`)
 * ====================================================================
 * Named-rule checks that keep every version, count, artefact and page in
 * the tree consistent with the single source of truth
 * (docs/assets/ecosystem.json). Read-only; safe on a dirty tree.
 * Exit 1 with `path:line [rule] message` diagnostics on failure.
 *
 * Flags: --online (npm-registry drift), --strict (warnings → errors),
 *        --json (machine-readable report)
 *
 * Suppress one finding with a `verify-docs:allow <rule>` marker on the
 * offending line or the line above it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { buildApiJson } from './build-api-json.ts';
import { buildLlmsFull, buildLlmsIndex, buildLlmsRecipes } from './build-llms-full.ts';

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
    derived?: { sampleZips?: number };
}
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
        if (key !== 'sampleZips') {
            report(MANIFEST, 1, 'manifest-shape',
                `unknown derived.${key} — a typo here silently disables its counter`);
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
    interface Surfaces { verifiedOn?: string; capabilities?: ReadonlyArray<{ id?: string; label?: string; library?: Cell; cli?: Cell; mcp?: Cell }> }
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
                        const readerMethods = ['entries', 'readEntry', 'readEntryStream', 'readEntryRaw', 'verifyEntry', 'addStream', 'stream', 'save', 'saveCompact', 'add', 'addDirectory'];
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

// ── Rule: switcher-parity ────────────────────────────────────────────
// Every playground page carries the same switcher: every playground
// linked, the current page marked aria-current, and no entry pointing to
// a page that does not exist (pdfnative rule, ported).
{
    const pages = walk('docs/playgrounds').filter((p) => p.endsWith('.html') && !p.endsWith('/index.html'));
    const expected = new Set(pages.map((p) => './' + p.split('/').pop()));
    for (const page of pages) {
        const html = read(page);
        const nav = html.match(/<nav class="playground-switcher"[\s\S]*?<\/nav>/);
        if (nav === null) { report(page, 1, 'switcher-parity', 'missing the playground switcher'); continue; }
        const links = [...nav[0].matchAll(/<a href="(\.\/[^"]+\.html)"([^>]*)>/g)];
        const found = new Set(links.map((m) => m[1]));
        for (const e of expected) if (!found.has(e)) report(page, lineOf(html, nav.index ?? 0), 'switcher-parity', `switcher lacks ${e}`);
        for (const f of found) if (!expected.has(f)) report(page, lineOf(html, nav.index ?? 0), 'switcher-parity', `switcher links to a page that does not exist: ${f}`);
        const self = './' + page.split('/').pop();
        const current = links.find((m) => m[2].includes('aria-current="page"'));
        if (current === undefined || current[1] !== self) report(page, lineOf(html, nav.index ?? 0), 'switcher-parity', `aria-current must mark ${self}`);
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
        for (const node of nodes) {
            checkVersion(node);
            const about = node['about'];
            if (about !== null && typeof about === 'object') checkVersion(about as Record<string, unknown>);
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
        const onDisk = walk('test-output').filter((p) => p.endsWith('.zip')).length;
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
