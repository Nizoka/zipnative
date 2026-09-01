/**
 * The determinism contract, demonstrated: two independent builds with
 * identical inputs produce byte-identical archives (docs/determinism.md).
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createZip } from '../../src/index.ts';
import { type GenerateContext } from '../helpers/io.ts';

function build(): Uint8Array {
    const zip = createZip({ compression: { deterministic: true } });
    zip.add('manifest.json', '{"name":"demo","version":"1.0.0"}\n');
    zip.add('data/payload.txt', 'reproducible content '.repeat(500));
    zip.addDirectory('data');
    return zip.toBytes();
}

export async function generate(ctx: GenerateContext): Promise<void> {
    const a = build();
    const b = build();
    const shaA = createHash('sha256').update(a).digest('hex');
    const shaB = createHash('sha256').update(b).digest('hex');
    const match = shaA === shaB ? 'IDENTICAL' : 'MISMATCH (bug!)';
    ctx.writeSafe(
        resolve(ctx.outputDir, 'deterministic', 'deterministic-a.zip'),
        `deterministic/deterministic-a.zip (sha ${shaA.slice(0, 12)}…)`,
        a,
    );
    ctx.writeSafe(
        resolve(ctx.outputDir, 'deterministic', 'deterministic-b.zip'),
        `deterministic/deterministic-b.zip (${match})`,
        b,
    );
}
