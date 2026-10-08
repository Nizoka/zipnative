/**
 * Entry-name shapes: ASCII, UTF-8 (flag bit 11), deep paths — and a legacy
 * code page (Shift-JIS, bit 11 clear) as the real-world long tail still
 * produces: readable through `nameDecoder` (1.1.0), declared
 * non-conformant to ISO/IEC 21320-1 (APPNOTE 4.4.4 demands UTF-8).
 */
import { resolve } from 'node:path';
import { createZip } from '../../src/index.ts';
import { buildRawZip } from '../../tests/helpers/raw-zip-builder.ts';
import { type GenerateContext } from '../helpers/io.ts';

export async function generate(ctx: GenerateContext): Promise<void> {
    const write = (name: string, bytes: Uint8Array): void =>
        ctx.writeSafe(resolve(ctx.outputDir, 'names-encoding', name), `names-encoding/${name}`, bytes);

    {
        const zip = createZip();
        zip.add('simple.txt', 'ascii name\n');
        zip.add('with-dash_and.dots.txt', 'punctuation\n');
        write('ascii.zip', zip.toBytes());
    }
    {
        const zip = createZip();
        zip.add('café/résumé.txt', 'french\n');
        zip.add('文档/说明.md', 'chinese\n');
        zip.add('日本語/読み物.txt', 'japanese\n');
        zip.add('emoji-📦.txt', 'emoji in name\n');
        write('unicode-utf8.zip', zip.toBytes());
    }
    {
        const zip = createZip();
        zip.add('a/'.repeat(40) + 'deep.txt', 'forty levels down\n');
        write('deep-paths.zip', zip.toBytes());
    }
    {
        // 日本語/読み物.txt in Shift-JIS, no bit 11 — what a 2005 Windows
        // producer wrote. openZip(bytes, { nameDecoder: (b) => new
        // TextDecoder('shift_jis').decode(b) }) reads the real name.
        const shiftJis = new Uint8Array([
            0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x2f, // 日本語/
            0x93, 0xc7, 0x82, 0xdd, 0x95, 0xa8, 0x2e, 0x74, 0x78, 0x74, // 読み物.txt
        ]);
        write('shift-jis-legacy.zip', buildRawZip([
            { name: shiftJis, data: new TextEncoder().encode('legacy code page name\n'), method: 8 },
        ]));
    }
}
