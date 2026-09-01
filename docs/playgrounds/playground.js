/* ═══════════════════════════════════════════════════════════════
   zipnative.dev — Playground chrome (theme + hamburger)
   Shared by every playground page. Per-page logic lives in each page's
   own inline <script type="module"> which imports ./zipnative.js.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

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

  var hamburger = document.querySelector('.nav-hamburger');
  var navLinks = document.querySelector('.nav-links');
  if (hamburger && navLinks) {
    hamburger.addEventListener('click', function () {
      var open = navLinks.classList.toggle('open');
      hamburger.setAttribute('aria-expanded', String(open));
      hamburger.textContent = open ? '✕' : '☰';
    });
    navLinks.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        navLinks.classList.remove('open');
        hamburger.setAttribute('aria-expanded', 'false');
        hamburger.textContent = '☰';
      });
    });
  }
})();
