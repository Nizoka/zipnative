#!/usr/bin/env node
/**
 * zipnative — agent issue-draft validator
 * =======================================
 * Validates a Markdown issue draft in .github/drafts/ against the governance
 * contract (.github/ai-governance.json) BEFORE a human reviews and submits
 * it. This is a guardrail, never an autonomous submitter. Read-only; exits 1
 * with `path:line [rule] message` diagnostics on failure.
 *
 * Rules:
 *   no-runtime-dependency  the draft proposes a runtime dependency
 *   anti-goal              the draft proposes a documented anti-goal
 *                          (encryption in 1.x, other formats, multi-disk,
 *                          filesystem I/O in the engine, repair, sockets, eval)
 *   compliance-section     the "## Compliance" section is missing
 *   reproduction           (advisory) no fenced reproduction block
 *
 * Usage: node scripts/verify-issue.mjs .github/drafts/my-draft.md
 * Exit:  0 on pass, 1 on policy violation, 2 on usage/IO error.
 *
 * The validation logic is exported as a pure function so it can be
 * unit-tested (tests/tools/verify-issue.test.ts) without touching the
 * filesystem; the CLI runs only when the file is the program entry.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Patterns that indicate a runtime dependency is being proposed. */
const DEPENDENCY_PATTERN = /\b(npm install (?!--save-dev|-D)|"dependencies"|add (a |the )?(runtime )?dependency|dependency on ['"`][a-z@])/i;

/** Documented anti-goals (README §What zipnative will NOT do). */
const ANTI_GOALS = [
    [/\b(zipcrypto|aes[- ]?encryption|encrypt(ing|ion)? support|decrypt(ing|ion)? support)\b/i, 'encryption, read or write, is out of scope in 1.x (README: What zipnative will NOT do); AES behind an injected provider is a later-major candidate'],
    [/\b(7z|rar|tar|gzip) (support|format|reading|writing)\b/i, 'other archive formats are an explicit anti-goal'],
    [/\bmulti-?disk|spanned archive\b/i, 'multi-disk archives are an explicit anti-goal'],
    [/\bwrite (to|files? on) (the )?(disk|filesystem)\b/i, 'filesystem I/O belongs to zipnative-cli, not the engine'],
    [/\b(archive )?repair (mode|support|the archive)\b/i, 'archive repair is an explicit anti-goal'],
    [/\b(open|use) (a )?(socket|network connection)\b|\beval\(/i, 'sockets and eval are banned by the charter'],
];

/** A line that merely restates the policy is not a proposal. */
const POLICY_RESTATEMENT = /not do|anti-goal|out of scope|refus|none|zero|no runtime/i;

/**
 * Validate the text of a draft issue.
 *
 * @param {string} text Raw markdown.
 * @param {string} [file] Path used in the diagnostics.
 * @returns {{ ok: boolean, problems: string[], warnings: string[] }}
 */
export function validateIssueMarkdown(text, file = '<draft>') {
    const lines = text.split(/\r?\n/);
    const problems = [];
    const warnings = [];
    const fail = (line, rule, message) => problems.push(`${file}:${line} [${rule}] ${message}`);

    lines.forEach((l, i) => {
        if (DEPENDENCY_PATTERN.test(l) && !POLICY_RESTATEMENT.test(l)) {
            fail(i + 1, 'no-runtime-dependency', 'draft appears to propose a runtime dependency — zipnative policy forbids it');
        }
        for (const [re, msg] of ANTI_GOALS) {
            if (re.test(l) && !POLICY_RESTATEMENT.test(l)) fail(i + 1, 'anti-goal', msg);
        }
    });

    if (!/^## Compliance/m.test(text)) {
        fail(1, 'compliance-section', 'draft is missing the "## Compliance" section (see .github/drafts/TEMPLATE.md)');
    }

    if (!/```[\s\S]*?```/.test(text)) {
        warnings.push(`${file}:1 [reproduction] no fenced code block — include the minimal reproduction (script or generator) inside a \`\`\` block`);
    }

    return { ok: problems.length === 0, problems, warnings };
}

// ── CLI ──────────────────────────────────────────────────────────────

function main(argv) {
    const file = argv[2];
    if (!file) {
        console.error('usage: node scripts/verify-issue.mjs <draft.md>');
        return 2;
    }
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (err) {
        console.error(`Cannot read "${file}": ${err instanceof Error ? err.message : String(err)}`);
        return 2;
    }
    const { ok, problems, warnings } = validateIssueMarkdown(text, file);
    for (const w of warnings) console.warn(`warning: ${w}`);
    if (!ok) {
        for (const p of problems) console.error(p);
        console.error(`\n${problems.length} problem(s) — draft rejected. A human must resolve these before submission.`);
        return 1;
    }
    console.error('draft OK. Reminder: this draft must be reviewed and submitted by a human under their own GitHub identity.');
    return 0;
}

// Run only when invoked directly (keeps the module import-safe for tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exit(main(process.argv));
}
