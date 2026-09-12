/**
 * Human/AI-readable rendering of a harness run (Issue #33).
 *
 * Pure formatting only: the underlying structured result (Execution
 * Result, Delegation Plan) is the source of truth and is returned
 * unchanged — this module only renders it for the CLI.
 *
 * @typedef {import("./contracts.js").ExecutionResult} ExecutionResult
 */

/**
 * @param {{
 *   goal?: string,
 *   message?: string,
 *   exitCode: number,
 *   decision: import("../decision-engine/contracts.js").DelegationPlan | null,
 *   workflowName: string | null,
 *   executionId: string | null,
 *   result: ExecutionResult | null,
 *   nonInteractive?: boolean
 * }} run
 * @returns {string[]}
 */
export function formatRunResult(run) {
  const lines = [];
  const risk = run.decision?.requestProfile?.risk ?? null;

  lines.push("Harness Run", "────────────────────────────");
  if (run.goal) lines.push(`Goal: ${run.goal}`);
  if (run.workflowName) lines.push(`Workflow: ${run.workflowName}`);
  if (risk) lines.push(`Risk: ${risk}`);
  if (run.executionId) lines.push(`Execution ID: ${run.executionId}`);
  if (run.nonInteractive) lines.push(`Mode: non-interactive`);

  const result = run.result;
  if (result !== null && result !== undefined) {
    lines.push("Steps");
    const fallbackSymbols = new Map();
    for (const entry of result.executionTrace) {
      const mark = entry.status === "succeeded" ? "✓" : "✗";
      lines.push(`  ${mark} ${entry.stepId} (attempt ${entry.attempt})`);
      void fallbackSymbols;
    }

    const verification = result.artifacts?.["verification-result"];
    if (verification !== undefined) {
      lines.push("Verification");
      for (const gate of verification.gates ?? []) {
        const gateMark = gate.status === "passed" ? "✓" : "✗";
        lines.push(`  ${gateMark} ${gate.id}`);
      }
    }

    lines.push("Model Usage");
    for (const record of result.modelExecutions ?? []) {
      const model = [record.resolvedProvider, record.resolvedModel].filter(Boolean).join("/") || "unknown";
      lines.push(`  ${record.stepId} (attempt ${record.attempt}): ${model}`);
    }

    const retryCount = countRetries(result);
    const fallbackCount = (result.modelExecutions ?? []).reduce(
      (sum, record) => sum + (record.fallbackCount ?? 0),
      0
    );
    lines.push(`Retry: ${retryCount}`);
    lines.push(`Fallback: ${fallbackCount}`);
    lines.push(`Result: ${result.status === "completed" ? "SUCCESS" : result.status.toUpperCase()}`);

    if (result.diagnostics.length > 0) {
      lines.push("Diagnostics");
      for (const diagnostic of result.diagnostics) {
        lines.push(`  ! [${diagnostic.code}] ${diagnostic.message}`);
      }
    }
    if (result.unresolved.length > 0) {
      lines.push("Unresolved");
      for (const item of result.unresolved) {
        lines.push(`  ! ${item}`);
      }
    }
  }

  lines.push(`Exit: ${run.exitCode}`);
  lines.push(run.message);
  return lines;
}

function countRetries(result) {
  let retries = 0;
  for (const step of Object.values(result.steps ?? {})) {
    if (step.executions > 1) retries += step.executions - 1;
  }
  return retries;
}

/**
 * Renders an Execution Plan (Issue #34) for human review. Pure
 * formatting: plans carry no side effects and this only reads them.
 *
 * @param {import("./execution-plan.js").ExecutionPlan} plan
 * @returns {string[]}
 */
export function formatExecutionPlan(plan) {
  const lines = [];
  lines.push("Harness Plan", "────────────────────────────");
  if (plan.task?.goal) lines.push(`Goal: ${plan.task.goal}`);
  if (plan.task?.intent) lines.push(`Intent: ${plan.task.intent}`);
  if (plan.task?.risk) lines.push(`Risk: ${plan.task.risk}（未指定時の既定は high）`);
  if (plan.workflow?.name) lines.push(`Workflow: ${plan.workflow.name}`);
  if (plan.runtime) lines.push(`Runtime: ${plan.runtime}`);

  if (Array.isArray(plan.steps) && plan.steps.length > 0) {
    lines.push("Steps");
    plan.steps.forEach((step, index) => {
      const role = step.role ?? "unknown";
      const dependencies = Array.isArray(step.dependencies) && step.dependencies.length > 0
        ? ` (after ${step.dependencies.join(", ")})`
        : "";
      lines.push(`  ${index + 1}. ${role} — ${step.stepId}${dependencies}`);
    });
  }

  if (Array.isArray(plan.models) && plan.models.length > 0) {
    lines.push("Models (planned — resolved at execution time)");
    for (const model of plan.models) {
      const resolved = [model.provider, model.model].filter(Boolean).join("/") || "unassigned";
      const tier = model.tier ? ` [${model.tier}]` : "";
      lines.push(`  ${model.role}: ${resolved}${tier}`);
    }
  }

  if (plan.tokenBudget !== undefined && plan.tokenBudget !== null) {
    lines.push("Token Budget");
    lines.push(`  Total: ${plan.tokenBudget.total ?? "unlimited"}`);
    for (const [stepId, budget] of Object.entries(plan.tokenBudget.perStep ?? {})) {
      lines.push(`  ${stepId}: ${budget}`);
    }
  }

  if (plan.retryPolicies !== undefined && plan.retryPolicies !== null && Object.keys(plan.retryPolicies).length > 0) {
    lines.push("Retry Policy");
    for (const [stepId, maxAttempts] of Object.entries(plan.retryPolicies)) {
      lines.push(`  ${stepId}: max_attempts ${maxAttempts}`);
    }
  }

  if (plan.fallbackPolicy !== undefined && plan.fallbackPolicy !== null) {
    lines.push("Fallback Policy");
    lines.push(`  max_fallbacks: ${plan.fallbackPolicy.maxFallbacks}`);
    for (const candidate of plan.fallbackPolicy.candidates ?? []) {
      lines.push(`  candidate: ${candidate}`);
    }
  }

  if (plan.verification !== undefined && plan.verification !== null) {
    lines.push("Verification");
    if (plan.verification.stepId) lines.push(`  step: ${plan.verification.stepId}`);
    for (const gate of plan.verification.gates ?? []) {
      lines.push(`  gate: ${gate}`);
    }
  }

  if (plan.guardrailsSummary !== undefined && plan.guardrailsSummary !== null) {
    lines.push("Action Guardrails (applied at execution time)");
    for (const [surface, level] of Object.entries(plan.guardrailsSummary)) {
      lines.push(`  ${surface}: ${level}`);
    }
  }

  lines.push(`Plan ID: ${plan.planId}`);
  lines.push(`Plan Version: ${plan.planVersion}`);
  lines.push(`Plan Hash: ${plan.planHash}`);
  lines.push("────────────────────────────");
  lines.push("No side effects will be performed.");
  lines.push(`Approve by writing approved: true, then run: harness run --plan <plan file>`);
  return lines;
}
