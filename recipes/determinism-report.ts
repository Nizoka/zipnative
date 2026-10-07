/**
 * Recipe: measure, canonicalise, prove. `analyzeDeterminism()` names every
 * entry that breaks the canonical form (wall-clock timestamps, insertion
 * order, foreign extra fields…); `canonicalizeZip()` rewrites any archive
 * into that form without recompressing a payload, idempotently, and the
 * resulting bytes are part of the frozen determinism contract.
 */
import { analyzeDeterminism, canonicalizeZip, openZip } from 'zipnative';
import { createZip } from 'zipnative';

export default async function run(): Promise<Record<string, string>> {
    // A "foreign-looking" archive: insertion order, a pinned wall-clock date.
    const zip = createZip({ order: 'insertion', defaultDate: new Date(Date.UTC(2024, 4, 6, 7, 8, 10)), dosTimeMode: 'utc' });
    zip.add('zeta.txt', 'last by name, first by insertion');
    zip.add('alpha.txt', 'first by name');
    const messy = zip.toBytes();

    const before = analyzeDeterminism(messy);
    const concerns = [...new Set(before.offenders.map((o) => o.concern))].sort();

    const canonical = canonicalizeZip(messy);
    const after = analyzeDeterminism(canonical);
    const again = canonicalizeZip(canonical);
    const idempotent = again.length === canonical.length && again.every((b, i) => b === canonical[i]);

    // The payloads travelled untouched: same CRCs, same compressed bytes.
    const names = [...openZip(canonical).entries()].map((e) => e.name);

    return {
        before: String(before.deterministic),
        concerns: concerns.join(','),
        after: String(after.deterministic),
        idempotent: String(idempotent),
        order: names.join(','),
    };
}
