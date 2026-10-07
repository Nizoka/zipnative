/**
 * zipnative — Archive builder
 * ===========================
 * `createZip()` returns a closure-factory writer with two output paths —
 * `toBytes()` (sync, buffered) and `stream()` (async, bounded memory) —
 * that consume the SAME segment generator (`core/zip-segments.ts`), so
 * their output is byte-identical by construction.
 *
 * Determinism contract (docs/determinism.md): canonical entry order
 * (raw-name bytes, or `order: 'insertion'`), DOS-epoch default
 * timestamp, constant version-made-by and external attributes, UTF-8
 * names with flag bit 11, Zip64 records exactly when a field overflows,
 * and — with `compression: { deterministic: true }` — the pure-TS
 * deflate encoder pinned so bytes are identical on every runtime.
 *
 * @module core/zip-builder
 */

import {
    type ZipCommonOptions,
    type ZipExtraField,
} from '../types/zip-types.js';
import { ZipError, ZipFormatError } from '../types/zip-errors.js';
import { activeDeflateTier } from '../codecs/deflate.js';
import { DOS_ATTR_DIRECTORY } from './zip-constants.js';
import { createDiagnosticEmitter, nondeterministicCodecDiagnostic, timestampClampedDiagnostic, timestampNotPinnedDiagnostic } from './zip-diagnostics.js';
import { compareNames, validateEntryName } from './zip-encoding.js';
import { dateToDosDateTime, DETERMINISTIC_DOS_DATE, DETERMINISTIC_DOS_TIME } from './zip-dos-time.js';
import { resolveLimits } from './zip-limits.js';
import { assembleArchive, planArchive, type EntrySpec, type ZipCtx } from './zip-segments.js';
import { toByteIterable, type ByteSource } from './zip-source.js';
import { streamArchive, type StreamOptions } from './zip-stream-writer.js';

/** Per-entry / archive-default compression settings. */
export interface ZipCompressionOptions {
    /** `'deflate'` (default) or `'store'`. */
    readonly method?: 'store' | 'deflate';
    /** 0–9 effort hint. Default 6. */
    readonly level?: number;
    /**
     * Pin the pure-TS deflate encoder so output bytes are identical on
     * every runtime (slower). Default `false`: the best available tier
     * is used and bytes are stable only per environment.
     */
    readonly deterministic?: boolean;
}

/** Options for {@link createZip}. */
export interface CreateZipOptions extends ZipCommonOptions {
    /**
     * `'canonical'` (default): entries sorted by raw UTF-8 name bytes.
     * `'insertion'`: call order preserved (the EPUB/JAR mimetype-first
     * cases) — still deterministic given identical call order.
     */
    readonly order?: 'canonical' | 'insertion';
    /**
     * Timestamp for entries that don't set their own. Default: the DOS
     * epoch (1980-01-01 00:00:00) for reproducible output. `'now'` uses
     * the wall clock and emits ZIP_TIMESTAMP_NOT_PINNED.
     */
    readonly defaultDate?: Date | 'now';
    /** Archive-default compression (overridable per entry). */
    readonly compression?: ZipCompressionOptions;
    readonly comment?: string | Uint8Array;
}

/** Per-entry options for `add`/`addDirectory`/`addStream`. */
export interface AddEntryOptions {
    readonly compression?: ZipCompressionOptions;
    /** Overrides the archive's `defaultDate` for this entry. */
    readonly date?: Date;
    readonly comment?: string;
    /** Overrides the canonical default (0o100644 files, 0o40755 dirs). */
    readonly externalAttributes?: number;
    /** Extra fields to embed verbatim — the caller owns their determinism. */
    readonly extraFields?: readonly ZipExtraField[];
    /**
     * `addStream()` only: opt the entry into the Zip64 streaming layout
     * for content that MAY exceed 4 GiB — the local header carries a
     * speculative Zip64 extra (both sizes as zero placeholders, APPNOTE
     * §4.5.3), the trailing data descriptor is the 24-byte form, and the
     * central record always carries both final sizes in its Zip64 extra.
     * Without it a stream crossing 4 GiB is refused mid-output
     * (`ZIP_UNSUPPORTED_ZIP64_STREAMING`). Opt in only for entries that
     * may really exceed 4 GiB: streaming readers that size the descriptor
     * from the measured lengths (Java's ZipInputStream) cannot read a small
     * entry written in this layout; random-access readers (unzip, 7-Zip,
     * python, bsdtar, jar, Expand-Archive, zipnative) read it fine. Buffered
     * entries (`add`, `addDirectory`, the modifier) promote to Zip64
     * automatically and reject this option (`ZIP_INVALID_OPTION`).
     * `deterministic: true` still buffers a stream through the pure encoder,
     * whose 2 GiB input cap this option does not lift.
     *
     * @since 1.1.0
     */
    readonly zip64?: boolean;
}

