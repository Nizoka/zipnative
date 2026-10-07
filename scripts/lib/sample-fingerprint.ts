/**
 * zipnative — Sample fingerprinting core (v1.1.0)
 * ================================================
 * Shared by the `verify:samples` CLI and the vitest regression gate
 * (tests/regression/samples.test.ts), so both compute the identical
 * fingerprint and there is one definition of what "unchanged output" means.
 *
 * Every sample is fingerprinted as the SHA-256 of its bytes: zipnative's
 * writer is deterministic by contract (docs/guides/determinism.md) and no
 * generator depends on the clock, randomness or the host timezone
 * (scripts/helpers/tz.ts pins the zone anyway), so the corpus is a pure
 * function of the sources. There is no "semantic" mode — nothing in a ZIP
 * archive is CSPRNG-derived.
 *
 * The baseline is a CHAIN, not a snapshot: each entry records the release
 * whose output its hash is (`since`) and keeps it across every later
 * rebaseline that leaves the sample alone, so 1.1.0 is still held to the
 * bytes v1.0.0 emitted, 1.2.0 will be held to 1.1.0's, and so on.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
export const OUTPUT_DIR = join(REPO_ROOT, 'test-output');
export const BASELINE_PATH = join(REPO_ROOT, 'tests', 'regression', 'baselines', 'samples.sha256.json');

/** What fingerprinting a sample yields, independent of any baseline. */
export interface Fingerprint {
    readonly hash: string;
    /** Byte length — informational, and a cheap first signal in diffs. */
    readonly size: number;
}

export interface BaselineEntry extends Fingerprint {
    /**
     * Release whose output this fingerprint captures — the sample's oldest
     * verified reference, carried forward untouched by every later
     * rebaseline. A sample first fingerprinted in 1.1.0 reads `"1.1.0"` and
     * has no earlier reference to be compared against; one that reads
     * `"1.0.0"` is still being held to the bytes v1.0.0 emitted.
     */
    readonly since: string;
}

export interface Baseline {
    readonly $comment: string;
    /** Release at which the manifest was last written. */
    readonly baselineVersion: string;
    /** How the oldest entries were verified against the previous release. */
    readonly provenance: string;
    readonly timezone: string;
    readonly entries: Record<string, BaselineEntry>;
}

/** The version in package.json — stamped on newly baselined samples. */
export function currentVersion(): string {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
    return pkg.version;
}

// ── Helpers ──────────────────────────────────────────────────────────

export function sha256Hex(data: Uint8Array | string): string {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    return createHash('sha256').update(buf).digest('hex');
}

/** Yield every `.zip` under `dir`, depth-first, in a stable order. */
export function* walkZips(dir: string): Generator<string> {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) yield* walkZips(p);
        else if (entry.endsWith('.zip')) yield p;
    }
}

/** Repo-relative, forward-slashed path of a sample under `test-output/`. */
export function relPath(abs: string): string {
    return relative(OUTPUT_DIR, abs).split('\\').join('/');
}

/** Fingerprint one sample. */
export function fingerprint(absPath: string): Fingerprint {
    const bytes = readFileSync(absPath);
    return { hash: sha256Hex(bytes), size: bytes.length };
}

export interface FingerprintRun {
    readonly entries: Record<string, Fingerprint>;
    readonly unreadable: { readonly path: string; readonly error: string }[];
}

/** Fingerprint every sample currently in `test-output/`. */
export function fingerprintAll(): FingerprintRun {
    const entries: Record<string, Fingerprint> = {};
    const unreadable: { path: string; error: string }[] = [];
    for (const file of walkZips(OUTPUT_DIR)) {
        const rel = relPath(file);
        try {
            entries[rel] = fingerprint(file);
        } catch (err) {
            unreadable.push({ path: rel, error: err instanceof Error ? err.message : String(err) });
        }
    }
    return { entries, unreadable };
}

export function loadBaseline(): Baseline | null {
    if (!existsSync(BASELINE_PATH)) return null;
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
}

export interface Comparison {
    readonly changed: string[];
    readonly added: string[];
    readonly removed: string[];
}

export function compareToBaseline(entries: Record<string, Fingerprint>, baseline: Baseline): Comparison {
    const changed: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    for (const [rel, entry] of Object.entries(entries)) {
        const base = baseline.entries[rel];
        if (!base) { added.push(rel); continue; }
        if (base.hash !== entry.hash) changed.push(rel);
    }
    for (const rel of Object.keys(baseline.entries)) {
        if (!(rel in entries)) removed.push(rel);
    }
    return { changed, added, removed };
}

/**
 * Stamp each fingerprint with the release whose output it is.
 *
 * An entry that still hashes to what the previous manifest recorded keeps
 * its `since` untouched, which is what gives the chain meaning: an entry
 * reading `1.0.0` really is being held to the bytes v1.0.0 emitted. An
 * entry whose hash changed is being re-anchored to the tree under
 * development, so it takes the current version — otherwise a deliberate
 * rebaseline would hide inside a one-line hash diff instead of announcing
 * itself.
 */
export function chainSince(
    entries: Record<string, Fingerprint>,
    previous: Baseline | null,
    version: string,
): Record<string, BaselineEntry> {
    const out: Record<string, BaselineEntry> = {};
    for (const key of Object.keys(entries).sort()) {
        const before = previous?.entries[key];
        const unchanged = before !== undefined && before.hash === entries[key].hash;
        out[key] = { ...entries[key], since: unchanged ? before.since : version };
    }
    return out;
}

/**
 * Samples that are expected to be byte-identical: each group is one output
 * produced two ways — the determinism showcase pair, and the worker pool
 * versus the sequential writer. Any other pair sharing a hash is a sample
 * that no longer demonstrates what its name claims.
 */
export const IDENTICAL_SAMPLE_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
    ['deterministic/deterministic-a.zip', 'deterministic/deterministic-b.zip'],
    ['parallel/parallel.zip', 'parallel/sequential.zip'],
    // Known since the 1.0.0 baseline was captured: the level ladder of the
    // deterministic encoder converges on this sample's short input, so
    // level 6 and level 9 emit the same bytes. Listed rather than hidden;
    // the generator keeps the pair until a larger input is chosen (which
    // re-anchors both hashes visibly in the manifest).
    ['basic-formats/deflate-level-6.zip', 'basic-formats/deflate-level-9.zip'],
];

/**
 * Groups of samples that share a fingerprint without being listed in
 * {@link IDENTICAL_SAMPLE_GROUPS}. Empty when every duplicate is expected.
 */
export function unexpectedDuplicates(entries: Record<string, { readonly hash: string }>): string[][] {
    const byHash = new Map<string, string[]>();
    for (const [rel, entry] of Object.entries(entries)) {
        const group = byHash.get(entry.hash) ?? [];
        group.push(rel);
        byHash.set(entry.hash, group);
    }
    const allowed = IDENTICAL_SAMPLE_GROUPS.map(g => [...g].sort().join('\n'));
    const out: string[][] = [];
    for (const group of byHash.values()) {
        if (group.length < 2) continue;
        const sorted = [...group].sort();
        if (!allowed.includes(sorted.join('\n'))) out.push(sorted);
    }
    return out.sort((a, b) => a[0].localeCompare(b[0]));
}
