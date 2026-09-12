/**
 * Core-side helpers of the Runtime Adapter Interface (Issue #31).
 *
 * Pure vocabulary and contract validation only: no runtime knows about
 * this module, and this module knows about no runtime. Adding a new
 * runtime adapter (Claude Code, Codex, ...) therefore requires no Core
 * change — implement the RuntimeAdapter contract and pass
 * `adapter.executeStep` to `runWorkflow`.
 *
 * @typedef {import("./contracts.js").ErrorCategory} ErrorCategory
 * @typedef {import("./contracts.js").RuntimeAdapter} RuntimeAdapter
 * @typedef {import("../execution/contracts.js").StepExecutor} StepExecutor
 */

/**
 * The full error-category vocabulary an adapter may report. Adapters
 * must use these values so downstream policies can stay
 * runtime-agnostic.
 *
 * @type {readonly import("./contracts.js").ErrorCategory[]}
 */
export const RUNTIME_ERROR_CATEGORIES = [
  // fallback-eligible (Issue #23): another provider may succeed
  "timeout",
  "provider_unavailable",
  "rate_limited",
  "quota_exceeded",
  "transient_error",
  // fallback-ineligible (Issue #23): retrying elsewhere will not help
  "auth_error",
  "invalid_model",
  "invalid_configuration",
  "permission_denied",
  "nonzero_exit",
  "runtime_error",
  "invalid_response",
  // the action guardrails refused a command before it ran (Issue #27)
  "guardrail_violation",
  "unknown"
];

/**
 * Error categories the Fallback Policy (Issue #23) treats as eligible
 * for switching model/provider. Declared here so the interface and the
 * future policy share one vocabulary definition.
 *
 * @type {readonly import("./contracts.js").ErrorCategory[]}
 */
export const FALLBACK_ELIGIBLE_ERROR_CATEGORIES = [
  "timeout",
  "provider_unavailable",
  "rate_limited",
  "quota_exceeded",
  "transient_error"
];

/**
 * Validates that an object satisfies the RuntimeAdapter contract.
 * Contract violations are reported, not thrown, so callers can surface
 * every problem of a misconfigured runtime at once.
 *
 * @param {unknown} adapter
 * @returns {string[]}
 */
export function validateRuntimeAdapter(adapter) {
  if (typeof adapter !== "object" || adapter === null || Array.isArray(adapter)) {
    return ["runtime adapter must be an object."];
  }

  const errors = [];

  if (typeof adapter.name !== "string" || adapter.name.trim() === "") {
    errors.push("runtime adapter must declare a non-empty name.");
  }

  if (typeof adapter.executeStep !== "function") {
    errors.push("runtime adapter must implement executeStep(request).");
  }

  if (adapter.capabilities !== undefined) {
    const capabilities = adapter.capabilities;
    if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) {
      errors.push("runtime adapter capabilities must be an object when present.");
    } else {
      if (capabilities.operations !== undefined && (!Array.isArray(capabilities.operations) || capabilities.operations.some((entry) => typeof entry !== "string"))) {
        errors.push("runtime adapter capabilities.operations must be an array of strings.");
      }
      if (capabilities.providers !== undefined && (!Array.isArray(capabilities.providers) || capabilities.providers.some((entry) => typeof entry !== "string"))) {
        errors.push("runtime adapter capabilities.providers must be an array of strings.");
      }
    }
  }

  return errors;
}

/**
 * Adapts a RuntimeAdapter to the StepExecutor Port the Execution Engine
 * consumes. The adapter is validated first: a broken adapter cannot
 * reach `runWorkflow` through this helper.
 *
 * @param {RuntimeAdapter} adapter
 * @returns {StepExecutor}
 */
export function toStepExecutor(adapter) {
  const errors = validateRuntimeAdapter(adapter);
  if (errors.length > 0) {
    throw new Error(`invalid runtime adapter: ${errors.join(" ")}`);
  }
  return adapter.executeStep.bind(adapter);
}

/**
 * Builds the runtime metadata block an adapter attaches to its outcome.
 * Unknown error categories collapse to "unknown" so the recorded
 * vocabulary stays clean, and the adapter name always wins over caller
 * input.
 *
 * @param {{
 *   adapterName: string,
 *   provider?: string,
 *   model?: string,
 *   requestedProvider?: string | null,
 *   requestedModel?: string | null,
 *   requestedTier?: string | null,
 *   resolvedTier?: string | null,
 *   exitCode?: number | null,
 *   errorCategory?: import("./contracts.js").ErrorCategory,
 *   durationMs?: number | null,
 *   sessionId?: string,
 *   escalation?: import("./contracts.js").RuntimeExecutionMetadata["escalation"],
 *   fallback?: import("./contracts.js").RuntimeExecutionMetadata["fallback"]
 * }} metadata
 * @returns {import("./contracts.js").RuntimeExecutionMetadata}
 */
export function buildRuntimeMetadata({
  adapterName,
  provider,
  model,
  requestedProvider,
  requestedModel,
  requestedTier,
  resolvedTier,
  exitCode,
  errorCategory,
  durationMs,
  sessionId,
  escalation,
  fallback
}) {
  const category = RUNTIME_ERROR_CATEGORIES.includes(errorCategory) ? errorCategory : undefined;
  return {
    runtime: adapterName,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(requestedProvider !== undefined ? { requestedProvider } : {}),
    ...(requestedModel !== undefined ? { requestedModel } : {}),
    ...(requestedTier !== undefined ? { requestedTier } : {}),
    ...(resolvedTier !== undefined ? { resolvedTier } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(category !== undefined ? { errorCategory: category } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(escalation !== undefined ? { escalation } : {}),
    ...(fallback !== undefined ? { fallback } : {})
  };
}
