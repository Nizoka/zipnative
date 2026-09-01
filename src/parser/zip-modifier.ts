/**
 * zipnative — Incremental archive modifier
 * ========================================
 * The ZIP counterpart of pdfnative's incremental PDF update: edits are an
 * overlay held in a Map — the source bytes are NEVER mutated — and two
 * save paths materialize them:
 *
 *   save()        — append-only: the original archive is copied VERBATIM
 *                   (SFX prefixes included), appended local headers +
 *                   payloads follow, then a NEW central directory in
 *                   which untouched entries' records are the source's
 *                   raw CFH bytes copied verbatim (valid because the
 *                   prefix is intact, so every stored offset still
 *                   resolves), then Zip64 records iff needed, then a new
 *                   EOCD. Untouched entries are never recompressed.
 *   saveCompact() — canonical full rewrite through the SAME segment
 *                   generator as createZip — still no recompression
 *                   (payloads are raw-copied), but removed content is
 *                   truly gone and the layout is compact.
 *
 * ── DATA REMANENCE (read this) ───────────────────────────────────────
 * `removeEntry()` + `save()` does NOT erase content: the append-only
 * layout keeps every original byte, so removed and replaced payloads
 * remain recoverable from the output (see SECURITY.md § Known
 * limitations). `saveCompact()` is the true-deletion path. A
 * ZIP_DEAD_BYTES_RATIO diagnostic fires when more than half of a
 * save() output is dead bytes.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Conformance notes:
 * - A save() output contains the old EOCD inside the copied prefix; it
 *   is not self-consistent for the grown file, so conforming readers
 *   (ours included) pick the new one — our reader emits an informational
 *   ZIP_MULTIPLE_EOCD when the old record falls inside its scan window.
 * - Renames are raw copies into the appended zone (fresh LFH + payload
 *   memcpy, no recompression): re-pointing a renamed CFH at the old
 *   local header would make every strict reader flag the name mismatch.
 * - saveCompact() drops any SFX/prepended prefix (canonical rewrite).
 *
 * @module parser/zip-modifier
 */

import {
    type ZipCommonOptions,
    type ZipEntry,
    type ZipExtraField,
} from '../types/zip-types.js';
import {
    ZipError,
    ZipFormatError,
    ZipSecurityError,
} from '../types/zip-errors.js';
import {
    EXTRA_ZIP64,
    FLAG_DATA_DESCRIPTOR,
    FLAG_UTF8,
    SENTINEL_U16,
    SENTINEL_U32,
} from '../core/zip-constants.js';
import { enforceLimit, resolveLimits } from '../core/zip-limits.js';
import {
    createDiagnosticEmitter,
    deadBytesRatioDiagnostic,
    timestampNotPinnedDiagnostic,
} from '../core/zip-diagnostics.js';
import { bytesEqual, compareNames, validateEntryName } from '../core/zip-encoding.js';
import { dateToDosDateTime, DETERMINISTIC_DOS_DATE, DETERMINISTIC_DOS_TIME } from '../core/zip-dos-time.js';
import { buildZip64Extra, serializeExtraFields } from '../core/zip-extra-fields.js';
import {
    parseCentralFileHeader,
    parseLocalFileHeader,
    writeCentralFileHeader,
    writeEocd,
    writeLocalFileHeader,
    writeZip64Eocd,
    writeZip64Locator,
} from '../core/zip-structs.js';
import { assembleArchive, planArchive, type EntrySpec, type PlannedEntry, type ZipCtx } from '../core/zip-segments.js';
import { type AddEntryOptions, type ZipCompressionOptions } from '../core/zip-builder.js';
import { locateEocd, type ArchiveLayout } from './zip-eocd.js';
import { type ZipReader } from './zip-reader.js';

