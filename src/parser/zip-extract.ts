/**
 * zipnative — Secure extraction (in memory)
 * =========================================
 * The engine NEVER touches a filesystem: extraction yields sanitized
 * relative paths plus data; writing to disk is the caller's (or the
 * satellite CLI's) job. `sanitizeEntryPath()` is exported for external
 * sinks and is the single traversal gate (security instructions).
 *
 * Defaults are the safe path: traversal rejected (CWE-22), symlink
 * entries rejected (CWE-59), duplicate names an error (CWE-694), total
 * output and per-entry budgets enforced (CWE-400).
 *
 * @module parser/zip-extract
 */

import {
    type ZipCommonOptions,
    type ZipEntry,
} from '../types/zip-types.js';
import { ZipSecurityError } from '../types/zip-errors.js';
import { UNIX_TYPE_MASK, UNIX_TYPE_SYMLINK } from '../core/zip-constants.js';
import { enforceLimit, resolveLimits } from '../core/zip-limits.js';
import { openZip } from './zip-reader.js';

/** Options for {@link extractZip} / {@link extractZipStream}. */
export interface ExtractOptions extends ZipCommonOptions {
    /**
     * Reject entries whose names escape the extraction root (`..`,
     * absolute paths, drive letters, NUL, NTFS alternate data streams).
     * Default `true` (CWE-22). When `false`, offending entries are
     * SKIPPED — zipnative never emits a traversal-capable path either way.
     */
    readonly rejectTraversal?: boolean;
    /** Reject symlink entries (Unix mode S_IFLNK). Default `true` (CWE-59). */
    readonly rejectSymlinks?: boolean;
    /** Duplicate sanitized paths: fail, keep the first, or keep the last. Default `'error'`. */
    readonly onDuplicate?: 'error' | 'first' | 'last';
    /** Keep only entries the predicate accepts (runs before decompression). */
    readonly filter?: (entry: ZipEntry) => boolean;
}

/** One extracted file. */
export interface ExtractedEntry {
    /** Sanitized, `/`-separated, relative path — safe to join under a root. */
    readonly path: string;
    readonly data: Uint8Array;
    readonly entry: ZipEntry;
}

/** One extracted file, streamed. */
export interface ExtractedStreamEntry {
    readonly path: string;
    readonly entry: ZipEntry;
    /** Chunked entry content; consume fully before advancing the iterator. */
    stream(): AsyncGenerator<Uint8Array, void, undefined>;
}

/**
 * Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9),
 * matched on the pre-dot base name, case-insensitively. On Win32
 * `CreateFile('aux.txt')` opens the AUX device regardless of directory —
 * so an external FS sink joining such a name under a root escapes it
 * (CWE-67). `CONX`/`COM10` are NOT reserved and pass.
 */
const RESERVED_WIN_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Return the safe relative form of an entry name, or `null` when the name
 * cannot be made safe (traversal, absolute, drive/UNC, NUL, NTFS ADS, or a
 * Windows reserved device name).
 *
 * The single traversal gate for zipnative and for external filesystem
 * sinks: join the result under your extraction root — never the raw name.
 */
export function sanitizeEntryPath(name: string): string | null {
    if (name.length === 0) return null;
    if (name.includes('\0')) return null;
    // ZIP names use '/'; hostile archives use '\' hoping the consumer is
    // on Windows. Normalize before segment inspection.
    const normalized = name.replace(/\\/g, '/');
    if (normalized.startsWith('/')) return null;             // absolute
    if (/^[A-Za-z]:/.test(normalized)) return null;          // drive letter
    if (normalized.startsWith('//')) return null;            // UNC
    const segments: string[] = [];
    for (const segment of normalized.split('/')) {
        if (segment === '' || segment === '.') continue;     // collapse
        if (segment === '..') return null;                   // traversal
        if (segment.includes(':')) return null;              // NTFS ADS (file.txt:stream)
        if (RESERVED_WIN_DEVICE.test(segment)) return null;  // CON, NUL, COM1… (CWE-67)
        segments.push(segment);
    }
    if (segments.length === 0) return null;
    return segments.join('/');
}

/** Is this entry a Unix symlink (external-attribute file type S_IFLNK)? */
function isSymlinkEntry(entry: ZipEntry): boolean {
    return ((entry.externalAttributes >>> 16) & UNIX_TYPE_MASK) === UNIX_TYPE_SYMLINK;
}

