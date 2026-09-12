/**
 * Contracts of the Action Guardrails layer (Issue #27).
 *
 * The guardrails extend the common permission model (Issue #6,
 * src/permission/) from "what the role may do in general" (read / edit /
 * write) to "whether this concrete action may execute at runtime"
 * (filesystem / shell / git / network / secrets / external). The model is
 * Core: runtime adapters convert it to their own enforcement mechanisms
 * (Runtime Adapter Interface, Issue #31, is the intended consumer).
 */

/** The operation kinds every action belongs to. */
export type ActionKind = "filesystem" | "shell" | "git" | "network" | "secrets" | "external";

/**
 * A concrete action a step runtime wants to perform. `target` is the
 * path, command string, URL/host, or service name; `content` carries
 * payload text that could leak secrets.
 */
export type ActionRequest = {
  kind: ActionKind;
  operation: string;
  target?: string;
  content?: string;
};

/**
 * Declarative, deny-by-default policy. Anything not explicitly allowed
 * here is refused; approvals can only ever lift operations the policy
 * vocabulary marks as approvable (destructive operations), never secrets.
 */
export type ActionPolicy = {
  shell?: {
    execute?: "allow" | "deny";
  };
  git?: {
    allow_push?: boolean;
    allow_destructive?: boolean;
  };
  network?: {
    /** Exact hosts (or host: with URL targets) allowed for egress. Empty = all denied. */
    allowed_hosts?: readonly string[];
  };
  external?: {
    /** External services a step may invoke. Empty = none. */
    allowed_services?: readonly string[];
  };
  filesystem?: {
    allow_delete?: boolean;
    /** Path prefixes a non-read filesystem action may touch. Empty = role permission governs. */
    write_paths?: readonly string[];
  };
};

/** A human approval token, e.g. "git.force-push" or "shell.execute.destructive". */
export type ApprovalToken = string;

export type ActionDecisionCode =
  | "permission_denied"
  | "path_outside_allowed"
  | "shell_disabled"
  | "destructive_shell"
  | "destructive_git"
  | "push_disabled"
  | "egress_not_allowed"
  | "external_service_not_allowed"
  | "secrets_denied"
  | "secret_leakage"
  | "invalid_action"
  | "approval_required";

export type ActionDecision = {
  decision: "allow" | "deny" | "requires_approval";
  reason: string;
  code: ActionDecisionCode | null;
  /** Set for requires_approval: the token a human must approve. */
  approvable?: ApprovalToken;
};

/** Machine-checkable description of a refused action. */
export type ActionViolation = {
  code: ActionDecisionCode;
  kind: ActionKind;
  operation: string;
  target?: string;
  reason: string;
  /** Set for requires_approval refusals: the token a human must approve. */
  approvable?: ApprovalToken;
};

export type ActionEnforcement = {
  decision: "allow" | "deny" | "requires_approval";
  reason: string;
  violation: ActionViolation | null;
  /** StepFailure-shaped object for refused actions; pass as outcome.failure. */
  failure: import("../execution/contracts.js").StepFailure | null;
};

export type UntrustedEnvelope = {
  id: string;
  source: string;
  /** The content wrapped in boundary markers; embed in prompts as-is. */
  envelope: string;
};
