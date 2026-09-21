/**
 * PR Automation contracts (Issue #37).
 *
 * Two ports, creation-only: the GitPort performs the safe local git
 * tail (status / branch / commit / push) through the guarded command
 * runner (#27), and the PullRequestPort creates a pull request. There
 * is deliberately NO merge capability anywhere in these contracts —
 * human review is the final gate.
 */

export type GitPort = {
  /** Working-tree changes (porcelain paths). */
  status(): Promise<{ changedFiles: readonly string[] }>;
  getCurrentBranch(): Promise<{ branch: string }>;
  createBranch(options: { name: string }): Promise<{ branch: string }>;
  stageAndCommit(options: { files: readonly string[]; message: string }): Promise<{ commit: string | null }>;
  push(options: { remote?: string; branch: string }): Promise<{ pushed: boolean; remote: string; branch: string }>;
};

export type PullRequestPort = {
  createPullRequest(request: {
    repository: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    body: string;
    executionId?: string;
  }): Promise<{ url: string | null; number: number | null; sourceBranch: string; targetBranch: string }>;
};

export type PRAutomationStatus = "created" | "skipped" | "failed" | "dry-run";

/** The outcome recorded as a pr-automation artifact (#29/#35). */
export type PRAutomationRecord = {
  executionId: string;
  status: PRAutomationStatus;
  code: string | null;
  reason: string;
  branch: string | null;
  commit: string | null;
  pullRequestUrl: string | null;
  createdAt: string;
};

export type PRAutomationResult = PRAutomationRecord & {
  dryRun: boolean;
  pullRequestTitle?: string;
  pullRequestBody?: string;
  historyRecorded?: boolean;
  steps?: readonly { step: string; [key: string]: unknown }[];
};
