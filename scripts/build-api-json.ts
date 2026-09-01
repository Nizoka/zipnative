/**
 * zipnative — mechanical API manifest (`npm run docs:api`)
 * ========================================================
 * Emits docs/assets/api.json by parsing the export statements of
 * src/index.ts — pure regex over source text, no compiler API, no build
 * required. dist/*.d.ts is gitignored, so without this artefact AI
 * agents have no ground truth for the export surface (the root condition
 * for hallucinated APIs).
 *
 * HONESTY RULE: fields that cannot be extracted mechanically are `null`,
 * never guessed. The signature is the declaration as written in source
 * (first line, normalised whitespace), not a reconstruction.
 *
 * Deterministic (LF-normalised, alphabetically sorted) so verify-docs's
 * api-json-sync rule can rebuild in memory and byte-compare.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ApiExport {
    readonly name: string;
    readonly kind: 'value' | 'type';
    readonly module: string;
    readonly signature: string | null;
    readonly summary: string | null;
}

export interface ApiManifest {
    readonly $comment: string;
    readonly package: string;
    readonly source: string;
    readonly exportCount: number;
    readonly exports: readonly ApiExport[];
}

const lf = (text: string): string => text.replace(/\r\n/g, '\n');

const moduleCache = new Map<string, string>();
function readModule(root: string, specifier: string): string {
    // './core/x.js' → 'src/core/x.ts'
    const path = resolve(root, 'src', specifier.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
    const cached = moduleCache.get(path);
    if (cached !== undefined) return cached;
    const text = existsSync(path) ? lf(readFileSync(path, 'utf8')) : '';
    moduleCache.set(path, text);
    return text;
}

function declarationOf(moduleText: string, name: string): string | null {
    const re = new RegExp(
        `export\\s+(?:async\\s+)?(?:function\\*?|const|let|class|type|interface|enum)\\s+${name}\\b[^\\n]*`);
    const m = moduleText.match(re);
    if (m === null) return null;
    let sig = m[0];
    // Extend a wrapped parameter list to its closing paren.
    if (sig.includes('(') && !sig.includes(')')) {
        const start = (m.index ?? 0) + sig.length;
        const rest = moduleText.slice(start, start + 2000);
        const close = rest.indexOf(')');
        if (close !== -1) sig += rest.slice(0, close + 1);
    }
    sig = sig.replace(/\s+/g, ' ').replace(/\s*\{\s*$/, '').trim();
    return sig.length > 300 ? `${sig.slice(0, 300)}…` : sig;
}

function docSummaryAbove(moduleText: string, name: string): string | null {
    const declRe = new RegExp(
        `export\\s+(?:async\\s+)?(?:function\\*?|const|let|class|type|interface|enum)\\s+${name}\\b`);
    const dm = moduleText.match(declRe);
    if (dm === null || dm.index === undefined) return null;
    const before = moduleText.slice(0, dm.index);
    // Tempered body — cannot cross a `*​/` — so this can only match the
    // block IMMEDIATELY above the declaration; a lazy [\s\S]*? would match
    // from the file banner and attribute it to every symbol.
    const m = before.match(/\/\*\*((?:[^*]|\*(?!\/))*)\*\/\s*$/);
    if (m === null) return null;
    const lines = m[1]
        .split('\n')
        .map((line) => line.replace(/^\s*\*? ?/, ''))
        .filter((line) => !line.startsWith('@') && !/^[=\-─═]{3,}/.test(line.trim()));
    const joined = lines.join(' ').replace(/\s+/g, ' ').trim();
    const sentence = joined.match(/^(.*?[.!?])(\s|$)/);
    let summary = (sentence !== null ? sentence[1] : joined).replace(/\{@link\s+([^}]+)\}/g, '$1').trim();
    if (summary.length === 0) return null;
    if (summary.length > 240) summary = `${summary.slice(0, 240)}…`;
    return summary;
}

export function buildApiJson(root: string): ApiManifest {
    const index = lf(readFileSync(resolve(root, 'src/index.ts'), 'utf8'));
    const seen = new Set<string>();
    const exports: ApiExport[] = [];

    const addExport = (name: string, kind: 'value' | 'type', modulePath: string, moduleText: string): void => {
        if (seen.has(name)) return;
        seen.add(name);
        exports.push({
            name,
            kind,
            module: modulePath,
            signature: declarationOf(moduleText, name),
            summary: docSummaryAbove(moduleText, name),
        });
    };

    // Pass A — re-export blocks.
    const RE_BLOCK = /export\s*(type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
    for (const m of index.matchAll(RE_BLOCK)) {
        const blockIsType = m[1] !== undefined;
        const specifier = m[3];
        const moduleText = readModule(root, specifier);
        const modulePath = `src/${specifier.replace(/^\.\//, '').replace(/\.js$/, '.ts')}`;
        for (const rawPiece of m[2].split(',')) {
            const piece = rawPiece.trim();
            if (piece.length === 0) continue;
            const isType = blockIsType || piece.startsWith('type ');
            const name = (piece.replace(/^type\s+/, '').split(/\s+as\s+/).pop() ?? '').trim();
            if (name.length === 0) continue;
            addExport(name, isType ? 'type' : 'value', modulePath, moduleText);
        }
    }

    // Pass B — direct declarations in index.ts itself.
    for (const m of index.matchAll(/export\s+(?:async\s+)?(function\*?|const|let|class|type|interface|enum)\s+([A-Za-z_]\w*)/g)) {
        const kind = m[1] === 'type' || m[1] === 'interface' ? 'type' : 'value';
        addExport(m[2], kind, 'src/index.ts', index);
    }

    exports.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
        $comment: 'Machine-generated export surface of the zipnative package — the ground truth for agents '
            + '(dist/*.d.ts is gitignored). Fields that cannot be extracted mechanically are null, never guessed. '
            + 'Regenerate with `npm run docs:api`; verify-docs api-json-sync enforces freshness.',
        package: 'zipnative',
        source: 'src/index.ts',
        exportCount: exports.length,
        exports,
    };
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
    const manifest = buildApiJson(resolve(import.meta.dirname, '..'));
    const outPath = resolve(import.meta.dirname, '..', 'docs/assets/api.json');
    writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.error(`docs/assets/api.json: ${manifest.exportCount} exports`);
}
