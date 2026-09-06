/**
 * Pure decision helpers for workflow token budgets.
 *
 * The canonical policy lives in the workflow YAML: workflow.budget defines
 * the total cap and the exhaustion behavior, step.token_budget caps a
 * single step (including its retries — retries of the same step accumulate
 * in the same bucket of the ledger). This module performs no I/O and never
 * mutates its inputs.
 *
 * Budgets are checked before an execution attempt: a model call cannot be
 * interrupted mid-flight, so the actual spend is recorded after each call
 * and the next check stops further work. Caps are limits, not allocations:
 * the sum of step budgets may exceed the total.
 *
 * @typedef {import("./contracts.js").WorkflowBudget} WorkflowBudget
 * @typedef {import("./contracts.js").TokenLedger} TokenLedger
 * @typedef {import("./contracts.js").TokenBudgetDecision} TokenBudgetDecision
 * @typedef {import("./contracts.js").BudgetExhaustionArtifact} BudgetExhaustionArtifact
 */

/**
 * Creates an empty spend ledger.
 *
 * @returns {TokenLedger}
 */
export function createTokenLedger() {
  return { spent: {} };
}

/**
 * Returns a new ledger with additional tokens recorded for the step. The
 * input ledger is not modified.
 *
 * @param {TokenLedger} ledger
 * @param {string} stepId
 * @param {number} tokens
 * @returns {TokenLedger}
 */
export function recordSpend(ledger, stepId, tokens) {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) {
    throw new Error("token spend must be a non-negative finite number.");
  }

  return {
    spent: {
      ...ledger.spent,
      [stepId]: tokensSpent(ledger, stepId) + tokens
    }
  };
}

/**
 * @param {TokenLedger} ledger
 * @param {string} stepId
 * @returns {number}
 */
export function tokensSpent(ledger, stepId) {
  return ledger.spent[stepId] ?? 0;
}

/**
 * @param {TokenLedger} ledger
 * @returns {number}
 */
export function totalTokensSpent(ledger) {
  return Object.values(ledger.spent).reduce((sum, value) => sum + value, 0);
}

/**
 * Decides whether the next execution attempt of the step stays in budget.
 * A total cap is checked before the step cap; exceeding either stops the
 * workflow — retrying on an exhausted budget would spend more tokens,
 * which contradicts the budget itself.
 *
 * @param {{
 *   ledger: TokenLedger,
 *   stepId: string,
 *   stepBudget?: number,
 *   workflowBudget?: WorkflowBudget | null
 * }} options
 * @returns {TokenBudgetDecision}
 */
export function decideStepBudget({ ledger, stepId, stepBudget, workflowBudget }) {
  const stepSpent = tokensSpent(ledger, stepId);
  const totalSpent = totalTokensSpent(ledger);

  if (workflowBudget && totalSpent >= workflowBudget.max_total_tokens) {
    return {
      status: "exceeded",
      scope: "workflow",
      limit: workflowBudget.max_total_tokens,
      spent: stepSpent,
      totalSpent,
      reason: `workflow total ${totalSpent} has reached the budget of ${workflowBudget.max_total_tokens} tokens.`
    };
  }

  if (stepBudget !== undefined && stepSpent >= stepBudget) {
    return {
      status: "exceeded",
      scope: "step",
      limit: stepBudget,
      spent: stepSpent,
      totalSpent,
      reason: `step "${stepId}" has spent ${stepSpent} of its ${stepBudget} token budget.`
    };
  }

  return {
    status: "within_budget",
    spent: stepSpent,
    totalSpent,
    reason: `step "${stepId}" may run (${stepSpent} tokens spent, workflow total ${totalSpent}).`
  };
}

/**
 * Builds the artifact a runtime returns to the user when the budget is
 * exhausted: completed work, remaining work, and unresolved items reach
 * the user instead of the workflow continuing silently.
 *
 * @param {{
 *   workflowName: string,
 *   stepId: string,
 *   ledger: TokenLedger,
 *   workflowBudget?: WorkflowBudget | null,
 *   stepBudget?: number,
 *   completedWork: readonly string[],
 *   remainingWork: readonly string[],
 *   unresolved: readonly string[]
 * }} options
 * @returns {BudgetExhaustionArtifact}
 */
export function buildBudgetExhaustionArtifact({
  workflowName,
  stepId,
  ledger,
  workflowBudget = null,
  stepBudget,
  completedWork,
  remainingWork,
  unresolved
}) {
  const totalSpent = totalTokensSpent(ledger);
  const stepSpent = tokensSpent(ledger, stepId);
  const exhaustedWorkflowTotal = Boolean(workflowBudget) && totalSpent >= workflowBudget.max_total_tokens;

  return {
    type: "budget_exhausted",
    workflow: workflowName,
    step: stepId,
    total_tokens_spent: totalSpent,
    max_total_tokens: workflowBudget ? workflowBudget.max_total_tokens : null,
    completed_work: [...completedWork],
    remaining_work: [...remainingWork],
    unresolved: [...unresolved],
    message: [
      `Workflow "${workflowName}" は予算超過のためステップ "${stepId}" で停止しました。`,
      `消費トークン: 合計 ${totalSpent}` +
        (workflowBudget ? `/${workflowBudget.max_total_tokens}` : "") +
        `（ステップ "${stepId}": ${stepSpent}` +
        (stepBudget !== undefined ? `/${stepBudget}` : "") +
        "）。超過範囲: " +
        (exhaustedWorkflowTotal ? "ワークフロー総額" : "ステップ上限"),
      `完了済み: ${completedWork.join("、") || "なし"}。`,
      `未完了: ${remainingWork.join("、") || "なし"}。`,
      `未解決事項: ${unresolved.join("、") || "なし"}。`,
      "継続する場合は予算の見直しと再開方針を決定してください。"
    ].join("")
  };
}
