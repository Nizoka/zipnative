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
interface Ecosystem {
    packages: Record<string, { version: string | null }>;
    verifiedOn?: string;
    site?: string;
    derived?: { sampleZips?: number };
}
const ecosystem = JSON.parse(read('docs/assets/ecosystem.json')) as Ecosystem;
const truthVersion = ecosystem.packages['zipnative']?.version ?? null;
const verifiedOn = ecosystem.verifiedOn ?? null;
const site = ecosystem.site ?? null;
const pkg = JSON.parse(read('package.json')) as { version: string; name: string };

// ── Rule: manifest-shape ─────────────────────────────────────────────
if (typeof truthVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(truthVersion)) {
    report('docs/assets/ecosystem.json', 1, 'manifest-shape', 'packages.zipnative.version must be a semver triple');
}
if (verifiedOn === null || !/^\d{4}-\d{2}-\d{2}$/.test(verifiedOn)) {
    report('docs/assets/ecosystem.json', 1, 'manifest-shape', 'verifiedOn must be an ISO date (documentation-audit date)');
}
if (ecosystem.derived !== undefined) {
    for (const key of Object.keys(ecosystem.derived)) {
        if (key !== 'sampleZips') {
            report('docs/assets/ecosystem.json', 1, 'manifest-shape',
                `unknown derived.${key} — a typo here silently disables its counter`);
        }
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

// ── Rule: playground-bundle ──────────────────────────────────────────
// The playgrounds run a committed copy of the engine's own dist bundle.
// It must match dist/index.js byte-for-byte (minus the sourceMappingURL
// line dropped by `docs:playground`) and carry the manifest version, or
// the playgrounds silently run stale code. dist/ is gitignored, so this
// only checks when a build is present (CI builds before verifying).
{
    const bundlePath = 'docs/playgrounds/zipnative.js';
    if (existsSync(resolve(ROOT, bundlePath))) {
        const committed = read(bundlePath);
        const versionMatch = committed.match(/VERSION = "([^"]+)"/);
        if (versionMatch === null || versionMatch[1] !== pkg.version) {
            report(bundlePath, 1, 'playground-bundle',
                `bundle VERSION ${versionMatch?.[1] ?? '(missing)'} != package.json ${pkg.version} — run \`npm run docs:playground\``);
        }
        if (existsSync(resolve(ROOT, 'dist/index.js'))) {
            const dist = read('dist/index.js').split('\n').filter((l) => !l.startsWith('//# sourceMappingURL=')).join('\n');
            if (dist !== committed) {
                report(bundlePath, 1, 'playground-bundle', 'differs from dist/index.js — run `npm run docs:playground`');
            }
        }
        // The CDN loader's version pin must track the manifest too.
        const loaderPath = 'docs/playgrounds/load-engine.js';
        if (existsSync(resolve(ROOT, loaderPath))) {
            const pin = read(loaderPath).match(/const VERSION = '([^']+)';/);
            if (pin === null || pin[1] !== pkg.version) {
                report(loaderPath, 1, 'playground-bundle',
                    `CDN pin ${pin?.[1] ?? '(missing)'} != package.json ${pkg.version} — run \`npm run docs:playground\``);
            }
        }
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
        for (const node of parsed['@graph'] ?? []) {
            const id = typeof node['@id'] === 'string' ? node['@id'] : '';
            if (id.endsWith('#library') && node['softwareVersion'] !== truthVersion) {
                report(page, lineOf(html, m.index ?? 0), 'jsonld-version',
                    `#library softwareVersion ${String(node['softwareVersion'])} != manifest ${String(truthVersion)}`);
            }
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
