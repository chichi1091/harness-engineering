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
