/**
 * zipnative — committed-fixture generator (`npm run fixtures:generate`)
 * =====================================================================
 * Produces the tiny foreign-provenance archives committed under
 * tests/fixtures/interop/ from whatever producers this machine has, named
 * `<tool>-<trait>.zip`. Run MANUALLY when growing the corpus; record each
 * new file in the provenance ledger (tests/fixtures/README.md) — the
 * fixture-budget test enforces the listing.
 *
 * Never run in CI: the point of a committed fixture is that its bytes were
 * shaped on a real machine by a real foreign tool, then frozen.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    cleanupDir,
    PRODUCERS,
    produceArchive,
    writeInteropSource,
} from '../tests/helpers/interop-tools.ts';

const OUT_DIR = 'tests/fixtures/interop';
const sourceDir = writeInteropSource();

try {
    for (const producer of PRODUCERS) {
        const description = producer.describe();
        if (description === null) {
            console.error(`SKIP  ${producer.id} (not available)`);
            continue;
        }
        const bytes = produceArchive(producer, sourceDir);
        if (bytes === null) {
            console.error(`FAIL  ${producer.id}`);
            continue;
        }
        const path = join(OUT_DIR, `${producer.id}-basic.zip`);
        writeFileSync(path, bytes);
        console.error(`WROTE ${path} (${bytes.length} bytes) — ${description}`);
        console.error('      → add it to the provenance ledger in tests/fixtures/README.md');
    }
} finally {
    cleanupDir(sourceDir);
}
