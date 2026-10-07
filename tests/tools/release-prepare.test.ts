import { describe, it, expect } from 'vitest';
import {
    isSemver,
    isIsoDate,
    todayUtc,
    stripTag,
    minorLine,
    bumpJsonVersion,
    bumpLockVersion,
    bumpVersionConst,
    bumpManifest,
    restampVerifiedOn,
    bumpCitation,
    bumpSecurityTable,
    replacePins,
    pinVersions,
    bumpWidgetFallback,
    bumpJsonLdVersion,
    bumpBadge,
    bumpReadmeRow,
    bumpChangelog,
    sitemapSources,
    sitemapEntries,
    sitemapCandidates,
    sitemapTouch,
    scaffoldReleaseNote,
    parseArgs,
} from '../../scripts/release-prepare.js';

// v1.1.0 — the pure half of scripts/release-prepare.ts: every edit is a
// targeted regex on the one field it owns, and these fixtures pin exactly
// which text each one may and may not touch. No git, no filesystem.

describe('release-prepare: helpers', () => {
    it('accepts plain semver triples only', () => {
        expect(isSemver('1.1.0')).toBe(true);
        expect(isSemver('v1.1.0')).toBe(false);
        expect(isSemver('1.1')).toBe(false);
        expect(isSemver('1.1.0-rc.1')).toBe(false);
    });

    it('validates ISO dates and formats today in UTC', () => {
        expect(isIsoDate('2026-10-07')).toBe(true);
        expect(isIsoDate('07/10/2026')).toBe(false);
        expect(isIsoDate('2026-13-45')).toBe(false);
        expect(todayUtc(new Date(Date.UTC(2026, 9, 7, 23, 59)))).toBe('2026-10-07');
    });

    it('strips the tag prefix and derives the minor line', () => {
        expect(stripTag('v1.0.0')).toBe('1.0.0');
        expect(stripTag('1.0.0')).toBe('1.0.0');
        expect(minorLine('1.1.3')).toBe('1.1');
        expect(minorLine('2.0.0')).toBe('2.0');
    });
});

describe('release-prepare: package manifests and VERSION', () => {
    const PKG = '{\n  "name": "zipnative",\n  "version": "1.0.0",\n  "devDependencies": {\n    "tsx": {\n      "version": "4.0.0"\n    }\n  }\n}\n';

    it('bumps the top-level version and nothing nested', () => {
        const r = bumpJsonVersion(PKG, '1.1.0');
        expect(r.matched).toBe(1);
        expect(r.text).toContain('  "version": "1.1.0",');
        expect(r.text).toContain('      "version": "4.0.0"');
        expect(r.text).not.toContain('1.0.0');
    });

    it('reports matched=1 with unchanged text when already at the version', () => {
        const at = PKG.replace('1.0.0', '1.1.0');
        const r = bumpJsonVersion(at, '1.1.0');
        expect(r.matched).toBe(1);
        expect(r.text).toBe(at);
    });

    it('reports matched=0 when there is no top-level version', () => {
        expect(bumpJsonVersion('{\n  "name": "x"\n}\n', '1.1.0').matched).toBe(0);
    });

    it('bumps the lockfile root and packages[""] but no dependency', () => {
        const LOCK =
            '{\n  "name": "zipnative",\n  "version": "1.0.0",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "zipnative",\n      "version": "1.0.0",\n      "license": "MIT"\n    },\n    "node_modules/a": {\n      "version": "1.0.0"\n    }\n  }\n}\n';
        const r = bumpLockVersion(LOCK, '1.1.0');
        expect(r.matched).toBe(2);
        expect(r.text.match(/"version": "1\.1\.0"/g)).toHaveLength(2);
        expect(r.text).toContain('"node_modules/a": {\n      "version": "1.0.0"');
    });

    it('bumps the VERSION export and the loader pin, nothing else', () => {
        const src = "export const VERSION = '1.0.0';\nconst other = '1.0.0';\n";
        const r = bumpVersionConst(src, '1.1.0');
        expect(r.matched).toBe(1);
        expect(r.text).toBe("export const VERSION = '1.1.0';\nconst other = '1.0.0';\n");
        const loader = "const VERSION = '1.0.0';\nconst url = `https://esm.sh/zipnative@${VERSION}`;\n";
        expect(bumpVersionConst(loader, '1.1.0').text).toContain("const VERSION = '1.1.0';");
    });
});

