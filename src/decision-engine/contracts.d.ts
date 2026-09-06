export type DecisionStatus = "ready" | "needs_clarification" | "blocked";

export type SelectionLevel = "low" | "medium" | "high";

export interface RequestInput {
  intent?: string;
  risk?: SelectionLevel;
  complexity?: SelectionLevel;
  [field: string]: unknown;
}

export interface WorkflowRouting {
  intents: readonly string[];
  required_request_fields?: readonly string[];
  priority?: number;
  /** Risk levels the workflow serves. Absent means the workflow serves every risk. */
  risk?: readonly SelectionLevel[];
}

export interface WorkflowDefinition {
  name: string;
  purpose?: string;
  routing: WorkflowRouting;
}

export interface DecisionContext {
  request: RequestInput;
  workflowRegistry: readonly WorkflowDefinition[];
}

export interface WorkflowSummary {
  name: string;
  purpose?: string;
}

export interface RequestProfile {
  /** Effective risk used for selection. Defaults to "high" when absent. */
  risk: SelectionLevel;
  /** Recorded for future Intent x Risk x Complexity selection; does not affect selection yet. */
  complexity: SelectionLevel | null;
}

export interface DecisionDiagnostic {
  code:
    | "missing_intent"
    | "invalid_risk"
    | "invalid_complexity"
    | "workflow_not_found"
    | "ambiguous_workflow";
  message: string;
}

export interface Clarification {
  missing_fields: readonly string[];
  message: string;
}

export interface DelegationPlan {
  status: DecisionStatus;
  requestProfile: RequestProfile;
  selectedWorkflow: WorkflowSummary | null;
  clarification: Clarification | null;
  diagnostics: readonly DecisionDiagnostic[];
}
