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

export interface ProfileAssignment {
  provider: string;
  model: string;
  mode: "readonly" | "write";
}

export type ProfileAssignments = Readonly<Record<string, ProfileAssignment>>;

export interface ExecutionProfile {
  name: string;
  assignments: ProfileAssignments;
}

export interface RegisteredProfile extends ExecutionProfile {
  sourcePath: string;
}

export interface OpenCodeAgentFile {
  role: string;
  relativePath: string;
  content: string;
}

export interface AgentDefinition {
  name: string;
  purpose?: string;
  responsibilities?: readonly string[];
  constraints?: readonly string[];
  done_when?: readonly string[];
  [field: string]: unknown;
}

export interface RegisteredAgentDefinition extends AgentDefinition {
  sourcePath: string;
}

export declare function loadProfiles(
  profilesDirectory: string
): Promise<readonly RegisteredProfile[]>;

export declare function loadAgentDefinitions(
  agentsDirectory: string
): Promise<readonly RegisteredAgentDefinition[]>;

export declare function toOpenCodeAgentFiles(
  profile: RegisteredProfile,
  agentDefinitions: readonly RegisteredAgentDefinition[]
): readonly OpenCodeAgentFile[];

export declare function describeRoleAssignments(
  profile: RegisteredProfile | null,
  roles: readonly string[]
): readonly string[];
