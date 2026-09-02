/* ═══════════════════════════════════════════════════════════════
   zipnative.dev — Interactions
   Theme toggle, hamburger menu, copy-to-clipboard, tabs, GitHub stars.
   Ported from the pdfnative charter (same behaviors, same storage keys).
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Theme toggle ──────────────────────────────────────────
  const toggle = document.querySelector('.theme-toggle');
  const root = document.documentElement;

  function getPreferred() {
    // 'theme' is the charter key; fall back to the pre-0.8 zipnative key
    // once so returning visitors keep their choice.
    const stored = localStorage.getItem('theme') || localStorage.getItem('zipnative-theme');
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

  // ── Hamburger menu ────────────────────────────────────────
  var hamburger = document.querySelector('.nav-hamburger');
  var navLinks = document.querySelector('.nav-links');

  if (hamburger && navLinks) {
    hamburger.addEventListener('click', function () {
      var open = navLinks.classList.toggle('open');
      hamburger.setAttribute('aria-expanded', String(open));
      hamburger.textContent = open ? '✕' : '☰';
    });
    // Close menu on link click
    navLinks.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        navLinks.classList.remove('open');
        hamburger.setAttribute('aria-expanded', 'false');
        hamburger.textContent = '☰';
      });
    });
  }

  // ── Copy to clipboard ─────────────────────────────────────
  // Single helper for every copy affordance: the Clipboard API only exists
  // in secure contexts, so guard it and fall back to execCommand on a
  // temporary textarea instead of throwing synchronously in the handler.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (res, rej) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { /* fall through */ }
      ta.remove();
      if (ok) res(); else rej(new Error('Clipboard unavailable'));
    });
  }

  document.querySelectorAll('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');
      if (!text) return;
      copyText(text).then(function () {
        btn.classList.add('copied');
        var prev = btn.innerHTML;
        btn.innerHTML = '✓';
        setTimeout(function () {
          btn.innerHTML = prev;
          btn.classList.remove('copied');
        }, 1500);
      }, function () {
        btn.classList.add('copied');
        var prev = btn.innerHTML;
        btn.innerHTML = '✗';
        setTimeout(function () {
          btn.innerHTML = prev;
          btn.classList.remove('copied');
        }, 1500);
      });
    });
  });

  // "Copy as prompt": fetch a same-origin document and copy its text
  // (the agent-brief pattern shared with pdfnative).
  document.querySelectorAll('[data-copy-url]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var url = btn.getAttribute('data-copy-url');
      if (!url) return;
      var prev = btn.textContent;
      fetch(url).then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      }).then(copyText).then(function () {
        btn.textContent = '✓ Copied';
      }, function () {
        btn.textContent = '✗ Copy failed';
      }).then(function () {
        setTimeout(function () { btn.textContent = prev; }, 1500);
      });
    });
  });

  // ── Code tabs ─────────────────────────────────────────────
  // Scoped to the Examples section so future page controls are never
  // captured by this tablist.
  var exampleTabBar = document.querySelector('#examples .tab-bar');
  var tabBtns = exampleTabBar ? exampleTabBar.querySelectorAll('.tab-btn') : [];
  var tabPanels = document.querySelectorAll('.tab-panel');

  function activateTab(btn) {
    var id = btn.getAttribute('data-tab');
    tabBtns.forEach(function (b) {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    tabPanels.forEach(function (p) { p.classList.remove('active'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    var panel = document.getElementById('tab-' + id);
    if (panel) panel.classList.add('active');
  }

  tabBtns.forEach(function (btn, i) {
    btn.addEventListener('click', function () { activateTab(btn); });
    // Arrow-key navigation between tabs (WAI-ARIA tabs pattern, activation on focus)
    btn.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowRight') next = (i + 1) % tabBtns.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + tabBtns.length) % tabBtns.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabBtns.length - 1;
      if (next === null) return;
      e.preventDefault();
      tabBtns[next].focus();
      activateTab(tabBtns[next]);
    });
  });

  // ── GitHub stars ──────────────────────────────────────────
  var starsEl = document.getElementById('stars-count');
  if (starsEl) {
    var hasValidCache = false;
    try {
      var raw = localStorage.getItem('gh-stars');
      if (raw) {
        var cached = JSON.parse(raw);
        if (
          cached &&
          typeof cached.count === 'number' &&
          typeof cached.ts === 'number' &&
          Date.now() - cached.ts < 3600000
        ) {
          starsEl.textContent = formatNumber(cached.count);
          hasValidCache = true;
        } else {
          localStorage.removeItem('gh-stars');
        }
      }
    } catch (_) {
      try { localStorage.removeItem('gh-stars'); } catch (__) { /* ignore */ }
    }

    if (!hasValidCache) {
      fetch('https://api.github.com/repos/Nizoka/zipnative', { headers: { Accept: 'application/vnd.github.v3+json' } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && typeof data.stargazers_count === 'number') {
            starsEl.textContent = formatNumber(data.stargazers_count);
            try {
              localStorage.setItem('gh-stars', JSON.stringify({ count: data.stargazers_count, ts: Date.now() }));
            } catch (_) { /* ignore */ }
          }
        })
        .catch(function (err) {
          console.warn('GitHub stars fetch failed:', err);
        });
    }
  }

  function formatNumber(n) {
    if (typeof n !== 'number' || Number.isNaN(n)) return '—';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }
})();
