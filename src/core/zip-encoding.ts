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

/** Byte-wise equality of two raw-name views. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}
