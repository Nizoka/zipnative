/**
 * The forward reader's trust caveat, made inspectable: an archive whose
 * LOCAL header carries a different name than the CENTRAL directory.
 * `openZip` (authoritative) trusts the CD and diagnoses the mismatch;
 * `iterateZipEntries` (forward, CD-less) can only see the local name —
 * open this sample with both and compare. This differential is the whole
 * reason the security guide says "prefer openZip when the archive is
 * complete".
 */
import { resolve } from 'node:path';
import { buildRawZip } from '../../tests/helpers/raw-zip-builder.ts';
import { type GenerateContext } from '../helpers/io.ts';

const te = new TextEncoder();

export async function generate(ctx: GenerateContext): Promise<void> {
    const archive = buildRawZip([{
        name: 'trusted-name.txt',                         // the CENTRAL directory name (authoritative)
        data: te.encode('same payload, two names\n'),
        lfhNameOverride: te.encode('local-name.txt'),     // what a forward reader sees
    }]);
    ctx.writeSafe(
        resolve(ctx.outputDir, 'forward-trust', 'lfh-cd-name-mismatch.zip'),
        "forward-trust/lfh-cd-name-mismatch.zip (CD: 'trusted-name.txt' / LFH: 'local-name.txt')",
        archive,
    );
}
