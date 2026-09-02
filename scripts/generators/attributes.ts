/**
 * Unix attributes on the wire: an archive carrying a symlink entry
 * (S_IFLNK, the shape `rejectSymlinks` guards against and 0.9's
 * `isSymlinkEntry` detects) plus regular 0644/0755 modes readable via
 * `getUnixMode`. DOS-authored archives carry none of this — the helper
 * returns null there, never a fake zero.
 */
import { resolve } from 'node:path';
import { buildRawZip } from '../../tests/helpers/raw-zip-builder.ts';
import { type GenerateContext } from '../helpers/io.ts';

const te = new TextEncoder();
const UNIX = 0x031E; // versionMadeBy: Unix host, spec 3.0

export async function generate(ctx: GenerateContext): Promise<void> {
    const archive = buildRawZip([
        {
            name: 'regular.txt', data: te.encode('mode 0644\n'),
            versionMadeBy: UNIX, externalAttributes: (0o100644 << 16) >>> 0,
        },
        {
            name: 'script.sh', data: te.encode('#!/bin/sh\necho executable\n'),
            versionMadeBy: UNIX, externalAttributes: (0o100755 << 16) >>> 0,
        },
        {
            name: 'link-to-target', data: te.encode('regular.txt'),
            versionMadeBy: UNIX, externalAttributes: (0o120777 << 16) >>> 0, // S_IFLNK
        },
    ]);
    ctx.writeSafe(
        resolve(ctx.outputDir, 'attributes', 'unix-attrs.zip'),
        'attributes/unix-attrs.zip (0644 + 0755 + symlink)',
        archive,
    );
}
