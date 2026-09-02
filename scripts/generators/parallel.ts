/**
 * Worker parallelism, demonstrated: the same inputs through `createZip`
 * and `createParallelZip` produce byte-identical archives (the M4
 * contract). Under tsx the worker script may not spawn — the pool then
 * degrades gracefully to the calling thread, which is itself part of
 * the contract and does not change the bytes.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createZip } from '../../src/index.ts';
import { createParallelZip } from '../../src/worker/index.ts';
import { type GenerateContext } from '../helpers/io.ts';

const te = new TextEncoder();

function addCorpus(writer: { add(name: string, data: Uint8Array): void }): void {
    writer.add('docs/a.txt', te.encode('parallel corpus alpha\n'.repeat(2000)));
    writer.add('docs/b.txt', te.encode('parallel corpus beta\n'.repeat(3000)));
    writer.add('data/c.bin', te.encode('0123456789'.repeat(5000)));
}

export async function generate(ctx: GenerateContext): Promise<void> {
    const sequential = createZip({ compression: { deterministic: true } });
    addCorpus(sequential);
    const seqBytes = sequential.toBytes();

    const parallel = createParallelZip({ compression: { deterministic: true }, workers: 2 });
    addCorpus(parallel);
    const parBytes = await parallel.toBytes();

    const shaSeq = createHash('sha256').update(seqBytes).digest('hex');
    const shaPar = createHash('sha256').update(parBytes).digest('hex');
    const verdict = shaSeq === shaPar ? 'IDENTICAL' : 'MISMATCH (bug!)';

    ctx.writeSafe(
        resolve(ctx.outputDir, 'parallel', 'sequential.zip'),
        `parallel/sequential.zip (sha ${shaSeq.slice(0, 12)}…)`,
        seqBytes,
    );
    ctx.writeSafe(
        resolve(ctx.outputDir, 'parallel', 'parallel.zip'),
        `parallel/parallel.zip (${verdict})`,
        parBytes,
    );
}
