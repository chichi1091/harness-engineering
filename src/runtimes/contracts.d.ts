/**
 * Runtime Adapter Interface (Issue #31).
 *
 * The common contract every runtime adapter implements so that Harness
 * Core can drive OpenCode, Claude Code, Codex, Gemini CLI, or any other
 * runtime without knowing about any of them:
 *
 *     Harness Core → Runtime Adapter (this interface) → Runtime → Provider/Model
 *
 * Relationship to the existing StepExecutor Port (Issue #21): the
 * interface EXTENDS the port, it does not replace it. `executeStep` keeps
 * exactly the StepExecutionRequest → StepExecutionOutcome signature, so
 * a RuntimeAdapter plugs into `runWorkflow` unchanged and a plain
 * executor function remains a valid (metadata-less) adapter input.
 *
 * Relationship to other layers (kept strictly separate):
 * - Execution Engine (#21) runs the loop and interprets outcomes
 * - Action Guardrails (#27) refuse prohibited actions; adapters reach
 *   them through the Command Runner boundary (see
 *   src/guardrails/guarded-command-runner.js)
 * - Mechanical Verification (#28) judges executed results
 */

import type {
  StepExecutionRequest,
  StepExecutionOutcome
} from "../execution/contracts.js";

/**
 * Mechanical error categories an adapter may report on failure. The
 * vocabulary is shared with the Fallback Policy (Issue #23):
 * fallback-eligible categories describe a runtime/provider condition
 * another provider could satisfy; ineligible ones describe a problem
 * retrying or switching providers would not fix.
 */
export type ErrorCategory =
  // fallback-eligible (Issue #23)
  | "timeout"
  | "provider_unavailable"
  | "rate_limited"
  | "quota_exceeded"
  | "transient_error"
  // fallback-ineligible
  | "auth_error"
  | "invalid_model"
  | "invalid_configuration"
  | "permission_denied"
  | "nonzero_exit"
  | "runtime_error"
  | "invalid_response"
  // reported by guardrails when a refused action reached a command runner
  | "guardrail_violation"
  | "unknown";

/**
 * What a runtime adapter reports about one execution of one step. Every
 * field is optional for the adapter (a scripted mock may omit what a
 * scenario does not exercise), but an adapter SHOULD report as much as
 * its runtime exposes — this is the record Model Execution Tracking
 * (#22) and the Fallback Policy (#23) consume.
 */
export type RuntimeExecutionMetadata = {
  /** Adapter name, e.g. "opencode", "mock". */
  runtime: string;
  /** Provider that executed the step, e.g. "openai", "google", "zai". */
  provider?: string;
  /** Concrete model that executed the step, e.g. "gpt-5.6-terra". */
  model?: string;
  /** Process exit code, when the runtime is process-shaped. */
  exitCode?: number | null;
  /** Mechanical classification of a failure (see ErrorCategory). */
  errorCategory?: ErrorCategory;
  /** Wall-clock duration of the runtime invocation in milliseconds. */
  durationMs?: number | null;
  /** Runtime-specific session/correlation identifier, if any. */
  sessionId?: string;
  /**
   * Model/Provider the caller asked the runtime to use, when it differs
   * conceptually from what actually ran (Issue #22: requested vs
   * resolved). Equal to provider/model when no resolution happened.
   */
  requestedProvider?: string | null;
  requestedModel?: string | null;
  /** Model tiers, when tier-based resolution is in play (#22). */
  requestedTier?: string | null;
  resolvedTier?: string | null;
  /** Tier escalation report (reserved; populated once #10 escalation runs through adapters). */
  escalation?: {
    escalated: boolean;
    fromTier?: string;
    toTier?: string;
    reason?: string;
  } | null;
  /** Provider/model fallback report (reserved for Issue #23). */
  fallback?: {
    fromProvider?: string;
    fromModel?: string;
    toProvider?: string;
    toModel?: string;
    reason?: string;
  } | null;
};

/**
 * Declares what a runtime adapter supports so Core or the user can pick
 * a suitable adapter without runtime-specific knowledge. Optional: a
 * minimal adapter may omit it.
 */
export type RuntimeCapabilities = {
  /** Operations the adapter can perform, e.g. ["execute-step", "shell"]. */
  operations?: readonly string[];
  /** Providers the adapter can drive, e.g. ["openai", "google"]. */
  providers?: readonly string[];
};

/**
 * The Runtime Adapter Interface. `executeStep` is the existing
 * StepExecutor Port (Issue #21) — same signature, plus the expectation
 * that the adapter reports `outcome.runtime` metadata.
 */
export type RuntimeAdapter = {
  /** Unique adapter name ("opencode", "mock", "claude-code", ...). */
  readonly name: string;
  readonly capabilities?: RuntimeCapabilities;
  executeStep(request: StepExecutionRequest): StepExecutionOutcome | Promise<StepExecutionOutcome>;
};

/** Request a runner receives from a shell-simulating or real adapter. */
export type ShellCommandRequest = {
  command: string;
  args?: readonly string[];
  cwd?: string;
};
