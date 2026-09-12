/**
 * The Execution Engine: drives a loaded workflow definition step by step
 * and turns the declarative on_failure / retry_policy / budget rules into
 * an actual loop (Issue #21).
 *
 * Separation of concerns:
 * - the Decision Engine selects a workflow (pure, unchanged)
 * - this engine executes the selected workflow (pure orchestration: no
 *   filesystem, no CLI, no model call)
 * - the actual agent invocation happens behind the injected `executeStep`
 *   port; runtime adapters (OpenCode, mock, ...) implement it
 *
 * Loop rules, in one place:
 * 1. steps run in declaration order
 * 2. a succeeded step hands its artifacts to the following steps
 * 3. a failed step records an attempt; when it declares on_failure and
 *    decideStepRetry allows it, control jumps to the on_failure step —
 *    this is the Developer → Test NG → Developer → Test repair loop
 * 4. retry_policy.max_attempts is enforced by the existing retry ledger:
 *    when exhausted, on_failure is NOT followed and the run stops safely
 *    with a retry_exhausted artifact for the user
 * 5. token budgets are checked before every execution and spends are
 *    recorded after each call (caps are limits, not allocations)
 * 6. a failed step without on_failure, an unreachable on_failure target,
 *    or an invalid workflow stops the run with a machine-checkable reason
 * 7. a defensive bound on total step executions guarantees termination
 *    even if the engine or a definition misbehaves
 *
 * @typedef {import("./contracts.js").AgentArtifact} AgentArtifact
 * @typedef {import("./contracts.js").ExecutionDiagnostic} ExecutionDiagnostic
 * @typedef {import("./contracts.js").ExecutionResult} ExecutionResult
 * @typedef {import("./contracts.js").StepExecutionOutcome} StepExecutionOutcome
 * @typedef {import("./contracts.js").StepExecutor} StepExecutor
 * @typedef {import("./contracts.js").StepFailure} StepFailure
 * @typedef {import("./contracts.js").StepRecord} StepRecord
 * @typedef {import("./contracts.js").StepResultSummary} StepResultSummary
 * @typedef {import("./contracts.js").WorkflowStep} WorkflowStep
 */

import { validateArtifact } from "../artifacts/artifact-schemas.js";
import {
  buildRetryExhaustionArtifact,
  createRetryLedger,
  decideStepRetry,
  recordAttempt
} from "./retry-policy.js";
import {
  buildBudgetExhaustionArtifact,
  createTokenLedger,
  decideStepBudget,
  recordSpend,
  totalTokensSpent
} from "./token-budget.js";

/**
 * Vocabulary of terminal execution statuses. "running" (see contracts) is
 * reserved for future resumable runtimes.
 */
export const EXECUTION_STATUSES = ["completed", "stopped", "failed"];

/**
 * Vocabulary of step statuses. In a finished result a step is "succeeded"
 * (reached at least one success), "failed" (executed without success) or
 * "blocked" (never executed because the run stopped earlier). "pending"
 * and "running" describe steps of a not-yet-finished execution and are
 * part of the vocabulary for resumable runtimes.
 */
export const STEP_STATUSES = ["pending", "running", "succeeded", "failed", "blocked"];

/**
 * Machine-checkable stop reasons. Values double as diagnostic codes.
 *
 * @type {Readonly<{ RETRY_EXHAUSTED: "retry_exhausted", BUDGET_EXHAUSTED: "budget_exhausted", STEP_FAILED: "step_failed", INVALID_WORKFLOW: "invalid_workflow", UNKNOWN_FAILURE_TARGET: "unknown_failure_target", BOUND_EXCEEDED: "max_step_executions_exceeded" }>}
 */
export const EXECUTION_STOP_REASONS = Object.freeze({
  RETRY_EXHAUSTED: "retry_exhausted",
  BUDGET_EXHAUSTED: "budget_exhausted",
  STEP_FAILED: "step_failed",
  INVALID_WORKFLOW: "invalid_workflow",
  UNKNOWN_FAILURE_TARGET: "unknown_failure_target",
  BOUND_EXCEEDED: "max_step_executions_exceeded"
});

