/**
 * Recipe: parallel archive creation (`zipnative/worker`, v0.5.0) — same
 * surface as `createZip` with an async `toBytes()`; per-entry deflate
 * fans out across a worker pool and the output is BYTE-IDENTICAL to the
 * sequential writer (unconditionally so under `deterministic: true`).
 * Worker spawn failures degrade gracefully to the calling thread — the
 * bytes never change, only the scheduling.
 */
import { createZip } from 'zipnative';
import { createParallelZip } from 'zipnative/worker';

export default async function run(): Promise<Record<string, string>> {
    const add = (writer: { add(name: string, data: string): void }): void => {
        writer.add('a.txt', 'first entry '.repeat(3000));
        writer.add('b.txt', 'second entry '.repeat(2000));
        writer.add('c.bin', '0123456789'.repeat(4000));
    };

    const sequential = createZip({ compression: { deterministic: true } });
    add(sequential);
    const seq = sequential.toBytes();

    const parallel = createParallelZip({ compression: { deterministic: true }, workers: 2 });
    add(parallel);
    const par = await parallel.toBytes();

    const identical = seq.length === par.length && seq.every((b, i) => b === par[i]);
    return { identical: String(identical), entries: '3' };
}
