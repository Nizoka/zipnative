/**
 * zipnative — Central-directory walk
 * ==================================
 * Parses central file headers into `ZipEntry` objects: name decoding per
 * the encoding policy, Zip64 resolution with spoof reporting, UT timestamp
 * refinement, Unicode-Path conflict inspection. All heavy views are
 * zero-copy subarrays of the source buffer.
 *
 * @module parser/zip-cd
 */

import {
    type ZipDiagnosticEmitter,
    type ZipEntry,
    type ZipLimits,
} from '../types/zip-types.js';
import { ZipFormatError, ZipUnsupportedError } from '../types/zip-errors.js';
import {
    DOS_ATTR_DIRECTORY,
    FLAG_DATA_DESCRIPTOR,
    FLAG_ENCRYPTED,
    FLAG_STRONG_ENCRYPTION,
    FLAG_UTF8,
} from '../core/zip-constants.js';
import { enforceLimit } from '../core/zip-limits.js';
import {
    extraFieldMalformedDiagnostic,
    invalidUtf8NameDiagnostic,
    unicodePathConflictDiagnostic,
    zip64ExtraIgnoredDiagnostic,
} from '../core/zip-diagnostics.js';
import { bytesEqual, decodeCp437, decodeUtf8Strict } from '../core/zip-encoding.js';
import { dosDateTimeToDate } from '../core/zip-dos-time.js';
import {
    parseExtraFields,
    resolveUnicodePath,
    resolveUtMtime,
    resolveZip64,
} from '../core/zip-extra-fields.js';
import { parseCentralFileHeader } from '../core/zip-structs.js';
import { type ArchiveLayout } from './zip-eocd.js';

/** Parse all central-directory records into entries. */
export function parseCentralDirectory(
    bytes: Uint8Array,
    layout: ArchiveLayout,
    limits: ZipLimits,
    emit: ZipDiagnosticEmitter,
): ZipEntry[] {
    const entries: ZipEntry[] = [];
    const cdEnd = layout.cdOffset + layout.cdSize;
    let pos = layout.cdOffset;

    for (let i = 0; i < layout.totalEntries; i++) {
        if (pos >= cdEnd) {
            throw new ZipFormatError('ZIP_CD_INCONSISTENT',
                `zipnative: central directory ended after ${i} of ${layout.totalEntries} declared entries `
                + '(corrupt or hostile archive)');
        }
        const cfh = parseCentralFileHeader(bytes, pos);
        if (pos + cfh.recordLength > cdEnd) {
            throw new ZipFormatError('ZIP_CD_INCONSISTENT',
                'zipnative: a central-directory record extends past the declared central-directory size '
                + '(corrupt or hostile archive)');
        }

        enforceLimit(limits, 'maxNameBytes', cfh.name.length, 'entry name length');
        enforceLimit(limits, 'maxExtraFieldBytes', cfh.extra.length, 'entry extra-field length');
        enforceLimit(limits, 'maxCommentBytes', cfh.comment.length, 'entry comment length');

        entries.push(makeEntry(cfh, layout.base, emit));
        pos += cfh.recordLength;
    }

    if (pos !== cdEnd) {
        throw new ZipFormatError('ZIP_CD_INCONSISTENT',
            'zipnative: the central directory contains bytes beyond its declared entries '
            + '(corrupt or hostile archive)');
    }
    return entries;
}

function makeEntry(
    cfh: ReturnType<typeof parseCentralFileHeader>,
    base: number,
    emit: ZipDiagnosticEmitter,
): ZipEntry {
    // ── Extra fields ─────────────────────────────────────────────────
    const { fields, malformed } = parseExtraFields(cfh.extra);

    // ── Name decoding ────────────────────────────────────────────────
    const utf8Flagged = (cfh.flags & FLAG_UTF8) !== 0;
    let name: string;
    let nameEncoding: 'utf-8' | 'cp437';
    if (utf8Flagged) {
        const decoded = decodeUtf8Strict(cfh.name);
        if (decoded === null) {
            name = decodeCp437(cfh.name);
            nameEncoding = 'cp437';
            emit(invalidUtf8NameDiagnostic(name));
        } else {
            name = decoded;
            nameEncoding = 'utf-8';
        }
    } else {
        name = decodeCp437(cfh.name);
        nameEncoding = 'cp437';
    }

    if (malformed) {
        emit(extraFieldMalformedDiagnostic(name));
    }

    // ── Zip64 resolution (spoof-resistant) ───────────────────────────
    const z64 = resolveZip64(fields, {
        uncompressedSize: cfh.uncompressedSize,
        compressedSize: cfh.compressedSize,
        localHeaderOffset: cfh.localHeaderOffset,
        diskNumberStart: cfh.diskNumberStart,
    });
    if (z64.suppliedNonSentinel) {
        emit(zip64ExtraIgnoredDiagnostic(name));
    }
    if (z64.diskNumberStart !== 0) {
        throw new ZipUnsupportedError('ZIP_UNSUPPORTED_MULTI_DISK',
            `zipnative: entry '${name}' starts on disk ${z64.diskNumberStart} — multi-disk archives are not supported`,
            'multi-disk');
    }

    // ── Unicode Path extra: inspected, never acted on ────────────────
    const unicodePath = resolveUnicodePath(fields);
    if (unicodePath !== null && !bytesEqual(unicodePath, cfh.name)) {
        emit(unicodePathConflictDiagnostic(name));
    }

    // ── Timestamp: UT extra refines the DOS pair ─────────────────────
    const utMtime = resolveUtMtime(fields);
    const lastModified = utMtime ?? dosDateTimeToDate(cfh.dosDate, cfh.dosTime);

    const isDirectory = name.endsWith('/')
        || ((cfh.externalAttributes & DOS_ATTR_DIRECTORY) !== 0 && z64.uncompressedSize === 0);

    return {
        name,
        rawName: cfh.name,
        nameEncoding,
        isDirectory,
        compressionMethod: cfh.compressionMethod,
        compressedSize: z64.compressedSize,
        uncompressedSize: z64.uncompressedSize,
        crc32: cfh.crc32,
        localHeaderOffset: z64.localHeaderOffset + base,
        lastModified,
        dosDate: cfh.dosDate,
        dosTime: cfh.dosTime,
        flags: cfh.flags,
        versionMadeBy: cfh.versionMadeBy,
        versionNeeded: cfh.versionNeeded,
        internalAttributes: cfh.internalAttributes,
        externalAttributes: cfh.externalAttributes,
        comment: cfh.comment,
        extraFields: fields,
        isEncrypted: (cfh.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0,
        usesZip64: z64.usesZip64,
        usesDataDescriptor: (cfh.flags & FLAG_DATA_DESCRIPTOR) !== 0,
    };
}
