/**
 * zipnative — Conformance diagnostics
 * ===================================
 * The single channel for non-fatal conformance concerns: odd-but-tolerated
 * archive shapes, determinism losses, quality traps. Structural failures
 * THROW; conformance concerns DIAGNOSE; the two never mix.
 *
 * Default sink: `console.warn`, deduplicated per code per operation —
 * this is the ONLY module in the library allowed to call `console.warn`
 * (AGENTS.md). Callers redirect with `onDiagnostic`, or escalate every
 * diagnostic to a thrown `Error` with `strict: true`.
 *
 * Diagnostic TYPES live in `types/zip-types.ts` so any layer can reference
 * them without importing this module — lower layers receive the emitter by
 * parameter injection.
 *
 * @module core/zip-diagnostics
 */

import {
    type ZipDiagnostic,
    type ZipDiagnosticCode,
    type ZipDiagnosticEmitter,
    type ZipDiagnosticHandler,
} from '../types/zip-types.js';

/**
 * Create the per-operation diagnostic emitter.
 *
 * - `strict: true` → the first diagnostic throws an `Error` with the
 *   diagnostic message (before any output is produced).
 * - `handler` → receives every diagnostic (no deduplication — the caller
 *   owns delivery).
 * - default → `console.warn`, once per code per operation.
 */
export function createDiagnosticEmitter(
    strict: boolean | undefined,
    handler: ZipDiagnosticHandler | undefined,
): ZipDiagnosticEmitter {
    const warned = new Set<ZipDiagnosticCode>();
    return (diagnostic: ZipDiagnostic): void => {
        if (strict) {
            throw new Error(`zipnative: ${diagnostic.message}`);
        }
        if (handler) {
            handler(diagnostic);
            return;
        }
        if (!warned.has(diagnostic.code)) {
            warned.add(diagnostic.code);
            // Sanctioned sole console sink (AGENTS.md).
            console.warn(`zipnative: ${diagnostic.message}`);
        }
    };
}

// ── Payload factories (message text cites the situation and the fix) ─

export function prependedDataDiagnostic(base: number): ZipDiagnostic {
    return {
        code: 'ZIP_PREPENDED_DATA',
        severity: 'info',
        message: `${base} byte(s) precede the archive (self-extractor stub or concatenation); `
            + 'all offsets were shifted accordingly. Verify the prefix is expected for this file.',
    };
}

export function multipleEocdDiagnostic(): ZipDiagnostic {
    return {
        code: 'ZIP_MULTIPLE_EOCD',
        severity: 'info',
        message: 'an additional end-of-central-directory signature exists inside the archive '
            + '(nested zip or an earlier revision); the self-consistent record closest to the end is authoritative.',
    };
}

export function nameMismatchDiagnostic(entryName: string): ZipDiagnostic {
    return {
        code: 'ZIP_NAME_MISMATCH',
        severity: 'warning',
        message: `entry '${entryName}': local-header filename bytes differ from the central directory `
            + '(a parser-differential trick in hostile archives); the central directory is authoritative. '
            + 'Pass strict: true to reject such archives.',
        entryName,
    };
}

export function unicodePathConflictDiagnostic(entryName: string): ZipDiagnostic {
    return {
        code: 'ZIP_UNICODE_PATH_CONFLICT',
        severity: 'warning',
        message: `entry '${entryName}': the Unicode Path extra field (0x7075) disagrees with the header name; `
            + 'zipnative never acts on 0x7075 — the header name wins. Pass strict: true to reject such archives.',
        entryName,
    };
}

export function invalidUtf8NameDiagnostic(entryName: string): ZipDiagnostic {
    return {
        code: 'ZIP_INVALID_UTF8_NAME',
        severity: 'warning',
        message: `entry '${entryName}': the UTF-8 flag (bit 11) is set but the name bytes are not valid UTF-8; `
            + 'decoded as CP437 instead. The producer of this archive is buggy.',
        entryName,
    };
}

export function duplicateNameDiagnostic(entryName: string): ZipDiagnostic {
    return {
        code: 'ZIP_DUPLICATE_NAME',
        severity: 'warning',
        message: `entry '${entryName}' appears more than once in the central directory; `
            + "getEntry() returns the last occurrence. extractZip defaults to onDuplicate: 'error'.",
        entryName,
    };
}

export function extraFieldMalformedDiagnostic(entryName: string): ZipDiagnostic {
    return {
        code: 'ZIP_EXTRA_FIELD_MALFORMED',
        severity: 'warning',
        message: `entry '${entryName}': an extra field overruns its declared length and was skipped `
            + '(the producer of this archive is buggy).',
        entryName,
    };
}

export function timestampNotPinnedDiagnostic(): ZipDiagnostic {
    return {
        code: 'ZIP_TIMESTAMP_NOT_PINNED',
        severity: 'info',
        message: "createZip used the wall clock (defaultDate: 'now') — output bytes will differ on every "
            + 'run. Pass a fixed Date (or omit defaultDate for the DOS-epoch default) for reproducible archives.',
    };
}

export function nondeterministicCodecDiagnostic(): ZipDiagnostic {
    return {
        code: 'ZIP_NONDETERMINISTIC_CODEC',
        severity: 'info',
        message: 'this archive pins its timestamps but compresses through the platform codec, so bytes are '
            + 'stable only per zlib build — pass compression: { deterministic: true } for cross-runtime '
            + 'byte-identical output (see docs/determinism.md).',
    };
}

export function zip64ExtraIgnoredDiagnostic(entryName: string): ZipDiagnostic {
    return {
        code: 'ZIP_ZIP64_EXTRA_IGNORED',
        severity: 'warning',
        message: `entry '${entryName}': a zip64 extra field supplies a value for a header field that is not `
            + 'set to its sentinel; the non-sentinel header value wins (spoofing-resistant reading). '
            + 'Pass strict: true to reject such archives.',
        entryName,
    };
}
