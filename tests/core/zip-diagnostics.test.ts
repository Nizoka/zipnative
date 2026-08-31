import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ZipDiagnostic } from 'zipnative';
import { createDiagnosticEmitter, duplicateNameDiagnostic } from '../../src/core/zip-diagnostics.ts';

describe('zip-diagnostics', () => {
    afterEach(() => vi.restoreAllMocks());

    it('strict mode throws on the first diagnostic', () => {
        const emit = createDiagnosticEmitter(true, undefined);
        expect(() => emit(duplicateNameDiagnostic('a.txt'))).toThrow(/zipnative:/);
    });

    it('a handler receives every diagnostic without deduplication', () => {
        const received: ZipDiagnostic[] = [];
        const emit = createDiagnosticEmitter(undefined, (d) => received.push(d));
        emit(duplicateNameDiagnostic('a.txt'));
        emit(duplicateNameDiagnostic('b.txt'));
        expect(received).toHaveLength(2);
        expect(received[0].code).toBe('ZIP_DUPLICATE_NAME');
    });

    it('the default sink warns once per code per operation', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const emit = createDiagnosticEmitter(undefined, undefined);
        emit(duplicateNameDiagnostic('a.txt'));
        emit(duplicateNameDiagnostic('b.txt'));
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('a handler suppresses the console sink entirely', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const emit = createDiagnosticEmitter(undefined, () => undefined);
        emit(duplicateNameDiagnostic('a.txt'));
        expect(warn).not.toHaveBeenCalled();
    });
});
