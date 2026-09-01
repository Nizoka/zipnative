/** Streaming output + addStream entries (data-descriptor layout, bit 3). */
import { resolve } from 'node:path';
import { createZip } from '../../src/index.ts';
import { type GenerateContext } from '../helpers/io.ts';

const te = new TextEncoder();

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of gen) {
        parts.push(chunk);
        total += chunk.length;
    }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    return out;
}

export async function generate(ctx: GenerateContext): Promise<void> {
    const write = (name: string, label: string, bytes: Uint8Array): void =>
        ctx.writeSafe(resolve(ctx.outputDir, 'streaming', name), `streaming/${label}`, bytes);

    {
        const content = te.encode('chunked payload line\n'.repeat(3000));
        const zip = createZip();
        zip.add('plain.txt', 'buffered sibling\n');
        zip.addStream('streamed.bin', (async function* () {
            for (let i = 0; i < content.length; i += 4096) {
                yield content.subarray(i, Math.min(i + 4096, content.length));
            }
        })());
        write('streamed-descriptor.zip', 'streamed-descriptor.zip (bit 3 set)', await collect(zip.stream()));
    }
    {
        const zip = createZip();
        for (let i = 0; i < 5; i++) {
            const body = te.encode(`stream entry number ${i}\n`.repeat(200));
            zip.addStream(`parts/part-${i}.txt`, (async function* () {
                yield body;
            })());
        }
        write('streamed-multi.zip', 'streamed-multi.zip (5 descriptor entries)', await collect(zip.stream()));
    }
}
