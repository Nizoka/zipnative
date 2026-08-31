/**
 * Interop read gate (test form): every foreign ZIP producer present on this
 * machine builds an archive from a known content set; zipnative must read
 * it back byte-for-byte. Absent producers are skipped with a note — never
 * faked. The standalone driver (scripts/run-interop.ts) runs the same
 * matrix in the conformance workflow.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openZip } from 'zipnative';
import {
    cleanupDir,
    interopCases,
    PRODUCERS,
    produceArchive,
    writeInteropSource,
} from '../helpers/interop-tools.ts';

let sourceDir: string;

beforeAll(() => {
    sourceDir = writeInteropSource();
});

afterAll(() => {
    cleanupDir(sourceDir);
});

describe('interop: zipnative reads foreign producers', () => {
    for (const producer of PRODUCERS) {
        it(`reads an archive produced by ${producer.id}`, (ctx) => {
            if (producer.describe() === null) {
                ctx.skip(`${producer.id} is not available on this machine`);
                return;
            }
            const bytes = produceArchive(producer, sourceDir);
            expect(bytes, `${producer.id} failed to produce an archive`).not.toBeNull();

            const reader = openZip(bytes as Uint8Array, { onDiagnostic: () => undefined, validate: 'eager' });
            const byName = new Map([...reader.entries()].map((e) => [e.name.replace(/^\.\//, ''), e]));

            for (const item of interopCases()) {
                // Producers differ on non-ASCII name encoding (UTF-8 vs
                // CP437 vs locale); assert content fidelity on ASCII names
                // and mere presence-or-absence tolerance on the unicode one.
                const entry = byName.get(item.path);
                if (item.path.includes('café') && entry === undefined) continue;
                expect(entry, `${producer.id}: entry ${item.path} missing`).toBeDefined();
                const data = reader.readEntry(entry as never);
                expect(data, `${producer.id}: content mismatch for ${item.path}`).toEqual(item.content);
            }
        });
    }
});
