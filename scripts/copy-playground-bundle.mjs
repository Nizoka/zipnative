// docs:playground — copy dist/index.js to the playground as a committed
// local bundle, minus the sourceMappingURL line (the .map is not shipped
// to docs/). Zero deps, deterministic. verify-docs playground-bundle
// asserts this stayed in sync.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const src = resolve(root, 'dist/index.js');
if (!existsSync(src)) {
    console.error('docs:playground: dist/index.js not found — run `npm run build` first');
    process.exit(1);
}
const out = readFileSync(src, 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('//# sourceMappingURL='))
    .join('\n');
const dest = resolve(root, 'docs/playgrounds/zipnative.js');
writeFileSync(dest, out);
const version = out.match(/VERSION = "([^"]+)"/)?.[1] ?? '(unknown)';
console.error(`docs/playgrounds/zipnative.js: ${out.length} bytes, VERSION ${version}`);
