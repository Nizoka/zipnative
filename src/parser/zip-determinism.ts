/**
 * zipnative — Determinism analysis
 * ================================
 * `analyzeDeterminism(bytes)` reports whether an archive — from any
 * producer — is in the canonical form zipnative's own writer emits under
 * the determinism contract (docs/guides/determinism.md, level 1): DOS-epoch
 * timestamps, entries sorted by raw name bytes, the UTF-8 flag on every
 * name, no extra field but Zip64, the constant version-made-by. It is the
 * "measure" half of the reproducible-builds story; `saveCompact({
 * canonical: true })` on the modifier is the "fix" half, and this report is
 * what makes the fix verifiable.
 *
 * Both satellites (zipnative-cli `inspect`, zipnative-mcp `inspect_zip`)
 * re-derived this verdict from the public entry fields before 1.1.0; the
 * engine now owns the definition so the three surfaces cannot disagree.
 *
 * Data descriptors are NOT a determinism loss: the streamed layout is a
 * byte-stable function of its inputs, so `addStream` output passes. They
 * are reported (`noDataDescriptors`) because the buffered and streamed
 * layouts of identical content differ.
 *
 * @module parser/zip-determinism
 */

import type { DosTimeMode, ZipEntry, ZipLimits } from '../types/zip-types.js';
import { EXTRA_ZIP64, FLAG_UTF8 } from '../core/zip-constants.js';
import { DETERMINISTIC_DOS_DATE, DETERMINISTIC_DOS_TIME, dateToDosDateTime } from '../core/zip-dos-time.js';
import { compareNames } from '../core/zip-encoding.js';
import { openZip } from './zip-reader.js';

/** The version-made-by zipnative writes (Unix host, spec 4.5) — the determinism contract. */
const CANONICAL_VERSION_MADE_BY = 0x032d;

/** Options for {@link analyzeDeterminism}. */
export interface AnalyzeDeterminismOptions {
    /** Security bounds, identical semantics to every other entry point. */
    readonly limits?: Partial<ZipLimits>;
    /**
     * The one timestamp every entry must carry instead of the DOS epoch —
     * the `date` an archive was canonicalised with (`canonicalizeZip`,
     * `saveCompact({ canonical: { date } })`). Compared as DOS fields under
     * `dosTimeMode` ('local' by default, like the writer).
     */
    readonly date?: Date;
    /** How `date` is converted to DOS fields; must match the writer's. */
    readonly dosTimeMode?: DosTimeMode;
}

/** One canonical-form rule an entry breaks. */
export type DeterminismConcern =
    | 'timestamp'        // not the DOS epoch
    | 'order'            // raw name bytes sort before the previous entry's
    | 'utf8-flag'        // non-ASCII name without flag bit 11
    | 'extra-field'      // an extra field other than Zip64 (0x0001)
    | 'version-made-by'  // not the constant 0x032D
    | 'data-descriptor'; // streamed layout (informational, never fails the verdict)

/** One entry and the rule it breaks. */
export interface DeterminismOffender {
    readonly name: string;
    readonly concern: DeterminismConcern;
}

/** The machine-readable result of {@link analyzeDeterminism}. */
export interface DeterminismReport {
    /**
     * Every entry is in the canonical form: epoch timestamps, canonical
     * order, UTF-8 flags, Zip64-only extras, the constant version-made-by.
     * Data descriptors do not count against it.
     */
    readonly deterministic: boolean;
    /** Every entry's DOS timestamp is the epoch (1980-01-01 00:00:00). */
    /** Every entry carries the DOS epoch — or the pinned `date` passed in the options. */
    readonly epochTimestamps: boolean;
    /** Entries are sorted by raw name bytes, unsigned bytewise. */
    readonly canonicalOrder: boolean;
    /** Every non-ASCII name carries flag bit 11 (ASCII names are valid either way). */
    readonly utf8Flags: boolean;
    /** No extra field other than Zip64 (0x0001) on any entry. */
    readonly canonicalExtras: boolean;
    /** Every entry's version-made-by is 0x032D. */
    readonly canonicalVersionMadeBy: boolean;
    /** No entry uses the data-descriptor (streamed) layout. */
    readonly noDataDescriptors: boolean;
    readonly entryCount: number;
    /** Every rule broken, entry by entry, in central-directory order. */
    readonly offenders: readonly DeterminismOffender[];
}

function isAscii(bytes: Uint8Array): boolean {
    for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) return false;
    return true;
}

/**
 * Analyse an archive against the canonical deterministic form. Throws like
 * `openZip` when the bytes are not a well-formed archive (a report about an
 * archive that cannot be opened would be meaningless); caller mistakes
 * (invalid limits) throw before any parsing.
 *
 * @since 1.1.0
 */
export function analyzeDeterminism(bytes: Uint8Array, options?: AnalyzeDeterminismOptions): DeterminismReport {
    const reader = openZip(bytes, { limits: options?.limits, onDiagnostic: () => undefined });
    const offenders: DeterminismOffender[] = [];
    let epochTimestamps = true;
    let canonicalOrder = true;
    let utf8Flags = true;
    let canonicalExtras = true;
    let canonicalVersionMadeBy = true;
    let noDataDescriptors = true;
    let previous: ZipEntry | null = null;
    let count = 0;
    const pinned = options?.date === undefined
        ? { dosDate: DETERMINISTIC_DOS_DATE, dosTime: DETERMINISTIC_DOS_TIME }
        : dateToDosDateTime(options.date, options.dosTimeMode);

    for (const entry of reader.entries()) {
        count++;
        if (entry.dosDate !== pinned.dosDate || entry.dosTime !== pinned.dosTime) {
            epochTimestamps = false;
            offenders.push({ name: entry.name, concern: 'timestamp' });
        }
        if (previous !== null && compareNames(previous.rawName, entry.rawName) > 0) {
            canonicalOrder = false;
            offenders.push({ name: entry.name, concern: 'order' });
        }
        if ((entry.flags & FLAG_UTF8) === 0 && !isAscii(entry.rawName)) {
            utf8Flags = false;
            offenders.push({ name: entry.name, concern: 'utf8-flag' });
        }
        if (entry.extraFields.some((f) => f.id !== EXTRA_ZIP64)) {
            canonicalExtras = false;
            offenders.push({ name: entry.name, concern: 'extra-field' });
        }
        if (entry.versionMadeBy !== CANONICAL_VERSION_MADE_BY) {
            canonicalVersionMadeBy = false;
            offenders.push({ name: entry.name, concern: 'version-made-by' });
        }
        if (entry.usesDataDescriptor) {
            noDataDescriptors = false;
            offenders.push({ name: entry.name, concern: 'data-descriptor' });
        }
        previous = entry;
    }

    return {
        deterministic: epochTimestamps && canonicalOrder && utf8Flags && canonicalExtras && canonicalVersionMadeBy,
        epochTimestamps,
        canonicalOrder,
        utf8Flags,
        canonicalExtras,
        canonicalVersionMadeBy,
        noDataDescriptors,
        entryCount: count,
        offenders,
    };
}
