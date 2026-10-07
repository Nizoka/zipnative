/**
 * zipnative — Raw-deflate decompression facade
 * ============================================
 * Tiered resolution (memoized, no import side effects):
 *
 *   1. Injection      — `setInflateImpl(fn)` (bring your own, e.g. fflate)
 *   2. node:zlib      — `inflateRawSync` with `maxOutputLength` enforced;
 *                       CJS `require` probe, or `initNodeZipCodecs()` for ESM
 *                       (string-indirected dynamic import so bundlers don't
 *                       statically resolve it)
 *   3. Web streams    — `DecompressionStream('deflate-raw')` (async paths
 *                       only; Node 18+, evergreen browsers, Deno, Bun, Workers)
 *   4. Pure TS        — `inflateRawJS` (always available; sync-first never breaks)
 *
 * Every tier speaks RAW deflate (RFC 1951, no zlib wrapper — ZIP's framing)
 * and enforces the caller's output bound DURING decompression (CWE-400).
 *
 * @module codecs/inflate
 */

import { ZipDataError, ZipError, ZipFormatError } from '../types/zip-errors.js';
import { inflateRawJS } from './inflate-pure.js';
import { initNodeDeflate } from './deflate.js';

type InflateFn = (data: Uint8Array, maxOutput: number) => Uint8Array;

let _injected: InflateFn | null = null;
let _nodeInflateRaw: InflateFn | null | undefined;

/**
 * Normalize a platform tier's failure to the vocabulary the pure tier
 * already speaks, so `err.code` is the same whichever tier decoded the
 * entry (issue #10): callers branch on the code, never on the runtime.
 *
 * - `ERR_BUFFER_TOO_LARGE` (node:zlib hit `maxOutputLength`) →
 *   `ZipDataError ZIP_INFLATE_OUTPUT_OVERFLOW`
 * - `Z_BUF_ERROR` ("unexpected end of file") → `ZipFormatError ZIP_DEFLATE_TRUNCATED`
 * - `Z_DATA_ERROR`, `Z_NEED_DICT` → `ZipFormatError ZIP_DEFLATE_CORRUPT`
 * - a `ZipError` passes through untouched
 * - anything else from a platform decoder (a `DecompressionStream`
 *   `TypeError` carries no stable code, and truncation cannot be told from
 *   corruption without parsing its message) → `ZIP_DEFLATE_CORRUPT`, with
 *   the platform detail kept in the message.
 *
 * Injected implementations (`setInflateImpl`) are deliberately NOT routed
 * through this: their failures stay `ZIP_DECOMPRESSION_FAILED` at the
 * parser, the documented meaning of that code.
 *
 * @internal Shared by the sync and stream facades and by the forward
 * reader's pump; not part of the public API.
 */
export function normalizeInflateError(err: unknown, maxOutput: number): ZipError {
    if (err instanceof ZipError) return err;
    const code = (err as { code?: unknown } | null)?.code;
    // Node's webstreams adapter rethrows zlib failures as a TypeError whose
    // message is empty and whose `code` is zlib's; keep whatever is useful.
    const raw = err instanceof Error ? err.message : String(err);
    const detail = raw.length > 0 ? raw : typeof code === 'string' ? code : 'platform decoder rejected the stream';
    if (code === 'ERR_BUFFER_TOO_LARGE') {
        return new ZipDataError('ZIP_INFLATE_OUTPUT_OVERFLOW',
            `zipnative: deflate output exceeds the declared/permitted size of ${maxOutput} bytes `
            + '(the archive metadata lies about this entry, or raise the relevant limit if intentional)');
    }
    if (code === 'Z_BUF_ERROR') {
        return new ZipFormatError('ZIP_DEFLATE_TRUNCATED',
            `zipnative: deflate stream ends mid-block (${detail}) — the entry is truncated; `
            + 'the archive is corrupt or hostile');
    }
    return new ZipFormatError('ZIP_DEFLATE_CORRUPT',
        `zipnative: deflate stream is structurally invalid (${detail}) — the archive is corrupt or hostile`);
}

/** @internal Reset the memoized node:zlib probe so tests can drive each tier. */
export function _resetInflateCache(): void {
    _nodeInflateRaw = undefined;
}

/**
 * Inject a custom raw-deflate decompressor (tier 1), or `null` to remove it.
 * The injected function MUST enforce `maxOutput` itself.
 */
export function setInflateImpl(fn: ((data: Uint8Array, maxOutput: number) => Uint8Array) | null): void {
    _injected = fn;
}

/** CJS-context probe for node:zlib (webpack-safe, memoized, never throws). */
function getNodeInflateRaw(): InflateFn | null {
    if (_nodeInflateRaw !== undefined) return _nodeInflateRaw;
    try {
        const g = globalThis as Record<string, unknown>;
        const proc = g['process'] as { versions?: { node?: string } } | undefined;
        if (!proc?.versions?.node) {
            _nodeInflateRaw = null;
            return null;
        }
        const req = (g['__non_webpack_require__'] as ((m: string) => Record<string, unknown>) | undefined)
            ?? (g['require'] as ((m: string) => Record<string, unknown>) | undefined);
        if (req) {
            const zlib = req('node:zlib');
            const fn = zlib['inflateRawSync'] as ((buf: Uint8Array, opts?: { maxOutputLength?: number }) => Uint8Array) | undefined;
            if (typeof fn === 'function') {
                _nodeInflateRaw = (data, maxOutput) => wrapNodeInflate(fn, data, maxOutput);
                return _nodeInflateRaw;
            }
        }
        _nodeInflateRaw = null;
        return null;
    } catch {
        _nodeInflateRaw = null;
        return null;
    }
}

