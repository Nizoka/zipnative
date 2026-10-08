import { describe, it, expect } from 'vitest';
import { validateIssueMarkdown } from '../../scripts/verify-issue.mjs';

/**
 * `scripts/verify-issue.mjs` is the mechanical half of the human-in-the-loop
 * gate: an agent's issue draft is refused before a human ever reads it when
 * it proposes a runtime dependency or a documented anti-goal, or skips the
 * compliance section. Both directions are tabled: what must fail, and what
 * a legitimate draft looks like.
 */

const GOOD = `# [zipnative] verifyEntry() reports encrypted entries as failed

## Summary
...

## Reproduction

\`\`\`js
import { openZip } from 'zipnative';
\`\`\`

## Expected behaviour
A skip reason.

## Compliance
- Zero-dependency confirmed.
`;

describe('verify-issue', () => {
    it('accepts a draft with a reproduction block and the compliance section', () => {
        const r = validateIssueMarkdown(GOOD, 'draft.md');
        expect(r.ok).toBe(true);
        expect(r.problems).toEqual([]);
        expect(r.warnings).toEqual([]);
    });

    it('refuses a runtime dependency proposal, with the line number', () => {
        const r = validateIssueMarkdown(GOOD.replace('## Summary', '## Summary\nRun npm install node-stream-zip and add a dependency on \'node-stream-zip\'.'), 'draft.md');
        expect(r.ok).toBe(false);
        expect(r.problems).toEqual([expect.stringMatching(/^draft\.md:4 \[no-runtime-dependency\]/)]);
    });

    it('refuses the documented anti-goals', () => {
        for (const [line, rule] of [
            ['Please add AES encryption support to readEntry.', 'anti-goal'],
            ['It would be great to have rar support as well.', 'anti-goal'],
            ['Support for spanned archive sets.', 'anti-goal'],
            ['The engine should write files on the filesystem directly.', 'anti-goal'],
            ['Add a repair mode for truncated archives.', 'anti-goal'],
        ] as const) {
            const r = validateIssueMarkdown(GOOD.replace('...', line), 'd.md');
            expect(r.ok, line).toBe(false);
            expect(r.problems[0], line).toContain(`[${rule}]`);
        }
    });

    it('lets a line that restates the policy through', () => {
        const r = validateIssueMarkdown(GOOD.replace('...', 'Encryption support is out of scope in 1.x, so this report is about the label only.'), 'd.md');
        expect(r.ok).toBe(true);
    });

    it('requires the compliance section and only warns about a missing reproduction block', () => {
        const noCompliance = validateIssueMarkdown(GOOD.replace('## Compliance', '## Checklist'), 'd.md');
        expect(noCompliance.ok).toBe(false);
        expect(noCompliance.problems).toEqual([expect.stringContaining('[compliance-section]')]);
        const noRepro = validateIssueMarkdown(GOOD.replace(/```[\s\S]*?```/, 'see attached'), 'd.md');
        expect(noRepro.ok).toBe(true);
        expect(noRepro.warnings).toEqual([expect.stringContaining('[reproduction]')]);
    });
});
