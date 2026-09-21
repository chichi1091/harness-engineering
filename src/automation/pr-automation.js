/**
 * PR Automation core (Issue #37): decide whether a completed execution
 * may become a Pull Request, and build the commit message / PR body
 * from the recorded execution data.
 *
 * Principles:
 * - The Mechanical Verification result (#28) is the ONLY quality gate.
 *   This module never judges "the code looks fine".
 * - A PR is created only for a completed execution whose verification
 *   passed, with no unresolved items and the required artifacts present.
 *   Every refusal is machine-checkable (skip code + reason).
 * - Free text that could carry secrets passes through the existing
 *   redaction (#27/#22) before it reaches a commit message or PR body.
 * - Merge is out of scope BY CONSTRUCTION: the PullRequestPort exposes
 *   creation only — there is no merge capability to bypass review with.
 *
 * @typedef {import("./contracts.js").PullRequestDecision} PullRequestDecision
 */

import { redactSecrets } from "../execution/model-execution-tracking.js";

/** Artifact types that must exist for a PR to be created. */
export const DEFAULT_REQUIRED_ARTIFACT_TYPES = ["implementation-result"];

/**
 * Decides whether the run may proceed to PR creation. Every refusal is
 * reported with a machine-checkable code and a human-readable reason.
 *
 * @param {{
 *   executionResult: import("./contracts.js").ExecutionResultLike,
 *   requiredArtifactTypes?: readonly string[]
 * }} options
 * @returns {PullRequestDecision}
 */
export function decidePullRequestAutomation({ executionResult, requiredArtifactTypes = DEFAULT_REQUIRED_ARTIFACT_TYPES }) {
  if (typeof executionResult !== "object" || executionResult === null) {
    return skip("invalid_execution", "execution result is missing.");
  }

  if (executionResult.status !== "completed") {
    return skip(
      "execution_failed",
      `execution status is "${executionResult.status}" (stop reason: ${executionResult.stopReason ?? "n/a"}); only completed executions produce pull requests.`
    );
  }

  const verification = executionResult.artifacts?.["verification-result"];
  if (verification === undefined || verification.status !== "passed") {
    return skip(
      "verification_failed",
      verification === undefined
        ? "no mechanical verification result was recorded; unverified changes must not become a pull request."
        : `mechanical verification did not pass (status: ${verification.status}, failed gates: ${(verification.failed_gates ?? []).join(", ") || "none recorded"}).`
    );
  }

  if (Array.isArray(executionResult.unresolved) && executionResult.unresolved.length > 0) {
    return skip("unresolved_items", `${executionResult.unresolved.length} unresolved item(s) remain; resolve them first.`);
  }

  const missing = (requiredArtifactTypes ?? []).filter((type) => executionResult.artifacts?.[type] === undefined);
  if (missing.length > 0) {
    return skip("missing_artifacts", `required artifact(s) missing: ${missing.join(", ")}.`);
  }

  return {
    action: "create-pr",
    code: null,
    reason: "execution completed and mechanical verification passed.",
    skipReason: null
  };
}

function skip(code, reason) {
  return { action: "skip", code, reason, skipReason: reason };
}

/**
 * Builds a commit message that stays traceable to the execution and, if
 * present, its issue source. Secret screening is applied to the body.
 *
 * @param {{
 *   executionId: string,
 *   workflowName: string,
 *   goal: string,
 *   issueSource?: { issueNumber?: number, repository?: string } | null
 * }} options
 * @returns {{ title: string, body: string, message: string }}
 */
export function buildCommitMessage({ executionId, workflowName, goal, issueSource = null }) {
  const safeGoal = redactSecrets(goal) ?? "";
  const title = `harness(${workflowName}): ${safeGoal} [${executionId}]`;
  const issueLine = issueSource?.issueNumber !== undefined && issueSource.issueNumber !== null
    ? `\n\nCloses #${issueSource.issueNumber}`
    : "";
  const body = `Automated changes from Harness execution ${executionId} (workflow: ${workflowName}).\n\nGoal: ${safeGoal}${issueLine}\n\nVerified by Mechanical Verification (#28) before commit.`;
  return { title, body, message: `${title}\n\n${body}` };
}