/**
 * Validates that a loaded workflow definition is runnable: steps exist,
 * ids are unique, and every on_failure references an earlier step with a
 * retry_policy (the same structural rules the registry validator enforces
 * on workflows/*.yaml). The engine re-checks defensively so that a
 * programmatically built definition cannot start an unbounded or broken
 * run.
 *
 * @param {unknown} workflow
 * @returns {string[]}
 */
export function validateWorkflowForExecution(workflow) {
  const errors = [];
  const label = isRecord(workflow) && typeof workflow.name === "string" ? workflow.name : "<unknown workflow>";

  if (!isRecord(workflow)) {
    return ["workflow must be an object."];
  }

  const steps = workflow.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    errors.push(`${label}: steps must be a non-empty array.`);
    return errors;
  }

  const ids = new Set();
  const indexOf = new Map();

  steps.forEach((step, index) => {
    const stepLabel = `${label}: steps[${index}]`;
    if (!isRecord(step)) {
      errors.push(`${stepLabel} must be an object.`);
      return;
    }
    if (typeof step.id !== "string" || step.id.trim() === "") {
      errors.push(`${stepLabel}.id must be a non-empty string.`);
      return;
    }
    if (ids.has(step.id)) {
      errors.push(`${stepLabel}.id duplicates "${step.id}".`);
      return;
    }
    ids.add(step.id);
    indexOf.set(step.id, index);
  });

  steps.forEach((step, index) => {
    if (!isRecord(step) || typeof step.id !== "string") return;
    if (step.on_failure === undefined) {
      if (step.retry_policy !== undefined) {
        errors.push(`${label}: step "${step.id}" declares retry_policy without on_failure.`);
      }
      return;
    }

    const targetIndex = typeof step.on_failure === "string" ? indexOf.get(step.on_failure) : undefined;
    if (targetIndex === undefined || targetIndex >= index) {
      errors.push(`${label}: step "${step.id}" declares on_failure "${String(step.on_failure)}" which is not an earlier step.`);
    }

    const policy = step.retry_policy;
    if (!isRecord(policy) || typeof policy.max_attempts !== "number" || !Number.isInteger(policy.max_attempts) || policy.max_attempts < 1) {
      errors.push(`${label}: step "${step.id}" declares on_failure and must define retry_policy.max_attempts (integer >= 1).`);
    }
  });

  return errors;
}

/**
 * Runs a workflow to completion, stop, or failure and returns a result
 * whose status, stop reason, failure details, artifacts, and per-step
 * records are machine-checkable.
 *
 * @param {{
 *   workflow: Record<string, unknown> & { name?: string, steps?: unknown },
 *   executeStep: StepExecutor,
 *   maxStepExecutions?: number
 * }} options
 * @returns {Promise<ExecutionResult>}
 */
