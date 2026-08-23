export type DecisionStatus = "ready" | "needs_clarification" | "blocked";

export interface RequestInput {
  intent?: string;
  [field: string]: unknown;
}

export interface WorkflowRouting {
  intents: readonly string[];
  required_request_fields?: readonly string[];
  priority?: number;
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

export interface DecisionDiagnostic {
  code: "missing_intent" | "workflow_not_found" | "ambiguous_workflow";
  message: string;
}

export interface Clarification {
  missing_fields: readonly string[];
  message: string;
}

export interface DelegationPlan {
  status: DecisionStatus;
  selectedWorkflow: WorkflowSummary | null;
  clarification: Clarification | null;
  diagnostics: readonly DecisionDiagnostic[];
}
