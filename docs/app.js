/* zipnative docs — zero-dependency page behavior. One IIFE, no build step. */
(function () {
    'use strict';

    // ── Theme toggle (localStorage + prefers-color-scheme) ──────────
    var root = document.documentElement;
    var stored = null;
    try { stored = localStorage.getItem('zipnative-theme'); } catch (e) { /* blocked storage */ }
    if (stored === 'dark' || (stored === null && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        root.setAttribute('data-theme', 'dark');
    }
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var dark = root.getAttribute('data-theme') === 'dark';
            if (dark) root.removeAttribute('data-theme');
            else root.setAttribute('data-theme', 'dark');
            try { localStorage.setItem('zipnative-theme', dark ? 'light' : 'dark'); } catch (e) { /* ignore */ }
        });
    });

    // ── Mobile nav ───────────────────────────────────────────────────
    var toggle = document.querySelector('.nav-toggle');
    var links = document.querySelector('.nav-links');
    if (toggle && links) {
        toggle.addEventListener('click', function () {
            var open = links.classList.toggle('open');
            toggle.setAttribute('aria-expanded', String(open));
        });
    }

    // ── Copy-to-clipboard ────────────────────────────────────────────
    document.querySelectorAll('.copy-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var text = btn.getAttribute('data-copy') || '';
            var done = function () {
                var label = btn.textContent;
                btn.textContent = 'Copied!';
                setTimeout(function () { btn.textContent = label; }, 1400);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(done, function () { /* ignore */ });
            }
        });
    });

    // ── Code tabs ────────────────────────────────────────────────────
    document.querySelectorAll('[data-tabs]').forEach(function (tabs) {
        var buttons = tabs.querySelectorAll('[data-tab]');
        var panels = tabs.querySelectorAll('[data-panel]');
        buttons.forEach(function (btn) {
            btn.addEventListener('click', function () {
                var target = btn.getAttribute('data-tab');
                buttons.forEach(function (b) { b.setAttribute('aria-selected', String(b === btn)); });
                panels.forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== target; });
            });
        });
    });
})();
