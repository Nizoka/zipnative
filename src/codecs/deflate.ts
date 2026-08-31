/**
 * zipnative — Raw-deflate compression facade
 * ==========================================
 * Tiered resolution (memoized, no import side effects), mirror of
 * inflate.ts:
 *
 *   1. Injection      — `setDeflateImpl(fn)` (bring your own, e.g. fflate).
 *                       Unlike pdfnative's facade, the injected function
 *                       receives the compression `level`.
 *   2. node:zlib      — `deflateRawSync({ level })`; CJS `require` probe,
 *                       or `initNodeZipCodecs()` for ESM (string-indirected
 *                       dynamic import so bundlers don't resolve it)
 *   3. Pure TS        — `deflateRawJS` (always available; ALSO the pin for
 *                       `deterministic: true` — cross-runtime byte-identical)
 *
 * `CompressionStream('deflate-raw')` is deliberately NOT a sync tier (it
 * is async-only); the stream writer uses it directly on async paths.
 *
 * All tiers speak RAW deflate (RFC 1951, no zlib wrapper — ZIP method 8).
 *
 * @module codecs/deflate
 */

import { deflateRawJS } from './deflate-pure.js';

type DeflateFn = (data: Uint8Array, level: number) => Uint8Array;

let _injected: DeflateFn | null = null;
let _nodeDeflateRaw: DeflateFn | null | undefined;

/**
 * Inject a custom raw-deflate compressor (tier 1), or `null` to remove it.
 * Note: an injected implementation is never used for `deterministic: true`
 * output — determinism always pins the pure-TS tier.
 */
export function setDeflateImpl(fn: ((data: Uint8Array, level: number) => Uint8Array) | null): void {
    _injected = fn;
}

/** CJS-context probe for node:zlib (webpack-safe, memoized, never throws). */
function getNodeDeflateRaw(): DeflateFn | null {
    if (_nodeDeflateRaw !== undefined) return _nodeDeflateRaw;
    try {
        const g = globalThis as Record<string, unknown>;
        const proc = g['process'] as { versions?: { node?: string } } | undefined;
        if (!proc?.versions?.node) {
            _nodeDeflateRaw = null;
            return null;
        }
        const req = (g['__non_webpack_require__'] as ((m: string) => Record<string, unknown>) | undefined)
            ?? (g['require'] as ((m: string) => Record<string, unknown>) | undefined);
        if (req) {
            const zlib = req('node:zlib');
            const fn = zlib['deflateRawSync'] as ((buf: Uint8Array, opts?: { level?: number }) => Uint8Array) | undefined;
            if (typeof fn === 'function') {
                _nodeDeflateRaw = (data, level) => new Uint8Array(fn(data, { level }));
                return _nodeDeflateRaw;
            }
        }
        _nodeDeflateRaw = null;
        return null;
    } catch {
        _nodeDeflateRaw = null;
        return null;
    }
}

/**
 * Resolve node:zlib's deflate in ESM contexts — optional performance
 * upgrade; the pure-TS tier keeps compression working without it.
 * (inflate.ts exposes the same-named init for the decompression side;
 * `initNodeZipCodecs` from the package root initializes both.)
 */
export async function initNodeDeflate(): Promise<void> {
    if (_nodeDeflateRaw !== undefined) return;
    try {
        const g = globalThis as Record<string, unknown>;
        const proc = g['process'] as { versions?: { node?: string } } | undefined;
        if (!proc?.versions?.node) {
            _nodeDeflateRaw = null;
            return;
        }
        // String indirection defeats bundler static analysis of the import.
        const modName = 'node:zlib';
        const zlib = await (import(modName) as Promise<Record<string, unknown>>);
        const fn = zlib['deflateRawSync'] as ((buf: Uint8Array, opts?: { level?: number }) => Uint8Array) | undefined;
        _nodeDeflateRaw = typeof fn === 'function'
            ? (data, level) => new Uint8Array(fn(data, { level }))
            : null;
    } catch {
        _nodeDeflateRaw = null;
    }
}

/**
 * Compress to a raw DEFLATE stream, synchronously.
 *
 * @param data - Bytes to compress
 * @param level - 0–9 effort hint (0 = stored blocks)
 * @param deterministic - Pin the pure-TS encoder so bytes are identical
 *                        on every runtime (slower than native zlib)
 */
export function deflateRawSync(data: Uint8Array, level: number, deterministic = false): Uint8Array {
    if (deterministic) return deflateRawJS(data, level);
    if (_injected) return _injected(data, level);
    const node = getNodeDeflateRaw();
    if (node) return node(data, level);
    return deflateRawJS(data, level);
}

/** Which tier `deflateRawSync` would use right now (for diagnostics). */
export function activeDeflateTier(deterministic: boolean): 'pure-pinned' | 'injected' | 'node-zlib' | 'pure' {
    if (deterministic) return 'pure-pinned';
    if (_injected) return 'injected';
    if (getNodeDeflateRaw()) return 'node-zlib';
    return 'pure';
}

/** @internal Reset the memoized node:zlib probe so tests can drive the fallback tier. */
export function _resetDeflateCache(): void {
    _nodeDeflateRaw = undefined;
}
