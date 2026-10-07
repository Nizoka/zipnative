/**
 * Recipe: stream an entry that MAY exceed 4 GiB. A streamed entry cannot
 * promote to Zip64 after the fact — its sizes are unknown when the local
 * header is written — so the caller opts in per entry with `zip64: true`:
 * version 45, sentinel sizes and a (0, 0) Zip64 extra in the local header,
 * a 24-byte data descriptor, both sizes in the central record (APPNOTE
 * 4.3.9.2). Without the opt-in a stream crossing 4 GiB is a typed refusal.
 */
import { createZip, openZip, verifyZip } from 'zipnative';

async function* chunks(): AsyncGenerator<Uint8Array> {
    const te = new TextEncoder();
    for (let i = 0; i < 8; i++) yield te.encode(`chunk ${i} of a stream that may grow past 4 GiB\n`);
}

export default async function run(): Promise<Record<string, string>> {
    const zip = createZip();
    zip.addStream('big.log', chunks(), { zip64: true, compression: { method: 'store' } });
    zip.add('tail.txt', 'buffered entry after the streamed one', { compression: { method: 'store' } });

    const parts: Uint8Array[] = [];
    for await (const part of zip.stream()) parts.push(part);
    const total = parts.reduce((n, p) => n + p.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { bytes.set(p, at); at += p.length; }

    const reader = openZip(bytes);
    const big = reader.getEntry('big.log');
    const tail = reader.getEntry('tail.txt');
    if (big === null || tail === null) throw new Error('entries missing');

    // Local header: version needed to extract at offset 4, name and extra lengths at 26/28.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const lfhVersion = view.getUint16(big.localHeaderOffset + 4, true);
    const nameLen = view.getUint16(big.localHeaderOffset + 26, true);
    const extraLen = view.getUint16(big.localHeaderOffset + 28, true);
    const dataStart = big.localHeaderOffset + 30 + nameLen + extraLen;
    // The descriptor sits between the payload and the next local header.
    const descriptorBytes = tail.localHeaderOffset - (dataStart + big.compressedSize);

    return {
        'lfh-version': String(lfhVersion),
        'descriptor-bytes': String(descriptorBytes),
        'zip64-extra': String(extraLen),
        verified: String(verifyZip(bytes).ok),
    };
}
