/**
 * Model Execution Tracking (Issue #22): one structured record per AI
 * execution answering "which step ran, on which provider/model, as which
 * attempt, and what happened".
 *
 * Layering (unchanged from #21/#27/#28/#29/#31):
 * - the Execution Engine records what actually happened, deriving the
 *   record from the Runtime Adapter's reported outcome metadata — no
 *   runtime-specific knowledge and no new model-management machinery
 * - values the runtime does not report are null/undefined, never
 *   guessed (requested tier, escalation, fallback are reserved shapes
 *   for the future policies)
 * - failure reasons are screened through the guardrails' secret
 *   detection (#27): anything matching a credential shape is redacted
 *   before it can reach a persisted record
 * - records can be persisted to the Artifact Store (#29) as
 *   `model-execution-record` artifacts (a registered common schema)
 *
 * @typedef {import("./contracts.js").ModelExecutionRecord} ModelExecutionRecord
 * @typedef {import("./contracts.js").StepExecutionOutcome} StepExecutionOutcome
 */

import { detectSecrets } from "../guardrails/secrets.js";
import { basename } from "node:path";

/**
 * The artifact type a persisted Model Execution Record is stored under
 * (registered in src/artifacts/artifact-schemas.js).
 */
export const MODEL_EXECUTION_ARTIFACT_TYPE = "model-execution-record";

/**
 * The role name of a step's agent path (`agents/developer.yaml` →
 * "developer"); null when the path does not resolve.
 *
 * @param {unknown} agentPath
 * @returns {string | null}
 */
export function resolveAgentRole(agentPath) {
  if (typeof agentPath !== "string" || agentPath.trim() === "") return null;
  const role = basename(agentPath).replace(/\.ya?ml$/, "").trim();
  return role === "" ? null : role;
}

/**
 * Screens a failure reason for credential shapes before it can reach a
 * persisted record (secret protection consistent with #27). The value
 * is fully replaced — partial masking still leaks shape and length.
 *
 * @param {string | null | undefined} reason
 * @returns {string | null}
 */
export function redactSecrets(reason) {
  if (typeof reason !== "string") return null;
  const kinds = detectSecrets(reason);
  if (kinds.length === 0) return reason;
  return `[redacted: ${kinds.length} secret pattern(s) detected (${kinds.join(", ")})]`;
}

/**
 * Builds one Model Execution Record from the engine's own view of an
 * execution plus whatever the Runtime Adapter reported. Fields the
 * runtime did not report stay null/undefined — nothing is invented.
 *
 * @param {{
 *   executionId: string | null,
 *   request: { workflowName?: string, stepId: string, attempt: number, step?: { id?: string, agent?: string, gate?: string } },
 *   outcome: StepExecutionOutcome,
 *   startedAt?: string,
 *   endedAt?: string,
 *   measuredDurationMs?: number
 * }} options
 * @returns {ModelExecutionRecord}
 */
export function createModelExecutionRecord({ executionId, request, outcome, startedAt, endedAt, measuredDurationMs }) {
  const runtimeMeta = typeof outcome.runtime === "object" && outcome.runtime !== null ? outcome.runtime : null;
  const failure = outcome.status === "failed" && typeof outcome.failure === "object" && outcome.failure !== null
    ? outcome.failure
    : null;

  const requestedModel = typeof runtimeMeta?.requestedProvider === "string" && typeof runtimeMeta?.requestedModel === "string"
    ? { provider: runtimeMeta.requestedProvider, model: runtimeMeta.requestedModel }
    : null;

  return {
    executionId: executionId ?? null,
    stepId: request.stepId,
    attempt: request.attempt,
    agent: resolveAgentRole(request.step?.agent),
    runtime: typeof runtimeMeta?.runtime === "string" ? runtimeMeta.runtime : null,

    requestedModel,
    resolvedProvider: typeof runtimeMeta?.provider === "string" ? runtimeMeta.provider : null,
    resolvedModel: typeof runtimeMeta?.model === "string" ? runtimeMeta.model : null,
    requestedTier: typeof runtimeMeta?.requestedTier === "string" ? runtimeMeta.requestedTier : null,
    resolvedTier: typeof runtimeMeta?.resolvedTier === "string" ? runtimeMeta.resolvedTier : null,

    startedAt: startedAt ?? null,
    endedAt: endedAt ?? null,
    durationMs: typeof runtimeMeta?.durationMs === "number"
      ? runtimeMeta.durationMs
      : typeof measuredDurationMs === "number"
        ? measuredDurationMs
        : null,

    status: outcome.status,
    errorCategory: typeof runtimeMeta?.errorCategory === "string" ? runtimeMeta.errorCategory : null,
    failureReason: failure === null ? null : redactSecrets(failure.reason ?? null),
    tokensSpent: typeof outcome.tokensSpent === "number" ? outcome.tokensSpent : null,

    escalation: runtimeMeta?.escalation ?? null,
    fallback: runtimeMeta?.fallback ?? null,
    fallbackCount: typeof runtimeMeta?.fallbackCount === "number" ? runtimeMeta.fallbackCount : null
  };
}

/**
 * Wraps a Model Execution Record as a common-schema artifact so it can
 * persist through the Artifact Store (#29) under the registered
 * `model-execution-record` type. `produced_by` is the harness itself:
 * the record is the harness's observation, not an agent's deliverable.
 *
 * @param {ModelExecutionRecord} record
 * @returns {object}
 */
export function toModelExecutionArtifact(record) {
  return {
    type: MODEL_EXECUTION_ARTIFACT_TYPE,
    produced_by: "harness",
    unresolved: [],
    executionId: record.executionId,
    stepId: record.stepId,
    attempt: record.attempt,
    runtime: record.runtime,
    status: record.status,
    fallbackCount: record.fallbackCount ?? undefined,
    fallback: record.fallback ?? undefined,
    record
  };
}
