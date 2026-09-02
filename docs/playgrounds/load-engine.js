/* ═══════════════════════════════════════════════════════════════
   zipnative.dev — Playground engine loader
   The pdfnative CDN pattern: try esm.sh, then jsDelivr's +esm build,
   each verified by a capability probe (a stale or missing CDN build
   must fail loudly, never half-load) — then fall back to the committed
   local copy of dist/index.js. Until the package is published on npm
   the CDN imports 404 and every page transparently runs the local
   bundle; after publication the CDN serves the pinned version and the
   local file remains the offline/dev fallback.
   The VERSION constant is stamped by scripts/copy-playground-bundle.mjs
   and checked by the playground-bundle verify-docs rule.
   ═══════════════════════════════════════════════════════════════ */

const VERSION = '1.0.0';

const CDN_URLS = [
  `https://esm.sh/zipnative@${VERSION}`,
  `https://cdn.jsdelivr.net/npm/zipnative@${VERSION}/+esm`,
];

let cached = null;

/** Load the engine once: `{ mod, source }` where source names what ran. */
export async function loadEngine() {
  if (cached) return cached;
  for (const url of CDN_URLS) {
    try {
      const m = await import(url);
      // esm.sh sometimes nests named exports under .default — normalise,
      // then PROBE a known export so a wrong build fails here, loudly.
      const mod = typeof m.openZip === 'function' ? m
        : (m.default && typeof m.default.openZip === 'function') ? m.default
          : Object.assign({}, m, m.default || {});
      if (typeof mod.openZip === 'function' && typeof mod.createZip === 'function') {
        cached = { mod, source: `CDN (${new URL(url).host})` };
        return cached;
      }
    } catch { /* next candidate */ }
  }
  const local = await import('./zipnative.js');
  cached = { mod: local, source: 'local bundle' };
  return cached;
}
