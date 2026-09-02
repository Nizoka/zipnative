/**
 * zipnative — Entry attribute readers
 * ===================================
 * Pure helpers over the raw `ZipEntry.externalAttributes` field. The
 * high 16 bits carry Unix `st_mode` bits when the entry was authored on
 * a Unix host (`versionMadeBy` high byte 3); DOS/Windows producers leave
 * them empty or carry FAT attributes instead. The helpers are the public
 * API — the underlying UNIX_* masks stay internal.
 *
 * @module core/zip-attributes
 */

import type { ZipEntry } from '../types/zip-types.js';
import { UNIX_TYPE_MASK, UNIX_TYPE_SYMLINK } from './zip-constants.js';

/** Host system id in the `versionMadeBy` high byte for Unix (APPNOTE 4.4.2). */
const HOST_UNIX = 3;

/**
 * Is this entry a Unix symlink (external-attribute file type `S_IFLNK`)?
 *
 * The same test `extractZip` runs behind `rejectSymlinks` — exported so
 * external filesystem sinks can apply the identical policy. Only
 * meaningful for Unix-authored entries; DOS-authored archives never
 * report symlinks.
 */
export function isSymlinkEntry(entry: ZipEntry): boolean {
    return ((entry.externalAttributes >>> 16) & UNIX_TYPE_MASK) === UNIX_TYPE_SYMLINK;
}

/**
 * The entry's Unix mode bits (type + permissions, e.g. `0o100644`), or
 * `null` when the archive was not authored on a Unix host — a DOS
 * producer's zeroed high word is indistinguishable from mode `0o000`,
 * so the honest answer there is "no Unix mode", never a fake zero.
 */
export function getUnixMode(entry: ZipEntry): number | null {
    if ((entry.versionMadeBy >>> 8) !== HOST_UNIX) return null;
    return (entry.externalAttributes >>> 16) & 0xFFFF;
}