/** Archive writer — obtain via {@link createZip}. */
export interface ZipWriter {
    /** Add one file from bytes (or a UTF-8 string). Duplicate names throw. */
    add(name: string, data: Uint8Array | string, options?: AddEntryOptions): void;
    /** Add an explicit directory entry (a trailing `/` is appended if absent). */
    addDirectory(name: string, options?: AddEntryOptions): void;
    /**
     * Add one file from an async chunk source — an `AsyncIterable` or a
     * Web `ReadableStream<Uint8Array>` (0.9+). Forces the data-descriptor
     * layout for this entry and makes `toBytes()` unavailable — use
     * `stream()`. Sources are consumed once; the writer becomes
     * single-shot. Entries beyond 4 GiB are rejected (Known Limitations).
     */
    addStream(name: string, source: ByteSource, options?: AddEntryOptions): void;
    setComment(comment: string | Uint8Array): void;

    /** Assemble the archive synchronously. Throws if addStream() was used. */
    toBytes(): Uint8Array;
    /**
     * Assemble the archive as fixed-size chunks with bounded memory —
     * byte-identical to `toBytes()` for buffer-only content.
     */
    stream(options?: StreamOptions): AsyncGenerator<Uint8Array, void, undefined>;
}

const te = new TextEncoder();

/**
 * @internal Shared add/validate/order state behind `createZip` and the
 * worker subpath's `createParallelZip` — ONE implementation of the name
 * rules, defaults resolution, ordering and plan-time diagnostics, so the
 * two writers' bytes cannot drift. Exported from this module but not
 * from `src/index.ts` (private by doctrine).
 */
export interface SpecCollector {
    readonly limits: ReturnType<typeof resolveLimits>;
    readonly emit: ReturnType<typeof createDiagnosticEmitter>;
    add(name: string, data: Uint8Array | string, options?: AddEntryOptions): void;
    addDirectory(name: string, options?: AddEntryOptions): void;
    addStream(name: string, source: AsyncIterable<Uint8Array>, options?: AddEntryOptions): void;
    setComment(comment: string | Uint8Array): void;
    hasStreamEntries(): boolean;
    /** Specs in emission order (canonical sort or insertion order). */
    orderedSpecs(): EntrySpec[];
    comment(): Uint8Array;
    /** The plan-time reproducibility-intent diagnostic (once per output call). */
    emitPlanDiagnostics(): void;
}