describe('release-prepare: manifest and Verified-on stamps', () => {
    const MANIFEST =
        '{\n  "packages": {\n    "zipnative": {\n      "version": "1.0.0",\n      "status": "active"\n    },\n    "zipnative-cli": {\n      "version": "1.0.0"\n    }\n  },\n  "verifiedOn": "2026-09-07",\n  "derived": {\n    "sampleZips": 38\n  }\n}\n';

    it('bumps packages.zipnative.version and verifiedOn, leaving the satellites alone', () => {
        const r = bumpManifest(MANIFEST, '1.1.0', '2026-10-07');
        expect(r.matched).toBe(2);
        expect(r.text).toContain('"zipnative": {\n      "version": "1.1.0"');
        expect(r.text).toContain('"zipnative-cli": {\n      "version": "1.0.0"');
        expect(r.text).toContain('  "verifiedOn": "2026-10-07"');
    });

    it('restamps every stamp form: "Verified on:", the footer, and "verifiedOn"', () => {
        expect(restampVerifiedOn('Verified on: 2026-09-07\n', '2026-10-07').text).toBe('Verified on: 2026-10-07\n');
        expect(restampVerifiedOn('<span>MIT · verified on 2026-09-07</span>', '2026-10-07').text).toContain('verified on 2026-10-07');
        expect(restampVerifiedOn('{\n  "verifiedOn": "2026-09-02",\n}', '2026-10-07').text).toContain('"verifiedOn": "2026-10-07"');
        expect(restampVerifiedOn('no stamp here', '2026-10-07').matched).toBe(0);
    });
});

describe('release-prepare: citation and support table', () => {
    it('bumps version: but never cff-version:, and adds date-released when absent', () => {
        const cff = 'cff-version: 1.2.0\ntitle: zipnative\nversion: 1.0.0\nlicense: MIT\n';
        const r = bumpCitation(cff, '1.1.0', '2026-10-07');
        expect(r.matched).toBe(2);
        expect(r.text).toBe('cff-version: 1.2.0\ntitle: zipnative\nversion: 1.1.0\ndate-released: 2026-10-07\nlicense: MIT\n');
    });

    it('rewrites an existing date-released', () => {
        const cff = 'cff-version: 1.2.0\nversion: 1.0.0\ndate-released: 2026-09-02\n';
        const r = bumpCitation(cff, '1.1.0', '2026-10-07');
        expect(r.matched).toBe(2);
        expect(r.text).toContain('date-released: 2026-10-07');
        expect(r.text.match(/date-released/g)).toHaveLength(1);
    });

    const TWO_ROWS = '| Version | Supported |\n|---|---|\n| 1.0.x | ✅ |\n| < 1.0 (git tags, never published to npm) | ❌ |\n';

    it('inserts the security-fixes row on the first minor after 1.0, keeping the 1.0 cut-off wording', () => {
        const r = bumpSecurityTable(TWO_ROWS, '1.1.0');
        expect(r.matched).toBe(1);
        expect(r.text).toBe('| Version | Supported |\n|---|---|\n| 1.1.x | ✅ |\n| 1.0.x | ✅ (security fixes) |\n| < 1.0 (git tags, never published to npm) | ❌ |\n');
    });

    it('rotates a three-row table and moves the cut-off', () => {
        const three = bumpSecurityTable(TWO_ROWS, '1.1.0').text;
        const r = bumpSecurityTable(three, '1.2.0');
        expect(r.text).toBe('| Version | Supported |\n|---|---|\n| 1.2.x | ✅ |\n| 1.1.x | ✅ (security fixes) |\n| < 1.1 | ❌ |\n');
    });

    it('leaves a patch release alone', () => {
        const r = bumpSecurityTable(TWO_ROWS, '1.0.3');
        expect(r.matched).toBe(1);
        expect(r.text).toBe(TWO_ROWS);
    });
});