/**
 * Resolve node:zlib in ESM contexts — both directions (inflate here,
 * deflate via codecs/deflate.ts). Optional performance upgrade: the
 * pure-TS tiers keep every API working without it. Call once at startup.
 */
export async function initNodeZipCodecs(): Promise<void> {
    await initNodeDeflate();
    if (_nodeInflateRaw !== undefined) return;
    try {
        const g = globalThis as Record<string, unknown>;
        const proc = g['process'] as { versions?: { node?: string } } | undefined;
        if (!proc?.versions?.node) {
            _nodeInflateRaw = null;
            return;
        }
        // String indirection defeats bundler static analysis of the import.
        const modName = 'node:zlib';
        const zlib = await (import(modName) as Promise<Record<string, unknown>>);
        const fn = zlib['inflateRawSync'] as ((buf: Uint8Array, opts?: { maxOutputLength?: number }) => Uint8Array) | undefined;
        _nodeInflateRaw = typeof fn === 'function'
            ? (data, maxOutput) => wrapNodeInflate(fn, data, maxOutput)
            : null;
    } catch {
        _nodeInflateRaw = null;
    }
}

function wrapNodeInflate(
    fn: (buf: Uint8Array, opts?: { maxOutputLength?: number }) => Uint8Array,
    data: Uint8Array,
    maxOutput: number,
): Uint8Array {
    try {
        const opts = Number.isFinite(maxOutput) ? { maxOutputLength: maxOutput } : undefined;
        return new Uint8Array(fn(data, opts));
    } catch (err) {
        // zlib reports the cap as ERR_BUFFER_TOO_LARGE, corruption as
        // Z_DATA_ERROR, truncation as Z_BUF_ERROR — normalize every one to
        // the typed error the pure tier throws for the same input.
        throw normalizeInflateError(err, maxOutput);
    }
}

/**
 * Decompress a raw DEFLATE stream, synchronously.
 *
 * @param data - Compressed bytes (RFC 1951, no zlib wrapper)
 * @param maxOutput - Hard output bound (for ZIP entries: the declared
 *                    uncompressed size); exceeding it throws `ZipDataError`
 */
export function inflateRawSync(data: Uint8Array, maxOutput: number): Uint8Array {
    if (_injected) return _injected(data, maxOutput);
    const node = getNodeInflateRaw();
    if (node) return node(data, maxOutput);
    return inflateRawJS(data, maxOutput);
}

/** Is the Web-streams tier (`DecompressionStream('deflate-raw')`) available here? */
export function hasDecompressionStream(): boolean {
    try {
        return typeof (globalThis as { DecompressionStream?: unknown }).DecompressionStream === 'function';
    } catch {
        return false;
    }
}

/**
 * Decompress a raw DEFLATE stream as an async chunk iterable, preferring
 * `DecompressionStream('deflate-raw')` and falling back to the sync facade
 * (single-chunk re-yield). Output counted against `maxOutput` as it flows.
 */
export async function* inflateRawStream(
    data: Uint8Array,
    maxOutput: number,
    chunkSize = 64 * 1024,
): AsyncGenerator<Uint8Array, void, undefined> {
    if (!_injected && hasDecompressionStream()) {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        // Copy: some engines detach transferred chunks, and `data` is a
        // zero-copy view of the caller's archive buffer.
        const writePromise = writer.write(data.slice()).then(() => writer.close());
        // Surface write-side failures (corrupt stream) instead of unhandled rejections.
        writePromise.catch(() => { /* re-thrown by reader.read() below */ });

        const reader = ds.readable.getReader();
        let produced = 0;
        for (;;) {
            let step: ReadableStreamReadResult<Uint8Array>;
            try {
                step = await reader.read();
            } catch (err) {
                // The platform decoder rejected the stream: corrupt or
                // truncated input, surfaced with the same code as the sync
                // tiers (Node's DecompressionStream carries zlib's codes).
                throw normalizeInflateError(err, maxOutput);
            }
            const { done, value } = step;
            if (done) break;
            produced += value.length;
            if (produced > maxOutput) {
                await reader.cancel();
                throw new ZipDataError('ZIP_INFLATE_OUTPUT_OVERFLOW',
                    `zipnative: deflate output exceeds the declared/permitted size of ${maxOutput} bytes `
                    + '(the archive metadata lies about this entry, or raise the relevant limit if intentional)');
            }
            yield value;
        }
        try {
            await writePromise;
        } catch (err) {
            throw normalizeInflateError(err, maxOutput);
        }
        return;
    }

    const out = inflateRawSync(data, maxOutput);
    for (let i = 0; i < out.length; i += chunkSize) {
        yield out.subarray(i, Math.min(i + chunkSize, out.length));
    }
}
