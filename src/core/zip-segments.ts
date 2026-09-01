/**
 * zipnative — Shared archive segment generator
 * ============================================
 * THE architectural centerpiece of the write path, in two explicit
 * phases (the pdfnative pagetree pattern):
 *
 *   1. `planArchive()` — canonicalization, compression, validation and
 *      every Zip64 decision. Anything that can throw does so HERE, so a
 *      tripped limit never yields a partial archive.
 *   2. `archiveSegments()` — emission. Both the buffered and streaming
 *      writers consume this one generator, so their output is
 *      byte-identical by construction.
 *
 * Offsets are advanced by a single `seg()` helper — the recorded
 * local-header offsets can never drift from what was actually emitted.
 * Compressed payloads are yielded zero-copy and freed as they go, so a
 * context can be DRAINED EXACTLY ONCE; the builder re-plans for every
 * output call.
 *
 * Stream-sourced entries yield a `stream-entry` segment: the buffered
 * writer rejects it (use `stream()`), the streaming writer expands it —
 * compressing chunk-wise, emitting the data descriptor — and reports the
 * bytes it wrote back into the generator via `next(consumed)` so the
 * offset stays exact.
 *
 * @module core/zip-segments
 */

import {
    type ZipDiagnosticEmitter,
    type ZipExtraField,
    type ZipLimits,
} from '../types/zip-types.js';
import { ZipError, ZipUnsupportedError } from '../types/zip-errors.js';
import { crc32 } from '../codecs/crc32.js';
import { getCodec, METHOD_DEFLATE, METHOD_STORE } from '../codecs/codec-registry.js';
import { FLAG_DATA_DESCRIPTOR, FLAG_UTF8, SENTINEL_U16, SENTINEL_U32 } from './zip-constants.js';
import { enforceLimit } from './zip-limits.js';
import { buildZip64Extra, serializeExtraFields } from './zip-extra-fields.js';
import {
    writeCentralFileHeader,
    writeEocd,
    writeLocalFileHeader,
    writeZip64Eocd,
    writeZip64Locator,
} from './zip-structs.js';

/** One entry as specified by the builder, before planning. */
export interface EntrySpec {
    readonly nameBytes: Uint8Array;
    readonly isDirectory: boolean;
    /** Uncompressed content (buffered entries). */
    readonly data: Uint8Array | null;
    /** Chunked content (stream entries — data-descriptor layout). */
    readonly source: AsyncIterable<Uint8Array> | null;
    readonly method: 'store' | 'deflate';
    readonly level: number;
    readonly deterministic: boolean;
    readonly dosDate: number;
    readonly dosTime: number;
    readonly externalAttributes: number;
    readonly comment: Uint8Array;
    readonly extraFields: readonly ZipExtraField[];
}

/** One planned entry: codec resolved, payload compressed, sizes known. */
export interface PlannedEntry {
    readonly nameBytes: Uint8Array;
    readonly method: number;
    readonly flags: number;
    readonly dosDate: number;
    readonly dosTime: number;
    readonly externalAttributes: number;
    readonly comment: Uint8Array;
    readonly extraFields: readonly ZipExtraField[];
    /** Compressed payload (buffered entries); freed after emission. */
    payload: Uint8Array | null;
    /** Chunked source (stream entries). */
    readonly source: AsyncIterable<Uint8Array> | null;
    readonly level: number;
    readonly deterministic: boolean;
    /** Mutated by the stream writer once the source is consumed. */
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    // ── Source-fidelity overrides (set only by the modifier when copying
    //    existing entries; planArchive never sets them, so createZip's
    //    bytes — the determinism contract — are untouched) ─────────────
    readonly versionMadeBy?: number;
    readonly internalAttributes?: number;
    /** Floor for version-needed (e.g. an exotic-method source entry). */
    readonly versionNeededMin?: number;
}

/** Fully planned archive — drain with `archiveSegments()` exactly once. */
export interface ZipCtx {
    readonly plans: PlannedEntry[];
    readonly comment: Uint8Array;
    readonly hasStreamEntries: boolean;
}