describe('release-prepare: pins, widget, JSON-LD, badge, README row', () => {
    it('rewrites literal pins of the previous version only and counts the rest', () => {
        const text = 'https://esm.sh/zipnative@1.0.0 and https://cdn.jsdelivr.net/npm/zipnative@1.0.0/+esm, historical zipnative@0.9.0, zipnative@1.0.01';
        const r = replacePins(text, '1.0.0', '1.1.0');
        expect(r.matched).toBe(2);
        expect(r.text).toContain('zipnative@1.1.0/+esm');
        expect(r.text).toContain('zipnative@0.9.0');
        expect(r.text).toContain('zipnative@1.0.01');
        // 1.0.01 is a (nonsense) semver of its own, so it is counted — and never rewritten as a prefix match.
        expect([...pinVersions(r.text)]).toEqual([['1.1.0', 2], ['0.9.0', 1], ['1.0.01', 1]]);
    });

    it('bumps only the engine entry of the widget fallback', () => {
        const js = "var FALLBACK = {\n        'zipnative': { version: '1.0.0', pin: null },\n        'zipnative-cli': { version: '1.0.0', pin: '^1.0.0' }\n    };";
        const r = bumpWidgetFallback(js, '1.1.0');
        expect(r.matched).toBe(1);
        expect(r.text).toContain("'zipnative': { version: '1.1.0', pin: null }");
        expect(r.text).toContain("'zipnative-cli': { version: '1.0.0', pin: '^1.0.0' }");
    });

    it('bumps the softwareVersion of the named JSON-LD node only', () => {
        const html = '{"@id": "https://zipnative.dev/#org", "softwareVersion": "9.9.9"}\n{"@id": "https://zipnative.dev/#library", "softwareVersion": "1.0.0"}';
        const r = bumpJsonLdVersion(html, 'https://zipnative.dev/#library', '1.1.0');
        expect(r.matched).toBe(1);
        expect(r.text).toContain('#library", "softwareVersion": "1.1.0"');
        expect(r.text).toContain('#org", "softwareVersion": "9.9.9"');
        expect(bumpJsonLdVersion(html, 'https://zipnative.dev/#missing', '1.1.0').matched).toBe(0);
    });

    it('bumps the engine badge and leaves the satellite badges alone', () => {
        const html = '<span data-zn-badge="zipnative">v1.0.0</span> <span data-zn-badge="zipnative-cli">v1.0.0</span>';
        const r = bumpBadge(html, '1.1.0');
        expect(r.matched).toBe(1);
        expect(r.text).toBe('<span data-zn-badge="zipnative">v1.1.0</span> <span data-zn-badge="zipnative-cli">v1.0.0</span>');
    });

    it('bumps the README ecosystem row of the engine only', () => {
        const md = '| [`zipnative`](https://www.npmjs.com/package/zipnative) | core engine (this repo) — 106 exports | 1.0.0 |\n| [`zipnative-cli`](https://github.com/x) | cli | 1.0.0 |\n';
        const r = bumpReadmeRow(md, '1.1.0');
        expect(r.matched).toBe(1);
        expect(r.text).toContain('106 exports | 1.1.0 |');
        expect(r.text).toContain('| cli | 1.0.0 |');
    });
});

describe('release-prepare: changelog', () => {
    it('turns [Unreleased] into the dated version heading', () => {
        const r = bumpChangelog('# Changelog\n\n## [Unreleased]\n\n### Added\n', '1.1.0', '2026-10-07');
        expect(r.matched).toBe(1);
        expect(r.text).toContain('## [1.1.0] - 2026-10-07\n\n### Added');
    });

    it('refreshes the date of a heading already at the version, and reports neither as not found', () => {
        expect(bumpChangelog('## [1.1.0] - 2026-10-01\n', '1.1.0', '2026-10-07').text).toBe('## [1.1.0] - 2026-10-07\n');
        expect(bumpChangelog('## [1.0.0] - 2026-09-02\n', '1.1.0', '2026-10-07').matched).toBe(0);
    });
});

