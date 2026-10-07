/** The verdict of `validateIssueMarkdown`: `problems` block submission, `warnings` are advisory. */
export interface IssueValidation {
    readonly ok: boolean;
    readonly problems: string[];
    readonly warnings: string[];
}

/** Validate a draft issue's Markdown against .github/ai-governance.json; `file` is used in the diagnostics. */
export function validateIssueMarkdown(text: string, file?: string): IssueValidation;
