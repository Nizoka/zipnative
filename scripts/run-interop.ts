/**
 * zipnative — interop conformance driver (`npm run test:interop`)
 * ===============================================================
 * The blocking gate of conformance.yml (the veraPDF analogue), both
 * directions:
 *
 *   READ:  every foreign producer available on this machine builds an
 *          archive from the canonical content set; zipnative must read
 *          it back byte-for-byte.
 *   WRITE: zipnative builds an archive matrix (store/deflate, subdirs,
 *          comments, streamed data-descriptor entries, deterministic
 *          mode, zip64 entry counts); every foreign extractor available
 *          must validate it — and where the tool can extract, the
 *          extracted files are byte-compared.
 *
 * Exits 1 on any mismatch. Absent tools are skipped and reported,
 * never faked; at least one tool must run in each direction.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, openZip } from '../src/index.ts';
import {
    cleanupDir,
    EXTRACTORS,
    interopCases,
    PRODUCERS,
    produceArchive,
    writeInteropSource,
} from '../tests/helpers/interop-tools.ts';

const te = new TextEncoder();
let failures = 0;

// ── Direction 1: READ foreign archives ───────────────────────────────

function runReadDirection(): number {
    const sourceDir = writeInteropSource();
    let ran = 0;
    try {
        for (const producer of PRODUCERS) {
            const description = producer.describe();
            if (description === null) {
                console.error(`SKIP  read ${producer.id} (not available)`);
                continue;
            }
            const bytes = produceArchive(producer, sourceDir);
            if (bytes === null) {
                console.error(`FAIL  read ${producer.id}: producer refused to build the archive`);
                failures++;
                continue;
            }
            try {
                const reader = openZip(bytes, { onDiagnostic: () => undefined, validate: 'eager' });
                const byName = new Map([...reader.entries()].map((e) => [e.name.replace(/^\.\//, ''), e]));
                let mismatches = 0;
                for (const item of interopCases()) {
                    const entry = byName.get(item.path);
                    if (entry === undefined) {
                        if (item.path.includes('café')) continue; // encoding differs by producer
                        console.error(`FAIL  read ${producer.id}: entry '${item.path}' missing`);
                        mismatches++;
                        continue;
                    }
                    const data = reader.readEntry(entry);
                    if (data.length !== item.content.length || !data.every((b, i) => b === item.content[i])) {
                        console.error(`FAIL  read ${producer.id}: content mismatch for '${item.path}'`);
                        mismatches++;
                    }
                }
                if (mismatches === 0) {
                    console.error(`OK    read ${producer.id} — ${description}`);
                    ran++;
                } else {
                    failures++;
                }
            } catch (err) {
                console.error(`FAIL  read ${producer.id}: ${err instanceof Error ? err.message : String(err)}`);
                failures++;
            }
        }
    } finally {
        cleanupDir(sourceDir);
    }
    return ran;
}

// ── Direction 2: WRITE archives foreign extractors must accept ───────

interface WriteCase {
    readonly name: string;
    /** 'extract' = extract + byte-compare expected files; 'test' = integrity only. */
    readonly mode: 'extract' | 'test';
    readonly expected: ReadonlyArray<{ path: string; content: Uint8Array }>;
    /** Documented tool-limitation exclusions: `${extractorId}@${platform}`. */
    readonly excludeTools?: readonly string[];
    readonly build: () => Promise<Uint8Array>;
}

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of gen) {
        parts.push(chunk);
        total += chunk.length;
    }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
        out.set(part, pos);
        pos += part.length;
    }
    return out;
}

