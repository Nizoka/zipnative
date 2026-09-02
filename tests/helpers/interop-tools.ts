/**
 * Foreign ZIP producers available on this machine — the interop half of
 * the anti-circularity invariant. Each producer writes an archive from a
 * directory of files using a NON-zipnative implementation; tests and the
 * conformance driver read the result back with zipnative and byte-compare.
 *
 * Detection is runtime: a producer absent from the machine is skipped
 * (and reported), never faked.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface InteropProducer {
    /** Stable id used in fixture names and reports. */
    readonly id: string;
    /** Human-readable tool description with version when detectable. */
    readonly describe: () => string | null;
    /** Create a ZIP at `archivePath` from the contents of `sourceDir`. */
    readonly produce: (sourceDir: string, archivePath: string) => boolean;
}

function run(
    command: string, args: string[], cwd?: string, okStatuses: readonly number[] = [0],
): { ok: boolean; stdout: string } {
    try {
        const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true });
        return {
            ok: result.status !== null && okStatuses.includes(result.status),
            stdout: (result.stdout ?? '') + (result.stderr ?? ''),
        };
    } catch {
        return { ok: false, stdout: '' };
    }
}

// Info-ZIP unzip's documented exit codes (man unzip, DIAGNOSTICS): 0 =
// no errors or warnings; 1 = "one or more warning errors were
// encountered, but processing completed successfully anyway" (fires on
// an empty zipfile and on SFX-prefixed archives); 2+ = real format/CRC
// errors. Treating 1 as failure would reject archives unzip itself
// processed fine — so unzip alone accepts {0, 1}.
const UNZIP_OK = [0, 1] as const;

// 7-Zip's documented exit codes (man 7z, DIAGNOSTICS): 0 = no errors or
// warnings; 1 = "Warning (Non fatal error(s))" — fires on prepended
// data (SFX stubs: "there are some data before archive"), observed on
// both CI runner images; 2 = fatal error, which is where CRC/format
// failures land. Same policy as unzip: {0, 1} passes, 2+ fails. In
// extract mode the byte-compare that follows remains the content gate.
const SEVENZIP_OK = [0, 1] as const;

function firstWorking(commands: string[], args: string[]): string | null {
    for (const command of commands) {
        if (run(command, args).ok) return command;
    }
    return null;
}