/** Options for {@link createZipModifier}. */
export interface ZipModifierOptions extends ZipCommonOptions {
    /** Compression defaults for entries written via addEntry/replaceEntry. */
    readonly compression?: ZipCompressionOptions;
    /**
     * Timestamp for written entries that don't set their own. Default:
     * the DOS epoch (determinism contract); `'now'` uses the wall clock
     * and emits ZIP_TIMESTAMP_NOT_PINNED.
     */
    readonly defaultDate?: Date | 'now';
}

/** Incremental archive modifier — obtain via {@link createZipModifier}. */
export interface ZipModifier {
    /** The reader this modifier wraps. Its bytes are never mutated. */
    readonly reader: ZipReader;

    /** Add a new entry. Throws if the name already exists (use replaceEntry). */
    addEntry(name: string, data: Uint8Array | string, options?: AddEntryOptions): void;
    /** Replace an existing entry's content. Throws if the name doesn't exist. */
    replaceEntry(name: string, data: Uint8Array | string, options?: AddEntryOptions): void;
    /**
     * Remove an entry. With save(), the old bytes REMAIN in the output
     * (data remanence) — use saveCompact() for true deletion.
     */
    removeEntry(name: string): void;
    /**
     * Rename an entry. Never overwrites implicitly (removeEntry the
     * target first). In save(), a rename costs a raw copy of the
     * compressed payload into the appended zone — no recompression —
     * and the old bytes remain as dead bytes.
     */
    renameEntry(from: string, to: string): void;
    setComment(comment: string | Uint8Array): void;

    /**
     * Append-only save: original bytes verbatim + appended entries + new
     * central directory + new EOCD. No pending edits and an unchanged
     * comment → returns `reader.bytes` (the SAME reference, zero copy).
     * Edits stay pending — saves are repeatable and each re-plans.
     */
    save(): Uint8Array;
    /** Canonical rewrite without recompression; removed data is truly gone. */
    saveCompact(): Uint8Array;
}

type PendingEdit =
    | { readonly kind: 'write'; readonly data: Uint8Array; readonly options?: AddEntryOptions }
    | { readonly kind: 'rawCopy'; readonly source: ZipEntry }
    | { readonly kind: 'remove' };

interface SourceRecord {
    readonly entry: ZipEntry;
    /** The entry's raw central-directory record — zero-copy source slice. */
    readonly rawCfh: Uint8Array;
}

const te = new TextEncoder();

/**
 * @internal Zip64 treatment for an appended LOCAL file header. APPNOTE
 * §4.5.3: when a local header carries a Zip64 extra it MUST contain BOTH
 * the original and compressed sizes (the emit-only-overflowed-fields rule
 * applies to the central directory only). So: if either size overflows,
 * sentinel both classic fields and put both u64s in the extra. Exported
 * from this module (not from src/index.ts) so the ≥4 GiB path is unit-
 * testable without a 4 GiB buffer.
 */
export function lfhZip64Fields(uncompressedSize: number, compressedSize: number): {
    readonly classicUncompressed: number;
    readonly classicCompressed: number;
    readonly extra: Uint8Array | null;
    readonly usesZip64: boolean;
} {
    const usesZip64 = uncompressedSize > SENTINEL_U32 - 1 || compressedSize > SENTINEL_U32 - 1;
    if (!usesZip64) {
        return { classicUncompressed: uncompressedSize, classicCompressed: compressedSize, extra: null, usesZip64 };
    }
    return {
        classicUncompressed: SENTINEL_U32,
        classicCompressed: SENTINEL_U32,
        extra: buildZip64Extra(uncompressedSize, compressedSize, undefined),
        usesZip64,
    };
}

/**
 * Wrap an opened archive in an incremental modifier.
 *
 * Construction is O(entries): the central directory is walked once to
 * capture each record's raw bytes for verbatim copying. Archives with
 * duplicate entry names are refused (`ZipFormatError`) — name-keyed
 * editing would be ambiguous; extract and rebuild with createZip instead.
 */
