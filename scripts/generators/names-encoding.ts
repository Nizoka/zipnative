/** Entry-name shapes: ASCII, UTF-8 (flag bit 11), deep paths. */
import { resolve } from 'node:path';
import { createZip } from '../../src/index.ts';
import { type GenerateContext } from '../helpers/io.ts';

export async function generate(ctx: GenerateContext): Promise<void> {
    const write = (name: string, bytes: Uint8Array): void =>
        ctx.writeSafe(resolve(ctx.outputDir, 'names-encoding', name), `names-encoding/${name}`, bytes);

    {
        const zip = createZip();
        zip.add('simple.txt', 'ascii name\n');
        zip.add('with-dash_and.dots.txt', 'punctuation\n');
        write('ascii.zip', zip.toBytes());
    }
    {
        const zip = createZip();
        zip.add('café/résumé.txt', 'french\n');
        zip.add('文档/说明.md', 'chinese\n');
        zip.add('日本語/読み物.txt', 'japanese\n');
        zip.add('emoji-📦.txt', 'emoji in name\n');
        write('unicode-utf8.zip', zip.toBytes());
    }
    {
        const zip = createZip();
        zip.add('a/'.repeat(40) + 'deep.txt', 'forty levels down\n');
        write('deep-paths.zip', zip.toBytes());
    }
}