export type ZipSegment =
    | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
    | { readonly kind: 'stream-entry'; readonly plan: PlannedEntry };

/** Per-spec guards shared by the sync and async planners. */
function checkSpec(spec: EntrySpec, limits: ZipLimits): void {
    enforceLimit(limits, 'maxNameBytes', spec.nameBytes.length, 'entry name length');
    enforceLimit(limits, 'maxCommentBytes', spec.comment.length, 'entry comment length');
}

/** Build the plan for one stream-sourced spec (data-descriptor layout). */
function buildStreamPlan(spec: EntrySpec): PlannedEntry {
    return {
        nameBytes: spec.nameBytes,
        method: spec.method === 'store' ? METHOD_STORE : METHOD_DEFLATE,
        flags: FLAG_UTF8 | FLAG_DATA_DESCRIPTOR,
        dosDate: spec.dosDate,
        dosTime: spec.dosTime,
        externalAttributes: spec.externalAttributes,
        comment: spec.comment,
        extraFields: spec.extraFields,
        payload: null,
        source: spec.source,
        level: spec.level,
        deterministic: spec.deterministic,
        crc32: 0,
        compressedSize: 0,
        uncompressedSize: 0,
    };
}

/**
 * Finish one buffered spec into a PlannedEntry, applying THE deterministic
 * method rules in one place (sync and parallel planning both land here, so
 * the rules physically cannot drift): empty content is always stored, and
 * deflate falls back to store when it does not shrink the payload — both
 * pure functions of the content (docs/determinism.md).
 *
 * @param compressed - Deflate output for this data, or null when the spec
 *                     asked for store (or the data is empty)
 */
function finishBufferedPlan(
    spec: EntrySpec,
    data: Uint8Array,
    compressed: Uint8Array | null,
    crc: number,
): PlannedEntry {
    let method = spec.method === 'store' || data.length === 0 ? METHOD_STORE : METHOD_DEFLATE;
    let payload: Uint8Array;
    if (method === METHOD_DEFLATE && compressed !== null) {
        if (compressed.length >= data.length) {
            method = METHOD_STORE;
            payload = data;
        } else {
            payload = compressed;
        }
    } else {
        method = METHOD_STORE;
        payload = data;
    }
    return {
        nameBytes: spec.nameBytes,
        method,
        flags: FLAG_UTF8,
        dosDate: spec.dosDate,
        dosTime: spec.dosTime,
        externalAttributes: spec.externalAttributes,
        comment: spec.comment,
        extraFields: spec.extraFields,
        payload,
        source: null,
        level: spec.level,
        deterministic: spec.deterministic,
        crc32: crc,
        compressedSize: payload.length,
        uncompressedSize: data.length,
    };
}

function needsDeflate(spec: EntrySpec, data: Uint8Array): boolean {
    return spec.method === 'deflate' && data.length > 0;
}

/**
 * Phase 1: compress, canonicalize and validate. Entries arrive already
 * ordered and de-duplicated by the builder. Throws before any emission.
 */
export function planArchive(
    specs: readonly EntrySpec[],
    comment: Uint8Array,
    limits: ZipLimits,
    _emit: ZipDiagnosticEmitter,
): ZipCtx {
    enforceLimit(limits, 'maxEntries', specs.length, 'archive entry count');
    enforceLimit(limits, 'maxCommentBytes', comment.length, 'archive comment length');

    const plans: PlannedEntry[] = [];
    let hasStreamEntries = false;

    for (const spec of specs) {
        checkSpec(spec, limits);
        if (spec.source !== null) {
            hasStreamEntries = true;
            plans.push(buildStreamPlan(spec));
            continue;
        }
        const data = spec.data ?? new Uint8Array(0);
        let compressed: Uint8Array | null = null;
        if (needsDeflate(spec, data)) {
            const codec = getCodec(METHOD_DEFLATE);
            if (codec?.compressSync === undefined) {
                throw new ZipError('ZIP_INTERNAL', 'zipnative: the deflate codec has no compressor registered (internal invariant)');
            }
            compressed = codec.compressSync(data, { level: spec.level, deterministic: spec.deterministic });
        }
        plans.push(finishBufferedPlan(spec, data, compressed, crc32(data)));
    }

    return { plans, comment, hasStreamEntries };
}

