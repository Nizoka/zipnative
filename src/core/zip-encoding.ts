/**
 * zipnative — Name encoding (UTF-8 / CP437)
 * =========================================
 * ZIP names are UTF-8 when general-purpose flag bit 11 (EFS) is set,
 * CP437 otherwise. Decoding policy (§3.4 of the design):
 *   - bit 11 set → strict UTF-8; invalid sequences fall back to CP437
 *     with a ZIP_INVALID_UTF8_NAME diagnostic (the caller emits it).
 *   - bit 11 clear → CP437 through the full 256-entry table.
 *
 * @module core/zip-encoding
 */

import { ZipFormatError } from '../types/zip-errors.js';

/**
 * CP437 high half (0x80–0xFF). The low half maps to ASCII — the universal
 * convention for ZIP filenames (true CP437 glyphs for control codes are
 * never intended in paths).
 */
const CP437_HIGH =
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐'
    + '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

let _utf8Strict: TextDecoder | undefined;

/** Decode bytes as strict UTF-8, or return `null` on any invalid sequence. */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
    _utf8Strict ??= new TextDecoder('utf-8', { fatal: true });
    try {
        return _utf8Strict.decode(bytes);
    } catch {
        return null;
    }
}

/** Decode bytes as CP437 (ASCII low half, IBM graphics high half). */
export function decodeCp437(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
    }
    return out;
}

/** Byte-wise lexicographic comparison of raw names (canonical entry order). */
export function compareNames(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
}

/**
 * Writer-side name validation: zipnative never emits a path its own
 * extractor rejects. Returns the final name (a trailing `/` is appended
 * for directories); throws `ZipFormatError` with the remedy otherwise.
 * Shared by the builder and the modifier.
 */
export function validateEntryName(name: string, isDirectory: boolean): string {
    if (name.length === 0) {
        throw new ZipFormatError('ZIP_INVALID_ENTRY_NAME', 'zipnative: entry name must not be empty');
    }
    if (name.includes('\0')) {
        throw new ZipFormatError('ZIP_INVALID_ENTRY_NAME', 'zipnative: entry name must not contain NUL bytes');
    }
    if (name.includes('\\')) {
        throw new ZipFormatError('ZIP_INVALID_ENTRY_NAME',
            `zipnative: entry name '${name}' contains a backslash — ZIP paths use forward slashes ('/')`);
    }
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
        throw new ZipFormatError('ZIP_INVALID_ENTRY_NAME',
            `zipnative: entry name '${name}' is absolute — archive paths must be relative`);
    }
    for (const segment of name.split('/')) {
        if (segment === '..') {
            throw new ZipFormatError('ZIP_INVALID_ENTRY_NAME',
                `zipnative: entry name '${name}' contains a '..' segment — zipnative never writes `
                + 'traversal-capable archives');
        }
    }
    if (isDirectory && !name.endsWith('/')) return `${name}/`;
    return name;
}

/** Byte-wise equality of two raw-name views. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}
