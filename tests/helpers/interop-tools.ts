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

function run(command: string, args: string[], cwd?: string): { ok: boolean; stdout: string } {
    try {
        const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true });
        return { ok: result.status === 0, stdout: (result.stdout ?? '') + (result.stderr ?? '') };
    } catch {
        return { ok: false, stdout: '' };
    }
}

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