interface PlannedEntry {
    readonly path: string;
    readonly entry: ZipEntry;
}

/** Shared guard pass: filter, sanitize, symlink policy, duplicates, budgets. */
function planExtraction(
    entries: Iterable<ZipEntry>,
    options: ExtractOptions | undefined,
): PlannedEntry[] {
    const limits = resolveLimits(options?.limits);
    const rejectTraversal = options?.rejectTraversal !== false;
    const rejectSymlinks = options?.rejectSymlinks !== false;
    const onDuplicate = options?.onDuplicate ?? 'error';

    const byPath = new Map<string, PlannedEntry>();
    let totalUncompressed = 0;

    for (const entry of entries) {
        if (entry.isDirectory) continue;
        if (options?.filter !== undefined && !options.filter(entry)) continue;

        if (isSymlinkEntry(entry)) {
            if (rejectSymlinks) {
                throw new ZipSecurityError('ZIP_SYMLINK_REJECTED',
                    `zipnative: entry '${entry.name}' is a symlink — rejected by default (CWE-59); `
                    + 'pass rejectSymlinks: false to receive its target as data',
                    entry.name);
            }
            // Accepted only by explicit opt-out: content (the link target)
            // is extracted as ordinary data, never materialized as a link.
        }

        const path = sanitizeEntryPath(entry.name);
        if (path === null) {
            if (rejectTraversal) {
                // Name the actual rule that fired: a Windows reserved device
                // name (CWE-67) is not a traversal, and saying "zip-slip"
                // would send the caller chasing one. The code stays
                // ZIP_PATH_TRAVERSAL — one gate, one code, two causes.
                const isDeviceName = entry.name.replace(/\\/g, '/').split('/')
                    .some((segment) => RESERVED_WIN_DEVICE.test(segment));
                throw new ZipSecurityError('ZIP_PATH_TRAVERSAL',
                    isDeviceName
                        ? `zipnative: entry name '${entry.name}' is a Windows reserved device name (CWE-67) — `
                        + 'writing it under any directory opens the device on Windows; '
                        + 'pass rejectTraversal: false to skip such entries instead'
                        : `zipnative: entry name '${entry.name}' escapes the extraction root (zip-slip, CWE-22) — `
                        + 'this archive is hostile or corrupt; pass rejectTraversal: false to skip such entries instead',
                    entry.name);
            }
            continue; // skipped — an unsafe path is never emitted
        }

        totalUncompressed += entry.uncompressedSize;
        enforceLimit(limits, 'maxTotalUncompressedSize', totalUncompressed, 'total declared uncompressed size');

        const existing = byPath.get(path);
        if (existing !== undefined) {
            if (onDuplicate === 'error') {
                throw new ZipSecurityError('ZIP_EXTRACT_DUPLICATE_PATH',
                    `zipnative: duplicate entry path '${path}' — a shadowing hazard (CWE-694); `
                    + "pass onDuplicate: 'first' or 'last' to resolve deliberately",
                    entry.name);
            }
            if (onDuplicate === 'first') continue;
        }
        byPath.set(path, { path, entry });
    }
    return [...byPath.values()];
}

/**
 * Extract an archive fully, in memory, with the security guards applied.
 * Directory entries are skipped (directories are implied by paths).
 */
export function extractZip(bytes: Uint8Array, options?: ExtractOptions): ExtractedEntry[] {
    const reader = openZip(bytes, options);
    const planned = planExtraction(reader.entries(), options);
    return planned.map(({ path, entry }) => ({
        path,
        entry,
        data: reader.readEntry(entry),
    }));
}

/**
 * Extract an archive entry-by-entry with streamed content — bounded
 * memory for large entries. Consume (or discard) each `stream()` before
 * advancing.
 */
export async function* extractZipStream(
    bytes: Uint8Array,
    options?: ExtractOptions,
): AsyncGenerator<ExtractedStreamEntry, void, undefined> {
    const reader = openZip(bytes, options);
    const planned = planExtraction(reader.entries(), options);
    for (const { path, entry } of planned) {
        yield {
            path,
            entry,
            stream: () => reader.readEntryStream(entry),
        };
    }
}
