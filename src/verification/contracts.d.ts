/**
 * Contracts of the Mechanical Verification layer (Issue #28).
 *
 * The canonical gate declaration lives in quality-gates.yaml (project
 * root). The verification engine is pure orchestration: it depends only
 * on the injected runCommand port, never on child_process or any other
 * runtime facility.
 */

/** Behavior when a gate fails. "continue" runs every gate so the repair
 * loop receives all failures at once; "stop" halts at the first failure. */
export type OnFailurePolicy = "continue" | "stop";

export type QualityGateCommand = {
  /** Unique gate id, referenced by reports and artifacts. */
  id: string;
  /** Human-readable title. Defaults to the id. */
  title?: string;
  /** Executable, e.g. "npm". */
  command: string;
  /** Argument list, passed verbatim to the command. */
  args?: readonly string[];
};

export type QualityGatesDefinition = {
  name: string;
  purpose: string;
  commands: readonly QualityGateCommand[];
  policy?: {
    on_failure?: OnFailurePolicy;
  };
};

export type GateStatus = "passed" | "failed" | "not_run";

/** One gate execution as reported by the verification engine. */
export type GateResult = {
  id: string;
  title: string;
  status: GateStatus;
  exitCode: number | null;
  durationMs: number | null;
  /** Trailing slice of the combined output (failures only by design). */
  output: string | null;
};

/**
 * The only interface the verification engine needs from a runtime: run
 * one command and report its exit code and streams. Core never spawns a
 * process itself; the Node runtime and the mock runtime implement this
 * port.
 */
export type CommandRunnerRequest = {
  id: string;
  command: string;
  args: readonly string[];
  cwd?: string;
};

export type CommandRunnerOutcome = {
  id: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number | null;
  /** Set by the Node runner when the process was killed on timeout. */
  timedOut?: boolean;
  /** Mechanical classification (Issue #31 vocabulary) when known. */
  errorCategory?: string;
  /** Set by the guarded runner when the guardrails refused the command. */
  violation?: unknown;
};

export type CommandRunner = (request: CommandRunnerRequest) => Promise<CommandRunnerOutcome>;

/**
 * Terminal verification statuses. "invalid" means the declaration itself
 * was rejected by validateQualityGates — nothing was executed.
 */
export type VerificationStatus = "passed" | "failed" | "invalid";

export type VerificationReport = {
  name: string;
  status: VerificationStatus;
  /** Declaration errors, when status is "invalid". */
  errors: readonly string[];
  failedGates: readonly string[];
  /** Gates skipped by an on_failure: "stop" policy. */
  notRunGates: readonly string[];
  results: readonly GateResult[];
  /** Human-readable summary. */
  message: string;
};

/**
 * Machine-checkable failure description shaped for the Execution Engine's
 * StepFailure: pass it as outcome.failure when a verification gate fails
 * inside a workflow step.
 */
export type VerificationFailure = {
  reason: string;
  severities?: undefined;
  unresolved: readonly string[];
};

export type VerificationArtifact = {
  type: "verification-result";
  produced_by: string;
  unresolved: readonly string[];
  status: "passed" | "failed";
  gates: readonly { id: string; status: GateStatus }[];
  failed_gates: readonly string[];
  /** How the repair loop re-checks after fixing. */
  rerun_command: string;
};
