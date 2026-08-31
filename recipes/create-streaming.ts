/**
 * Recipe: create an archive with bounded memory — stream() output plus an
 * addStream() entry fed chunk by chunk (data-descriptor layout).
 * Task: serverless/Workers-friendly archive creation without buffering
 * the whole output or the large entry.
 */
import { createZip, openZip } from 'zipnative';

export default async function run(): Promise<Record<string, string>> {
    // Pseudo-random content: stays large after compression, so the 16 KiB
    // chunking below is actually exercised.
    const bigContent = new Uint8Array(80_000);
    let state = 0xACE1;
    for (let i = 0; i < bigContent.length; i++) {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        bigContent[i] = (state >>> 16) & 0xff;
    }

    const zip = createZip();
    zip.add('readme.txt', 'streamed archive demo');
    zip.addStream('data/big.bin', (async function* () {
        for (let i = 0; i < bigContent.length; i += 4096) {
            yield bigContent.subarray(i, Math.min(i + 4096, bigContent.length));
        }
    })());

    // Consume fixed-size chunks — in production these go straight to a
    // socket or file; here we reassemble to verify the round-trip.
    const parts: Uint8Array[] = [];
    let total = 0;
    let chunks = 0;
    for await (const chunk of zip.stream({ chunkSize: 16 * 1024 })) {
        parts.push(chunk);
        total += chunk.length;
        chunks++;
    }
    const bytes = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
        bytes.set(part, pos);
        pos += part.length;
    }

    const reader = openZip(bytes);
    const restored = reader.readEntry('data/big.bin');

    return {
        'multiple-chunks': String(chunks > 1),
        'round-trip': String(restored.length === bigContent.length),
    };
}
