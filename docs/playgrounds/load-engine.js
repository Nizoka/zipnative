/* ═══════════════════════════════════════════════════════════════
   zipnative.dev — Playground engine loader
   The pdfnative CDN pattern: import the PUBLISHED package, pinned to
   this site's version, from esm.sh and then jsDelivr's +esm build. Each
   candidate is verified by a capability probe — a stale or missing CDN
   build must fail loudly, never half-load. There is no local fallback:
   what runs here is exactly the npm artefact, byte for byte.
   The VERSION constant is checked against docs/assets/ecosystem.json by
   the cdn-pin verify-docs rule — bump it with every release.
   ═══════════════════════════════════════════════════════════════ */

const VERSION = '1.0.0';

const CDN_URLS = [
  `https://esm.sh/zipnative@${VERSION}`,
  `https://cdn.jsdelivr.net/npm/zipnative@${VERSION}/+esm`,
];

let cached = null;

/** Load the engine once: `{ mod, source }` where source names the CDN that served it. */
export async function loadEngine() {
  if (cached) return cached;
  let lastError = null;
  for (const url of CDN_URLS) {
    try {
      const m = await import(url);
      // esm.sh sometimes nests named exports under .default — normalise,
      // then PROBE a known export so a wrong build fails here, loudly.
      const mod = typeof m.openZip === 'function' ? m
        : (m.default && typeof m.default.openZip === 'function') ? m.default
          : Object.assign({}, m, m.default || {});
      if (typeof mod.openZip === 'function' && typeof mod.createZip === 'function') {
        cached = { mod, source: `CDN (${new URL(url).host}) · zipnative@${VERSION}` };
        return cached;
      }
      lastError = new Error(`${url} loaded but does not export openZip/createZip`);
    } catch (err) {
      lastError = err;
    }
  }
  const message = `zipnative@${VERSION} could not be loaded from esm.sh or jsDelivr — `
    + `check your network or content blocker and reload. (${lastError && lastError.message ? lastError.message : 'no details'})`;
  // Surface the failure on the page: every playground has an engine-source
  // slot in its footer and most have a #status line.
  const slot = document.getElementById('engine-source');
  if (slot) slot.textContent = 'unavailable — CDN unreachable';
  const status = document.getElementById('status');
  if (status) { status.textContent = message; status.className = 'pg-status err'; }
  throw new Error(message);
}