export function createZipModifier(reader: ZipReader, options?: ZipModifierOptions): ZipModifier {
    // Validate early.
    const limits = resolveLimits(options?.limits);
    const emit = createDiagnosticEmitter(options?.strict, options?.onDiagnostic);

    // Layout recovery: locateEocd only scans the ≤ 65 557-byte tail. A
    // no-op emitter — prepended-data/multiple-EOCD concerns were already
    // the reader's to report.
    const layout: ArchiveLayout = locateEocd(reader.bytes, limits, () => undefined);

    // Capture raw CFH slices in the reader's own iteration order.
    const entries = [...reader.entries()];
    const sourceIndex = new Map<string, SourceRecord>();
    {
        let pos = layout.cdOffset;
        for (let i = 0; i < layout.totalEntries; i++) {
            const cfh = parseCentralFileHeader(reader.bytes, pos);
            const record: SourceRecord = {
                entry: entries[i],
                rawCfh: reader.bytes.subarray(pos, pos + cfh.recordLength),
            };
            if (sourceIndex.has(record.entry.name)) {
                throw new ZipFormatError('ZIP_DUPLICATE_ENTRY_NAME',
                    `zipnative: the archive contains duplicate entry name '${record.entry.name}' — `
                    + 'incremental modification of duplicate-name archives is not supported; '
                    + 'extract and rebuild with createZip() instead');
            }
            sourceIndex.set(record.entry.name, record);
            pos += cfh.recordLength;
        }
    }

    // ── Edit overlay (the source is never mutated) ───────────────────
    const edits = new Map<string, PendingEdit>();
    let pendingComment: Uint8Array | null = null;

    const existsNow = (name: string): boolean => {
        const edit = edits.get(name);
        if (edit !== undefined) return edit.kind !== 'remove';
        return sourceIndex.has(name);
    };

    // Written-entry defaults (mirrors createZip's resolution).
    const defaultCompression = options?.compression;
    let defaultDos: { dosDate: number; dosTime: number };
    if (options?.defaultDate === 'now') {
        emit(timestampNotPinnedDiagnostic());
        defaultDos = dateToDosDateTime(new Date());
    } else if (options?.defaultDate instanceof Date) {
        defaultDos = dateToDosDateTime(options.defaultDate);
    } else {
        defaultDos = { dosDate: DETERMINISTIC_DOS_DATE, dosTime: DETERMINISTIC_DOS_TIME };
    }

    const validateNewName = (name: string, isDirectory: boolean): string => {
        const finalName = validateEntryName(name, isDirectory);
        enforceLimit(limits, 'maxNameBytes', te.encode(finalName).length, 'entry name length');
        return finalName;
    };

    /** Build the EntrySpec for one pending `write` (shared by both saves). */
    const specForWrite = (name: string, edit: { data: Uint8Array; options?: AddEntryOptions }): EntrySpec => {
        const isDirectory = name.endsWith('/');
        const compression = edit.options?.compression;
        const level = compression?.level ?? defaultCompression?.level ?? 6;
        if (!Number.isInteger(level) || level < 0 || level > 9) {
            throw new ZipError('ZIP_INVALID_OPTION', `zipnative: compression.level must be an integer 0-9 (got ${String(level)})`);
        }
        const dos = edit.options?.date !== undefined ? dateToDosDateTime(edit.options.date) : defaultDos;
        return {
            nameBytes: te.encode(name),
            isDirectory,
            data: isDirectory ? new Uint8Array(0) : edit.data,
            source: null,
            method: isDirectory ? 'store' : (compression?.method ?? defaultCompression?.method ?? 'deflate'),
            level,
            deterministic: compression?.deterministic ?? defaultCompression?.deterministic ?? false,
            dosDate: dos.dosDate,
            dosTime: dos.dosTime,
            externalAttributes: edit.options?.externalAttributes
                ?? (isDirectory ? ((0o040755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0),
            comment: edit.options?.comment === undefined ? new Uint8Array(0) : te.encode(edit.options.comment),
            extraFields: edit.options?.extraFields ?? [],
        };
    };

    /**
     * Raw compressed payload for copying. Non-encrypted entries go
     * through the reader's fully defended path; encrypted entries are
     * copyable-but-not-decompressible, so a minimal manual path
     * duplicates prepareRead's method and bounds checks (the reader's
     * full path is intentionally unreachable for them).
     */
    const rawCompressedSlice = (entry: ZipEntry): Uint8Array => {
        if (!entry.isEncrypted) return reader.readEntryRaw(entry);
        const lfh = parseLocalFileHeader(reader.bytes, entry.localHeaderOffset);
        if (lfh.compressionMethod !== entry.compressionMethod) {
            throw new ZipSecurityError('ZIP_CD_LFH_MISMATCH',
                `zipnative: entry '${entry.name}' local header declares method ${lfh.compressionMethod} but the `
                + `central directory says ${entry.compressionMethod} — parser-differential archives are rejected`,
                entry.name);
        }
        const dataEnd = lfh.dataStart + entry.compressedSize;
        if (dataEnd > reader.bytes.length || dataEnd > layout.cdOffset) {
            throw new ZipFormatError('ZIP_RECORD_TRUNCATED',
                `zipnative: entry '${entry.name}' data extends past its region (truncated or corrupt archive)`);
        }
        return reader.bytes.subarray(lfh.dataStart, dataEnd);
    };

    /**
     * A copied source entry as a PlannedEntry (no recompression, bit 3
     * cleared). `nameIsUtf8` is true when `nameBytes` is a fresh UTF-8
     * re-encoding (rename): the UTF-8 flag (bit 11) is then SET when the
     * bytes are non-ASCII so a CP437 source renamed to a non-ASCII name is
     * not mislabeled — and never cleared (ASCII is valid UTF-8). For a
     * verbatim survivor (`nameIsUtf8` false, original `rawName`), the
     * source's own flag is preserved untouched.
     */
    const planForCopy = (source: ZipEntry, nameBytes: Uint8Array, nameIsUtf8: boolean): PlannedEntry => {
        let flags = source.flags & ~FLAG_DATA_DESCRIPTOR;
        // Set-only: a non-ASCII UTF-8 re-encoding needs bit 11 to stay
        // truthful; an ASCII name is valid under BOTH encodings, so an
        // already-set bit stays set (clearing it would gratuitously mutate
        // copied metadata and contradict the determinism contract's
        // "always UTF-8 with bit 11" writer rule).
        if (nameIsUtf8 && nameBytes.some((b) => b >= 0x80)) {
            flags |= FLAG_UTF8;
        }
        return {
        nameBytes,
        method: source.compressionMethod,
        flags,
        dosDate: source.dosDate,
        dosTime: source.dosTime,
        externalAttributes: source.externalAttributes,
        comment: source.comment,
        // Zip64 extras are recomputed from the new offsets; the rest travel.
        extraFields: source.extraFields.filter((f: ZipExtraField) => f.id !== EXTRA_ZIP64),
        payload: rawCompressedSlice(source),
        source: null,
        level: 6,
        deterministic: false,
        crc32: source.crc32,
        compressedSize: source.compressedSize,
        uncompressedSize: source.uncompressedSize,
        versionMadeBy: source.versionMadeBy,
        internalAttributes: source.internalAttributes,
        versionNeededMin: source.versionNeeded,
        };
    };

    /** Appended-zone plans for save(): pending writes + raw copies, canonical order. */
    const buildAppendedPlans = (): PlannedEntry[] => {
        const writeSpecs: EntrySpec[] = [];
        const copyPlans: PlannedEntry[] = [];
        for (const [name, edit] of edits) {
            if (edit.kind === 'write') {
                writeSpecs.push(specForWrite(name, edit));
            } else if (edit.kind === 'rawCopy') {
                copyPlans.push(planForCopy(edit.source, te.encode(name), true));
            }
        }
        const writePlans = planArchive(writeSpecs, new Uint8Array(0), limits, emit).plans;
        return [...writePlans, ...copyPlans].sort((a, b) => compareNames(a.nameBytes, b.nameBytes));
    };

    /** Surviving untouched source records (their CFH bytes stay verbatim). */
    const survivingSources = (): SourceRecord[] =>
        [...sourceIndex.values()].filter((record) => !edits.has(record.entry.name));

    /** Dead-bytes lower bound for the append-only layout (descriptors excluded). */
    const deadBytesEstimate = (originalLength: number): number => {
        let dead = originalLength - layout.cdOffset; // old CD + zip64 + EOCD + comment
        for (const name of edits.keys()) {
            const record = sourceIndex.get(name);
            if (record === undefined) continue;
            try {
                const lfh = parseLocalFileHeader(reader.bytes, record.entry.localHeaderOffset);
                dead += (lfh.dataStart - record.entry.localHeaderOffset) + record.entry.compressedSize;
            } catch {
                // Unparsable local header — skip; the estimate stays a lower bound.
            }
        }
        return dead;
    };

    return {
        reader,

        addEntry(name: string, data: Uint8Array | string, entryOptions?: AddEntryOptions): void {
            const bytes = typeof data === 'string' ? te.encode(data) : data;
            const finalName = validateNewName(name, false);
            if (finalName.endsWith('/') && bytes.length > 0) {
                throw new ZipError('ZIP_INVALID_OPTION',
                    `zipnative: entry name '${finalName}' ends with '/' (a directory) but carries data — `
                    + 'drop the trailing slash for a file, or pass empty data for a directory');
            }
            if (existsNow(finalName)) {
                throw new ZipError('ZIP_ENTRY_EXISTS',
                    `zipnative: entry '${finalName}' already exists — use replaceEntry() to overwrite it`);
            }
            edits.set(finalName, { kind: 'write', data: bytes, options: entryOptions });
        },

        replaceEntry(name: string, data: Uint8Array | string, entryOptions?: AddEntryOptions): void {
            const bytes = typeof data === 'string' ? te.encode(data) : data;
            const finalName = validateNewName(name, false);
            if (!existsNow(finalName)) {
                throw new ZipError('ZIP_ENTRY_NOT_FOUND',
                    `zipnative: no entry named '${finalName}' (it may have been removed) — `
                    + 'use addEntry() to create it');
            }
            edits.set(finalName, { kind: 'write', data: bytes, options: entryOptions });
        },

        removeEntry(name: string): void {
            if (!existsNow(name)) {
                throw new ZipError('ZIP_ENTRY_NOT_FOUND',
                    `zipnative: no entry named '${name}' to remove (names are case-sensitive)`);
            }
            if (sourceIndex.has(name)) {
                // Even over a pending write: replace-then-remove nets to remove.
                edits.set(name, { kind: 'remove' });
            } else {
                edits.delete(name); // session-only name: net no-op
            }
        },

        renameEntry(from: string, to: string): void {
            if (!existsNow(from)) {
                throw new ZipError('ZIP_ENTRY_NOT_FOUND',
                    `zipnative: no entry named '${from}' to rename (it may have been removed)`);
            }
            const pending = edits.get(from);
            const fromIsDirectory = pending?.kind === 'write'
                ? from.endsWith('/')
                : (sourceIndex.get(from)?.entry.isDirectory ?? from.endsWith('/'));
            const finalTo = validateNewName(to, fromIsDirectory);
            if (existsNow(finalTo)) {
                throw new ZipError('ZIP_ENTRY_EXISTS',
                    `zipnative: an entry named '${finalTo}' already exists — removeEntry() it first `
                    + '(renames never overwrite implicitly)');
            }
            // The pending edit moves; an untouched source becomes a raw copy.
            if (pending !== undefined && pending.kind !== 'remove') {
                edits.set(finalTo, pending);
            } else {
                const record = sourceIndex.get(from) as SourceRecord;
                edits.set(finalTo, { kind: 'rawCopy', source: record.entry });
            }
            if (sourceIndex.has(from)) {
                edits.set(from, { kind: 'remove' });
            } else {
                edits.delete(from);
            }
        },

        setComment(comment: string | Uint8Array): void {
            const bytes = typeof comment === 'string' ? te.encode(comment) : comment;
            enforceLimit(limits, 'maxCommentBytes', bytes.length, 'archive comment length');
            pendingComment = bytes;
        },

        save(): Uint8Array {
            // No-op fast path: the identical buffer, zero copy.
            if (edits.size === 0
                && (pendingComment === null || bytesEqual(pendingComment, layout.comment))) {
                return reader.bytes;
            }

            const original = reader.bytes;
            const base = layout.base;
            const segments: Uint8Array[] = [original];
            let abs = original.length;
            const emitSeg = (bytes: Uint8Array): void => {
                segments.push(bytes);
                abs += bytes.length;
            };

            // ── Appended zone ────────────────────────────────────────
            const appended = buildAppendedPlans();
            const storedOffsets = new Array<number>(appended.length);
            for (let i = 0; i < appended.length; i++) {
                const plan = appended[i];
                storedOffsets[i] = abs - base;
                // Raw-copied payloads can be ≥4 GiB (a slice of an existing
                // archive, not a freshly-compressed ≤2 GiB buffer), so the
                // LFH needs the Zip64 size form. APPNOTE §4.5.3: a local-
                // header Zip64 extra must carry BOTH sizes (unlike the CD).
                const lfh64 = lfhZip64Fields(plan.uncompressedSize, plan.compressedSize);
                const lfhExtraParts: Uint8Array[] = [];
                if (lfh64.extra !== null) lfhExtraParts.push(lfh64.extra);
                if (plan.extraFields.length > 0) lfhExtraParts.push(serializeExtraFields(plan.extraFields));
                emitSeg(writeLocalFileHeader({
                    versionNeeded: Math.max(lfh64.usesZip64 ? 45 : 20, plan.versionNeededMin ?? 0),
                    flags: plan.flags,
                    compressionMethod: plan.method,
                    dosTime: plan.dosTime,
                    dosDate: plan.dosDate,
                    crc32: plan.crc32,
                    compressedSize: lfh64.classicCompressed,
                    uncompressedSize: lfh64.classicUncompressed,
                    name: plan.nameBytes,
                    extra: lfhExtraParts.length === 0 ? new Uint8Array(0)
                        : lfhExtraParts.length === 1 ? lfhExtraParts[0] : concatBytes(lfhExtraParts),
                }));
                if (plan.payload !== null && plan.payload.length > 0) {
                    emitSeg(plan.payload);
                }
            }

            // ── New central directory (merged, canonical order) ──────
            const cdStartAbs = abs;
            type CdItem =
                | { readonly nameBytes: Uint8Array; readonly raw: Uint8Array }
                | { readonly nameBytes: Uint8Array; readonly plan: PlannedEntry; readonly storedOffset: number };
            const items: CdItem[] = [
                ...survivingSources().map((record) => ({ nameBytes: record.entry.rawName, raw: record.rawCfh })),
                ...appended.map((plan, i) => ({ nameBytes: plan.nameBytes, plan, storedOffset: storedOffsets[i] })),
            ];
            items.sort((a, b) => compareNames(a.nameBytes, b.nameBytes));
            enforceLimit(limits, 'maxEntries', items.length, 'surviving entry count');

            for (const item of items) {
                if ('raw' in item) {
                    emitSeg(item.raw); // untouched: the source's CFH bytes, verbatim
                    continue;
                }
                const { plan, storedOffset } = item;
                // Sentinel exactly the overflowed classic fields (size AND
                // offset), matching archiveSegments and our reader's
                // lock-step Zip64 parse.
                const z64Unc = plan.uncompressedSize > SENTINEL_U32 - 1 ? plan.uncompressedSize : undefined;
                const z64Comp = plan.compressedSize > SENTINEL_U32 - 1 ? plan.compressedSize : undefined;
                const z64Off = storedOffset > SENTINEL_U32 - 1 ? storedOffset : undefined;
                const usesZip64 = z64Unc !== undefined || z64Comp !== undefined || z64Off !== undefined;
                const extraParts: Uint8Array[] = [];
                if (usesZip64) extraParts.push(buildZip64Extra(z64Unc, z64Comp, z64Off));
                if (plan.extraFields.length > 0) extraParts.push(serializeExtraFields(plan.extraFields));
                const extra = extraParts.length === 0 ? new Uint8Array(0)
                    : extraParts.length === 1 ? extraParts[0]
                        : concatBytes(extraParts);
                emitSeg(writeCentralFileHeader({
                    versionMadeBy: plan.versionMadeBy ?? 0x032D,
                    versionNeeded: Math.max(usesZip64 ? 45 : 20, plan.versionNeededMin ?? 0),
                    flags: plan.flags,
                    compressionMethod: plan.method,
                    dosTime: plan.dosTime,
                    dosDate: plan.dosDate,
                    crc32: plan.crc32,
                    compressedSize: z64Comp !== undefined ? SENTINEL_U32 : plan.compressedSize,
                    uncompressedSize: z64Unc !== undefined ? SENTINEL_U32 : plan.uncompressedSize,
                    internalAttributes: plan.internalAttributes ?? 0,
                    externalAttributes: plan.externalAttributes,
                    localHeaderOffset: z64Off !== undefined ? SENTINEL_U32 : storedOffset,
                    name: plan.nameBytes,
                    extra,
                    comment: plan.comment,
                }));
            }
            const cdSize = abs - cdStartAbs;
            const cdOffsetStored = cdStartAbs - base;
            enforceLimit(limits, 'maxCentralDirectoryBytes', cdSize, 'new central-directory size');

            // ── Trailer (same sentinel policy as archiveSegments) ────
            const count = items.length;
            const needsZip64 = count > SENTINEL_U16 - 1
                || cdSize > SENTINEL_U32 - 1
                || cdOffsetStored > SENTINEL_U32 - 1;
            if (needsZip64) {
                const z64Abs = abs;
                emitSeg(writeZip64Eocd(count, cdSize, cdOffsetStored));
                emitSeg(writeZip64Locator(z64Abs - base));
            }
            emitSeg(writeEocd(
                count > SENTINEL_U16 - 1 ? SENTINEL_U16 : count,
                cdSize > SENTINEL_U32 - 1 ? SENTINEL_U32 : cdSize,
                cdOffsetStored > SENTINEL_U32 - 1 ? SENTINEL_U32 : cdOffsetStored,
                pendingComment ?? layout.comment,
            ));

            // ── Dead-bytes diagnostic ────────────────────────────────
            const dead = deadBytesEstimate(original.length);
            if (dead / abs > 0.5) {
                emit(deadBytesRatioDiagnostic(dead, abs));
            }

            // ── Assemble ─────────────────────────────────────────────
            const out = new Uint8Array(abs);
            let pos = 0;
            for (const segment of segments) {
                out.set(segment, pos);
                pos += segment.length;
            }
            return out;
        },

        saveCompact(): Uint8Array {
            const writeSpecs: EntrySpec[] = [];
            const plans: PlannedEntry[] = [];
            for (const [name, edit] of edits) {
                if (edit.kind === 'write') {
                    writeSpecs.push(specForWrite(name, edit));
                } else if (edit.kind === 'rawCopy') {
                    plans.push(planForCopy(edit.source, te.encode(name), true));
                }
            }
            for (const record of survivingSources()) {
                plans.push(planForCopy(record.entry, record.entry.rawName, false));
            }
            plans.push(...planArchive(writeSpecs, new Uint8Array(0), limits, emit).plans);
            plans.sort((a, b) => compareNames(a.nameBytes, b.nameBytes));
            enforceLimit(limits, 'maxEntries', plans.length, 'surviving entry count');

            const ctx: ZipCtx = {
                plans,
                comment: pendingComment ?? layout.comment,
                hasStreamEntries: false,
            };
            return assembleArchive(ctx);
        },
    };
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
    }
    return out;
}
