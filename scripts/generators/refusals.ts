/**
 * The refusals corpus: archives zipnative DELIBERATELY refuses, each
 * validated against the exact frozen `err.code` it must trigger (a
 * refusal that stops firing aborts generation — regressions cannot land
 * silently). The companion `refusals.json` maps filename → operation →
 * expected code, machine-readable for agents and interop tooling.
 * Crafted by the engine-independent raw builder (tests/helpers).
 */
import { resolve } from 'node:path';
import { buildRawZip } from '../../tests/helpers/raw-zip-builder.ts';
import { type GenerateContext } from '../helpers/io.ts';

const te = new TextEncoder();

export async function generate(ctx: GenerateContext): Promise<void> {
    const cases: ReadonlyArray<{
        readonly file: string;
        readonly via: 'openZip' | 'extractZip' | 'readEntry';
        readonly code: string;
        readonly note: string;
        readonly bytes: Uint8Array;
    }> = [
        {
            file: 'zip-slip.zip', via: 'extractZip', code: 'ZIP_PATH_TRAVERSAL',
            note: "entry name '../evil.txt' escapes the extraction root (CWE-22)",
            bytes: buildRawZip([
                { name: '../evil.txt', data: te.encode('pwned') },
                { name: 'ok.txt', data: te.encode('legit') },
            ]),
        },
        {
            file: 'device-name.zip', via: 'extractZip', code: 'ZIP_PATH_TRAVERSAL',
            note: "entry name 'aux.txt' is a Windows reserved device name (CWE-67)",
            bytes: buildRawZip([{ name: 'aux.txt', data: te.encode('device') }]),
        },
        {
            file: 'duplicate-paths.zip', via: 'extractZip', code: 'ZIP_EXTRACT_DUPLICATE_PATH',
            note: 'two entries share one output path (CWE-694); onDuplicate defaults to error',
            bytes: buildRawZip([
                { name: 'same.txt', data: te.encode('first') },
                { name: 'same.txt', data: te.encode('second') },
            ]),
        },
        {
            file: 'overlap.zip', via: 'openZip', code: 'ZIP_ENTRY_OVERLAP',
            note: 'two central records claim one local header (CWE-405); always-on, no opt-out',
            bytes: buildRawZip([
                { name: 'a.txt', data: te.encode('shared payload') },
                { name: 'b.txt', data: te.encode('shared payload'), localHeaderOffsetOverride: 0 },
            ]),
        },
        {
            file: 'cd-mismatch.zip', via: 'openZip', code: 'ZIP_CD_INCONSISTENT',
            note: 'EOCD declares more entries than the central directory holds',
            bytes: buildRawZip([{ name: 'a.txt', data: te.encode('x') }], { totalEntriesOverride: 9 }),
        },
        {
            file: 'declared-bomb.zip', via: 'readEntry', code: 'ZIP_LIMIT_EXCEEDED',
            note: 'central directory declares 2 GiB uncompressed for a tiny payload (CWE-400)',
            bytes: buildRawZip([{
                name: 'bomb.bin', data: te.encode('tiny'),
                uncompressedSizeOverride: 2 * 1024 ** 3,
            }]),
        },
    ];

    for (const c of cases) {
        ctx.writeRefusal(resolve(ctx.outputDir, 'refusals', c.file), `refusals/${c.file}`, c.bytes, c.via, c.code);
    }

    const manifest = {
        $comment: 'Each archive here MUST be refused with exactly this err.code — validated at generation time.',
        cases: cases.map(({ file, via, code, note }) => ({ file, via, expectedCode: code, note })),
    };
    ctx.writeCompanion(
        resolve(ctx.outputDir, 'refusals', 'refusals.json'),
        te.encode(`${JSON.stringify(manifest, null, 2)}\n`),
    );
}
