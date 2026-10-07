/*!
 * zipnative — Live version widget (the pdfnative versions.js pattern)
 * ====================================================================
 * Renders the current published versions of `zipnative`, `zipnative-cli`
 * and `zipnative-mcp` straight from the public npm registry on page
 * load, including the transitive zipnative pin each satellite declares in
 * its `dependencies`, so visitors can verify the wiring at a glance.
 *
 * Mount points: every element matching `.zn-version-strip` (compact
 * one-line strip under the nav) or `[data-zn-versions]` (detailed list);
 * every `[data-zn-badge="<pkg>"]` receives `v<version>` as text.
 *
 * Zero-dependency, zero-build: one fetch per package against
 * https://registry.npmjs.org. FALLBACK mirrors docs/assets/ecosystem.json
 * (the verify-docs `versions-widget` rule keeps them equal) and is used
 * only when the registry is unreachable.
 */
(function () {
    'use strict';

    var NPM = 'https://registry.npmjs.org/';
    var PKGS = ['zipnative', 'zipnative-cli', 'zipnative-mcp'];
    var FALLBACK = {
        'zipnative': { version: '1.1.0', pin: null },
        'zipnative-cli': { version: '1.0.0', pin: '^1.0.0' },
        'zipnative-mcp': { version: '1.0.0', pin: '^1.0.0' }
    };

    function el(tag, attrs, kids) {
        var n = document.createElement(tag);
        if (attrs) for (var k in attrs) {
            if (k === 'class') n.className = attrs[k];
            else if (k === 'text') n.textContent = attrs[k];
            else n.setAttribute(k, attrs[k]);
        }
        if (kids) for (var i = 0; i < kids.length; i++) if (kids[i]) n.appendChild(kids[i]);
        return n;
    }

    function fetchPkg(name) {
        return fetch(NPM + name + '/latest', { mode: 'cors' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
                if (!data) return FALLBACK[name];
                var pin = data.dependencies && typeof data.dependencies.zipnative === 'string' ? data.dependencies.zipnative : null;
                return { version: data.version, pin: pin };
            })
            .catch(function () { return FALLBACK[name]; });
    }

    function renderCompact(host, results) {
        host.innerHTML = '';
        var inner = el('div', { class: 'zn-version-strip-inner' });
        inner.appendChild(el('span', { class: 'zn-version-strip-label', text: 'Live npm:' }));
        PKGS.forEach(function (name, idx) {
            var info = results[name];
            if (idx > 0) inner.appendChild(el('span', { class: 'zn-version-strip-sep', text: '·' }));
            var link = el('a', { class: 'zn-version-strip-pkg', href: 'https://www.npmjs.com/package/' + name, target: '_blank', rel: 'noopener' });
            link.appendChild(document.createTextNode((name === 'zipnative' ? name : name.replace('zipnative-', '')) + ' '));
            link.appendChild(el('strong', { text: 'v' + info.version }));
            if (info.pin) link.appendChild(el('span', { class: 'zn-version-strip-pin', title: 'zipnative pin declared in this package’s dependencies', text: ' (→ ' + info.pin + ')' }));
            inner.appendChild(link);
        });
        host.appendChild(inner);
    }

    function renderDetailed(host, results) {
        host.innerHTML = '';
        var list = el('ul', { class: 'zn-versions-list' });
        PKGS.forEach(function (name) {
            var info = results[name];
            list.appendChild(el('li', null, [
                el('a', { class: 'zn-versions-name', href: 'https://www.npmjs.com/package/' + name, target: '_blank', rel: 'noopener', text: name }),
                el('span', { class: 'zn-versions-ver', text: 'v' + info.version }),
                info.pin ? el('span', { class: 'zn-versions-pin', text: '→ zipnative ' + info.pin }) : null
            ]));
        });
        host.appendChild(list);
        host.appendChild(el('p', { class: 'zn-versions-foot', text: 'Fetched from registry.npmjs.org on page load · zero-dep, zero-build' }));
    }

    function boot() {
        var strips = document.querySelectorAll('.zn-version-strip');
        var details = document.querySelectorAll('[data-zn-versions]');
        var badges = document.querySelectorAll('[data-zn-badge]');
        if (!strips.length && !details.length && !badges.length) return;
        Promise.all(PKGS.map(fetchPkg)).then(function (arr) {
            var byName = {};
            for (var k = 0; k < PKGS.length; k++) byName[PKGS[k]] = arr[k] || FALLBACK[PKGS[k]];
            strips.forEach(function (h) { renderCompact(h, byName); });
            details.forEach(function (h) { renderDetailed(h, byName); });
            badges.forEach(function (b) { var info = byName[b.getAttribute('data-zn-badge')]; if (info) b.textContent = 'v' + info.version; });
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
