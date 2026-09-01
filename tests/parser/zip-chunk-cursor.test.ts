import { describe, expect, it } from 'vitest';
import { ZipFormatError } from 'zipnative';
import { createChunkCursor } from '../../src/parser/zip-chunk-cursor.ts';

function* chunked(bytes: Uint8Array, size: number): Generator<Uint8Array> {
    for (let i = 0; i < bytes.length; i += size) {
        yield bytes.subarray(i, Math.min(i + size, bytes.length));
    }
}

async function* asAsync(gen: Generator<Uint8Array>): AsyncGenerator<Uint8Array> {
    for (const chunk of gen) yield chunk;
}

const DATA = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));

describe('chunk cursor', () => {
    it('readExact spans chunk boundaries and tracks bytesRead', async () => {
        const cursor = createChunkCursor(asAsync(chunked(DATA, 7)));
        expect([...await cursor.readExact(10)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(cursor.bytesRead).toBe(10);
        expect([...await cursor.readExact(3)]).toEqual([10, 11, 12]);
    });

    it('readExact throws a typed error on truncation', async () => {
        const cursor = createChunkCursor(asAsync(chunked(DATA.subarray(0, 5), 2)));
        await expect(cursor.readExact(10)).rejects.toThrow(ZipFormatError);
    });

    it('peek4 does not consume, returns null on clean EOF, throws on a short tail', async () => {
        const cursor = createChunkCursor(asAsync(chunked(DATA, 3)));
        expect([...(await cursor.peek4()) as Uint8Array]).toEqual([0, 1, 2, 3]);
        expect([...(await cursor.peek4()) as Uint8Array]).toEqual([0, 1, 2, 3]); // still there
        await cursor.readExact(100);
        expect(await cursor.peek4()).toBeNull();

        const short = createChunkCursor(asAsync(chunked(DATA.subarray(0, 3), 1)));
        await expect(short.peek4()).rejects.toThrow(/too short/);
    });

    it('take yields zero-copy pieces summing to exactly n', async () => {
        const cursor = createChunkCursor(asAsync(chunked(DATA, 9)));
        await cursor.readExact(4);
        const pieces: Uint8Array[] = [];
        for await (const piece of cursor.take(20)) pieces.push(piece);
        const total = pieces.reduce((sum, p) => sum + p.length, 0);
        expect(total).toBe(20);
        expect(pieces[0][0]).toBe(4);
        expect(cursor.bytesRead).toBe(24);
        // Zero-copy: pieces share the source chunks' backing buffer.
        expect(pieces[0].buffer).toBe(DATA.buffer);
    });

    it('take throws on truncation mid-range', async () => {
        const cursor = createChunkCursor(asAsync(chunked(DATA.subarray(0, 10), 4)));
        await expect(async () => {
            for await (const _p of cursor.take(50)) { /* drain */ }
        }).rejects.toThrow(/truncated/);
    });
});
