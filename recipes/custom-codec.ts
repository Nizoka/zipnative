/**
 * Recipe: the codec registry — the extension point for compression
 * methods zipnative deliberately does not ship (zstd, bzip2, …). A
 * registered codec makes archives using that method readable through
 * every read path; without one, the entry refuses with the typed
 * `ZIP_UNSUPPORTED_METHOD` and the remedy names `registerCodec()`.
 */
import { crc32, openZip, registerCodec, ZipError } from 'zipnative';

export default async function run(): Promise<Record<string, string>> {
    // A tiny archive whose single entry claims method 99 with a raw
    // (identity-"compressed") payload — normally unreadable.
    const payload = new TextEncoder().encode('exotic method payload');
    const archive = buildMethod99Archive(payload);

    let beforeCode = '(none)';
    try {
        openZip(archive).readEntry('x.bin');
    } catch (err) {
        if (err instanceof ZipError) beforeCode = err.code;
    }

    registerCodec({
        method: 99,
        name: 'identity-99',
        decompressSync: (data) => data.slice(),
    });
    const after = new TextDecoder().decode(openZip(archive).readEntry('x.bin'));

    return { 'before-code': beforeCode, after };
}

/** Hand-assembled single-entry archive declaring compression method 99. */
function buildMethod99Archive(data: Uint8Array): Uint8Array {
    const te = new TextEncoder();
    const name = te.encode('x.bin');
    const crc = crc32(data);
    const lfh = new Uint8Array(30 + name.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 99, true); // compression method
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lfh.set(name, 30);
    const cfh = new Uint8Array(46 + name.length);
    const cv = new DataView(cfh.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 0x031E, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 99, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, 0, true); // local header offset
    cfh.set(name, 46);
    const cdOffset = lfh.length + data.length;
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 1, true);
    ev.setUint16(10, 1, true);
    ev.setUint32(12, cfh.length, true);
    ev.setUint32(16, cdOffset, true);
    const out = new Uint8Array(cdOffset + cfh.length + eocd.length);
    out.set(lfh, 0);
    out.set(data, lfh.length);
    out.set(cfh, cdOffset);
    out.set(eocd, cdOffset + cfh.length);
    return out;
}
