/**
 * harness run composition (Issue #33).
 *
 * This is the thin composition layer between the CLI shell and the
 * existing components — it contains NO new execution logic:
 *
 *   goal/plan → plan approval check → Decision Engine (#decision)
 *             → Execution Engine (#21) [executeStep injected from CLI]
 *             → exit code decision
 *
 * The CLI shell (bin/harness.js) owns everything runtime-specific:
 * loading the workflow registry and quality gates from disk, composing
 * the runtime adapter (OpenCode #32 + Guardrails #27 + Fallback #23)
 * and passing it in as `executeStep`. Mock runtimes work identically,
 * which is how this layer is tested without any real AI.
 *
 * Exit codes:
 * - 0: the workflow completed
 * - 1: the workflow failed or stopped (machine-checkable reason included)
 * - 2: invalid input (missing goal/intent, needs_clarification, no
 *      matching workflow)
 * - 3: the supplied plan is not approved
 *
 * @typedef {import("../decision-engine/contracts.js").DelegationPlan} DelegationPlan
 * @typedef {import("./contracts.js").ExecutionResult} ExecutionResult
 */

import { decide } from "../decision-engine/decision-engine.js";
import { runWorkflow } from "../execution/execution-engine.js";
import { runVerification, buildVerificationArtifact, buildVerificationFailure } from "../verification/verification-engine.js";

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  EXECUTION_FAILED: 1,
  INVALID_INPUT: 2,
  PLAN_NOT_APPROVED: 3
});

/**
 * @param {{
 *   goal?: string,
 *   intent?: string,
 *   risk?: string,
 *   workflowRegistry: readonly Record<string, unknown>[],
 *   executeStep: import("./contracts.js").StepExecutor,
 *   artifactStore?: import("../artifacts/contracts.js").ArtifactStore,
 *   executionId?: string,
 *   trackModelExecutions?: boolean,
 *   verification?: { stepId?: string, gates: unknown } | null,
 *   plan?: { approved?: boolean, goal?: string, intent?: string, risk?: string } | null
 * }} options
 */
export async function runHarness({
  goal,
  intent,
  risk,
  workflowRegistry,
  executeStep,
  artifactStore,
  executionId,
  trackModelExecutions,
  verification = null,
  plan = null
}) {
  // --- Plan approval (#34 boundary): a plan that was not explicitly
  // approved by a human is never executed.
  if (plan !== null && plan.approved !== true) {
    return {
      exitCode: EXIT_CODES.PLAN_NOT_APPROVED,
      decision: null,
      workflowName: null,
      executionId: executionId ?? null,
      result: null,
      message: "実行を開始しませんでした: Planが人間によって承認されていません（approved: true が必要です）。"
    };
  }

  // --- Request assembly: CLI flags win, plan fields fill the gaps.
  const effectiveGoal = firstNonEmpty(goal, plan?.goal);
  const effectiveIntent = firstNonEmpty(intent, plan?.intent);
  const effectiveRisk = firstNonEmpty(risk, plan?.risk);

  if (typeof effectiveGoal !== "string" || effectiveGoal.trim() === "") {
    return {
      exitCode: EXIT_CODES.INVALID_INPUT,
      decision: null,
      workflowName: null,
      executionId: executionId ?? null,
      result: null,
      message: "goal が指定されていません。harness run \"実現したいこと\" の形式で指定してください。"
    };
  }

  const request = {
    intent: effectiveIntent,
    risk: effectiveRisk,
    goal: effectiveGoal
  };

  // --- Decision (existing Decision Engine; no intent guessing here).
  const decision = decide({ request, workflowRegistry });

  if (decision.status !== "ready" || decision.selectedWorkflow === null) {
    const details = decision.clarification
      ? `${decision.clarification.message} 必要な入力: ${decision.clarification.missing_fields.join("、")}`
      : decision.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
    return {
      exitCode: EXIT_CODES.INVALID_INPUT,
      decision,
      workflowName: decision.selectedWorkflow?.name ?? null,
      executionId: executionId ?? null,
      result: null,
      message: `実行するWorkflowを決定できませんでした。${details}`.trim()
    };
  }

  const selectedWorkflow = workflowRegistry.find(
    (workflow) => workflow.name === decision.selectedWorkflow.name
  );
  if (selectedWorkflow === undefined) {
    return {
      exitCode: EXIT_CODES.INVALID_INPUT,
      decision,
      workflowName: decision.selectedWorkflow.name,
      executionId: executionId ?? null,
      result: null,
      message: `選択されたWorkflow "${decision.selectedWorkflow.name}" がRegistryに存在しません。`
    };
  }

  // --- Execution (existing Execution Engine; runtime injected by CLI).
  const effectiveVerification = verification && typeof verification.gates === "object" && verification.gates !== null
    ? verification
    : null;
  const wrappedExecuteStep = effectiveVerification
    ? withVerificationGate(executeStep, effectiveVerification)
    : executeStep;

  const result = await runWorkflow({
    workflow: selectedWorkflow,
    executeStep: wrappedExecuteStep,
    artifactStore,
    executionId,
    trackModelExecutions: trackModelExecutions === true
  });

  const exitCode = result.status === "completed" ? EXIT_CODES.SUCCESS : EXIT_CODES.EXECUTION_FAILED;

  return {
    exitCode,
    decision,
    workflowName: selectedWorkflow.name,
    executionId: executionId ?? null,
    result,
    message: summarize(result, selectedWorkflow)
  };
}

/**
 * Wraps the runtime executeStep so that the configured verification step
 * runs Mechanical Verification (#28) after its base execution. A failed
 * verification becomes a Failure Result, which the Execution Loop's
 * existing retry/on_failure rules then handle — no new loop logic.
 */
function withVerificationGate(executeStep, verification) {
  return async function executeWithVerification(request) {
    const baseOutcome = await executeStep(request);
    if (verification.stepId !== undefined && request.stepId !== verification.stepId) {
      return baseOutcome;
    }

    const report = await runVerification({
      gates: verification.gates,
      runCommand: verification.runCommand,
      cwd: verification.cwd
    });
    const artifact = buildVerificationArtifact(report, { producedBy: "test-engineer" });

    if (report.status !== "passed") {
      const failure = buildVerificationFailure(report);
      return {
        status: "failed",
        failure: { reason: failure.reason, unresolved: failure.unresolved },
        artifacts: [artifact],
        tokensSpent: baseOutcome.tokensSpent ?? 0,
        runtime: baseOutcome.runtime
      };
    }

    return {
      ...baseOutcome,
      artifacts: [...(baseOutcome.artifacts ?? []), artifact]
    };
  };
}

function summarize(result, workflow) {
  if (result.status === "completed") {
    return `Workflow "${workflow.name}" は完了しました（${result.completedSteps.length}ステップ成功）。`;
  }
  const reason = result.stopReason ?? result.failure?.reason ?? "unknown";
  return `Workflow "${workflow.name}" は${result.status === "stopped" ? "停止" : "失敗"}しました（${reason}）。未解決事項を確認してください。`;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}
