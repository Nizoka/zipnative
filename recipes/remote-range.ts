/**
 * Recipe: open an archive through an injected byte-range source — the
 * shape of an HTTP `Range` client, a `Blob`, a file handle or object
 * storage — and read one entry with the memory of the central directory.
 * The engine never fetches: `openZipRange()` asks the source for exactly
 * the bytes a read needs (one tail window, the central directory, the
 * entry's local header and payload), and every cross-check of `openZip()`
 * applies unchanged.
 */
import { createZip, openZipRange, type ByteRangeSource } from 'zipnative';

export default async function run(): Promise<Record<string, string>> {
    // The "remote" archive: ~480 KB of stored padding around the entry we
    // want — larger than the tail window the reader fetches to find the
    // end-of-central-directory record (the APPNOTE scan window plus 64 KiB
    // of slack, about 195 KiB at most).
    const zip = createZip({ compression: { deterministic: true } });
    zip.add('README.md', '# remote\n');
    zip.add('data/padding.txt', 'padding '.repeat(60_000), { compression: { method: 'store' } });
    zip.add('manifest.json', '{"content":"hello remote"}');
    const archive = zip.toBytes();

    // A counting source over the bytes — swap `archive.subarray` for a
    // fetch with a Range header, `blob.slice`, or `handle.read` in production.
    let reads = 0;
    let bytesFetched = 0;
    const source: ByteRangeSource = {
        size: archive.length,
        async read(offset, length) {
            reads++;
            bytesFetched += Math.min(length, archive.length - offset);
            return archive.subarray(offset, offset + length);
        },
    };

    const remote = await openZipRange(source);
    const names = [...remote.entries()].map((e) => e.name);
    const manifest = JSON.parse(new TextDecoder().decode(await remote.readEntry('manifest.json'))) as { content: string };

    return {
        entries: String(names.length),
        content: manifest.content,
        // The padding entry was never fetched: the reads stay far below the archive size.
        'reads-bounded': String(reads <= 4 && bytesFetched < archive.length / 2),
    };
}
