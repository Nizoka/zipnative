/**
 * zipnative — Canonicalisation (reproducible builds for any ZIP)
 * ==============================================================
 * `canonicalizeZip(bytes)` rewrites an archive from any producer into
 * zipnative's deterministic canonical form without recompression — the
 * one-call form of `createZipModifier(openZip(bytes)).saveCompact({
 * canonical: true })`. `analyzeDeterminism()` on the result reports
 * `deterministic: true`, and canonicalising twice yields the same bytes
 * (idempotent). The payloads are copied bit for bit, so a corrupt or
 * encrypted entry travels unchanged; nothing is decoded.
 *
 * @module parser/zip-canonical
 */

import type { ZipCommonOptions } from '../types/zip-types.js';
import { createZipModifier, type CanonicalOptions } from './zip-modifier.js';
import { openZip } from './zip-reader.js';

/** Options for {@link canonicalizeZip}: the canonical rules plus the shared fragment. @since 1.1.0 */
export interface CanonicalizeOptions extends CanonicalOptions, ZipCommonOptions {}

/**
 * Rewrite an archive into the canonical deterministic form (see
 * `CanonicalOptions` for the rules and `docs/guides/determinism.md` for
 * the contract). Throws like `openZip` when the bytes are not a
 * well-formed archive; duplicate-name archives are refused like the
 * modifier refuses them.
 *
 * @since 1.1.0
 */
export function canonicalizeZip(bytes: Uint8Array, options?: CanonicalizeOptions): Uint8Array {
    const common: ZipCommonOptions = {
        strict: options?.strict,
        onDiagnostic: options?.onDiagnostic,
        limits: options?.limits,
        dosTimeMode: options?.dosTimeMode,
    };
    const reader = openZip(bytes, common);
    const modifier = createZipModifier(reader, common);
    return modifier.saveCompact({
        canonical: {
            date: options?.date,
            keepComments: options?.keepComments,
            keepExternalAttributes: options?.keepExternalAttributes,
        },
    });
}