export const PRODUCERS: InteropProducer[] = [
    {
        id: 'powershell-compress-archive',
        describe: () => {
            const shell = firstWorking(['pwsh', 'powershell'], ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
            if (shell === null) return null;
            return `${shell} Compress-Archive (System.IO.Compression)`;
        },
        produce: (sourceDir, archivePath) => {
            const shell = firstWorking(['pwsh', 'powershell'], ['-NoProfile', '-Command', 'exit 0']);
            if (shell === null) return false;
            return run(shell, [
                '-NoProfile', '-Command',
                `Compress-Archive -Path '${sourceDir}/*' -DestinationPath '${archivePath}' -Force`,
            ]).ok;
        },
    },
    {
        id: 'bsdtar',
        describe: () => {
            const probe = run('tar', ['--version']);
            return probe.ok && probe.stdout.includes('bsdtar') ? probe.stdout.split('\n')[0].trim() : null;
        },
        produce: (sourceDir, archivePath) => {
            const probe = run('tar', ['--version']);
            if (!probe.ok || !probe.stdout.includes('bsdtar')) return false;
            return run('tar', ['-a', '-cf', archivePath, '-C', sourceDir, '.']).ok;
        },
    },
    {
        id: 'infozip',
        describe: () => {
            const probe = run('zip', ['-v']);
            return probe.ok ? (probe.stdout.split('\n').find((l) => l.includes('Zip'))?.trim() ?? 'Info-ZIP zip') : null;
        },
        produce: (sourceDir, archivePath) =>
            run('zip', ['-r', '-q', archivePath, '.'], sourceDir).ok,
    },
    {
        id: '7z',
        describe: () => {
            for (const cmd of ['7z', '7za', 'C:\\Program Files\\7-Zip\\7z.exe']) {
                const probe = run(cmd, ['i']);
                if (probe.ok) return `${cmd} ${probe.stdout.split('\n')[1]?.trim() ?? ''}`.trim();
            }
            return null;
        },
        produce: (sourceDir, archivePath) => {
            for (const cmd of ['7z', '7za', 'C:\\Program Files\\7-Zip\\7z.exe']) {
                if (run(cmd, ['a', '-tzip', '-y', archivePath, '.'], sourceDir).ok) return true;
            }
            return false;
        },
    },
    {
        id: 'python-zipfile',
        describe: () => {
            const python = firstWorking(['python3', 'python'], ['--version']);
            return python === null ? null : `${python} -m zipfile`;
        },
        produce: (sourceDir, archivePath) => {
            const python = firstWorking(['python3', 'python'], ['--version']);
            if (python === null) return false;
            return run(python, ['-m', 'zipfile', '-c', archivePath, '.'], sourceDir).ok;
        },
    },
    {
        id: 'jar',
        describe: () => {
            const probe = run('jar', ['--version']);
            return probe.ok ? probe.stdout.split('\n')[0].trim() : null;
        },
        produce: (sourceDir, archivePath) =>
            run('jar', ['--create', '--no-manifest', '--file', archivePath, '-C', sourceDir, '.']).ok,
    },
];

// ── Foreign extractors (write-direction gate, M2) ────────────────────

export interface InteropExtractor {
    /** Stable id used in reports. */
    readonly id: string;
    /** Human-readable tool description, or null when unavailable. */
    readonly describe: () => string | null;
    /** Integrity-check the archive without extracting (preferred for huge archives). */
    readonly test?: (archivePath: string) => boolean;
    /** Extract the archive into `destDir` for byte comparison. */
    readonly extract?: (archivePath: string, destDir: string) => boolean;
}

function sevenZipCmd(): string | null {
    for (const cmd of ['7z', '7za', 'C:\\Program Files\\7-Zip\\7z.exe']) {
        if (run(cmd, ['i']).ok) return cmd;
    }
    return null;
}

export const EXTRACTORS: InteropExtractor[] = [
    {
        id: 'powershell-expand-archive',
        describe: () => {
            const shell = firstWorking(['pwsh', 'powershell'], ['-NoProfile', '-Command', 'exit 0']);
            return shell === null ? null : `${shell} Expand-Archive (System.IO.Compression)`;
        },
        extract: (archivePath, destDir) => {
            const shell = firstWorking(['pwsh', 'powershell'], ['-NoProfile', '-Command', 'exit 0']);
            if (shell === null) return false;
            return run(shell, [
                '-NoProfile', '-Command',
                `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
            ]).ok;
        },
    },
    {
        id: 'bsdtar',
        describe: () => {
            const probe = run('tar', ['--version']);
            return probe.ok && probe.stdout.includes('bsdtar') ? probe.stdout.split('\n')[0].trim() : null;
        },
        test: (archivePath) => run('tar', ['-tf', archivePath]).ok,
        extract: (archivePath, destDir) => run('tar', ['-xf', archivePath, '-C', destDir]).ok,
    },
    {
        id: 'unzip',
        describe: () => {
            const probe = run('unzip', ['-v']);
            return probe.ok ? (probe.stdout.split('\n').find((l) => l.includes('UnZip'))?.trim() ?? 'Info-ZIP unzip') : null;
        },
        test: (archivePath) => run('unzip', ['-t', '-qq', archivePath], undefined, UNZIP_OK).ok,
        extract: (archivePath, destDir) => run('unzip', ['-o', '-qq', archivePath, '-d', destDir], undefined, UNZIP_OK).ok,
    },
    {
        id: '7z',
        describe: () => {
            const cmd = sevenZipCmd();
            return cmd === null ? null : `${cmd} (7-Zip)`;
        },
        test: (archivePath) => {
            const cmd = sevenZipCmd();
            return cmd !== null && run(cmd, ['t', '-y', archivePath], undefined, SEVENZIP_OK).ok;
        },
        extract: (archivePath, destDir) => {
            const cmd = sevenZipCmd();
            return cmd !== null && run(cmd, ['x', '-y', `-o${destDir}`, archivePath], undefined, SEVENZIP_OK).ok;
        },
    },
    {
        id: 'python-zipfile',
        describe: () => {
            const python = firstWorking(['python3', 'python'], ['--version']);
            return python === null ? null : `${python} -m zipfile`;
        },
        test: (archivePath) => {
            const python = firstWorking(['python3', 'python'], ['--version']);
            return python !== null && run(python, ['-m', 'zipfile', '-t', archivePath]).ok;
        },
        extract: (archivePath, destDir) => {
            const python = firstWorking(['python3', 'python'], ['--version']);
            return python !== null && run(python, ['-m', 'zipfile', '-e', archivePath, destDir]).ok;
        },
    },
    {
        id: 'jar',
        describe: () => {
            const probe = run('jar', ['--version']);
            return probe.ok ? probe.stdout.split('\n')[0].trim() : null;
        },
        test: (archivePath) => run('jar', ['tf', archivePath]).ok,
        extract: (archivePath, destDir) => run('jar', ['xf', archivePath], destDir).ok,
    },
];

/** The canonical interop content set: text, binary-ish, subdir, non-ASCII name. */
export interface InteropCase {
    readonly path: string;
    readonly content: Uint8Array;
}

const te = new TextEncoder();

export function interopCases(): InteropCase[] {
    const binary = new Uint8Array(4096);
    for (let i = 0; i < binary.length; i++) binary[i] = (i * 31 + 7) & 0xff;
    return [
        { path: 'readme.txt', content: te.encode('interop corpus — plain ASCII text\n') },
        { path: 'data/compressible.txt', content: te.encode('the same line over and over\n'.repeat(500)) },
        { path: 'data/binary.bin', content: binary },
        { path: 'unicode-café.txt', content: te.encode('non-ASCII filename content\n') },
    ];
}

/** Materialize the content set into a fresh temp dir; returns its path. */
export function writeInteropSource(): string {
    const dir = mkdtempSync(join(tmpdir(), 'zipnative-interop-'));
    for (const item of interopCases()) {
        const full = join(dir, item.path);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, item.content);
    }
    return dir;
}

/** Produce one archive with one producer; returns its bytes or null. */
export function produceArchive(producer: InteropProducer, sourceDir: string): Uint8Array | null {
    const dir = mkdtempSync(join(tmpdir(), `zipnative-out-${producer.id}-`));
    const archivePath = join(dir, 'out.zip');
    try {
        if (!producer.produce(sourceDir, archivePath)) return null;
        return new Uint8Array(readFileSync(archivePath));
    } catch {
        return null;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

export function cleanupDir(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
}
