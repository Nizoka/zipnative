/**
 * zipnative — One-call deep archive verification
 * ==============================================
 * `verifyZip(data)` answers "is this archive intact?" as a single
 * machine-readable report: structural validation (the eager reader
 * pass), per-entry CRC/size/local-header verification, and every
 * conformance diagnostic the parse emitted — without the caller wiring
 * `openZip` + `verifyEntry` + `onDiagnostic` together.
 *
 * The contract that makes it agent-grade: **verifyZip never throws for
 * a problem with the archive.** A structural refusal becomes
 * `report.error` (carrying the frozen `err.code`); an unverifiable
 * entry (encrypted, or a registered codec without a sync decompressor)
 * is reported as `skipped` with its reason instead of masquerading as
 * corruption. Only caller mistakes (invalid `limits`) still throw.
 *
 * @module parser/zip-verify
 */

import type { EntryVerification, ZipDiagnostic, ZipLimits } from '../types/zip-types.js';
import { ZipError } from '../types/zip-errors.js';
import { getCodec } from '../codecs/codec-registry.js';
import { resolveLimits } from '../core/zip-limits.js';
import { openZip } from './zip-reader.js';

/** Options for {@link verifyZip}. Deliberately WITHOUT `strict`/`onDiagnostic`:
 * verification never escalates — diagnostics land in the report instead. */
export interface VerifyZipOptions {
    /** Security bounds, identical semantics to every other entry point. */
    readonly limits?: Partial<ZipLimits>;
}

/** One entry's verification outcome inside a {@link ZipVerificationReport}. */
export interface VerifiedEntry extends EntryVerification {
    readonly name: string;
    /**
     * Present when the entry's content could not be verified at all:
     * `'encrypted'` (payload undecryptable by design) or
     * `'stream-only-codec'` (a registered codec without `decompressSync`).
     * Skipped entries still had their local header cross-checked and do
     * not fail the archive on their own.
     */
    readonly skipped?: 'encrypted' | 'stream-only-codec';
}

/** The machine-readable result of {@link verifyZip}. */
export interface ZipVerificationReport {
    /** Structure valid AND every verifiable entry passed. */
    readonly ok: boolean;
    /** The structural refusal, when the archive could not even be opened. */
    readonly error: { readonly code: string; readonly message: string } | null;
    readonly entryCount: number;
    readonly entries: readonly VerifiedEntry[];
    /** Every conformance diagnostic the parse emitted (deduplicated by nothing — raw). */
    readonly diagnostics: readonly ZipDiagnostic[];
}

/**
 * Deep-verify an archive in one call: eager structural validation,
 * per-entry CRC-32/size/local-header checks, diagnostics collected.
 * Sync, in-memory, non-throwing for archive problems — see the module
 * header for the exact contract.
 */
export function verifyZip(data: Uint8Array, options?: VerifyZipOptions): ZipVerificationReport {
    // Caller mistakes still throw, before any parsing: an invalid limits
    // object is a bug at the call site, not a property of the archive.
    resolveLimits(options?.limits);

    const diagnostics: ZipDiagnostic[] = [];
    let reader;
    try {
        reader = openZip(data, {
            validate: 'eager',
            limits: options?.limits,
            onDiagnostic: (d) => diagnostics.push(d),
        });
    } catch (err) {
        const code = err instanceof ZipError ? err.code : 'ZIP_INTERNAL';
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { code, message }, entryCount: 0, entries: [], diagnostics };
    }

    const entries: VerifiedEntry[] = [];
    let allVerifiablePass = true;
    for (const entry of reader.entries()) {
        if (entry.isEncrypted) {
            entries.push({
                name: entry.name, ok: false, crcMatch: false, sizeMatch: false,
                localHeaderMatch: true, // the eager pass already cross-checked it
                skipped: 'encrypted',
            });
            continue;
        }
        const codec = getCodec(entry.compressionMethod);
        if (codec !== null && codec !== undefined && codec.decompressSync === undefined) {
            entries.push({
                name: entry.name, ok: false, crcMatch: false, sizeMatch: false,
                localHeaderMatch: true,
                skipped: 'stream-only-codec',
            });
            continue;
        }
        const verification = reader.verifyEntry(entry);
        entries.push({ name: entry.name, ...verification });
        if (!verification.ok) allVerifiablePass = false;
    }

    return {
        ok: allVerifiablePass,
        error: null,
        entryCount: reader.entryCount,
        entries,
        diagnostics,
    };
}
