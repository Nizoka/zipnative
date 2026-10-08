/**
 * Byte-array equality for the codec suites. `expect(a).toEqual(b)` walks
 * both typed arrays element by element through the matcher — on a 1 MiB
 * corpus, inside a loop over levels and chunkings, that walk (not the
 * codec) is what turns a coverage run into minutes and trips the timeouts.
 * `Buffer.compare` is a memcmp; the failure message still names the first
 * differing offset.
 */
import { expect } from 'vitest';

export function firstDifference(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
    return a.length === b.length ? -1 : n;
}

export function expectSameBytes(actual: Uint8Array, expected: Uint8Array, label = 'bytes'): void {
    const same = Buffer.compare(
        Buffer.from(actual.buffer, actual.byteOffset, actual.length),
        Buffer.from(expected.buffer, expected.byteOffset, expected.length),
    ) === 0;
    if (!same) {
        const at = firstDifference(actual, expected);
        expect.fail(`${label}: ${actual.length} vs ${expected.length} bytes, first difference at offset ${at}`
            + ` (actual ${actual[at] ?? 'end'}, expected ${expected[at] ?? 'end'})`);
    }
}
