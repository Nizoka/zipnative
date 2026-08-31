---
name: Bug report
about: Something behaves incorrectly
title: ''
labels: bug
assignees: ''
---

## What happened

<!-- Actual behavior, including the full error message (zipnative errors include a remedy — paste it whole). -->

## Expected

## Reproduction

- zipnative version:
- Runtime (Node/browser/Deno/Bun + version):
- OS:

**The offending archive**: attach it if shareable. If not, attach a script
that generates an equivalent archive (e.g. using `tests/helpers/raw-zip-builder.ts`
patterns), or the output of `unzip -v` / `7z l -slt` on it. A parser bug
without a reproducible archive is very hard to act on.

```ts
// minimal reproduction code
```
