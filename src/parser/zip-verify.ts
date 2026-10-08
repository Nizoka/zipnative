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
import { resolveLimits } from '../core/zip-limits.js';
import { openZip } from './zip-reader.js';

/** Options for {@link verifyZip}. Deliberately WITHOUT `strict`/`onDiagnostic`:
 * verification never escalates — diagnostics land in the report instead. */
export interface VerifyZipOptions {
    /** Security bounds, identical semantics to every other entry point. */
    readonly limits?: Partial<ZipLimits>;
}

/**
 * One entry's verification outcome inside a {@link ZipVerificationReport}:
 * exactly what `ZipReader.verifyEntry()` returns for it, plus its name.
 * The `skipped` reason (inherited from {@link EntryVerification}) is present
 * when the content could not be verified: `'encrypted'` and
 * `'stream-only-codec'` are design-time skips whose local header was still
 * cross-checked and which do not fail the archive on their own;
 * `'unsupported-method'` (no codec registered) counts as unverifiable and
 * fails the archive, as it did in 1.0.0 — an unknown method byte can be
 * hostile.
 */
export interface VerifiedEntry extends EntryVerification {
    readonly name: string;
}

/** The machine-readable result of {@link verifyZip}. */
export interface ZipVerificationReport {
    /**
     * Structure valid AND every verifiable entry passed AND every
     * design-time-skipped entry (encrypted, stream-only codec) has a local
     * header that agrees with the central directory.
     */
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

    // One classification, in the reader: verifyEntry() cross-checks every
    // local header (encrypted entries included) and names the skip reason
    // (issue #12). The archive rule: a design-time skip passes when its
    // local header agrees with the central directory; everything else must
    // be ok.
    const entries: VerifiedEntry[] = [];
    let allPass = true;
    for (const entry of reader.entries()) {
        const verification = reader.verifyEntry(entry);
        entries.push({ name: entry.name, ...verification });
        const designSkip = verification.skipped === 'encrypted' || verification.skipped === 'stream-only-codec';
        if (!(verification.ok || (designSkip && verification.localHeaderMatch))) allPass = false;
    }

    return {
        ok: allPass,
        error: null,
        entryCount: reader.entryCount,
        entries,
        diagnostics,
    };
}
