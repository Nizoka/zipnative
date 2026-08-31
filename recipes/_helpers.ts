/**
 * Shared demo-archive builders for the recipes. Recipes demonstrate the
 * READING API (M1); archives are hand-assembled here until createZip ships
 * in M2, at which point these helpers switch to the public writer.
 */
import { buildRawZip } from '../tests/helpers/raw-zip-builder.ts';

const te = new TextEncoder();

/** dir/ + hello.txt + data.bin — the archive the recipe expectations assume. */
export function buildDemoArchive(): Uint8Array {
    return buildRawZip([
        { name: 'dir/', data: new Uint8Array(0), externalAttributes: 0x10 },
        { name: 'hello.txt', data: te.encode('hello zipnative') },
        { name: 'data.bin', data: te.encode('payload '.repeat(100)), method: 8 },
    ]);
}

/** A zip-slip archive: one traversal entry. */
export function buildHostileArchive(): Uint8Array {
    return buildRawZip([
        { name: '../escape.txt', data: te.encode('evil') },
    ]);
}
