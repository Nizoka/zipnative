---
description: "Public API surface rules"
applyTo: "src/index.ts,src/types/**"
---

# API design rules

- `src/index.ts` is the single public surface, organized in numbered export
  categories with comments. Not exported there = private.
- Closure factories, not classes: `openZip(bytes, options?) → ZipReader`.
  Returned interfaces have readonly fields and methods that close over state.
- `fn(data, options?)`: required params first, one trailing options object
  for anything optional. Options interfaces are readonly, live in the module
  that owns the function, and embed `ZipCommonOptions` (strict /
  onDiagnostic / limits) where applicable.
- Never create a second option shape for an existing concept — reuse
  `ZipCompressionOptions`, `ZipLimits`, etc.
- Explicit return types on every exported function. `export type {}` for
  zero-cost type exports.
- Sync-first: sync unless the operation is inherently async (streams,
  workers, dynamic import). Async variants are separate functions or
  `AsyncIterable` returns — never a sync API that secretly awaits.
- README Quick Start must stay copy-paste runnable against the current API.
