export type RetryPolicy = {
  max_attempts: number;
  retry_on?: readonly string[];
};

export type StepFailure = {
  severities?: readonly string[];
};

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
