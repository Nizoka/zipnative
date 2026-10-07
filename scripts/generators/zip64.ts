/** Zip64: an archive whose entry count overflows the classic EOCD. */
import { resolve } from 'node:path';
import { createZip } from '../../src/index.ts';
import { type GenerateContext } from '../helpers/io.ts';

export async function generate(ctx: GenerateContext): Promise<void> {
    const zip = createZip();
    for (let i = 0; i < 66_000; i++) {
        zip.add(`entries/${i.toString(36)}`, 'x', { compression: { method: 'store' } });
    }
    ctx.writeSafe(
        resolve(ctx.outputDir, 'zip64', 'zip64-66k-entries.zip'),
        'zip64/zip64-66k-entries.zip (zip64 EOCD)',
        zip.toBytes(),
    );

    // The Zip64 streaming opt-in (1.1.0): a small entry written in the
    // layout a >4 GiB stream would use — speculative Zip64 extra in the
    // local header (sizes as zero placeholders), 24-byte data descriptor,
    // both final sizes in the central record's Zip64 extra — next to a
    // plain streamed entry for contrast. Small on purpose: the corpus is
    // inspected by humans and validated by six foreign extractors.
    const line = 'zip64 streaming opt-in: the 24-byte descriptor form.' + String.fromCharCode(10);
    const text = new TextEncoder().encode(line.repeat(40));
    const streamed = createZip({ compression: { deterministic: true } });
    streamed.addStream('opted-in.txt', (async function* () {
        for (let i = 0; i < text.length; i += 512) yield text.subarray(i, Math.min(i + 512, text.length));
    })(), { zip64: true });
    streamed.addStream('classic.txt', (async function* () { yield text.subarray(0, 600); })());
    const chunks: Uint8Array[] = [];
    for await (const chunk of streamed.stream()) chunks.push(chunk);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const bytes = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { bytes.set(c, pos); pos += c.length; }
    ctx.writeSafe(
        resolve(ctx.outputDir, 'zip64', 'zip64-streamed.zip'),
        'zip64/zip64-streamed.zip (opt-in: 24-byte descriptor)',
        bytes,
    );
}
