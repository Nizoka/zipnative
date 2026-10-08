/**
 * Recipe: timestamps that do not depend on the process time zone. DOS
 * date-time fields carry no zone; by default an explicit `Date` is written
 * as local time (the Info-ZIP / 7-Zip convention, byte-compatible with
 * 1.0). `dosTimeMode: 'utc'` writes and reads the UTC fields instead, so a
 * pinned date reproduces on every machine. Out-of-range dates clamp with
 * the `ZIP_TIMESTAMP_CLAMPED` diagnostic rather than silently drifting.
 */
import { createZip, openZip, type ZipDiagnostic } from 'zipnative';

export default async function run(): Promise<Record<string, string>> {
    const pinned = new Date(Date.UTC(2026, 0, 2, 3, 4, 6));
    const zip = createZip({ defaultDate: pinned, dosTimeMode: 'utc' });
    zip.add('a.txt', 'pinned to 2026-01-02T03:04:06Z on every machine');
    const entry = openZip(zip.toBytes(), { dosTimeMode: 'utc' }).getEntry('a.txt');

    const diagnostics: ZipDiagnostic[] = [];
    const old = createZip({ dosTimeMode: 'utc', onDiagnostic: (d) => diagnostics.push(d) });
    old.add('b.txt', 'born before the DOS epoch', { date: new Date(Date.UTC(1975, 6, 15)) });
    const clamped = openZip(old.toBytes(), { dosTimeMode: 'utc' }).getEntry('b.txt');

    return {
        'utc-roundtrip': entry?.lastModified.toISOString() ?? '(missing)',
        clamped: clamped?.lastModified.toISOString() ?? '(missing)',
        diagnostic: diagnostics.map((d) => d.code).join(',') || '(none)',
    };
}
