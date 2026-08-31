import { describe, expect, it } from 'vitest';
import { bytesEqual, decodeCp437, decodeUtf8Strict } from '../../src/core/zip-encoding.ts';

const te = new TextEncoder();

describe('zip-encoding', () => {
    it('decodes ASCII identically in both encodings', () => {
        const bytes = te.encode('folder/file.txt');
        expect(decodeCp437(bytes)).toBe('folder/file.txt');
        expect(decodeUtf8Strict(bytes)).toBe('folder/file.txt');
    });

    it('decodes CP437 high-half graphics correctly', () => {
        // 0x82 = é, 0xA0 = á, 0xE1 = ß in CP437
        expect(decodeCp437(new Uint8Array([0x82, 0xA0, 0xE1]))).toBe('éáß');
    });

    it('returns null for invalid UTF-8 (strict decoding)', () => {
        expect(decodeUtf8Strict(new Uint8Array([0xC3]))).toBeNull();        // truncated sequence
        expect(decodeUtf8Strict(new Uint8Array([0xFF, 0xFE]))).toBeNull();  // invalid bytes
    });

    it('decodes multi-byte UTF-8 names', () => {
        const bytes = te.encode('文档/résumé.txt');
        expect(decodeUtf8Strict(bytes)).toBe('文档/résumé.txt');
    });

    it('bytesEqual compares content, not identity', () => {
        expect(bytesEqual(te.encode('abc'), te.encode('abc'))).toBe(true);
        expect(bytesEqual(te.encode('abc'), te.encode('abd'))).toBe(false);
        expect(bytesEqual(te.encode('abc'), te.encode('abcd'))).toBe(false);
    });
});
