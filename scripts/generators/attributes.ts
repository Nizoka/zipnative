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

    // Extended Unix metadata (1.1.0 readers): the UT extra with all three
    // times and the Info-ZIP ux extra with uid/gid — getExtendedTimestamps
    // and getUnixIds read them; the 1.0.0 unix-attrs sample stays byte-for-byte.
    const owned = buildRawZip([
        {
            name: 'owned.txt', data: te.encode('uid 1000, gid 1000, three UT times\n'),
            versionMadeBy: UNIX, externalAttributes: (0o100644 << 16) >>> 0,
            extraCentral: new Uint8Array([
                0x55, 0x54, 0x0d, 0x00, 0x07, 0x00, 0x00, 0x4b, 0x5f, 0x00, 0x00, 0x4b, 0x5f, 0x00, 0x00, 0x4b, 0x5f, // UT: 2020-09-13T12:26:40Z x3
                0x75, 0x78, 0x0b, 0x00, 0x01, 0x04, 0xe8, 0x03, 0x00, 0x00, 0x04, 0xe8, 0x03, 0x00, 0x00, // ux: 1000/1000
            ]),
        },
    ]);
    ctx.writeSafe(
        resolve(ctx.outputDir, 'attributes', 'unix-ids.zip'),
        'attributes/unix-ids.zip (UT x3 + ux uid/gid)',
        owned,
    );

    // NTFS timestamps (0x000a): what Windows producers write — 100 ns
    // FILETIMEs for mtime/atime/ctime, readable via getExtendedTimestamps.
    const ntfs = new Uint8Array(4 + 4 + 24);
    const dv = new DataView(ntfs.buffer);
    dv.setUint16(4, 0x0001, true);
    dv.setUint16(6, 24, true);
    const fileTime = (iso: string): bigint => (BigInt(Date.parse(iso)) + 11644473600000n) * 10000n;
    dv.setBigUint64(8, fileTime('2021-03-04T05:06:07Z'), true);
    dv.setBigUint64(16, fileTime('2021-03-05T00:00:00Z'), true);
    dv.setBigUint64(24, fileTime('2021-03-01T00:00:00Z'), true);
    const windows = buildRawZip([
        { name: 'report.docx', data: te.encode('ntfs timestamps\n'), versionMadeBy: 0x0014, extraCentral: ntfs, dosDate: 0x5264, dosTime: 0x28c3 },
    ]);
    ctx.writeSafe(
        resolve(ctx.outputDir, 'attributes', 'ntfs-timestamps.zip'),
        'attributes/ntfs-timestamps.zip (0x000a FILETIMEs)',
        windows,
    );
}
