/* ═══════════════════════════════════════════════════════════════
   zipnative.dev — Guide page enhancements
   Guides are PRE-RENDERED from the companion `.md` by build-guides.ts
   (the guide-render-sync rule keeps them fresh) — this script only adds
   chrome behaviors, the source bar, per-block copy buttons and Prism
   highlighting. No client-side markdown rendering, ever.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Theme toggle (shared with main page) ──────────────────
  var toggle = document.querySelector('.theme-toggle');
  var root = document.documentElement;

  function getPreferred() {
    var stored = localStorage.getItem('theme') || localStorage.getItem('zipnative-theme');
    if (stored === 'dark' || stored === 'light') return stored;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    if (toggle) {
      toggle.textContent = theme === 'dark' ? '☀️' : '🌙';
      toggle.setAttribute('aria-pressed', String(theme === 'dark'));
    }
  }

  applyTheme(getPreferred());
  if (toggle) {
    toggle.addEventListener('click', function () {
      applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
  }

  // ── Hamburger menu (shared) ───────────────────────────────
  var hamburger = document.querySelector('.nav-hamburger');
  var navLinks = document.querySelector('.nav-links');
  if (hamburger && navLinks) {
    hamburger.addEventListener('click', function () {
      var open = navLinks.classList.toggle('open');
      hamburger.setAttribute('aria-expanded', String(open));
      hamburger.textContent = open ? '✕' : '☰';
    });
  }

  // ── Guide enhancements ────────────────────────────────────
  var container = document.getElementById('guide-content');
  if (!container) return;

  // The Markdown source name is DERIVED from the page's own URL (every guide
  // pairs name.html with name.md) — never from DOM text. The data-md
  // attribute is demoted to an opt-in marker: it must agree with the derived
  // name, but the value that reaches fetch() and the source-bar href comes
  // from location, filtered to a plain same-directory Markdown filename.
  var page = (location.pathname.split('/').pop() || '').replace(/\.html$/, '');
  var src = page + '.md';
  var declared = container.getAttribute('data-md');
  if (!declared || declared !== src || !/^[A-Za-z0-9][A-Za-z0-9_-]*\.md$/.test(src)) return;

  // Pages are always pre-rendered; anything else is a build error the
  // verifier catches — never rendered client-side.
  if (container.getAttribute('data-prerendered') !== 'true') return;

  function addCopyButtons(scope) {
    scope.querySelectorAll('pre').forEach(function (pre) {
      // The button lives in a positioned wrapper OUTSIDE the scrollable
      // <pre>: as a child it would scroll away with wide code and its label
      // would pollute manual text selection.
      if (pre.parentNode.classList && pre.parentNode.classList.contains('pre-wrap')) return;
      var wrap = document.createElement('div');
      wrap.className = 'pre-wrap';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      var btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.type = 'button';
      btn.textContent = 'Copy';
      btn.addEventListener('click', function () {
        var code = pre.querySelector('code');
        navigator.clipboard.writeText(code ? code.textContent : pre.textContent).then(function () {
          btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
        }, function () { btn.textContent = 'Failed'; });
      });
      wrap.appendChild(btn);
    });
  }

  function addSourceBar(scope) {
    if (document.querySelector('.guide-source-bar')) return;
    var bar = document.createElement('div');
    bar.className = 'guide-source-bar';
    var copyMd = document.createElement('button');
    copyMd.type = 'button';
    copyMd.className = 'guide-source-btn';
    copyMd.textContent = 'Copy page as Markdown';
    copyMd.addEventListener('click', function () {
      fetch(src, { cache: 'no-cache' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(function (md) { return navigator.clipboard.writeText(md); })
        .then(function () {
          copyMd.textContent = 'Copied!';
          setTimeout(function () { copyMd.textContent = 'Copy page as Markdown'; }, 1500);
        })
        .catch(function () { copyMd.textContent = 'Copy failed'; });
    });
    var view = document.createElement('a');
    view.className = 'guide-source-link';
    view.href = src;
    view.textContent = 'View Markdown source';
    bar.appendChild(copyMd);
    bar.appendChild(view);
    scope.parentNode.insertBefore(bar, scope);
  }

  // Layout-affecting enhancements run at once — deferring them behind the
  // Prism wait would shift the article down after render. Only the
  // highlighting waits for the deferred Prism scripts.
  addSourceBar(container);
  addCopyButtons(container);
  var tries = 20;
  (function highlightWhenReady() {
    if (window.Prism && typeof window.Prism.highlightAllUnder === 'function') {
      window.Prism.highlightAllUnder(container);
      return;
    }
    if (tries-- > 0) setTimeout(highlightWhenReady, 100);
  })();
})();
