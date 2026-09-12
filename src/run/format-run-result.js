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