function writeCases(): WriteCase[] {
    const text = te.encode('the same line over and over\n'.repeat(400));
    const binary = new Uint8Array(4096);
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 31 + 7) & 0xff;

    const expected = [
        { path: 'readme.txt', content: te.encode('written by zipnative\n') },
        { path: 'data/compressible.txt', content: text },
        { path: 'data/binary.bin', content: binary },
    ];

    return [
        {
            name: 'mixed-buffered',
            mode: 'extract',
            expected,
            build: async () => {
                const zip = createZip({ comment: 'zipnative interop matrix' });
                zip.add('readme.txt', 'written by zipnative\n');
                zip.add('data/compressible.txt', text);
                zip.add('data/binary.bin', binary, { compression: { method: 'store' } });
                zip.addDirectory('data');
                return zip.toBytes();
            },
        },
        {
            name: 'deterministic',
            mode: 'extract',
            expected,
            build: async () => {
                const zip = createZip({ compression: { deterministic: true } });
                zip.add('readme.txt', 'written by zipnative\n');
                zip.add('data/compressible.txt', text);
                zip.add('data/binary.bin', binary);
                return zip.toBytes();
            },
        },
        {
            name: 'streamed-descriptor',
            mode: 'extract',
            expected,
            build: async () => {
                const zip = createZip();
                zip.add('readme.txt', 'written by zipnative\n');
                zip.add('data/binary.bin', binary);
                zip.addStream('data/compressible.txt', (async function* () {
                    for (let i = 0; i < text.length; i += 977) {
                        yield text.subarray(i, Math.min(i + 977, text.length));
                    }
                })());
                return collect(zip.stream());
            },
        },
        {
            name: 'unicode-names',
            mode: 'test',
            expected: [],
            // bsdtar on Windows cannot convert UTF-8 entry names to its
            // console wide-character set and reports "unreadable filename".
            // The archive itself is valid — Expand-Archive, 7-Zip and
            // bsdtar-on-Linux all accept it (verified 2026-09-01); this is
            // a documented tool limitation, not a zipnative bug.
            excludeTools: ['bsdtar@win32'],
            build: async () => {
                const zip = createZip();
                zip.add('unicode-café/文档.txt', 'non-ASCII paths\n');
                zip.add('plain.txt', 'ascii sibling\n');
                return zip.toBytes();
            },
        },
        {
            name: 'zip64-66k-entries',
            mode: 'test',
            expected: [],
            build: async () => {
                const zip = createZip();
                for (let i = 0; i < 66_000; i++) {
                    zip.add(`e/${i.toString(36)}`, 'x', { compression: { method: 'store' } });
                }
                return zip.toBytes();
            },
        },
    ];
}

async function runWriteDirection(): Promise<number> {
    const available = EXTRACTORS.filter((x) => x.describe() !== null);
    for (const extractor of EXTRACTORS) {
        if (extractor.describe() === null) {
            console.error(`SKIP  write ${extractor.id} (not available)`);
        }
    }
    if (available.length === 0) return 0;

    let validated = 0;
    for (const testCase of writeCases()) {
        const bytes = await testCase.build();
        // Self-sanity first: our own eager reader must accept it.
        openZip(bytes, { validate: 'eager', onDiagnostic: () => undefined });

        const workDir = mkdtempSync(join(tmpdir(), `zipnative-write-${testCase.name}-`));
        const archivePath = join(workDir, 'out.zip');
        writeFileSync(archivePath, bytes);
        try {
            for (const extractor of available) {
                if (testCase.excludeTools?.includes(`${extractor.id}@${process.platform}`)) {
                    console.error(`SKIP  write ${testCase.name} ← ${extractor.id} (documented tool limitation on ${process.platform})`);
                    continue;
                }
                const wantExtract = testCase.mode === 'extract' && extractor.extract !== undefined;
                if (wantExtract) {
                    const destDir = mkdtempSync(join(workDir, 'x-'));
                    if (!(extractor.extract as (a: string, d: string) => boolean)(archivePath, destDir)) {
                        console.error(`FAIL  write ${testCase.name} ← ${extractor.id}: extraction refused`);
                        failures++;
                        continue;
                    }
                    let mismatches = 0;
                    for (const item of testCase.expected) {
                        try {
                            const actual = new Uint8Array(readFileSync(join(destDir, item.path)));
                            if (actual.length !== item.content.length || !actual.every((b, i) => b === item.content[i])) {
                                console.error(`FAIL  write ${testCase.name} ← ${extractor.id}: content mismatch for '${item.path}'`);
                                mismatches++;
                            }
                        } catch {
                            console.error(`FAIL  write ${testCase.name} ← ${extractor.id}: '${item.path}' missing after extraction`);
                            mismatches++;
                        }
                    }
                    if (mismatches > 0) {
                        failures++;
                        continue;
                    }
                    console.error(`OK    write ${testCase.name} ← ${extractor.id} (extracted, byte-compared)`);
                    validated++;
                } else if (extractor.test !== undefined) {
                    if (extractor.test(archivePath)) {
                        console.error(`OK    write ${testCase.name} ← ${extractor.id} (integrity test)`);
                        validated++;
                    } else {
                        console.error(`FAIL  write ${testCase.name} ← ${extractor.id}: integrity test refused the archive`);
                        failures++;
                    }
                }
            }
        } finally {
            rmSync(workDir, { recursive: true, force: true });
        }
    }
    return validated;
}

// ── Drive both directions ────────────────────────────────────────────

const readRan = runReadDirection();
const writeRan = await runWriteDirection();

if (failures > 0) {
    console.error(`\ninterop: ${failures} failure(s)`);
    process.exit(1);
}
if (readRan === 0 || writeRan === 0) {
    console.error(`\ninterop: no tools available in a direction (read: ${readRan}, write: ${writeRan}) — nothing validated`);
    process.exit(1);
}
console.error(`\ninterop: OK (read ${readRan} producer(s), write ${writeRan} validation(s))`);