export async function runWorkflow({ workflow, executeStep, maxStepExecutions }) {
  if (typeof executeStep !== "function") {
    throw new Error("executeStep must be a function: the engine never invokes an agent runtime itself.");
  }

  const workflowName = isRecord(workflow) && typeof workflow.name === "string" ? workflow.name : "<unknown workflow>";

  const validationErrors = validateWorkflowForExecution(workflow);
  if (validationErrors.length > 0) {
    return buildResult({
      workflowName,
      status: "failed",
      stopReason: EXECUTION_STOP_REASONS.INVALID_WORKFLOW,
      diagnostics: validationErrors.map((message) => ({
        code: EXECUTION_STOP_REASONS.INVALID_WORKFLOW,
        message
      }))
    });
  }

  const steps = /** @type {WorkflowStep[]} */ (workflow.steps);
  const budget = isRecord(workflow.budget) ? workflow.budget : null;
  const bound = typeof maxStepExecutions === "number"
    ? maxStepExecutions
    : defaultExecutionBound(steps);

  /** @type {Map<string, StepRecord[]>} */
  const recordsByStep = new Map(steps.map((step) => [step.id, []]));
  /** @type {Map<string, AgentArtifact>} */
  const latestArtifacts = new Map();
  /** @type {AgentArtifact[]} */
  const artifactsProduced = [];
  /** @type {import("./contracts.js").ExecutionTraceEntry[]} */
  const trace = [];
  /** @type {ExecutionDiagnostic[]} */
  const diagnostics = [];

  let retryLedger = createRetryLedger();
  let tokenLedger = createTokenLedger();
  let index = 0;

  while (true) {
    if (trace.length >= bound) {
      return buildResult({
        workflowName,
        status: "failed",
        stopReason: EXECUTION_STOP_REASONS.BOUND_EXCEEDED,
        diagnostics: [{
          code: EXECUTION_STOP_REASONS.BOUND_EXCEEDED,
          message: `execution exceeded its bound of ${bound} step executions; refusing to continue.`
        }],
        state: { steps, recordsByStep, latestArtifacts, artifactsProduced, trace, diagnostics, tokenLedger }
      });
    }

    const step = steps[index];
    const attempt = recordsByStep.get(step.id).length + 1;

    const budgetDecision = decideStepBudget({
      ledger: tokenLedger,
      stepId: step.id,
      stepBudget: step.token_budget,
      workflowBudget: budget
    });

    if (budgetDecision.status === "exceeded") {
      const stopArtifact = buildBudgetExhaustionArtifact({
        workflowName,
        stepId: step.id,
        ledger: tokenLedger,
        workflowBudget: budget,
        stepBudget: step.token_budget,
        completedWork: completedStepIds(steps, recordsByStep),
        remainingWork: unexecutedStepIds(steps, recordsByStep),
        unresolved: [
          `ステップ "${step.id}" の実行前にトークン予算を使い切りました（${budgetDecision.reason}）`
        ]
      });

      return buildResult({
        workflowName,
        status: "stopped",
        stopReason: EXECUTION_STOP_REASONS.BUDGET_EXHAUSTED,
        stopArtifact,
        unresolved: stopArtifact.unresolved,
        state: { steps, recordsByStep, latestArtifacts, artifactsProduced, trace, diagnostics, tokenLedger }
      });
    }

    const outcome = await invokeStep(executeStep, {
      workflowName,
      stepId: step.id,
      step,
      attempt,
      artifacts: Object.fromEntries(latestArtifacts)
    });

    const tokensSpent = normalizeSpend(outcome.tokensSpent);
    if (tokensSpent === null) {
      diagnostics.push({
        code: "invalid_token_spend",
        message: `step "${step.id}" reported an invalid tokensSpent value; it was ignored.`
      });
    } else if (tokensSpent > 0) {
      tokenLedger = recordSpend(tokenLedger, step.id, tokensSpent);
    }

    // A "succeeded" outcome with malformed artifacts does not pass the
    // step: artifact schemas are the machine-checkable part of the gate.
    let status = outcome.status;
    let failure = outcome.status === "failed" ? normalizeFailure(outcome.failure) : null;
    const artifactErrors = (outcome.artifacts ?? []).flatMap((artifact) => validateArtifact(artifact));

    if (status === "succeeded" && artifactErrors.length > 0) {
      status = "failed";
      failure = {
        reason: `step "${step.id}" produced invalid artifacts: ${artifactErrors.join(" ")}`,
        unresolved: []
      };
    }

    const record = {
      stepId: step.id,
      attempt,
      status,
      failure,
      artifacts: outcome.artifacts ?? [],
      tokensSpent: tokensSpent ?? 0
    };
    recordsByStep.get(step.id).push(record);
    trace.push({ stepId: step.id, attempt, status });

    for (const artifact of record.artifacts) {
      artifactsProduced.push(artifact);
      latestArtifacts.set(artifact.type, artifact);
    }

    if (status === "succeeded") {
      if (index === steps.length - 1) {
        return buildResult({
          workflowName,
          status: "completed",
          stopReason: null,
          state: { steps, recordsByStep, latestArtifacts, artifactsProduced, trace, diagnostics, tokenLedger }
        });
      }
      index += 1;
      continue;
    }

    // Failed execution. The attempt is recorded before the retry decision
    // so that attemptsUsed includes the failed run (retry-policy contract).
    retryLedger = recordAttempt(retryLedger, step.id);

    if (step.on_failure === undefined) {
      return buildResult({
        workflowName,
        status: "failed",
        stopReason: EXECUTION_STOP_REASONS.STEP_FAILED,
        failedStep: step.id,
        failure,
        unresolved: failure?.unresolved ?? [],
        state: { steps, recordsByStep, latestArtifacts, artifactsProduced, trace, diagnostics, tokenLedger }
      });
    }

    const decision = decideStepRetry({
      ledger: retryLedger,
      stepId: step.id,
      policy: step.retry_policy,
      failure: failure ?? undefined
    });

    if (decision.action === "retry") {
      const targetIndex = steps.findIndex((candidate) => candidate.id === step.on_failure);
      if (targetIndex === -1 || targetIndex >= index) {
        // Unreachable after validateWorkflowForExecution; guarded anyway
        // so a broken jump can never masquerade as progress.
        return buildResult({
          workflowName,
          status: "failed",
          stopReason: EXECUTION_STOP_REASONS.UNKNOWN_FAILURE_TARGET,
          failedStep: step.id,
          failure,
          diagnostics: [{
            code: EXECUTION_STOP_REASONS.UNKNOWN_FAILURE_TARGET,
            message: `step "${step.id}" declares on_failure "${String(step.on_failure)}" which is not an earlier step.`
          }],
          state: { steps, recordsByStep, latestArtifacts, artifactsProduced, trace, diagnostics, tokenLedger }
        });
      }
      index = targetIndex;
      continue;
    }

    // Retry budget exhausted (or the failure class is not retryable):
    // following on_failure is forbidden; the user decides what is next.
    const stopArtifact = buildRetryExhaustionArtifact({
      workflowName,
      stepId: step.id,
      ledger: retryLedger,
      policy: step.retry_policy,
      gate: step.gate,
      unresolved: failure?.unresolved ?? []
    });

    return buildResult({
      workflowName,
      status: "stopped",
      stopReason: EXECUTION_STOP_REASONS.RETRY_EXHAUSTED,
      failedStep: step.id,
      failure,
      stopArtifact,
      unresolved: stopArtifact.unresolved,
      state: { steps, recordsByStep, latestArtifacts, artifactsProduced, trace, diagnostics, tokenLedger }
    });
  }
}

