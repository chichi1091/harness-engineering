/**
 * Fallback Runtime Adapter (Issue #23): a decorator over the Runtime
 * Adapter Interface (#31) that retries a failed step on the next
 * candidate provider/model — but ONLY for fallback-eligible failures
 * (temporary provider unavailability). It changes nothing about the
 * Execution Loop: to the engine this is just another executeStep.
 *
 *     Execution Engine
 *       → this adapter (candidate plan, eligibility check, tracking)
 *         → createDelegate({ provider, model }) → candidate adapter
 *           → (Guarded Command Runner #27 → opencode CLI …)
 *
 * Boundaries that cannot be bypassed:
 * - the delegate factory is caller-supplied, so the caller composes
 *   every candidate adapter with the SAME Guarded Command Runner and
 *   action policy — switching providers never weakens the guardrails,
 *   and a guardrail refusal (guardrail_violation) is never
 *   fallback-eligible, so it can never be escaped by switching
 * - candidates are consumed forward from a finite, duplicate-free plan;
 *   cycles (A → B → A) are structurally impossible
 *
 * @typedef {import("./contracts.js").RuntimeAdapter} RuntimeAdapter
 * @typedef {import("../execution/fallback-policy.js").FallbackPolicy} FallbackPolicy
 */

import { FALLBACK_ELIGIBLE_ERROR_CATEGORIES, buildRuntimeMetadata } from "./runtime-adapter.js";
import { planFallbacks, validateFallbackPolicy } from "../execution/fallback-policy.js";

/**
 * @param {{
 *   name?: string,
 *   policy: FallbackPolicy,
 *   createDelegate: (candidate: { provider: string, model: string }) => RuntimeAdapter
 * }} options
 * @returns {RuntimeAdapter & { candidates: readonly { provider: string, model: string }[] }}
 */
export function createFallbackRuntimeAdapter({ name = "fallback", policy, createDelegate }) {
  const errors = validateFallbackPolicy(policy);
  if (errors.length > 0) {
    throw new Error(`invalid fallback policy: ${errors.join(" ")}`);
  }
  if (typeof createDelegate !== "function") {
    throw new Error("fallback runtime adapter requires a createDelegate(candidate) factory.");
  }

  const plan = planFallbacks(policy);

  function candidateAdapter(candidate) {
    const delegate = createDelegate(candidate);
    if (typeof delegate?.executeStep !== "function") {
      throw new Error(`delegate for ${candidate.provider}/${candidate.model} does not implement executeStep.`);
    }
    return delegate;
  }

  /** Reports the full fallback trail on the final outcome's metadata. */
  function withFallbackMetadata(outcome, { candidate, attemptsMade, lastEligibleCategory, primary }) {
    const previous = typeof outcome.runtime === "object" && outcome.runtime !== null ? outcome.runtime : {};
    const count = attemptsMade.length - 1;
    const fallback = count > 0 || attemptsMade.length > 1
      ? {
          fromProvider: primary.provider,
          fromModel: primary.model,
          toProvider: candidate.provider,
          toModel: candidate.model,
          reason: lastEligibleCategory ?? "unknown",
          count,
          attempts: attemptsMade.map((attempt) => ({ ...attempt }))
        }
      : previous.fallback ?? null;

    return {
      ...outcome,
      runtime: buildRuntimeMetadata({
        ...previous,
        adapterName: name,
        fallbackCount: count,
        fallbackReason: count > 0 ? lastEligibleCategory ?? "unknown" : undefined,
        fallbackChain: attemptsMade.map((attempt) => ({ ...attempt })),
        fallback
      })
    };
  }

  return {
    name,
    capabilities: {
      operations: ["execute-step", "fallback"],
      providers: plan.candidates.map((candidate) => candidate.provider)
    },

    /** Exposed for contract tests and tracking consumers. */
    candidates: plan.candidates,

    async executeStep(request) {
      /** @type {{ provider: string, model: string, status: string, errorCategory: string | null }[]} */
      const attemptsMade = [];
      let lastOutcome = null;
      let lastEligibleCategory = null;

      for (const candidate of [plan.primary, ...plan.candidates]) {
        const delegate = candidateAdapter(candidate);
        const outcome = await delegate.executeStep(request);

        attemptsMade.push({
          provider: candidate.provider,
          model: candidate.model,
          status: outcome.status,
          errorCategory: outcome.runtime?.errorCategory ?? null
        });

        if (outcome.status === "succeeded") {
          return withFallbackMetadata(outcome, { candidate, attemptsMade, lastEligibleCategory, primary: plan.primary });
        }

        lastOutcome = outcome;
        const eligible = FALLBACK_ELIGIBLE_ERROR_CATEGORIES.includes(outcome.runtime?.errorCategory);
        if (!eligible) {
          // Not the kind of failure a provider switch can fix (code
          // failure, guardrail refusal, auth error, harness error …):
          // return it as-is. The Execution Loop's own rules decide.
          return withFallbackMetadata(outcome, { candidate, attemptsMade, lastEligibleCategory: null, primary: plan.primary });
        }

        lastEligibleCategory = outcome.runtime.errorCategory;
        // eligible → consume the next candidate and retry
      }

      // Every candidate failed with an eligible category: report the
      // last failure with the full fallback trail for tracking.
      const finalOutcome = lastOutcome ?? { status: "failed", failure: { reason: "all fallback candidates failed.", unresolved: [] } };
      return withFallbackMetadata(finalOutcome, {
        candidate: plan.candidates[plan.candidates.length - 1] ?? plan.primary,
        attemptsMade,
        lastEligibleCategory,
        primary: plan.primary
      });
    }
  };
}
