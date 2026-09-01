/** Basic archive shapes: store, deflate levels, empty archive, mixed methods. */
import { resolve } from 'node:path';
import { createZip } from '../../src/index.ts';
import { type GenerateContext } from '../helpers/io.ts';

const te = new TextEncoder();
const TEXT = te.encode('the quick brown fox jumps over the lazy dog. '.repeat(200));

export async function generate(ctx: GenerateContext): Promise<void> {
    const write = (name: string, bytes: Uint8Array): void =>
        ctx.writeSafe(resolve(ctx.outputDir, 'basic-formats', name), `basic-formats/${name}`, bytes);

    {
        const zip = createZip({ compression: { method: 'store' } });
        zip.add('readme.txt', TEXT);
        zip.add('data/notes.md', '# stored, no compression\n');
        write('store.zip', zip.toBytes());
    }
    for (const level of [1, 6, 9]) {
        const zip = createZip({ compression: { level } });
        zip.add('readme.txt', TEXT);
        write(`deflate-level-${level}.zip`, zip.toBytes());
    }
    write('empty.zip', createZip().toBytes());
    {
        const zip = createZip();
        zip.add('compressed.txt', TEXT);
        zip.add('stored.bin', TEXT, { compression: { method: 'store' } });
        zip.addDirectory('data');
        zip.add('data/nested.txt', 'nested file\n');
        write('mixed-methods.zip', zip.toBytes());
    }
}
