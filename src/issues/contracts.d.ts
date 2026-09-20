/**
 * Issue → Harness contracts (Issue #38).
 *
 * Core knows only these shapes: an external issue source (GitHub, GitLab,
 * ...) is resolved through the IssueResolver port into an IssueRecord,
 * and transformed into a HarnessInput — a structured execution input.
 * The issue body is NEVER a trusted instruction: it travels inside the
 * untrusted content boundary (#27/#34) and grants nothing.
 */

export type IssueRecord = {
  /** Issue number, e.g. 123. */
  number: number;
  title: string;
  body: string;
  repository: string;
  url?: string;
  author?: string;
  labels?: readonly string[];
  state?: "open" | "closed";
  createdAt?: string;
  updatedAt?: string;
};

export type IssueSource = {
  type: "github_issue";
  repository: string;
  issueNumber: number;
  url?: string;
  author?: string | null;
};

export type HarnessInput = {
  goal: string;
  intent?: string;
  risk?: string;
  source: IssueSource;
  context: {
    labels: readonly string[];
    state: "open" | "closed" | null;
    author: string | null;
    repository: string;
    issueNumber: number;
    url: string | null;
    /**
     * The issue body wrapped in the untrusted content boundary (#34).
     * Runtime adapters must embed it as-is; the boundary prevents the
     * body from merging with trusted instructions.
     */
    untrustedEnvelope: string | null;
  };
};

export type IssueErrorCategory =
  | "not_found"
  | "invalid_issue"
  | "invalid_input"
  | "auth_error"
  | "unavailable"
  | "issue_closed"
  | "unknown";

export type IssueResolution =
  | { status: "resolved"; input: HarnessInput; warnings: readonly string[] }
  | { status: "issue_closed"; input: HarnessInput; message: string }
  | { status: "invalid"; errors: readonly string[]; message: string };

export type IssueResolver = {
  name: string;
  resolveIssue(request: { repository: string; issueNumber: number }): Promise<
    | { ok: true; issue: IssueRecord }
    | { ok: false; error: { code: IssueErrorCategory; message: string } }
  >;
};
