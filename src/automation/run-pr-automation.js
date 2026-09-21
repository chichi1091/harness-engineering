/**
 * PR Automation orchestration (Issue #37).
 *
 * Runs the safe tail of a completed execution:
 *
 *   decide (Verification = the only quality gate)
 *     → git status → branch (reuse or create harness/<execution-id>)
 *     → stage changed files → commit → push
 *     → create pull request
 *     → record the outcome as a pr-automation artifact (#29/#35)
 *
 * All git commands run through the injected Guarded Command Runner
 * (#27): destructive git operations are refused by the existing policy
 * and this module can never bypass the runner. The PullRequestPort has
 * creation ONLY — merging is structurally impossible here.
 *
 * Failures of this tail are INFRASTRUCTURE failures: they are recorded
 * (pr-automation artifact + returned result) and are never fed back
 * into the Execution Loop as code-quality failures.
 *
 * @typedef {import("./contracts.js").GitPort} GitPort
 * @typedef {import("./contracts.js").PullRequestPort} PullRequestPort
 */

import { saveArtifact } from "../artifacts/artifact-store.js";
import {
  buildCommitMessage,
  buildPullRequestBody,
  classifyAutomationError,
  decidePullRequestAutomation
} from "./pr-automation.js";

/**
 * @param {{
 *   executionResult: object,
 *   modelExecutions?: readonly object[],
 *   git: GitPort,
 *   pullRequests: PullRequestPort,
 *   repository: string,
 *   targetBranch?: string,
 *   issueSource?: { issueNumber?: number, url?: string, repository?: string } | null,
 *   goal?: string | null,
 *   requiredArtifactTypes?: readonly string[],
 *   artifactStore?: import("../artifacts/contracts.js").ArtifactStore | null,
 *   dryRun?: boolean
 * }} options
 * @returns {Promise<object>} automation result (status / skip reason / pull request info / steps trail)
 */
