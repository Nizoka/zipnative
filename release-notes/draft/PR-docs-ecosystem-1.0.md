# PR — docs: the ecosystem on the site — zipnative-cli and zipnative-mcp 1.0.0

Branch `docs/ecosystem-1.0` → `main`. Paste the body below into the pull request (the `gh` CLI is not installed on the authoring machine).

## Summary

Documentation-only branch aligning the site and the repository docs on the published ecosystem: `zipnative` 1.0.0, `zipnative-cli` 1.0.0 (npm 2026-09-05) and `zipnative-mcp` 1.0.0 (npm 2026-09-07). No engine change; `src/` untouched.

- **Satellites documented as published** — README, ROADMAP, AGENTS.md, llms.txt, agent brief; `docs/assets/ecosystem.json` records both packages in full (version, repo, binary, pin, command groups, tools, prompts, env vars) and is the single source of truth every count on the site is checked against.
- **Three new guides** in the pdfnative charter — `guides/cli.md` (15 commands, every flag, agent contract, refused combinations, error classes / codes / remedies, batch-manifest and config rules), `guides/mcp.md` (client configuration, 13 tools with inputs/outputs, 7 prompts, resources, 7 env vars, protocol, error and security models), `guides/choose.md` (capability × surface matrix, twin of `docs/data/surfaces.json`).
- **Two new playgrounds** — `playgrounds/cli.html` (command builder driven by an embedded copy of the CLI surface: every flag of every command, the CLI's own exit-2 refusals as errors, 27 presets; nothing executed, by design) and `playgrounds/mcp.html` (real MCP payloads, client config, a Run button executing the engine call behind twelve of the thirteen tools on a sample or a dropped archive, honest `BROWSER_LIMITATION` refusals for what only the Node server can do).
- **Use case 5 — Encrypt first, then archive** (+ diagram): why no surface has a password and how confidentiality is delegated to the document layer (pdfnative AES-256, Office) while the archive stays deterministic and verifiable.
- **Landing** — "Pick your surface" section, hero install switcher, satellite badges, live npm version strip (`assets/versions.js`), `architecture.svg` extended with an ecosystem-consumers band; nav/footers on every page; OG and social images carry CLI and MCP.
- **Playgrounds are CDN-only** — `load-engine.js` imports the published package (esm.sh → jsDelivr, capability probe, loud on-page error); the pre-publication fallback (committed `dist/index.js` copy, `docs:playground`, the build step in `docs.yml`) is removed.
- **verify-docs** — `playground-bundle` → `cdn-pin`; `manifest-shape` for every package; `jsonld-version` on satellite `about` nodes; new `satellite-counts`, `surfaces-shape`, `cli-surface-parity` (snapshot of `zipnative schema manifest` vs manifest, guide and builder), `mcp-surface-parity`, `switcher-parity`, `versions-widget`. `verifiedOn` → 2026-09-07.

## Verification

| Gate | Result |
|---|---|
| `npm run typecheck:scripts` | clean |
| `npm run docs:all` | idempotent (0 shells updated on the final run) |
| `npm run verify:docs` | OK, 0 warnings (31 rules) |
| `npm run verify:docs -- --online --strict` (the weekly `npm-drift` job) | OK — registry `latest` = 1.0.0 for all three packages |
| Engine API smoke (every call the MCP explorer makes, against `dist/index.js`) | pass |
| Both new playground scripts | parse clean; rendered with headless Edge, MCP loader status green ("zipnative 1.0.0 loaded from the CDN") |
| Independent audits | A (factual conformity vs source trees **and** the published tarballs): 25 findings; B (perimeter coverage): 54 findings; C (adversarial verifier): 77 fixed, 2 false positives, 0 deferred |

## Out of scope — to report to the satellite repositories

- `zipnative-cli`: tag `v1.0.0` (== the npm tarball) ships `inspect --check safe-names` and `error.remedy`, but its CHANGELOG files both under `[Unreleased]`; README says "20 checks" where the CHANGELOG says "19"; README line 134 says `--max-output` is mandatory while the source and README line 741 make it optional (1 GiB default).
- `zipnative-mcp`: `SERVER_INSTRUCTIONS` says `zipBase64` takes "no data: URI" while `archive-input.ts` tolerates and strips the prefix; veraZIP corpus "38" (CHANGELOG) vs "37" (CLI README).

## Human steps after merge

- Upload the regenerated `docs/assets/social-preview.png` (1280×640) in GitHub → Settings → Social preview.
- GitHub Pages redeploys from `main:/docs` automatically; the CDN-only playgrounds need no build.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