/**
 * Builds the pull request body from the recorded execution data.
 * Sections follow Issue #37; free text passes through secret
 * redaction, and raw runtime output is never included.
 *
 * @param {{
 *   executionResult: import("./contracts.js").ExecutionResultLike,
 *   modelExecutions?: readonly object[],
 *   goal?: string | null,
 *   issueSource?: { type?: string, repository?: string, issueNumber?: number, url?: string } | null,
 *   changes?: readonly string[]
 * }} options
 * @returns {{ title: string, body: string }}
 */
export function buildPullRequestBody({ executionResult, modelExecutions = [], goal = null, issueSource = null, changes = [] }) {
  const lines = [];

  const summaryGoal = goal ?? executionResult.goal ?? "(no goal recorded)";
  lines.push("## Summary");
  lines.push(`${summaryGoal} の変更をHarnessが実行・検証しました。人間のレビューをお願いします。`);
  lines.push("");

  lines.push("## Execution");
  lines.push(`- Execution ID: \`${executionResult.executionId ?? "unknown"}\``);
  lines.push(`- Workflow: ${executionResult.workflow ?? "unknown"}`);
  if (issueSource?.issueNumber !== undefined && issueSource.issueNumber !== null) {
    lines.push(`- Issue: #${issueSource.issueNumber}${issueSource.url ? ` (${issueSource.url})` : ""}`);
  }
  lines.push(`- Status: ${executionResult.status}`);
  lines.push("");

  lines.push("## Verification");
  const verification = executionResult.artifacts?.["verification-result"];
  if (verification !== undefined) {
    lines.push(`- Status: **${verification.status}**`);
    for (const gate of verification.gates ?? []) {
      lines.push(`- ${gate.status === "passed" ? "✓" : "✗"} ${gate.id}`);
    }
  } else {
    lines.push("- no verification result recorded");
  }
  lines.push("");

  lines.push("## Changes");
  if (changes.length > 0) {
    for (const change of changes) {
      lines.push(`- ${change}`);
    }
  } else {
    const changedFiles = executionResult.artifacts?.["implementation-result"]?.changed_files ?? [];
    for (const file of changedFiles) {
      lines.push(`- ${file.path}: ${file.reason}`);
    }
    if (changedFiles.length === 0) lines.push("- (変更ファイルの記録なし)");
  }
  lines.push("");

  lines.push("## Model / Runtime");
  const seen = new Set();
  for (const record of modelExecutions) {
    const key = `${record.stepId}#${record.attempt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const model = [record.resolvedProvider, record.resolvedModel].filter(Boolean).join("/") || "unknown";
    const fallbackNote = (record.fallbackCount ?? 0) > 0 ? ` (fallback ×${record.fallbackCount})` : "";
    lines.push(`- ${record.stepId} attempt ${record.attempt}: ${record.runtime} / ${model}${fallbackNote}`);
  }
  if (modelExecutions.length === 0) lines.push("- (model execution records are not tracked for this run)");
  lines.push("");

  const unresolved = executionResult.unresolved ?? [];
  lines.push("## Unresolved");
  if (unresolved.length === 0) {
    lines.push("- none");
  } else {
    for (const item of unresolved) {
      lines.push(`- ${redactSecrets(item)}`);
    }
  }

  const body = lines.join("\n");
  return {
    title: `${summaryGoal} (harness ${executionResult.executionId ?? ""})`.trim(),
    // Whole-body screening: no credential shape may reach GitHub.
    body: redactSecrets(body) ?? body
  };
}

/**
 * Classifies a git / pull request automation failure using the existing
 * failure vocabulary (#23/#31). PR automation failures are INPUT /
 * INFRASTRUCTURE failures and must never be fed back into the
 * Execution Loop as code-quality failures.
 *
 * @param {unknown} error
 * @returns {{ code: string, fallbackEligible: boolean }}
 */
export function classifyAutomationError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  if (/auth|credential|unauthorized|401|403/.test(message)) {
    return { code: "auth_error", fallbackEligible: false };
  }
  if (/permission denied|eperm|eacces/.test(message)) {
    return { code: "permission_denied", fallbackEligible: false };
  }
  if (/not found|enoent|does not exist/.test(message)) {
    return { code: "not_found", fallbackEligible: false };
  }
  if (/network|timed out|timeout|econn|enotfound|rate limit/.test(message)) {
    return { code: "transient_error", fallbackEligible: true };
  }
  return { code: "unknown", fallbackEligible: false };
}
