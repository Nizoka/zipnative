#!/usr/bin/env node
/**
 * zipnative — agent issue-draft validator
 * =======================================
 * Validates a Markdown issue draft in .github/drafts/ against the governance
 * contract (.github/ai-governance.json). Read-only; exits 1 with
 * `path:line [rule] message` diagnostics on failure.
 *
 * Usage: node scripts/verify-issue.mjs .github/drafts/my-draft.md
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
    console.error('usage: node scripts/verify-issue.mjs <draft.md>');
    process.exit(1);
}

const text = readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);
const problems = [];

const fail = (line, rule, message) => problems.push(`${file}:${line} [${rule}] ${message}`);

// Rule: no runtime dependency proposals.
const depPattern = /\b(npm install (?!--save-dev|-D)|"dependencies"|add (a |the )?(runtime )?dependency|dependency on ['"`][a-z@])/i;
lines.forEach((l, i) => {
    if (depPattern.test(l) && !/none|zero|no runtime/i.test(l)) {
        fail(i + 1, 'no-runtime-dependency', 'draft appears to propose a runtime dependency — zipnative policy forbids it');
    }
});

// Rule: no anti-goal proposals.
const antiGoals = [
    [/\b(zipcrypto|aes[- ]?encryption|encrypt(ing|ion)? support)\b/i, 'encryption is out of scope pre-1.0 (README: What zipnative will NOT do)'],
    [/\b(7z|rar|tar|gzip) (support|format|reading|writing)\b/i, 'other archive formats are an explicit anti-goal'],
    [/\bmulti-?disk|spanned archive\b/i, 'multi-disk archives are an explicit anti-goal'],
    [/\bwrite (to|files? on) (the )?(disk|filesystem)\b/i, 'filesystem I/O belongs to zipnative-cli, not the engine'],
];
lines.forEach((l, i) => {
    for (const [re, msg] of antiGoals) {
        if (re.test(l) && !/not do|anti-goal|out of scope|refus/i.test(l)) fail(i + 1, 'anti-goal', msg);
    }
});

// Rule: compliance section present.
if (!/^## Compliance/m.test(text)) {
    fail(1, 'compliance-section', 'draft is missing the "## Compliance" section (see .github/drafts/TEMPLATE.md)');
}

if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error(`\n${problems.length} problem(s) — draft rejected.`);
    process.exit(1);
}
console.error('draft OK');
