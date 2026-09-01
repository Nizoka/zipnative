/**
 * The incremental modifier (v0.4.0), as a before/after/compacted triple:
 *   -original.zip   the base archive
 *   -updated.zip    after replace+add+remove via save() — open it in a hex
 *                   editor: the first bytes are IDENTICAL to -original.zip
 *                   (append-only), and the removed payload is still inside
 *                   (data remanence, see SECURITY.md)
 *   -compacted.zip  the same edits via saveCompact() — removed content is
 *                   truly gone and the layout is canonical
 */
import { resolve } from 'node:path';
import { createZip, createZipModifier, openZip } from '../../src/index.ts';
import { type GenerateContext } from '../helpers/io.ts';

export async function generate(ctx: GenerateContext): Promise<void> {
    const write = (name: string, label: string, bytes: Uint8Array): void =>
        ctx.writeSafe(resolve(ctx.outputDir, 'incremental', name), `incremental/${label}`, bytes);

    const base = ((): Uint8Array => {
        const zip = createZip({ compression: { deterministic: true } });
        zip.add('config.json', '{"env":"production","version":1}\n');
        zip.add('data/large.txt', 'untouched large payload line\n'.repeat(2000));
        zip.add('obsolete.log', 'REMANENT-LOG-CONTENT '.repeat(50));
        return zip.toBytes();
    })();
    write('incremental-original.zip', 'incremental-original.zip', base);

    const applyEdits = (bytes: Uint8Array): ReturnType<typeof createZipModifier> => {
        const modifier = createZipModifier(openZip(bytes), { onDiagnostic: () => undefined });
        modifier.replaceEntry('config.json', '{"env":"production","version":2}\n');
        modifier.addEntry('CHANGES.md', '# v2\n- config bumped\n');
        modifier.removeEntry('obsolete.log');
        return modifier;
    };

    const updated = applyEdits(base).save();
    const prefixIntact = updated.subarray(0, base.length).every((b, i) => b === base[i]);
    write('incremental-updated.zip', `incremental-updated.zip (prefix intact: ${String(prefixIntact)})`, updated);

    write('incremental-compacted.zip', 'incremental-compacted.zip (true deletion)', applyEdits(base).saveCompact());
}
