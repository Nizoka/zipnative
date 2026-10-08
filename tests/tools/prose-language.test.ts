import { describe, it, expect } from 'vitest';
import { classifyLine, findNonEnglishProse, DEMO_LANGUAGE_MARKER } from '../../scripts/lib/prose-language.js';

// v1.1.0 — the English-only prose detector shared by verify-docs
// (`prose-language`) and the tooling tests. Ported from pdfnative 1.8.0:
// deliberately narrow, because a false positive costs a marker while a
// false negative ships a French sentence on an English site.

describe('classifyLine', () => {
    it('flags the French vocabulary a ZIP engine is likeliest to leak', () => {
        for (const line of [
            "label: 'Fichiers compressés',",
            'Le dossier est vérifié avant extraction.',
            "title: 'Métadonnées étendues',",
            'Les octets sont identiques pour chaque exécution.',
            'Archive générée le 12 janvier',
        ]) {
            expect(classifyLine(line), line).not.toBeNull();
        }
    });

    it('flags two distinct French function words but not one', () => {
        expect(classifyLine('la table qui borde une ligne')).not.toBeNull();
        expect(classifyLine('set the par value of the bond')).toBeNull();
        expect(classifyLine('EST is five hours behind UTC')).toBeNull();
        expect(classifyLine('a sur-name is not a surname')).toBeNull();
    });

    it('flags UTF-8 text decoded as Latin-1', () => {
        expect(classifyLine("comment: 'â‚¬ 1,000.00',")).toMatch(/mojibake/);
        expect(classifyLine('zipnative â€” ZIP engine')).toMatch(/mojibake/);
    });

    it('leaves English typographic vocabulary and isolated accents alone', () => {
        for (const line of [
            'Brackets and Guillemets',
            'A café résumé with naïve façade — €42',
            "expect(sanitize('Café <2026>')).toBe('Café-2026');",
            'files that parse the parser output',
            '« » are the French quotation marks',
            'the archive format, its signature and the extraction path',
        ]) {
            expect(classifyLine(line), line).toBeNull();
        }
    });

    it('flags Spanish, Italian, Portuguese and German prose under their own name', () => {
        expect(classifyLine('El proyecto está en la fase final, pero todo funciona')).toMatch(/^Spanish/);
        expect(classifyLine('La casa che sta sulla collina è molto bella, anche di notte')).toMatch(/^Italian/);
        expect(classifyLine('A casa que fica na colina é muito bonita, mas também fria')).toMatch(/^Portuguese/);
        expect(classifyLine('Die Einträge liegen außerhalb der Grenze und werden nicht gelesen')).toMatch(/^German/);
    });

    it('never mistakes English for another language', () => {
        for (const line of [
            'The old APIs die when the shim is removed, per the deprecation policy.',
            'Cast the die: the fallback is deterministic and the den of legacy code is gone.',
            'The CLI is a pure dispatch layer over zipnative, as documented.',
            'Convert DER to PEM with openssl; the MIT licence applies.',
            '<em>Validated</em> against ISO/IEC 21320-1 by six foreign parsers',
            '<link rel="alternate" hreflang="en" href="https://zipnative.dev/">',
            'Le Corbusier and Les Paul are proper names, not prose.',
            'Under an unsupported intent the claim can die; a den of stale bytes remains.',
            'the central directory is authoritative over local headers',
        ]) {
            expect(classifyLine(line), line).toBeNull();
        }
    });

    it('uses Unicode word boundaries, so "est" does not match inside "está"', () => {
        expect(classifyLine('está aquí')).toMatch(/^Spanish/);
        expect(classifyLine('It is a test of the est, honestly.')).toBeNull();
    });

    it('does not detect Turkish, Vietnamese, Polish or Japanese — by design, documented', () => {
        for (const line of [
            'Zażółć gęślą jaźń',
            'Việt Nam đất nước tươi đẹp',
            'Restoran Menüsü – Akşam Yemeği',
            '日本語のファイル名.txt',
        ]) {
            expect(classifyLine(line), line).toBeNull();
        }
    });
});

describe('findNonEnglishProse', () => {
    it('reports line numbers and skips marked lines', () => {
        const text = [
            'English line',
            "title: 'Métadonnées',",
            `// ${DEMO_LANGUAGE_MARKER} fr (legacy code page demo)`,
            "title: 'Métadonnées',",
            `text: 'Vraiment ? Oui ! Total : 42.', // ${DEMO_LANGUAGE_MARKER} fr (punctuation)`,
            'an English line, so the marker above does not reach the next one',
            'la table qui borde une ligne',
        ].join('\n');
        const found = findNonEnglishProse(text, 'sample.ts');
        expect(found.map((f) => f.line)).toEqual([2, 7]);
        expect(found[0].snippet).toContain('Métadonnées');
    });

    it('skips comment lines in TypeScript but not in other files', () => {
        const ts = "// Lexique des règles de l'archive\nconst x = 1;";
        expect(findNonEnglishProse(ts, 'a.ts')).toEqual([]);
        expect(findNonEnglishProse('// la table qui borde une ligne', 'a.md')).toHaveLength(1);
    });

    it('exempts a fenced block that follows a marker in Markdown', () => {
        const md = [
            `<!-- ${DEMO_LANGUAGE_MARKER} fr (example) -->`,
            '```ts',
            "const s = 'Vraiment ? Oui ! Total : 42. Et une « citation » pour finir.';",
            "const t = 'la table qui borde une ligne';",
            '```',
            'la table qui borde une ligne',
        ].join('\n');
        expect(findNonEnglishProse(md, 'guide.md').map((f) => f.line)).toEqual([6]);
    });

    it('honours a caller-supplied suppression marker', () => {
        const md = '<!-- verify-docs:allow prose-language (history) -->\nla table qui borde une ligne';
        expect(findNonEnglishProse(md, 'x.md', { suppress: 'verify-docs:allow prose-language' })).toEqual([]);
        expect(findNonEnglishProse(md, 'x.md')).toHaveLength(1);
    });
});
