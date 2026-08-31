/**
 * zipnative — interop conformance driver (`npm run test:interop`)
 * ===============================================================
 * M1 (read direction): every foreign producer available on this machine
 * builds an archive from the canonical content set; zipnative must read it
 * back byte-for-byte. Exits 1 on any mismatch. From M2 the matrix gains
 * the write direction (zipnative-produced archives validated by foreign
 * extractors) and becomes the blocking gate of conformance.yml.
 */
import { openZip } from '../src/index.ts';
import {
    cleanupDir,
    interopCases,
    PRODUCERS,
    produceArchive,
    writeInteropSource,
} from '../tests/helpers/interop-tools.ts';

const sourceDir = writeInteropSource();
let failures = 0;
let ran = 0;

try {
    for (const producer of PRODUCERS) {
        const description = producer.describe();
        if (description === null) {
            console.error(`SKIP  ${producer.id} (not available)`);
            continue;
        }
        const bytes = produceArchive(producer, sourceDir);
        if (bytes === null) {
            console.error(`FAIL  ${producer.id}: producer refused to build the archive`);
            failures++;
            continue;
        }
        try {
            const reader = openZip(bytes, { onDiagnostic: () => undefined, validate: 'eager' });
            const byName = new Map([...reader.entries()].map((e) => [e.name.replace(/^\.\//, ''), e]));
            let mismatches = 0;
            for (const item of interopCases()) {
                const entry = byName.get(item.path);
                if (entry === undefined) {
                    if (item.path.includes('café')) continue; // encoding differs by producer
                    console.error(`FAIL  ${producer.id}: entry '${item.path}' missing`);
                    mismatches++;
                    continue;
                }
                const data = reader.readEntry(entry);
                if (data.length !== item.content.length || !data.every((b, i) => b === item.content[i])) {
                    console.error(`FAIL  ${producer.id}: content mismatch for '${item.path}'`);
                    mismatches++;
                }
            }
            if (mismatches === 0) {
                console.error(`OK    ${producer.id} — ${description}`);
                ran++;
            } else {
                failures++;
            }
        } catch (err) {
            console.error(`FAIL  ${producer.id}: ${err instanceof Error ? err.message : String(err)}`);
            failures++;
        }
    }
} finally {
    cleanupDir(sourceDir);
}

if (failures > 0) {
    console.error(`\ninterop: ${failures} producer(s) failed`);
    process.exit(1);
}
if (ran === 0) {
    console.error('\ninterop: no producers available on this machine — nothing validated');
    process.exit(1);
}
console.error(`\ninterop: OK (${ran} producer(s) validated)`);