/**
 * @internal Injected compressor for {@link planArchiveAsync} — the worker
 * pool supplies it (injection keeps the layering: core never imports
 * worker). Returns the raw-deflate bytes AND the CRC-32 of the input
 * (computed wherever the bytes already are).
 */
export type AsyncDeflate = (data: Uint8Array, level: number, deterministic: boolean)
    => Promise<{ compressed: Uint8Array; crc: number }>;

/**
 * @internal Async twin of {@link planArchive}: identical guards, identical
 * method rules (both call `finishBufferedPlan`), but deflate jobs run
 * CONCURRENTLY through the injected compressor. Plans assemble in spec
 * order — parallelism changes scheduling, never bytes.
 */
export async function planArchiveAsync(
    specs: readonly EntrySpec[],
    comment: Uint8Array,
    limits: ZipLimits,
    _emit: ZipDiagnosticEmitter,
    deflate: AsyncDeflate,
): Promise<ZipCtx> {
    enforceLimit(limits, 'maxEntries', specs.length, 'archive entry count');
    enforceLimit(limits, 'maxCommentBytes', comment.length, 'archive comment length');

    for (const spec of specs) {
        checkSpec(spec, limits);
    }

    const jobs = specs.map((spec): Promise<{ compressed: Uint8Array; crc: number } | null> => {
        if (spec.source !== null) return Promise.resolve(null);
        const data = spec.data ?? new Uint8Array(0);
        if (!needsDeflate(spec, data)) return Promise.resolve(null);
        return deflate(data, spec.level, spec.deterministic);
    });
    const results = await Promise.all(jobs);

    const plans: PlannedEntry[] = [];
    let hasStreamEntries = false;
    for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        if (spec.source !== null) {
            hasStreamEntries = true;
            plans.push(buildStreamPlan(spec));
            continue;
        }
        const data = spec.data ?? new Uint8Array(0);
        const result = results[i];
        plans.push(finishBufferedPlan(spec, data, result?.compressed ?? null, result?.crc ?? crc32(data)));
    }
    return { plans, comment, hasStreamEntries };
}

/**
 * @internal Drain a context through the buffered path into one archive.
 * Shared by `createZip.toBytes`, the modifier's `saveCompact`, and the
 * worker writer.
 */
export function assembleArchive(ctx: ZipCtx): Uint8Array {
    const segments: Uint8Array[] = [];
    let total = 0;
    const generator = archiveSegments(ctx);
    for (let res = generator.next(); !res.done; res = generator.next()) {
        const segment = res.value;
        if (segment.kind !== 'bytes') {
            throw new ZipError('ZIP_INTERNAL', 'zipnative: unexpected stream segment in the buffered writer (internal invariant)');
        }
        segments.push(segment.bytes);
        total += segment.bytes.length;
    }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const segment of segments) {
        out.set(segment, pos);
        pos += segment.length;
    }
    return out;
}

/**
 * Phase 2: emit the archive as a sequence of segments (local headers,
 * payloads, central directory, Zip64 records, EOCD). Both the buffered
 * and streaming writers consume this, so their output is byte-identical
 * by construction. Payloads are freed as they are emitted — a context
 * drains exactly once.
 */