describe('release-prepare: sitemap', () => {
    const XML = [
        '<urlset>',
        '  <url><loc>https://zipnative.dev/</loc><lastmod>2026-09-07</lastmod></url>',
        '  <url><loc>https://zipnative.dev/guides/errors.html</loc><lastmod>2026-09-07</lastmod></url>',
        '  <url><loc>https://zipnative.dev/playgrounds/</loc><lastmod>2026-10-07</lastmod></url>',
        '</urlset>',
    ].join('\n');

    it('maps a URL to its sources (directory index, guide shell + markdown)', () => {
        expect(sitemapSources('https://zipnative.dev/')).toEqual(['docs/index.html']);
        expect(sitemapSources('https://zipnative.dev/playgrounds/')).toEqual(['docs/playgrounds/index.html']);
        expect(sitemapSources('https://zipnative.dev/guides/errors.html')).toEqual(['docs/guides/errors.html', 'docs/guides/errors.md']);
        expect(sitemapSources('https://zipnative.dev/guides/')).toEqual(['docs/guides/index.html']);
    });

    it('lists entries and picks the candidates whose sources changed and are not already dated', () => {
        expect(sitemapEntries(XML).map((e) => e.lastmod)).toEqual(['2026-09-07', '2026-09-07', '2026-10-07']);
        const c = sitemapCandidates(XML, ['docs/guides/errors.md', 'docs\\playgrounds\\index.html'], '2026-10-07');
        expect(c).toEqual([{ loc: 'https://zipnative.dev/guides/errors.html', because: 'docs/guides/errors.md' }]);
    });

    it('touches only the requested URLs', () => {
        const r = sitemapTouch(XML, ['https://zipnative.dev/guides/errors.html'], '2026-10-07');
        expect(r.matched).toBe(1);
        expect(r.text).toContain('errors.html</loc><lastmod>2026-10-07</lastmod>');
        expect(r.text).toContain('zipnative.dev/</loc><lastmod>2026-09-07</lastmod>');
    });
});

describe('release-prepare: release note scaffold and CLI', () => {
    it('extracts the template block, resolves placeholders and unescapes fences', () => {
        const template = '# Template\n\n```markdown\n# zipnative vX.Y.Z\n\n_Released YYYY-MM-DD_\n\nSince vX.Y.Z-1 (X.Y.Z):\n\n\\`\\`\\`ts\nimport { VERSION } from "zipnative";\n\\`\\`\\`\n```\n';
        const note = scaffoldReleaseNote(template, '1.1.0', '2026-10-07', 'v1.0.0');
        expect(note).toBe('# zipnative v1.1.0\n\n_Released 2026-10-07_\n\nSince v1.0.0 (1.1.0):\n\n```ts\nimport { VERSION } from "zipnative";\n```\n');
        expect(() => scaffoldReleaseNote('no block', '1.1.0', '2026-10-07', 'v1.0.0')).toThrow(/markdown block/);
    });

    it('parses the arguments and rejects bad ones with a usage line', () => {
        const ok = parseArgs(['--version', '1.1.0', '--date', '2026-10-07', '--previous', '1.0.0', '--dry-run']);
        expect(ok).toEqual({ version: '1.1.0', date: '2026-10-07', previous: 'v1.0.0', dryRun: true });
        const eq = parseArgs(['--version=1.1.0']);
        expect(typeof eq === 'string' ? eq : eq.version).toBe('1.1.0');
        expect(parseArgs([])).toMatch(/--version is required/);
        expect(parseArgs(['--version', 'v1.1.0'])).toMatch(/not a plain semver/);
        expect(parseArgs(['--version', '1.1.0', '--date', 'today'])).toMatch(/not an ISO date/);
        expect(parseArgs(['--version', '1.1.0', '--bogus'])).toMatch(/unknown argument/);
    });
});
