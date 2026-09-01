/** Odd-but-legal shapes: SFX-style prefix, empty entries, extreme ratio. */
import { resolve } from 'node:path';
import { createZip, createZipModifier, openZip } from '../../src/index.ts';
import { type GenerateContext } from '../helpers/io.ts';

const te = new TextEncoder();

export async function generate(ctx: GenerateContext): Promise<void> {
    const write = (name: string, label: string, bytes: Uint8Array): void =>
        ctx.writeSafe(resolve(ctx.outputDir, 'edge-cases', name), `edge-cases/${label}`, bytes);

    {
        // A prepended stub (self-extractor shape). Built by prefixing a normal
        // archive and letting the modifier re-anchor the trailer — the result
        // opens in zipnative (with a ZIP_PREPENDED_DATA info) and in foreign
        // tools that apply the standard offset shift.
        const inner = ((): Uint8Array => {
            const zip = createZip();
            zip.add('payload.txt', 'archive behind a stub\n');
            return zip.toBytes();
        })();
        const stub = te.encode('#!/bin/sh\necho "self-extracting stub placeholder"\n');
        const prefixed = new Uint8Array(stub.length + inner.length);
        prefixed.set(stub, 0);
        prefixed.set(inner, stub.length);
        // Re-anchor via a no-edit-plus-comment incremental save (writes a new,
        // self-consistent EOCD after the prefixed layout).
        const modifier = createZipModifier(openZip(prefixed, { onDiagnostic: () => undefined }), { onDiagnostic: () => undefined });
        modifier.setComment('sfx sample');
        write('sfx-prefixed.zip', 'sfx-prefixed.zip (stub + shifted offsets)', modifier.save());
    }
    {
        const zip = createZip();
        zip.add('empty-file.txt', new Uint8Array(0));
        zip.addDirectory('empty-dir');
        write('empty-entries.zip', 'empty-entries.zip', zip.toBytes());
    }
    {
        const zip = createZip();
        zip.add('zeros.bin', new Uint8Array(2_000_000)); // ~1000:1 after deflate
        write('high-ratio.zip', 'high-ratio.zip (2 MB → ~2 KB)', zip.toBytes());
    }
}
