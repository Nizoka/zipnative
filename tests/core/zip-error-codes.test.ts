/**
 * The error-code freeze contract (0.8.0): every thrown error carries a
 * stable machine-readable `code`; the full vocabulary is snapshot below.
 * Any diff to CODES is a deliberate semver decision, never an accident —
 * removal or renaming is semver-major, additions are semver-minor. The
 * registry docs/data/errors.json mirrors this list (error-parity rule).
 */
import { describe, expect, it } from 'vitest';
import {
    createZip,
    createZipModifier,
    extractZip,
    openZip,
    ZipDataError,
    ZipError,
    ZipFormatError,
    ZipLimitError,
    ZipSecurityError,
    ZipUnsupportedError,
    type ZipErrorCode,
} from 'zipnative';
import { createInflator } from '../../src/codecs/inflate-stream.ts';
import { createDiagnosticEmitter, timestampNotPinnedDiagnostic } from '../../src/core/zip-diagnostics.ts';
import { buildRawZip } from '../helpers/raw-zip-builder.ts';

const te = new TextEncoder();

/** The frozen vocabulary — sorted; keep in sync with ZipErrorCode. */
const CODES = [
    'ZIP_API_MISUSE',
    'ZIP_CD_INCONSISTENT',
    'ZIP_CD_LFH_MISMATCH',
    'ZIP_CRC_MISMATCH',
    'ZIP_DECOMPRESSION_FAILED',
    'ZIP_DEFLATE_CORRUPT',
    'ZIP_DEFLATE_TRUNCATED',
    'ZIP_DESCRIPTOR_MISMATCH',
    'ZIP_DUPLICATE_ENTRY_NAME',
    'ZIP_ENTRY_EXISTS',
    'ZIP_ENTRY_NOT_FOUND',
    'ZIP_ENTRY_OVERLAP',
    'ZIP_EOCD_INCONSISTENT',
    'ZIP_EOCD_NOT_FOUND',
    'ZIP_EXTRACT_DUPLICATE_PATH',
    'ZIP_INFLATE_OUTPUT_OVERFLOW',
    'ZIP_INPUT_TOO_LARGE',
    'ZIP_INTERNAL',
    'ZIP_INVALID_ENTRY_NAME',
    'ZIP_INVALID_OPTION',
    'ZIP_LIMIT_EXCEEDED',
    'ZIP_LIMIT_INVALID',
    'ZIP_PATH_TRAVERSAL',
    'ZIP_RECORD_TRUNCATED',
    'ZIP_SIGNATURE_MISMATCH',
    'ZIP_SIZE_MISMATCH',
    'ZIP_STREAM_TRUNCATED',
    'ZIP_STRICT_DIAGNOSTIC',
    'ZIP_SYMLINK_REJECTED',
    'ZIP_UNSUPPORTED_CD_LESS_DESCRIPTOR',
    'ZIP_UNSUPPORTED_CODEC_MODE',
    'ZIP_UNSUPPORTED_ENCRYPTION',
    'ZIP_UNSUPPORTED_METHOD',
    'ZIP_UNSUPPORTED_MULTI_DISK',
    'ZIP_UNSUPPORTED_ZIP64_STREAMING',
    'ZIP_VALUE_UNREPRESENTABLE',
    'ZIP_ZIP64_CONTRADICTION',
    'ZIP_ZIP64_EOCD_MISPLACED',
    'ZIP_ZIP64_LOCATOR_MISSING',
] as const satisfies readonly ZipErrorCode[];

/** Every source throw site must use a literal from CODES (error-parity double-checks). */
function grab(fn: () => unknown): ZipError {
    try {
        fn();
    } catch (err) {
        expect(err).toBeInstanceOf(ZipError);
        return err as ZipError;
    }
    throw new Error('expected the call to throw');
}

describe('error codes: class contract', () => {
    it('every class sets name, code and the instanceof chain', () => {
        const cases: ReadonlyArray<[ZipError, string]> = [
            [new ZipError('ZIP_API_MISUSE', 'zipnative: x'), 'ZipError'],
            [new ZipFormatError('ZIP_EOCD_NOT_FOUND', 'zipnative: x'), 'ZipFormatError'],
            [new ZipLimitError('ZIP_LIMIT_EXCEEDED', 'zipnative: x', 'maxEntries', 1, 2), 'ZipLimitError'],
            [new ZipSecurityError('ZIP_PATH_TRAVERSAL', 'zipnative: x', 'a'), 'ZipSecurityError'],
            [new ZipDataError('ZIP_CRC_MISMATCH', 'zipnative: x', 'a', 1, 2), 'ZipDataError'],
            [new ZipUnsupportedError('ZIP_UNSUPPORTED_MULTI_DISK', 'zipnative: x', 'multi-disk'), 'ZipUnsupportedError'],
        ];
        for (const [err, name] of cases) {
            expect(err.name).toBe(name);
            expect(typeof err.code).toBe('string');
            expect(err).toBeInstanceOf(ZipError);
            expect(err).toBeInstanceOf(Error);
            expect(CODES).toContain(err.code);
        }
    });

    it('the frozen vocabulary snapshot holds exactly 39 sorted codes', () => {
        expect(CODES.length).toBe(39);
        expect([...CODES].sort()).toEqual([...CODES]);
        expect(new Set(CODES).size).toBe(CODES.length);
    });
});

