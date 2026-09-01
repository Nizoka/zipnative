/**
 * zipnative — guide pre-renderer (`npm run docs:guides`)
 * ======================================================
 * Renders each docs/guides/<name>.md into the committed article of its
 * paired <name>.html shell, between guide:render markers. Rendering is
 * deterministic: marked@12.0.2 pinned as an EXACT devDependency, LF
 * endings, and a GitHub-style heading slugger implemented here
 * (marked ≥ 5 no longer emits heading ids itself). Content is
 * first-party Markdown reviewed in the repo, so no sanitiser runs.
 *
 * The pages are prerendered-only: no client-side markdown, no CDN
 * scripts — the strictly-more-zero-dependency variant of the pdfnative
 * pipeline. `applyGuideRender` is pure (returns the updated shell) so
 * verify-docs's guide-render-sync rule rebuilds in memory and
 * byte-compares.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { marked } from 'marked';

marked.use({ gfm: true, breaks: false });

function lf(text: string): string {
    return text.replace(/\r\n/g, '\n');
}

function decodeEntities(s: string): string {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function stripTags(html: string): string {
    return html.replace(/<[^>]+>/g, '');
}

/**
 * GitHub-style heading slugs. Convention decided BEFORE any anchors were
 * published and frozen since: strip punctuation, then EVERY whitespace
 * character becomes its own hyphen. Shared with build-llms-full.ts so
 * site anchors and llms-index anchors cannot drift.
 */
export function slugify(text: string): string {
    return decodeEntities(stripTags(text))
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-');
}

/**
 * Add `id` attributes and a visible anchor link to every h1–h4. marked
 * emits headings on a single line with no attributes, so a line-scoped
 * regex is reliable (generator output, not arbitrary HTML).
 */
function addHeadingAnchors(html: string): string {
    const seen = new Map<string, number>();
    return html.replace(/<h([1-4])>([\s\S]*?)<\/h\1>/g, (_m, level: string, inner: string) => {
        let slug = slugify(inner) || 'section';
        const n = seen.get(slug) ?? 0;
        seen.set(slug, n + 1);
        if (n > 0) slug = `${slug}-${n}`;
        const anchor = level === '1'
            ? ''
            : `<a class="heading-anchor" href="#${slug}" aria-label="Link to this section">#</a>`;
        return `<h${level} id="${slug}">${inner}${anchor}</h${level}>`;
    });
}

/** Open external links in a new tab. Matches marked's exact output shape. */
function externaliseLinks(html: string): string {
    return html.replace(/<a href="(https?:\/\/[^"]+)">/g, '<a href="$1" target="_blank" rel="noopener">');
}

/** Render one guide's Markdown into the article HTML committed in its shell. */
export function renderGuideArticle(root: string, mdName: string): string {
    const md = lf(readFileSync(join(root, 'docs', 'guides', mdName), 'utf8'));
    const html = marked.parse(md) as string;
    return externaliseLinks(addHeadingAnchors(html)).trimEnd() + '\n';
}

const ARTICLE_RE = /(<article id="guide-content"[^>]*>)([\s\S]*?)(<\/article>)/;

/** Return the fully updated shell for one guide (pure — the verifier reuses it). */
export function applyGuideRender(root: string, htmlName: string): string {
    const path = join(root, 'docs', 'guides', htmlName);
    let shell = lf(readFileSync(path, 'utf8'));

    const article = shell.match(ARTICLE_RE);
    if (article === null) return shell;
    const mdAttr = article[1].match(/data-md="([^"]+)"/);
    if (mdAttr === null) return shell;
    const mdName = mdAttr[1];
    if (!existsSync(join(root, 'docs', 'guides', mdName))) return shell;

    const rendered = renderGuideArticle(root, mdName);

    let openTag = article[1];
    if (!openTag.includes('data-prerendered')) {
        openTag = openTag.replace(/>$/, ' data-prerendered="true">');
    }
    // Function replacer: `$&`/`$'` in guide content must not corrupt output.
    shell = shell.replace(
        ARTICLE_RE,
        () => `${openTag}\n<!-- guide:render:start -->\n${rendered}<!-- guide:render:end -->\n  ${article[3]}`,
    );
    return shell;
}

/** All guide shells that pair with a Markdown source, alphabetical. */
export function listGuideShells(root: string): string[] {
    const dir = join(root, 'docs', 'guides');
    return readdirSync(dir)
        .filter((f) => f.endsWith('.html') && f !== 'index.html')
        .filter((f) => existsSync(join(dir, f.replace(/\.html$/, '.md'))))
        .sort();
}

// Exact-path check: a substring test would make any importer whose argv[1]
// merely contains "build-guides" rewrite the shells as an import side effect.
if (import.meta.filename === resolve(process.argv[1] ?? '')) {
    const root = resolve(import.meta.dirname, '..');
    let changed = 0;
    for (const htmlName of listGuideShells(root)) {
        const path = join(root, 'docs', 'guides', htmlName);
        const before = readFileSync(path, 'utf8');
        const after = applyGuideRender(root, htmlName);
        if (before !== after) {
            writeFileSync(path, after);
            changed++;
        }
    }
    console.error(`build-guides: ${changed} shell(s) updated, ${listGuideShells(root).length} total.`);
}
