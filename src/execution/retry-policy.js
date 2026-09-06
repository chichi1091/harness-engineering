/**
 * Pure decision helpers for workflow step retries.
 *
 * The canonical policy lives in the workflow YAML (step.retry_policy); the
 * canonical severity vocabulary lives in agents/reviewer.yaml. This module
 * performs no I/O and never mutates its inputs: the ledger is treated as an
 * immutable value so that an execution runtime can log attempts without a
 * shared mutable structure.
 *
 * max_attempts counts the total number of executions of the step, including
 * the first one: max_attempts: 2 means one initial run plus one retry.
 *
 * @typedef {import("./contracts.js").RetryPolicy} RetryPolicy
 * @typedef {import("./contracts.js").RetryLedger} RetryLedger
 * @typedef {import("./contracts.js").StepFailure} StepFailure
 * @typedef {import("./contracts.js").StepRetryDecision} StepRetryDecision
 * @typedef {import("./contracts.js").RetryExhaustionArtifact} RetryExhaustionArtifact
 */

/**
 * Creates an empty attempt ledger.
 *
 * @returns {RetryLedger}
 */
export function createRetryLedger() {
  return { attempts: {} };
}

/**
 * Returns a new ledger with one more recorded attempt for the step. The
 * input ledger is not modified.
 *
 * Call this right after a step execution fails and before decideStepRetry:
 * attemptsUsed in the decision therefore includes the failed run.
 *
 * @param {RetryLedger} ledger
 * @param {string} stepId
 * @returns {RetryLedger}
 */
export function recordAttempt(ledger, stepId) {
  return {
    attempts: {
      ...ledger.attempts,
      [stepId]: attemptCount(ledger, stepId) + 1
    }
  };
}

/**
 * @param {RetryLedger} ledger
 * @param {string} stepId
 * @returns {number}
 */
export function attemptCount(ledger, stepId) {
  return ledger.attempts[stepId] ?? 0;
}

/**
 * Decides whether a failed step may be retried.
 *
 * - stop when max_attempts is already used: the runtime must not follow
 *   step.on_failure any further, which bounds every backward edge and
 *   prevents an infinite Developer → Reviewer loop
 * - stop when retry_on is set and the failure reports none of its
 *   severities: such a failure is not the kind this policy retries
 * - retry otherwise
 *
 * @param {{
 *   ledger: RetryLedger,
 *   stepId: string,
 *   policy: RetryPolicy,
 *   failure?: StepFailure
 * }} options
 * @returns {StepRetryDecision}
 */
export function decideStepRetry({ ledger, stepId, policy, failure }) {
  const maxAttempts = policy.max_attempts;
  const attemptsUsed = attemptCount(ledger, stepId);

  if (attemptsUsed >= maxAttempts) {
    return {
      action: "stop",
      attemptsUsed,
      maxAttempts,
      reason: `step "${stepId}" already used ${attemptsUsed} of ${maxAttempts} allowed attempts.`
    };
  }

  if (Array.isArray(policy.retry_on) && !failureOverlapsRetryOn(policy.retry_on, failure)) {
    return {
      action: "stop",
      attemptsUsed,
      maxAttempts,
      reason: `failure of step "${stepId}" reports none of the retry_on severities (${policy.retry_on.join(", ")}).`
    };
  }

  return {
    action: "retry",
    attemptsUsed,
    maxAttempts,
    reason: `step "${stepId}" may retry (${attemptsUsed} of ${maxAttempts} attempts used).`
  };
}

/**
 * Builds the artifact a runtime returns to the user when a step stops.
 * Following step.on_failure is forbidden at this point; the unresolved
 * items must reach the user instead of looping silently.
 *
 * @param {{
 *   workflowName: string,
 *   stepId: string,
 *   ledger: RetryLedger,
 *   policy: RetryPolicy,
 *   gate: string,
 *   unresolved: readonly string[]
 * }} options
 * @returns {RetryExhaustionArtifact}
 */
export function buildRetryExhaustionArtifact({ workflowName, stepId, ledger, policy, gate, unresolved }) {
  const attemptsUsed = attemptCount(ledger, stepId);

  return {
    type: "retry_exhausted",
    workflow: workflowName,
    step: stepId,
    attempts_used: attemptsUsed,
    max_attempts: policy.max_attempts,
    gate,
    unresolved: [...unresolved],
    message: [
      `Workflow "${workflowName}" のステップ "${stepId}" は ${attemptsUsed}/${policy.max_attempts} 回の実行で打ち切りしました。`,
      `ゲート「${gate}」を満たせず、${stepId} への差し戻しは行いません。`,
      "未解決事項を確認し、対応方針を決定してください。"
    ].join("")
  };
}

function failureOverlapsRetryOn(retryOn, failure) {
  const severities = failure?.severities ?? [];
  return severities.some((severity) => retryOn.includes(severity));
}
