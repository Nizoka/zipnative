/**
 * Recipe: the resumable inflater (public since 0.8.0) — feed a raw
 * deflate stream in arbitrary chunks and read back EXACTLY where it
 * ended (`bytesConsumed`), the capability neither `DecompressionStream`
 * nor `node:zlib` exposes and the reason zipnative can delimit
 * data-descriptor entries in forward streaming.
 */
import { createInflator } from 'zipnative';
import { deflateRawSync } from 'node:zlib';

export default async function run(): Promise<Record<string, string>> {
    const original = new TextEncoder().encode('resumable '.repeat(400));
    const compressed = new Uint8Array(deflateRawSync(original));

    // The stream is followed by trailing bytes the inflater must NOT eat.
    const trailer = new TextEncoder().encode('TRAILING-RECORD');
    const wire = new Uint8Array(compressed.length + trailer.length);
    wire.set(compressed, 0);
    wire.set(trailer, compressed.length);

    const inflator = createInflator(1024 * 1024);
    let produced = 0;
    for (let i = 0; i < wire.length && !inflator.finished; i += 7) {
        for (const piece of inflator.push(wire.subarray(i, Math.min(i + 7, wire.length)))) {
            produced += piece.length;
        }
    }
    inflator.end();

    return {
        'consumed-exact': String(inflator.bytesConsumed === compressed.length),
        produced: String(produced),
        'trailer-untouched': String(inflator.bytesConsumed + trailer.length <= wire.length + inflator.leftover.length),
    };
}
