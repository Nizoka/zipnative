/** Archive-level and per-entry comments. */
import { resolve } from 'node:path';
import { createZip } from '../../src/index.ts';
import { type GenerateContext } from '../helpers/io.ts';

export async function generate(ctx: GenerateContext): Promise<void> {
    const write = (name: string, bytes: Uint8Array): void =>
        ctx.writeSafe(resolve(ctx.outputDir, 'comments', name), `comments/${name}`, bytes);

    {
        const zip = createZip({ comment: 'zipnative sample — archive-level comment' });
        zip.add('readme.txt', 'the archive itself carries a comment\n');
        write('archive-comment.zip', zip.toBytes());
    }
    {
        const zip = createZip();
        zip.add('first.txt', 'entry one\n', { comment: 'comment on the first entry' });
        zip.add('second.txt', 'entry two\n', { comment: 'comment on the second entry' });
        write('entry-comments.zip', zip.toBytes());
    }
}
