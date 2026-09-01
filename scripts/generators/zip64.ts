/** Zip64: an archive whose entry count overflows the classic EOCD. */
import { resolve } from 'node:path';
import { createZip } from '../../src/index.ts';
import { type GenerateContext } from '../helpers/io.ts';

export async function generate(ctx: GenerateContext): Promise<void> {
    const zip = createZip();
    for (let i = 0; i < 66_000; i++) {
        zip.add(`entries/${i.toString(36)}`, 'x', { compression: { method: 'store' } });
    }
    ctx.writeSafe(
        resolve(ctx.outputDir, 'zip64', 'zip64-66k-entries.zip'),
        'zip64/zip64-66k-entries.zip (zip64 EOCD)',
        zip.toBytes(),
    );
}
