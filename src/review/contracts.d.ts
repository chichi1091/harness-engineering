export type ReviewSeverity = "blocker" | "high" | "medium" | "low";

export type SeverityAction = "reject" | "report" | "ignore";

export interface SeverityRule {
  action: SeverityAction;
  criteria: string;
}

export interface ReviewPolicy {
  severity: Readonly<Record<string, SeverityRule>>;
  approval: {
    require: Readonly<Record<string, number>>;
  };
}

export interface ReviewFinding {
  severity: ReviewSeverity;
  [field: string]: unknown;
}

export interface ReviewDecision {
  status: "approved" | "rejected" | "invalid";
  counts: Readonly<Record<string, number>>;
  reasons: readonly string[];
}

export declare function validateReviewPolicy(policy: ReviewPolicy): string[];

export declare function decideReview(
  findings: readonly ReviewFinding[],
  policy: ReviewPolicy
): ReviewDecision;
