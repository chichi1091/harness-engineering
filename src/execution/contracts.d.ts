export type RetryPolicy = {
  max_attempts: number;
  retry_on?: readonly string[];
};

export type StepFailure = {
  /** Human-readable reason the step failed. */
  reason?: string;
  /** Severity classification used by retry_policy.retry_on matching. */
  severities?: readonly string[];
  /** Unresolved items returned to the user when the workflow stops. */
  unresolved?: readonly string[];
};

export type AgentArtifact = {
  type: string;
  produced_by: string;
  unresolved: readonly string[];
  [field: string]: unknown;
};

export type WorkflowStep = {
  id: string;
  agent: string;
  token_budget?: number;
  input?: readonly unknown[];
  output?: readonly unknown[];
  gate: string;
  on_failure?: string;
  retry_policy?: RetryPolicy;
};

/**
 * The only interface the Execution Engine needs from a runtime: run one
 * step (typically one agent invocation) and report what happened. Core
 * never invokes a CLI or a model itself; runtime adapters implement this
 * port (the mock runtime is the reference implementation).
 */
export type StepExecutionRequest = {
  workflowName: string;
  stepId: string;
  step: WorkflowStep;
  /** 1-based execution count of this step within the run. */
  attempt: number;
  /** Latest artifact per type produced by earlier steps of this run. */
  artifacts: Readonly<Record<string, AgentArtifact>>;
};

export type StepExecutionOutcome = {
  status: "succeeded" | "failed";
  /** Artifacts produced by this execution; validated against the common schemas. */
  artifacts?: readonly AgentArtifact[];
  /** Required when status is "failed". */
  failure?: StepFailure;
  /** Tokens consumed by this execution; recorded in the token ledger. */
  tokensSpent?: number;
  /**
   * Runtime execution metadata reported by the Runtime Adapter
   * (Issue #31): which runtime/provider/model ran, how it exited, and
   * the mechanical error category (shared vocabulary with the Fallback
   * Policy, Issue #23). Optional so every existing executor keeps
   * working; recorded verbatim on the step record.
   */
  runtime?: import("../runtimes/contracts.js").RuntimeExecutionMetadata;
  /**
   * Raw text output of the runtime invocation, when the adapter can
   * capture one. Recorded on the step record for tracking and
   * debugging; structured results should be returned as artifacts.
   */
  outputText?: string;
};

export type StepExecutor = (request: StepExecutionRequest) => StepExecutionOutcome | Promise<StepExecutionOutcome>;

export type RetryLedger = {
  readonly attempts: Readonly<Record<string, number>>;
};

export type StepRetryDecision = {
  action: "retry" | "stop";
  attemptsUsed: number;
  maxAttempts: number;
  reason: string;
};

export type WorkflowBudget = {
  max_total_tokens: number;
  on_budget_exceeded: {
    action: "stop";
    output?: readonly string[];
  };
};

export type TokenLedger = {
  readonly spent: Readonly<Record<string, number>>;
};

export type TokenBudgetDecision = {
  status: "within_budget" | "exceeded";
  scope?: "workflow" | "step";
  limit?: number;
  spent: number;
  totalSpent: number;
  reason: string;
};

export type BudgetExhaustionArtifact = {
  type: "budget_exhausted";
  workflow: string;
  step: string;
  total_tokens_spent: number;
  max_total_tokens: number | null;
  completed_work: readonly string[];
  remaining_work: readonly string[];
  unresolved: readonly string[];
  message: string;
};

export type EscalationCondition = "low_confidence" | "critical_and_low_confidence";

export type ModelTier = {
  provider: string;
  model: string;
};

export type EscalationRule = {
  when: EscalationCondition;
  tier: string;
};

export type ModelPolicy = {
  escalation: readonly EscalationRule[];
  max_escalations: number;
};

export type EscalationRecord = {
  step: string;
  from: string;
  to: string;
  reason: EscalationCondition;
};

export type EscalationLedger = {
  readonly records: readonly EscalationRecord[];
};

export type EscalationDecision = {
  action: "keep" | "escalate" | "stop";
  tier?: string;
  reason: string;
  record?: EscalationRecord;
};

export type EscalationExhaustionArtifact = {
  type: "escalation_exhausted";
  workflow: string;
  step: string;
  escalations_used: number;
  max_escalations: number;
  records: readonly EscalationRecord[];
  unresolved: readonly string[];
  message: string;
};

export type RetryExhaustionArtifact = {
  type: "retry_exhausted";
  workflow: string;
  step: string;
  attempts_used: number;
  max_attempts: number;
  gate: string;
  unresolved: readonly string[];
  message: string;
};

export declare function createRetryLedger(): RetryLedger;

export declare function recordAttempt(ledger: RetryLedger, stepId: string): RetryLedger;

export declare function attemptCount(ledger: RetryLedger, stepId: string): number;

