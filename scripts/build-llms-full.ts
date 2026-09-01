/**
 * zipnative — LLM documentation artefacts (`npm run docs:llms`)
 * =============================================================
 * Emits, in this order (the index reports the others' sizes):
 *   docs/llms.txt         — byte-copy of the root llms.txt (the site is
 *                           served from docs/, so the root file 404s there)
 *   docs/llms-full.txt    — llms.txt + README + every docs/guides/*.md,
 *                           alphabetical, with <!-- source: --> separators
 *   docs/llms-recipes.txt — every recipes/*.ts fenced as ```ts
 *   docs/llms-index.json  — artefact + guide index with sizes and anchors
 *
 * Deterministic: LF-normalised content, sorted inputs — verify-docs
 * rebuilds each artefact in memory and byte-compares.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SUMMARY_MAX = 400;

const lf = (text: string): string => Buffer.isBuffer(text) ? String(text) : text.replace(/\r\n/g, '\n');
const readLf = (path: string): string => lf(readFileSync(path, 'utf8'));

/** GitHub-style heading slugs — ONE implementation, imported everywhere. */
export function slugify(heading: string): string {
    return heading
        .toLowerCase()
        .replace(/`/g, '')
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s/g, '-');
}

export function buildLlmsFull(root: string): string {
    const parts: string[] = [readLf(resolve(root, 'llms.txt')).trim()];
    const sources: Array<[string, string]> = [['README.md', resolve(root, 'README.md')]];
    const guidesDir = resolve(root, 'docs/guides');
    for (const name of readdirSync(guidesDir).filter((f) => f.endsWith('.md')).sort()) {
        sources.push([`docs/guides/${name}`, resolve(guidesDir, name)]);
    }
    for (const [label, path] of sources) {
        parts.push(`\n\n---\n<!-- source: ${label} -->\n\n${readLf(path).trim()}`);
    }
    return `${parts.join('')}\n`;
}

export function buildLlmsRecipes(root: string): string {
    const header = '# zipnative — executable recipes\n\n'
        + 'Each file below is CI-executed against the current tree; the expectations\n'
        + 'declared in recipes/index.json are asserted on every run — these samples\n'
        + 'cannot silently rot.\n';
    const parts: string[] = [header];
    const recipesDir = resolve(root, 'recipes');
    for (const name of readdirSync(recipesDir).filter((f) => f.endsWith('.ts')).sort()) {
        parts.push(`\n---\n<!-- source: recipes/${name} -->\n\n\`\`\`ts\n${readLf(resolve(recipesDir, name)).trim()}\n\`\`\`\n`);
    }
    return parts.join('');
}

interface GuideIndexEntry {
    readonly title: string;
    readonly summary: string;
    readonly html: string;
    readonly markdown: string;
    readonly anchors: readonly string[];
    readonly bytes: number;
    readonly approxTokens: number;
}

function truncateSummary(text: string): string {
    if (text.length <= SUMMARY_MAX) return text;
    const window = text.slice(0, SUMMARY_MAX);
    const lastSentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
    if (lastSentence > SUMMARY_MAX * 0.6) return window.slice(0, lastSentence + 1);
    const lastSpace = window.lastIndexOf(' ');
    return `${window.slice(0, lastSpace > 0 ? lastSpace : SUMMARY_MAX)}…`;
}

function guideEntry(root: string, name: string): GuideIndexEntry {
    const md = readLf(resolve(root, 'docs/guides', name));
    const lines = md.split('\n');
    const h1Index = lines.findIndex((line) => line.startsWith('# '));
    const title = h1Index >= 0 ? lines[h1Index].slice(2).replace(/`/g, '').trim() : name;

    // Summary = the lede blockquote ANCHORED on the H1 (a mid-document
    // callout must never become the page summary); fallback: first prose
    // paragraph outside a code fence.
    let summary = '';
    for (let i = h1Index + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') {
            if (summary !== '') break;
            continue;
        }
        if (line.startsWith('> ')) {
            summary += (summary === '' ? '' : ' ') + line.slice(2).trim();
        } else if (summary !== '') {
            break;
        } else {
            break; // first non-blank isn't a blockquote → use the fallback
        }
    }
    if (summary === '') {
        let inFence = false;
        for (let i = h1Index + 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('```')) { inFence = !inFence; continue; }
            if (inFence || line === '' || line.startsWith('#') || line.startsWith('>') || line.startsWith('|')) continue;
            summary = line;
            break;
        }
    }
    summary = truncateSummary(
        summary.replace(/\*\*/g, '').replace(/_([^_]+)_/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim());

    const anchors = lines
        .filter((line) => line.startsWith('## '))
        .map((line) => slugify(line.slice(3).trim()));

    const bytes = Buffer.byteLength(md, 'utf8'); // LF-normalised, not statSync
    return {
        title,
        summary,
        html: `guides/${name.replace(/\.md$/, '.html')}`,
        markdown: `guides/${name}`,
        anchors,
        bytes,
        approxTokens: Math.round(bytes / 4),
    };
}

export function buildLlmsIndex(root: string): string {
    const artefactSources: Array<[string, string, string]> = [
        ['llms.txt', 'llms.txt', 'Machine-readable documentation index (the entry point).'],
        ['llms-full.txt', 'docs/llms-full.txt', 'Concatenated documentation: llms.txt + README + every guide.'],
        ['llms-recipes.txt', 'docs/llms-recipes.txt', 'Every executable recipe, fenced as TypeScript.'],
        ['assets/api.json', 'docs/assets/api.json', 'The mechanically extracted export surface — the API ground truth.'],
        ['assets/ecosystem.json', 'docs/assets/ecosystem.json', 'Versions, counts and milestones — the single source of truth.'],
    ];
    const artefacts = artefactSources.map(([url, path, description]) => {
        const bytes = Buffer.byteLength(readLf(resolve(root, path)), 'utf8');
        return { url, description, bytes, approxTokens: Math.round(bytes / 4) };
    });
    const guides = readdirSync(resolve(root, 'docs/guides'))
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((name) => guideEntry(root, name));

    return `${JSON.stringify({
        $comment: 'Index of zipnative’s machine-readable artefacts and guides, with LF-normalised sizes. '
            + 'Regenerate with `npm run docs:llms`; verify-docs llms-index-sync enforces freshness. '
            + 'approxTokens = bytes/4, approximate by construction.',
        site: 'https://zipnative.dev',
        verifiedOn: '2026-09-01',
        artefacts,
        guides,
    }, null, 2)}\n`;
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
    const root = resolve(import.meta.dirname, '..');
    // Order matters: the index reports the other artefacts' sizes.
    writeFileSync(resolve(root, 'docs/llms.txt'), readLf(resolve(root, 'llms.txt')));
    writeFileSync(resolve(root, 'docs/llms-full.txt'), buildLlmsFull(root));
    writeFileSync(resolve(root, 'docs/llms-recipes.txt'), buildLlmsRecipes(root));
    writeFileSync(resolve(root, 'docs/llms-index.json'), buildLlmsIndex(root));
    console.error('docs/llms.txt, llms-full.txt, llms-recipes.txt, llms-index.json written');
}
