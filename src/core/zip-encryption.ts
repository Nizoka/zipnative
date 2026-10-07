/**
 * zipnative — Encryption detection (never decryption)
 * ===================================================
 * Encrypted entries are refused in 1.x (README: What zipnative will NOT
 * do), but the refusal must name the scheme honestly: a WinZip AES entry
 * (method 99, or the 0x9901 "AE-x" extra) is not ZipCrypto, and a caller
 * routing around encrypted entries — or planning for an injected crypto
 * provider in a later major — needs the right label. Pure, no I/O.
 *
 * @module core/zip-encryption
 */

import type { ZipExtraField } from '../types/zip-types.js';
import type { ZipUnsupportedFeature } from '../types/zip-errors.js';
import { EXTRA_AES, FLAG_STRONG_ENCRYPTION, METHOD_AES } from './zip-constants.js';

/** The encryption schemes the detector can name. */
export type EncryptionScheme = Extract<ZipUnsupportedFeature, 'zipcrypto' | 'aes' | 'strong-encryption'>;

/**
 * Name the encryption scheme of an entry whose flag bit 0 (or 6) is set.
 *
 * - method 99 or an `0x9901` extra → `'aes'` (WinZip AE-1 / AE-2)
 * - flag bit 6 → `'strong-encryption'` (APPNOTE §6.2 strong encryption)
 * - otherwise → `'zipcrypto'` (the traditional PKWARE stream cipher)
 */
export function encryptionScheme(
    flags: number,
    compressionMethod: number,
    extraFields: readonly ZipExtraField[],
): EncryptionScheme {
    if (compressionMethod === METHOD_AES || extraFields.some((f) => f.id === EXTRA_AES)) return 'aes';
    if ((flags & FLAG_STRONG_ENCRYPTION) !== 0) return 'strong-encryption';
    return 'zipcrypto';
}