export declare function decideStepRetry(options: {
  ledger: RetryLedger;
  stepId: string;
  policy: RetryPolicy;
  failure?: StepFailure;
}): StepRetryDecision;

export declare function buildRetryExhaustionArtifact(options: {
  workflowName: string;
  stepId: string;
  ledger: RetryLedger;
  policy: RetryPolicy;
  gate: string;
  unresolved: readonly string[];
}): RetryExhaustionArtifact;

/** Vocabulary of step statuses within an execution run. */
export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "blocked";

/**
 * Terminal execution statuses. "running" is an intermediate state used by
 * future resumable runtimes and never appears in a finished runWorkflow
 * result.
 */
export type ExecutionStatus = "completed" | "stopped" | "failed";

/**
 * Machine-checkable reason an execution did not complete:
 * - retry_exhausted: a gated step used up retry_policy.max_attempts; the
 *   workflow stopped instead of following on_failure (policy stop)
 * - budget_exhausted: the workflow or step token budget was spent (policy stop)
 * - step_failed: a step failed and declared no on_failure recovery
 * - invalid_workflow: the workflow definition is not runnable
 * - unknown_failure_target: on_failure referenced an unreachable step
 * - max_step_executions_exceeded: the defensive execution bound was hit
 */
export type ExecutionStopReason =
  | "retry_exhausted"
  | "budget_exhausted"
  | "step_failed"
  | "invalid_workflow"
  | "unknown_failure_target"
  | "max_step_executions_exceeded";

export type ExecutionDiagnostic = {
  code: string;
  message: string;
};

/** Record of one execution of one step (a step may execute multiple times). */
export type StepRecord = {
  stepId: string;
  attempt: number;
  status: "succeeded" | "failed";
  failure: StepFailure | null;
  artifacts: readonly AgentArtifact[];
  tokensSpent: number;
  /** Runtime execution metadata reported by the Runtime Adapter (Issue #31). */
  runtime: import("../runtimes/contracts.js").RuntimeExecutionMetadata | null;
  /** Raw text output captured by the adapter, when any. */
  outputText: string | null;
};

export type StepResultSummary = {
  status: StepStatus;
  executions: number;
  succeeded: number;
  failed: number;
  results: readonly StepRecord[];
};

export type ExecutionTraceEntry = {
  stepId: string;
  attempt: number;
  status: "succeeded" | "failed";
};

export type ExecutionResult = {
  workflow: string;
  status: ExecutionStatus;
  /** null when the workflow completed. */
  stopReason: ExecutionStopReason | null;
  /** Step whose terminal failure ended the run, when applicable. */
  failedStep: string | null;
  /** Terminal failure details, when applicable. */
  failure: StepFailure | null;
  diagnostics: readonly ExecutionDiagnostic[];
  /** Per-step summary in workflow declaration order. */
  steps: Readonly<Record<string, StepResultSummary>>;
  /** Steps that reached at least one successful execution. */
  completedSteps: readonly string[];
  /** Steps never executed because the run stopped or failed earlier. */
  blockedSteps: readonly string[];
  /** Chronological record of every step execution. */
  executionTrace: readonly ExecutionTraceEntry[];
  /** Latest artifact per type, available to later steps and to the caller. */
  artifacts: Readonly<Record<string, AgentArtifact>>;
  /** Every artifact produced during the run, in production order. */
  artifactsProduced: readonly AgentArtifact[];
  /** retry_exhausted / budget_exhausted artifact, when the run stopped on policy. */
  stopArtifact: RetryExhaustionArtifact | BudgetExhaustionArtifact | null;
  /** Unresolved items the user must judge (empty on completion). */
  unresolved: readonly string[];
  tokensSpent: number;
  /** One Model Execution Record per AI execution, in execution order (Issue #22). */
  modelExecutions: readonly import("./model-execution-tracking.js").ModelExecutionRecord[];
};

/**
 * Model Execution Tracking (Issue #22): what the harness observed about
 * one AI execution. Fields the Runtime Adapter did not report stay
 * null — the record never invents values. escalation/fallback are
 * reserved report shapes (populated by #23 and future tier policies).
 */
export type ModelExecutionRecord = {
  executionId: string | null;
  stepId: string;
  attempt: number;
  agent: string | null;
  runtime: string | null;

  requestedModel: { provider: string; model: string } | null;
  resolvedProvider: string | null;
  resolvedModel: string | null;
  requestedTier: string | null;
  resolvedTier: string | null;

  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;

  status: "succeeded" | "failed";
  errorCategory: string | null;
  failureReason: string | null;
  tokensSpent: number | null;

  escalation: {
    escalated: boolean;
    fromTier?: string;
    toTier?: string;
    reason?: string;
  } | null;
  fallback: {
    fromProvider?: string;
    fromModel?: string;
    toProvider?: string;
    toModel?: string;
    reason?: string;
  } | null;
};