/**
 * Calls the executor port and converts every misbehavior (throwing,
 * returning garbage) into a failed outcome so that policy rules — not
 * exceptions — decide what happens next.
 *
 * @param {StepExecutor} executeStep
 * @param {import("./contracts.js").StepExecutionRequest} request
 * @returns {Promise<StepExecutionOutcome>}
 */
async function invokeStep(executeStep, request) {
  let outcome;
  try {
    outcome = await executeStep(request);
  } catch (error) {
    return {
      status: "failed",
      failure: {
        reason: `step "${request.stepId}" executor threw: ${error instanceof Error ? error.message : String(error)}`,
        unresolved: []
      }
    };
  }

  if (!isRecord(outcome) || (outcome.status !== "succeeded" && outcome.status !== "failed")) {
    return {
      status: "failed",
      failure: {
        reason: `step "${request.stepId}" executor returned an invalid outcome (expected status "succeeded" or "failed").`,
        unresolved: []
      }
    };
  }

  return /** @type {StepExecutionOutcome} */ (outcome);
}

function normalizeFailure(failure) {
  if (!isRecord(failure)) {
    return { reason: "step failed without a reported reason.", unresolved: [] };
  }
  return {
    reason: typeof failure.reason === "string" ? failure.reason : "step failed without a reported reason.",
    severities: Array.isArray(failure.severities) ? failure.severities : undefined,
    unresolved: Array.isArray(failure.unresolved) ? failure.unresolved : []
  };
}

/**
 * @param {unknown} value
 * @returns {number | null} the spend when it is a usable number, else null
 */