export function* archiveSegments(ctx: ZipCtx): Generator<ZipSegment, void, number | undefined> {
    let offset = 0;
    const offsets = new Array<number>(ctx.plans.length);

    /** The single place emitted bytes advance the offset (no drift). */
    const seg = (bytes: Uint8Array): ZipSegment => {
        offset += bytes.length;
        return { kind: 'bytes', bytes };
    };

    // ── Local headers + payloads ─────────────────────────────────────
    for (let i = 0; i < ctx.plans.length; i++) {
        const plan = ctx.plans[i];
        offsets[i] = offset;
        const isStream = plan.source !== null;

        // Buffered in-memory payloads never exceed 4 GiB (2 GiB input
        // cap), so LFH sizes need no Zip64 form; user extras only.
        const lfhExtra = serializeExtraFields(plan.extraFields);
        yield seg(writeLocalFileHeader({
            versionNeeded: 20,
            flags: plan.flags,
            compressionMethod: plan.method,
            dosTime: plan.dosTime,
            dosDate: plan.dosDate,
            crc32: isStream ? 0 : plan.crc32,
            compressedSize: isStream ? 0 : plan.compressedSize,
            uncompressedSize: isStream ? 0 : plan.uncompressedSize,
            name: plan.nameBytes,
            extra: lfhExtra,
        }));

        if (isStream) {
            // The stream writer compresses the source, emits the data
            // descriptor, fills plan.crc32/sizes, and reports the bytes
            // it wrote so the offset stays exact.
            const consumed = yield { kind: 'stream-entry', plan };
            offset += consumed ?? 0;
        } else if (plan.payload !== null && plan.payload.length > 0) {
            yield seg(plan.payload);
            plan.payload = null; // free as we go
        }
    }

    // ── Central directory ────────────────────────────────────────────
    const cdOffset = offset;
    for (let i = 0; i < ctx.plans.length; i++) {
        const plan = ctx.plans[i];
        const z64Unc = plan.uncompressedSize > SENTINEL_U32 - 1 ? plan.uncompressedSize : undefined;
        const z64Comp = plan.compressedSize > SENTINEL_U32 - 1 ? plan.compressedSize : undefined;
        const z64Off = offsets[i] > SENTINEL_U32 - 1 ? offsets[i] : undefined;
        const usesZip64 = z64Unc !== undefined || z64Comp !== undefined || z64Off !== undefined;

        const extraParts: Uint8Array[] = [];
        if (usesZip64) extraParts.push(buildZip64Extra(z64Unc, z64Comp, z64Off));
        if (plan.extraFields.length > 0) extraParts.push(serializeExtraFields(plan.extraFields));
        const extra = concat(extraParts);

        yield seg(writeCentralFileHeader({
            versionMadeBy: plan.versionMadeBy ?? 0x032D, // Unix, spec 4.5 — constant (determinism contract)
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
            localHeaderOffset: z64Off !== undefined ? SENTINEL_U32 : offsets[i],
            name: plan.nameBytes,
            extra,
            comment: plan.comment,
        }));
    }
    const cdSize = offset - cdOffset;

    // ── Zip64 EOCD + locator (only when a classic field overflows) ───
    const count = ctx.plans.length;
    const needsZip64 = count > SENTINEL_U16 - 1 || cdSize > SENTINEL_U32 - 1 || cdOffset > SENTINEL_U32 - 1;
    if (needsZip64) {
        const z64Pos = offset;
        yield seg(writeZip64Eocd(count, cdSize, cdOffset));
        yield seg(writeZip64Locator(z64Pos));
    }

    // Sentinel only the overflowed classic fields (spec-preferred; our
    // reader cross-checks non-sentinel values against the Zip64 record).
    yield seg(writeEocd(
        count > SENTINEL_U16 - 1 ? SENTINEL_U16 : count,
        cdSize > SENTINEL_U32 - 1 ? SENTINEL_U32 : cdSize,
        cdOffset > SENTINEL_U32 - 1 ? SENTINEL_U32 : cdOffset,
        ctx.comment,
    ));
}

/** Guard against >4 GiB stream entries (Zip64 streaming is out of scope pre-1.0). */
export function assertStreamSizesInRange(plan: PlannedEntry, entryName: string): void {
    if (plan.uncompressedSize > SENTINEL_U32 - 1 || plan.compressedSize > SENTINEL_U32 - 1) {
        throw new ZipUnsupportedError('ZIP_UNSUPPORTED_ZIP64_STREAMING',
            `zipnative: stream entry '${entryName}' exceeds 4 GiB — Zip64 streaming is not supported yet; `
            + 'buffer the content via add() or split it (see README Known Limitations)',
            'zip64-streaming');
    }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
    if (parts.length === 0) return new Uint8Array(0);
    if (parts.length === 1) return parts[0];
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
    }
    return out;
}
