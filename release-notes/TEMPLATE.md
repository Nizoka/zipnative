# Release Notes Template

This directory contains release notes for each tagged version of `zipnative`.

## File naming

- One file per version: `release-notes/vMAJOR.MINOR.PATCH.md`
- Examples: `v0.9.0.md`, `v1.0.0.md`, `v1.1.0.md`

## Template

Copy the content below into a new `release-notes/vX.Y.Z.md` file and fill in the sections. Omit any section that has no entries for the release (do not leave empty sections).

```markdown
# zipnative vX.Y.Z

<!-- GitHub Release title: vX.Y.Z — short description -->

_Released YYYY-MM-DD_

<!-- One-paragraph summary: what is this release about (bugfix / feature / polish / security) and compatibility statement (e.g. "100% backward-compatible with vX.Y.Z-1"). -->

## Highlights

<!-- 2–5 bullets calling out the most user-visible changes. Link to detailed sections below where useful. -->

- ...

## Security

<!-- CVE-style entries: CWE reference, affected versions, mitigation. Keep this section first when present. -->

- **fix(security):** ...

## Breaking Changes

<!-- Only for MAJOR bumps. Each entry must include: what changed, why, migration path. -->

- **BREAKING:** ...

## Added

<!-- New features, new public API, new samples. Use conventional commit scopes: feat(core), feat(parser), feat(codecs), feat(worker), feat(samples), etc. -->

- **feat(scope):** ...

## Changed

<!-- Non-breaking behavior changes, metadata updates, dependency bumps, internal refactors with user-visible effects. -->

- **chore(meta):** ...
- **refactor(core):** ...

## Fixed

<!-- Bug fixes. Reference GitHub issues (#NN) where applicable. -->

- **fix(scope):** ... ([#NN]).

## Deprecated

<!-- APIs kept working but scheduled for removal in a future MAJOR. Include the target version. -->

- **deprecate(scope):** `oldApi()` — use `newApi()` instead. Will be removed in vX+1.0.0.

## Removed

<!-- Only for MAJOR bumps. Cross-reference the deprecation notice from a prior release. -->

- **remove(scope):** ... (deprecated in vX.Y.Z).

## Performance

<!-- Benchmark deltas with measurement methodology. -->

- **perf(scope):** reduced X by N% (measured via `npm run bench` on Node 22.x, documented machine, median of 5 runs).

## Documentation

<!-- README / guides / docs-site changes worth calling out. -->

- **docs(scope):** ...

## Install

\`\`\`bash
npm install zipnative@X.Y.Z
\`\`\`

## Upgrade

<!-- Step-by-step migration if non-trivial. For PATCH releases with no breaking changes, one sentence suffices. -->

No breaking changes. Drop-in replacement for vX.Y.Z-1.

## Known limitations

<!-- zipnative local extension (analogue of a Deferred section): the scoped refusals and gaps that remain true after this release, stated plainly. Omit only when there are none. -->

- ...

## Downstream integration notes

<!-- zipnative local extension: what the satellite packages (zipnative-cli, zipnative-mcp) and other wrappers need to know. Omit when nothing affects them. -->

- ...

## Contributors

<!-- Optional: acknowledge external contributors for this release. -->

Thanks to @handle1, @handle2 for contributions to this release.

## Links

- [CHANGELOG](../CHANGELOG.md)
- [Full diff](https://github.com/Nizoka/zipnative/compare/vX.Y.Z-1...vX.Y.Z)
- [Roadmap](../ROADMAP.md)
```

## Conventions

- **GitHub Release title.** Use `vX.Y.Z — short description` (3–5 words) as the GitHub Release title, not the bare version number. Single-focus releases use that focus (`v0.8.2 — conformance pass on 0.8.1`); multi-theme releases summarize (`v0.8.0 — error codes & docs charter`). The H1 of this file stays `# zipnative vX.Y.Z` for direct Markdown rendering; the descriptive title is only for the GitHub Releases UI.
- **SemVer classification first.** Decide MAJOR / MINOR / PATCH before writing the note; it determines which sections apply.
- **Mirror `CHANGELOG.md`.** Each release note must have a corresponding entry in `CHANGELOG.md`. Bullets should match (the CHANGELOG is the canonical per-line record; the release note adds narrative framing).
- **Conventional commit scopes.** Prefix bullets with `fix(scope):`, `feat(scope):`, `chore(scope):`, `perf(scope):`, etc. Common scopes: `core`, `parser`, `codecs`, `worker`, `errors`, `samples`, `docs`, `meta`, `build`, `ci`.
- **Link issues & PRs.** Use `([#NN])` inline references with footnote-style link definitions at the bottom of the release note when referenced more than once.
- **No emojis** in release notes (per project coding conventions).
- **Security section first** when a release contains security fixes — always include CWE identifier and mitigation.
- **Code blocks** for install commands and migration examples only. No decorative code blocks.
- **Backward-compatibility statement** in the summary paragraph for every PATCH and MINOR release. For zipnative, byte-level compatibility is part of the statement: say explicitly whether `deterministic: true` output bytes changed (they must not, short of a MAJOR).
- **Local extensions.** `## Known limitations` (the scoped refusals that remain true) and `## Downstream integration notes` (what satellite packages need to know) are zipnative additions to the pdfnative format, placed after Upgrade and before Contributors/Links.
- **Pre-1.0 install honesty.** Versions before the first npm publication are git tags only; their Install section says so instead of showing an `npm install` that would fail.

## Publication workflow

1. Draft `release-notes/vX.Y.Z.md` on the release branch.
2. Mirror the bullets into `CHANGELOG.md` under a new `## [X.Y.Z] – YYYY-MM-DD` section.
3. Bump `package.json` `version` (and the synced version sites: lockfile, `CITATION.cff`, `ecosystem.json`, `VERSION` in `src/index.ts`, docs JSON-LD).
4. Open PR → merge to `main`.
5. Tag `vX.Y.Z` and publish a GitHub Release with title `vX.Y.Z — short description`; paste the release note body as the Release description.
6. The `publish.yml` workflow fires on "Release published" → re-runs the full gate → npm package with provenance.
