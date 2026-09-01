/**
 * zipnative — Security bounds table
 * =================================
 * THE named-limits table every loop over untrusted archive bytes consults
 * (security instructions). Each limit is caller-configurable via
 * `options.limits`; each violation throws `ZipLimitError` naming the limit
 * and the remedy. The table below is mirrored in SECURITY.md — update both
 * in the same PR.
 *
 * | Limit                        | Default   | CWE     |
 * |------------------------------|-----------|---------|
 * | maxEntries                   | 100 000   | CWE-400 |
 * | maxEntryUncompressedSize     | 1 GiB     | CWE-400 |
 * | maxTotalUncompressedSize     | 8 GiB     | CWE-400 |
 * | maxCompressionRatio          | 1024 (≥1 KiB compressed) | CWE-409 |
 * | maxNameBytes                 | 4 096     | CWE-400 |
 * | maxExtraFieldBytes           | 65 535    | CWE-400 |
 * | maxCommentBytes              | 65 535    | CWE-400 |
 * | maxCentralDirectoryBytes     | 256 MiB   | CWE-400 |
 *
 * @module core/zip-limits
 */

import { type ZipLimits } from '../types/zip-types.js';
import { ZipLimitError } from '../types/zip-errors.js';

/** Default security bounds — the safe path for untrusted input. */
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
    maxEntries: 100_000,
    maxEntryUncompressedSize: 1024 * 1024 * 1024,          // 1 GiB
    maxTotalUncompressedSize: 8 * 1024 * 1024 * 1024,      // 8 GiB
    maxCompressionRatio: 1024,
    maxNameBytes: 4096,
    maxExtraFieldBytes: 65_535,
    maxCommentBytes: 65_535,
    maxCentralDirectoryBytes: 256 * 1024 * 1024,           // 256 MiB
};

/**
 * Merge caller overrides over the defaults — validated early, before any
 * parsing (each value must be a positive number or Infinity).
 */
export function resolveLimits(overrides?: Partial<ZipLimits>): ZipLimits {
    if (overrides === undefined) return DEFAULT_ZIP_LIMITS;
    const merged: Record<string, number> = { ...DEFAULT_ZIP_LIMITS };
    for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) continue;
        if (!(key in merged)) {
            throw new ZipLimitError('ZIP_LIMIT_INVALID',
                `zipnative: unknown limit '${key}' (valid keys: ${Object.keys(merged).join(', ')})`,
                key, NaN, NaN);
        }
        if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
            throw new ZipLimitError('ZIP_LIMIT_INVALID',
                `zipnative: limit '${key}' must be a positive number or Infinity, got ${String(value)}`,
                key, NaN, NaN);
        }
        merged[key] = value;
    }
    return merged as unknown as ZipLimits;
}

/** Enforce one limit: throws `ZipLimitError` with the remedy when exceeded. */
export function enforceLimit(
    limits: ZipLimits,
    limit: keyof ZipLimits,
    observed: number,
    context: string,
): void {
    const configured = limits[limit];
    if (observed > configured) {
        throw new ZipLimitError('ZIP_LIMIT_EXCEEDED',
            `zipnative: ${context} (${observed}) exceeds limits.${limit} (${configured}) — `
            + `raise limits.${limit} explicitly if this archive is trusted`,
            limit, configured, observed);
    }
}
