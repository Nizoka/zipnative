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
import { ZipError } from '../types/zip-errors.js';
import { DOS_ATTR_DIRECTORY, UNIX_TYPE_MASK, UNIX_TYPE_SYMLINK } from './zip-constants.js';

/** Host system id in the `versionMadeBy` high byte for Unix (APPNOTE 4.4.2). */
const HOST_UNIX = 3;

const UNIX_TYPE_REGULAR = 0o100000;
const UNIX_TYPE_DIRECTORY = 0o040000;

/** Options for {@link externalAttributesFromUnixMode}. */
export interface UnixModeOptions {
    /** Author a directory entry: `S_IFDIR` type bits plus the DOS directory attribute. Default false. */
    readonly directory?: boolean;
}

/**
 * The `externalAttributes` word for a Unix mode — the write-side mirror
 * of {@link getUnixMode}, for `AddEntryOptions.externalAttributes`.
 *
 * `mode` is the permission bits (`0o644`, `0o755`, setuid/setgid/sticky
 * kept as given) with or without the file-type bits: a mode that carries
 * none gets `S_IFREG`, or `S_IFDIR` with `directory: true`; a mode that
 * already names a type (a symlink `0o120777`, for instance) keeps it. The
 * low word carries the DOS directory attribute for directories, as
 * zipnative's own canonical defaults do (`0o100644 << 16` for files,
 * `(0o40755 << 16) | 0x10` for directories).
 *
 * @since 1.1.0
 */
export function externalAttributesFromUnixMode(mode: number, options?: UnixModeOptions): number {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0xffff) {
        throw new ZipError('ZIP_INVALID_OPTION', `zipnative: a Unix mode is an integer 0–0o177777 (got ${String(mode)})`);
    }
    const directory = options?.directory === true;
    const typed = (mode & UNIX_TYPE_MASK) !== 0 ? mode : mode | (directory ? UNIX_TYPE_DIRECTORY : UNIX_TYPE_REGULAR);
    return ((typed << 16) | (directory ? DOS_ATTR_DIRECTORY : 0)) >>> 0;
}

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
