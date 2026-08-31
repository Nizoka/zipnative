/**
 * Committed foreign-provenance fixtures: frozen bytes shaped by real
 * external tools (see tests/fixtures/README.md for the ledger). These run
 * on every machine — including ones with no producers installed — so the
 * reader always faces at least some bytes zipnative did not shape.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openZip } from 'zipnative';

const FIXTURE_DIR = 'tests/fixtures/interop';
const fixtures = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.zip'));

describe('interop: committed foreign fixtures', () => {
    it('the corpus is not empty', () => {
        expect(fixtures.length).toBeGreaterThan(0);
    });

    for (const name of fixtures) {
        it(`${name}: opens, validates eagerly, and every entry verifies`, () => {
            const bytes = new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
            const reader = openZip(bytes, { validate: 'eager', onDiagnostic: () => undefined });
            expect(reader.entryCount).toBeGreaterThan(0);

            let verified = 0;
            for (const entry of reader.entries()) {
                if (entry.isDirectory || entry.isEncrypted) continue;
                const verification = reader.verifyEntry(entry);
                expect(verification.ok, `${name}: entry '${entry.name}' failed verification`).toBe(true);
                verified++;
            }
            expect(verified).toBeGreaterThan(0);
        });

        it(`${name}: contains readme.txt with the canonical content`, () => {
            const bytes = new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
            const reader = openZip(bytes, { onDiagnostic: () => undefined });
            // Producers differ on leading './' in names.
            const entry = reader.getEntry('readme.txt') ?? reader.getEntry('./readme.txt');
            expect(entry, `${name}: readme.txt missing`).not.toBeNull();
            const text = new TextDecoder().decode(reader.readEntry(entry as never));
            expect(text).toBe('interop corpus — plain ASCII text\n');
        });
    }
});