/** @internal See {@link SpecCollector}. */
export function createSpecCollector(options?: CreateZipOptions): SpecCollector {
    // Validate early, before any entry is accepted.
    const limits = resolveLimits(options?.limits);
    const emit = createDiagnosticEmitter(options?.strict, options?.onDiagnostic);
    const order = options?.order ?? 'canonical';

    const defaultCompression = options?.compression;
    const defaultMethod = defaultCompression?.method ?? 'deflate';
    const defaultLevel = defaultCompression?.level ?? 6;
    const defaultDeterministic = defaultCompression?.deterministic === true;
    // Validate every compression level — archive default AND per-entry — so
    // the node:zlib tier can never surface a raw RangeError (the pure tier
    // already throws a typed ZipError; this keeps the two tiers in step).
    const validateLevel = (level: number): void => {
        if (!Number.isInteger(level) || level < 0 || level > 9) {
            throw new ZipError('ZIP_INVALID_OPTION', `zipnative: compression.level must be an integer 0-9 (got ${String(level)})`);
        }
    };
    validateLevel(defaultLevel);

    // Resolve the default timestamp ONCE so every entry of one archive
    // shares it (and so 'now' costs a single diagnostic). The wall-clock
    // the fields are read with is the archive's dosTimeMode (issue #9).
    const dosMode = options?.dosTimeMode ?? 'local';
    const toDos = (date: Date, entryName?: string): { dosDate: number; dosTime: number } => {
        const dos = dateToDosDateTime(date, dosMode);
        if (dos.clamped !== null) emit(timestampClampedDiagnostic(dos.clamped, entryName));
        return dos;
    };
    let defaultDos: { dosDate: number; dosTime: number };
    let datePinned: boolean;
    if (options?.defaultDate === 'now') {
        emit(timestampNotPinnedDiagnostic());
        defaultDos = toDos(new Date());
        datePinned = false;
    } else if (options?.defaultDate instanceof Date) {
        defaultDos = toDos(options.defaultDate);
        datePinned = true;
    } else {
        defaultDos = { dosDate: DETERMINISTIC_DOS_DATE, dosTime: DETERMINISTIC_DOS_TIME };
        datePinned = false; // the epoch default needs no reproducibility warning
    }

    const specs: EntrySpec[] = [];
    const names = new Set<string>();
    let archiveComment: Uint8Array = options?.comment === undefined
        ? new Uint8Array(0)
        : typeof options.comment === 'string' ? te.encode(options.comment) : options.comment;
    let hasStreamEntries = false;

    const makeSpec = (
        name: string,
        isDirectory: boolean,
        data: Uint8Array | null,
        source: AsyncIterable<Uint8Array> | null,
        entryOptions: AddEntryOptions | undefined,
    ): void => {
        const finalName = validateEntryName(name, isDirectory);
        // Validate early: the Zip64 streaming opt-in has no meaning for a
        // buffered entry (those promote automatically), so a caller setting
        // it there is corrected at the call site, not silently ignored.
        if (entryOptions?.zip64 !== undefined && source === null) {
            throw new ZipError('ZIP_INVALID_OPTION',
                `zipnative: entry '${finalName}': zip64 applies to addStream() only — buffered entries promote to Zip64 automatically`);
        }
        if (names.has(finalName)) {
            throw new ZipFormatError('ZIP_DUPLICATE_ENTRY_NAME',
                `zipnative: duplicate entry name '${finalName}' — every archive path must be unique`);
        }
        names.add(finalName);

        const compression = entryOptions?.compression;
        if (compression?.level !== undefined) validateLevel(compression.level);
        const dos = entryOptions?.date !== undefined ? toDos(entryOptions.date, finalName) : defaultDos;
        specs.push({
            nameBytes: te.encode(finalName),
            isDirectory,
            data: isDirectory ? new Uint8Array(0) : data,
            source,
            method: isDirectory ? 'store' : (compression?.method ?? defaultMethod),
            level: compression?.level ?? defaultLevel,
            deterministic: compression?.deterministic ?? defaultDeterministic,
            dosDate: dos.dosDate,
            dosTime: dos.dosTime,
            externalAttributes: entryOptions?.externalAttributes
                ?? (isDirectory ? ((0o040755 << 16) | DOS_ATTR_DIRECTORY) >>> 0 : (0o100644 << 16) >>> 0),
            comment: entryOptions?.comment === undefined ? new Uint8Array(0) : te.encode(entryOptions.comment),
            extraFields: entryOptions?.extraFields ?? [],
            zip64: entryOptions?.zip64 === true,
        });
    };

    return {
        limits,
        emit,
        add(name: string, data: Uint8Array | string, entryOptions?: AddEntryOptions): void {
            const bytes = typeof data === 'string' ? te.encode(data) : data;
            makeSpec(name, false, bytes, null, entryOptions);
        },
        addDirectory(name: string, entryOptions?: AddEntryOptions): void {
            makeSpec(name, true, null, null, entryOptions);
        },
        addStream(name: string, source: ByteSource, entryOptions?: AddEntryOptions): void {
            hasStreamEntries = true;
            // Normalise once at the boundary — everything downstream (the
            // stream writer, the parallel writer) sees an AsyncIterable.
            makeSpec(name, false, null, toByteIterable(source), entryOptions);
        },
        setComment(comment: string | Uint8Array): void {
            archiveComment = typeof comment === 'string' ? te.encode(comment) : comment;
        },
        hasStreamEntries: (): boolean => hasStreamEntries,
        orderedSpecs: (): EntrySpec[] =>
            order === 'canonical'
                ? [...specs].sort((a, b) => compareNames(a.nameBytes, b.nameBytes))
                : specs,
        comment: (): Uint8Array => archiveComment,
        emitPlanDiagnostics: (): void => {
            // Reproducibility-intent heuristic: a caller who pinned an explicit
            // date but left the codec unpinned gets one info diagnostic that
            // bytes still vary across zlib builds.
            if (datePinned && !defaultDeterministic && activeDeflateTier(false) !== 'pure') {
                emit(nondeterministicCodecDiagnostic());
            }
        },
    };
}

/**
 * Create an archive writer.
 *
 * Cheap by design: nothing is compressed until `toBytes()`/`stream()`,
 * each of which plans the archive fresh from the added entries.
 */
export function createZip(options?: CreateZipOptions): ZipWriter {
    const collector = createSpecCollector(options);

    /** Plan a fresh context for one output call (contexts drain once). */
    const plan = (): ZipCtx => {
        collector.emitPlanDiagnostics();
        return planArchive(collector.orderedSpecs(), collector.comment(), collector.limits, collector.emit);
    };

    return {
        add: collector.add,
        addDirectory: collector.addDirectory,
        addStream: collector.addStream,
        setComment: collector.setComment,

        toBytes(): Uint8Array {
            if (collector.hasStreamEntries()) {
                throw new ZipError('ZIP_API_MISUSE',
                    'zipnative: toBytes() is incompatible with addStream() entries (their sizes are only '
                    + 'known after the source is consumed). Use stream(), or buffer the content via add().');
            }
            return assembleArchive(plan());
        },

        stream(streamOptions?: StreamOptions): AsyncGenerator<Uint8Array, void, undefined> {
            return streamArchive(plan, streamOptions);
        },
    };
}