describe('error codes: representative end-to-end paths', () => {
    it('ZIP_EOCD_NOT_FOUND on non-ZIP input', () => {
        const err = grab(() => openZip(new Uint8Array(10)));
        expect(err.code).toBe('ZIP_EOCD_NOT_FOUND');
    });

    it('ZIP_ENTRY_NOT_FOUND on a missing name', () => {
        const reader = openZip(buildRawZip([{ name: 'a.txt', data: te.encode('x') }]));
        const err = grab(() => reader.readEntry('missing.txt'));
        expect(err.code).toBe('ZIP_ENTRY_NOT_FOUND');
    });

    it('ZIP_LIMIT_EXCEEDED carries the typed limit key', () => {
        const archive = buildRawZip([
            { name: 'a.txt', data: te.encode('x') },
            { name: 'b.txt', data: te.encode('y') },
        ]);
        const err = grab(() => openZip(archive, { limits: { maxEntries: 1 } })) as ZipLimitError;
        expect(err.code).toBe('ZIP_LIMIT_EXCEEDED');
        expect(err.limit).toBe('maxEntries');
        expect(err.configured).toBe(1);
    });

    it('ZIP_LIMIT_INVALID with NaN sentinels on a bad override', () => {
        const err = grab(() => openZip(buildRawZip([]), { limits: { maxEntries: -1 } })) as ZipLimitError;
        expect(err.code).toBe('ZIP_LIMIT_INVALID');
        expect(Number.isNaN(err.configured)).toBe(true);
        expect(Number.isNaN(err.observed)).toBe(true);
    });

    it('ZIP_UNSUPPORTED_ENCRYPTION carries the feature', () => {
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('x'), flags: 0x0001 }]);
        const reader = openZip(archive, { onDiagnostic: () => undefined });
        const err = grab(() => reader.readEntry('a.txt')) as ZipUnsupportedError;
        expect(err.code).toBe('ZIP_UNSUPPORTED_ENCRYPTION');
        expect(err.feature).toBe('zipcrypto');
    });

    it('ZIP_CRC_MISMATCH on corrupted payload', () => {
        // Deflate so the corrupted payload byte leaves the declared CRC intact.
        const archive = buildRawZip([{ name: 'a.txt', data: te.encode('payload-payload'), method: 8, corruptDataAt: 2 }]);
        const reader = openZip(archive, { onDiagnostic: () => undefined });
        const err = grab(() => reader.readEntry('a.txt')) as ZipDataError;
        expect(err.code).toBe('ZIP_CRC_MISMATCH');
        expect(err.expectedCrc).toBeDefined();
    });

    it('ZIP_PATH_TRAVERSAL from extractZip on a zip-slip name', () => {
        // Craft the hostile name via the raw builder (bypasses writer rules).
        const hostile = buildRawZip([{ name: '../evil.txt', data: te.encode('x') }]);
        const err = grab(() => extractZip(hostile)) as ZipSecurityError;
        expect(err.code).toBe('ZIP_PATH_TRAVERSAL');
    });

    it('ZIP_DEFLATE_CORRUPT from the resumable inflator', () => {
        const inflator = createInflator(Number.MAX_SAFE_INTEGER);
        // 0b110 in the first bits: final block, invalid type 3.
        const err = grab(() => inflator.push(new Uint8Array([0x07, 0x00, 0x00])));
        expect(err.code).toBe('ZIP_DEFLATE_CORRUPT');
    });

    it('ZIP_DUPLICATE_ENTRY_NAME from the writer', () => {
        const writer = createZip();
        writer.add('a.txt', te.encode('x'));
        const err = grab(() => writer.add('a.txt', te.encode('y')));
        expect(err.code).toBe('ZIP_DUPLICATE_ENTRY_NAME');
    });

    it('ZIP_ENTRY_EXISTS from the modifier', () => {
        const reader = openZip(buildRawZip([{ name: 'a.txt', data: te.encode('x') }]));
        const modifier = createZipModifier(reader);
        const err = grab(() => modifier.addEntry('a.txt', te.encode('y')));
        expect(err.code).toBe('ZIP_ENTRY_EXISTS');
    });

    it('ZIP_STRICT_DIAGNOSTIC from strict-mode escalation, as a typed ZipError', () => {
        const emit = createDiagnosticEmitter(true, undefined);
        const err = grab(() => emit(timestampNotPinnedDiagnostic()));
        expect(err.code).toBe('ZIP_STRICT_DIAGNOSTIC');
        expect(err.name).toBe('ZipError');
    });
});