function normalizeSpend(value) {
  if (value === undefined) return 0;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  return null;
}

/**
 * Default bound on total step executions. Every backward jump is a failed
 * execution bounded by that step's max_attempts, and between two jumps at
 * most `steps.length` steps can succeed once more, so legitimate runs
 * stay strictly below this number; only an engine bug or an explicit
 * option override can reach it.
 *
 * @param {readonly WorkflowStep[]} steps
 * @returns {number}
 */
function defaultExecutionBound(steps) {
  const stepCount = steps.length;
  const maxBackwardJumps = steps.reduce(
    (sum, step) => sum + (step.retry_policy?.max_attempts ?? 0),
    0
  );
  return stepCount * (maxBackwardJumps + 1) + maxBackwardJumps + stepCount + 1;
}

function completedStepIds(steps, recordsByStep) {
  return steps
    .map((step) => step.id)
    .filter((id) => (recordsByStep.get(id) ?? []).some((record) => record.status === "succeeded"));
}

function unexecutedStepIds(steps, recordsByStep) {
  return steps.map((step) => step.id).filter((id) => (recordsByStep.get(id) ?? []).length === 0);
}

/**
 * Assembles the public result from the loop state.
 *
 * @param {{
 *   workflowName: string,
 *   status: "completed" | "stopped" | "failed",
 *   stopReason: import("./contracts.js").ExecutionStopReason | null,
 *   failedStep?: string | null,
 *   failure?: StepFailure | null,
 *   stopArtifact?: import("./contracts.js").RetryExhaustionArtifact | import("./contracts.js").BudgetExhaustionArtifact | null,
 *   unresolved?: readonly string[],
 *   diagnostics?: readonly ExecutionDiagnostic[],
 *   state?: {
 *     steps: readonly WorkflowStep[],
 *     recordsByStep: ReadonlyMap<string, StepRecord[]>,
 *     latestArtifacts: ReadonlyMap<string, AgentArtifact>,
 *     artifactsProduced: readonly AgentArtifact[],
 *     trace: readonly import("./contracts.js").ExecutionTraceEntry[],
 *     diagnostics: readonly ExecutionDiagnostic[],
 *     tokenLedger: import("./contracts.js").TokenLedger
 *   }
 * }} options
 * @returns {ExecutionResult}
 */
function buildResult({
  workflowName,
  status,
  stopReason,
  failedStep = null,
  failure = null,
  stopArtifact = null,
  unresolved = [],
  diagnostics = [],
  state
}) {
  const steps = state?.steps ?? [];
  const recordsByStep = state?.recordsByStep ?? new Map();
  const trace = state?.trace ?? [];

  /** @type {Record<string, StepResultSummary>} */
  const stepSummaries = {};
  const completedSteps = [];

  for (const step of steps) {
    const records = recordsByStep.get(step.id) ?? [];
    const succeeded = records.filter((record) => record.status === "succeeded").length;
    const failed = records.length - succeeded;

    if (records.length === 0) {
      stepSummaries[step.id] = { status: status === "completed" ? "pending" : "blocked", executions: 0, succeeded: 0, failed: 0, results: [] };
    } else {
      if (succeeded > 0) completedSteps.push(step.id);
      stepSummaries[step.id] = {
        status: succeeded > 0 ? "succeeded" : "failed",
        executions: records.length,
        succeeded,
        failed,
        results: records
      };
    }
  }

  return {
    workflow: workflowName,
    status,
    stopReason,
    failedStep,
    failure,
    diagnostics: [...(state?.diagnostics ?? []), ...diagnostics],
    steps: stepSummaries,
    completedSteps,
    blockedSteps: unexecutedStepIds(steps, recordsByStep),
    executionTrace: trace,
    artifacts: Object.fromEntries(state?.latestArtifacts ?? new Map()),
    artifactsProduced: state?.artifactsProduced ?? [],
    stopArtifact: stopArtifact ?? null,
    unresolved: [...unresolved],
    tokensSpent: state ? totalTokensSpent(state.tokenLedger) : 0
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
