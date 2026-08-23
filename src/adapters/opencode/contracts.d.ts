import type {
  DecisionContext,
  DelegationPlan,
  RequestInput,
  WorkflowDefinition
} from "../../decision-engine/contracts.js";

export interface RegisteredWorkflow extends WorkflowDefinition {
  sourcePath: string;
  steps?: readonly unknown[];
}

export interface OpenCodeCommand {
  relativePath: string;
  content: string;
}

export interface OpenCodeDelegation {
  delegationPlan: DelegationPlan;
  command: OpenCodeCommand | null;
}

export declare function loadWorkflowRegistry(
  workflowsDirectory: string
): Promise<readonly RegisteredWorkflow[]>;

export declare function createDecisionContext(
  request: RequestInput,
  workflowRegistry: readonly RegisteredWorkflow[]
): DecisionContext;

export declare function createOpenCodeDelegation(
  request: RequestInput,
  workflowRegistry: readonly RegisteredWorkflow[]
): OpenCodeDelegation;

export declare function toOpenCodeCommand(
  delegationPlan: DelegationPlan,
  workflowRegistry: readonly RegisteredWorkflow[]
): OpenCodeCommand | null;