export async function runPullRequestAutomation({
  executionResult,
  modelExecutions = [],
  git,
  pullRequests,
  repository,
  targetBranch = "main",
  issueSource = null,
  goal = null,
  requiredArtifactTypes,
  artifactStore = null,
  dryRun = false
}) {
  const decision = decidePullRequestAutomation({ executionResult, requiredArtifactTypes });

  // Dry run stops right after the decision: it reports what WOULD run
  // (branch name, commit message, PR title) without performing any of it.
  if (dryRun === true) {
    if (decision.action === "skip") {
      const skipResult = {
        status: "skipped", code: decision.code, reason: decision.reason,
        branch: null, commit: null, pullRequestUrl: null, dryRun: true, steps: []
      };
      skipResult.historyRecorded = (await recordOutcome(artifactStore, executionResult?.executionId, skipResult)).recorded;
      return skipResult;
    }
    const plannedBranch = `harness/${executionResult.executionId}`;
    const commitMessage = buildCommitMessage({
      executionId: executionResult.executionId,
      workflowName: executionResult.workflow,
      goal: goal ?? executionResult.goal ?? "",
      issueSource: issueSource ?? null
    });
    const plannedBody = buildPullRequestBody({
      executionResult,
      modelExecutions,
      goal: goal ?? executionResult.goal ?? null,
      issueSource: issueSource ?? null,
      changes: []
    });
    const plannedResult = {
      status: "dry-run", code: null, reason: "dry run: nothing was pushed or created.",
      branch: plannedBranch, commit: null, pullRequestUrl: null,
      pullRequestTitle: plannedBody.title, pullRequestBody: plannedBody.body,
      dryRun: true,
      steps: [
        { step: "planned-branch", branch: plannedBranch },
        { step: "planned-commit", message: commitMessage.title },
        { step: "planned-pull-request", title: plannedBody.title, targetBranch: targetBranch ?? "main" }
      ]
    };
    plannedResult.historyRecorded = (await recordOutcome(artifactStore, executionResult?.executionId, plannedResult)).recorded;
    return plannedResult;
  }

  if (decision.action === "skip") {
    const result = {
      status: "skipped",
      code: decision.code,
      reason: decision.reason,
      branch: null,
      commit: null,
      pullRequestUrl: null,
      dryRun,
      steps: []
    };
    const historyOutcome = await recordOutcome(artifactStore, executionResult?.executionId, result);
  result.historyRecorded = historyOutcome.recorded;
  if (historyOutcome.error !== undefined) {
    result.historyError = historyOutcome.error;
  }
    return result;
  }

  // --- 1. inspect the working tree: no changes → nothing to propose.
  const status = await git.status();
  if (status.changedFiles.length === 0) {
    const result = {
      status: "skipped",
      code: "no_changes",
      reason: "the working tree has no changes to commit.",
      branch: null,
      commit: null,
      pullRequestUrl: null,
      dryRun,
      steps: []
    };
    const historyOutcome = await recordOutcome(artifactStore, executionResult?.executionId, result);
  result.historyRecorded = historyOutcome.recorded;
  if (historyOutcome.error !== undefined) {
    result.historyError = historyOutcome.error;
  }
    return result;
  }

  // --- 2. resolve the branch: reuse a harness branch, else create one.
  const desiredBranch = `harness/${executionResult.executionId}`;
  const current = await git.getCurrentBranch();
  const branch = current.branch === desiredBranch ? current.branch : (await git.createBranch({ name: desiredBranch })).branch;
  const steps = [{ step: "branch", branch }];

  // --- 3. commit the changes (message traceable to execution / issue).
  const commitMessage = buildCommitMessage({
    executionId: executionResult.executionId,
    workflowName: executionResult.workflow,
    goal: goal ?? executionResult.goal ?? "",
    issueSource
  });
  const commit = await git.stageAndCommit({ files: status.changedFiles, message: commitMessage.message });
  steps.push({ step: "commit", commit: commit.commit });

  // --- 4. push the branch (policy-governed; force is never used).
  const push = await git.push({ remote: "origin", branch });
  steps.push({ step: "push", branch, pushed: push.pushed });

  // --- 5. create the pull request.
  const body = buildPullRequestBody({
    executionResult,
    modelExecutions,
    goal: goal ?? executionResult.goal ?? null,
    issueSource,
    changes: status.changedFiles
  });
  const pullRequest = dryRun
    ? { url: null, number: null, dryRun: true, title: body.title }
    : await pullRequests.createPullRequest({
        repository,
        sourceBranch: branch,
        targetBranch,
        title: body.title,
        body: body.body,
        executionId: executionResult.executionId
      });
  steps.push({ step: "pull-request", url: pullRequest.url ?? null, dryRun: dryRun === true });

  const result = {
    status: dryRun === true ? "dry-run" : "created",
    code: null,
    reason: dryRun === true ? "dry run: nothing was pushed or created." : "pull request created.",
    branch,
    commit: commit.commit,
    pullRequestUrl: pullRequest.url ?? null,
    pullRequestTitle: body.title,
    pullRequestBody: body.body,
    dryRun,
    steps
  };
  const historyOutcome = await recordOutcome(artifactStore, executionResult?.executionId, result);
  result.historyRecorded = historyOutcome.recorded;
  if (historyOutcome.error !== undefined) {
    result.historyError = historyOutcome.error;
  }
  return result;
}

/**
 * Records the automation outcome as a pr-automation artifact (#29/#35).
 * Bookkeeping failures are visible on the result (historyRecorded) but
 * never break the automation outcome itself.
 */
async function recordOutcome(artifactStore, executionId, result) {
  if (artifactStore === null || artifactStore === undefined || executionId === undefined || executionId === null) {
    return { recorded: false };
  }
  try {
    await saveArtifact(artifactStore, {
      artifactId: "pr-automation",
      executionId,
      stepId: "automation",
      artifact: {
        type: "pr-automation",
        produced_by: "harness",
        unresolved: result.status === "skipped" && result.code !== undefined ? [`PR automation skipped: ${result.reason}`] : [],
        executionId,
        status: result.status,
        code: result.code,
        reason: result.reason,
        branch: result.branch,
        commit: result.commit,
        pullRequestUrl: result.pullRequestUrl,
        createdAt: new Date().toISOString()
      }
    });
    return { recorded: true };
  } catch (error) {
    return { recorded: false, error: error instanceof Error ? error.message : String(error) };
  }
}
