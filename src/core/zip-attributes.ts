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
import { resolveNtfsTimestamps, resolveUnixIds, resolveUtTimestamps } from './zip-extra-fields.js';

/**
 * An entry's timestamps at the best precision its metadata offers.
 * `source` names where they came from: `'ut'` (the Info-ZIP 0x5455 extra,
 * 1-second Unix times; the central copy usually carries mtime only),
 * `'ntfs'` (the 0x000a extra, 100 ns FILETIMEs), or `'dos'` (the 2-second
 * DOS fields — `entry.lastModified`; no atime/ctime).
 *
 * @since 1.1.0
 */
export interface ExtendedTimestamps {
    readonly mtime: Date | null;
    readonly atime: Date | null;
    readonly ctime: Date | null;
    readonly source: 'ut' | 'ntfs' | 'dos';
}

/** Unix owner ids of an entry (the Info-ZIP "ux" 0x7875 extra). @since 1.1.0 */
export interface UnixIds {
    readonly uid: number;
    readonly gid: number;
}

/**
 * The entry's modification, access and creation times — UT first, then
 * NTFS, then the DOS fields (Info-ZIP's precedence). Pure: reads the
 * extra fields the entry already carries.
 *
 * @since 1.1.0
 */
export function getExtendedTimestamps(entry: ZipEntry): ExtendedTimestamps {
    const ut = resolveUtTimestamps(entry.extraFields);
    if (ut !== null && ut.mtime !== null) return { ...ut, source: 'ut' };
    const ntfs = resolveNtfsTimestamps(entry.extraFields);
    if (ntfs !== null && ntfs.mtime !== null) return { ...ntfs, source: 'ntfs' };
    return { mtime: entry.lastModified, atime: null, ctime: null, source: 'dos' };
}

/**
 * The entry's Unix uid/gid from the Info-ZIP 0x7875 extra, or null when the
 * archive carries none (DOS/Windows producers, or a Unix one that omitted
 * it). @since 1.1.0
 */
export function getUnixIds(entry: ZipEntry): UnixIds | null {
    return resolveUnixIds(entry.extraFields);
}

/** Host system id in the `versionMadeBy` high byte for Unix (APPNOTE 4.4.2). */
const HOST_UNIX = 3;

const UNIX_TYPE_REGULAR = 0o100000;
const UNIX_TYPE_DIRECTORY = 0o040000;

/** Options for {@link externalAttributesFromUnixMode}. @since 1.1.0 */
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
