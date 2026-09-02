/**
 * zipnative — contributor sample generation (`npm run test:generate`)
 * ===================================================================
 * Writes a corpus of demonstration archives into the git-ignored
 * `test-output/` directory for human inspection with real tools
 * (Explorer, 7-Zip, unzip, hex editors) — the pdfnative contributor
 * model. Every sample is self-validated through zipnative's eager
 * reader as it is written (scripts/helpers/io.ts); the foreign-tool
 * validation lives in the interop gate (`npm run test:interop`).
 *
 * Adding a category: see scripts/README.md.
 */
import { createContext, printSummary } from './helpers/io.ts';
import { generate as generateBasicFormats } from './generators/basic-formats.ts';
import { generate as generateNamesEncoding } from './generators/names-encoding.ts';
import { generate as generateZip64 } from './generators/zip64.ts';
import { generate as generateStreaming } from './generators/streaming.ts';
import { generate as generateDeterministic } from './generators/deterministic.ts';
import { generate as generateComments } from './generators/comments.ts';
import { generate as generateIncremental } from './generators/incremental.ts';
import { generate as generateEdgeCases } from './generators/edge-cases.ts';
import { generate as generateParallel } from './generators/parallel.ts';
import { generate as generateRefusals } from './generators/refusals.ts';
import { generate as generateForwardTrust } from './generators/forward-trust.ts';
import { generate as generateAttributes } from './generators/attributes.ts';

async function generateAll(): Promise<void> {
    const ctx = createContext();

    // ── Basic archive shapes (v0.2.0) ────────────────────────────────
    await generateBasicFormats(ctx);

    // ── Entry-name encodings (v0.2.0) ────────────────────────────────
    await generateNamesEncoding(ctx);

    // ── Zip64 (v0.2.0) ───────────────────────────────────────────────
    await generateZip64(ctx);

    // ── Streaming / data descriptors (v0.2.0) ────────────────────────
    await generateStreaming(ctx);

    // ── Determinism contract (v0.2.0) ────────────────────────────────
    await generateDeterministic(ctx);

    // ── Comments (v0.2.0) ────────────────────────────────────────────
    await generateComments(ctx);

    // ── Incremental modification (v0.4.0) ────────────────────────────
    await generateIncremental(ctx);

    // ── Odd-but-legal edge cases (v0.4.0) ────────────────────────────
    await generateEdgeCases(ctx);

    // ── Worker parallelism byte-identity (v0.5.0) ────────────────────
    await generateParallel(ctx);

    // ── Deliberate refusals + machine-readable manifest (v0.9.0) ─────
    await generateRefusals(ctx);

    // ── The forward reader's trust differential (v0.9.0) ─────────────
    await generateForwardTrust(ctx);

    // ── Unix attributes: modes + symlink (v0.9.0) ────────────────────
    await generateAttributes(ctx);

    printSummary(ctx.results, ctx.outputDir);
}

generateAll().catch((err: unknown) => {
    console.error('❌ Sample generation failed:', err);
    process.exit(1);
});
