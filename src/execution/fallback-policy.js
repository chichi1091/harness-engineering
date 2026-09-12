/**
 * Fallback Policy (Issue #23): recovery when a provider/model is
 * temporarily unavailable — NOT a model switch for poor implementation
 * quality (that belongs to the Execution Loop's retry / on_failure).
 *
 * Separation of concerns:
 * - Retry (#21, engine): re-run the step on the SAME runtime/provider/model
 * - Fallback (this module + the fallback runtime adapter): switch to the
 *   next candidate provider/model when the failure is fallback-eligible
 * - Escalation (#10 reserved shapes): tier switching, reported but not
 *   decided here
 *
 * Eligibility reuses the vocabulary the Runtime Adapter Interface (#31)
 * shares with this policy (FALLBACK_ELIGIBLE_ERROR_CATEGORIES): only
 * temporary provider/model unavailability qualifies. Authentication
 * errors, invalid models/configuration, permission errors, harness
 * errors, and guardrail violations NEVER fall back — a policy refusal
 * must not be escapable by switching providers.
 *
 * Loop prevention is structural: candidates form a finite, ordered,
 * duplicate-free list derived from the policy and truncated by
 * maxFallbacks. A fallback can only move forward through that list, so
 * cycles (A → B → A) are impossible by construction.
 *
 * @typedef {import("./contracts.js").FallbackPolicy} FallbackPolicy
 * @typedef {import("./contracts.js").FallbackCandidate} FallbackCandidate
 */

import { FALLBACK_ELIGIBLE_ERROR_CATEGORIES } from "../runtimes/runtime-adapter.js";

/**
 * Validates a fallback policy declaration:
 * - `primary` is required (provider + model)
 * - `fallbacks` is an ordered list of distinct provider/model candidates
 * - duplicate candidates are rejected (they would be circular)
 * - `maxFallbacks` optionally caps the candidate list (positive integer)
 *
 * @param {unknown} policy
 * @returns {string[]}
 */
export function validateFallbackPolicy(policy) {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    return ["fallback policy must be an object."];
  }

  const errors = [];

  if (!isCandidate(policy.primary)) {
    errors.push("fallback policy.primary must declare a non-empty provider and model.");
  }

  if (policy.fallbacks !== undefined) {
    if (!Array.isArray(policy.fallbacks)) {
      errors.push("fallback policy.fallbacks must be an array.");
    } else {
      const seen = new Set();
      if (isCandidate(policy.primary)) {
        seen.add(candidateKey(policy.primary));
      }
      policy.fallbacks.forEach((candidate, index) => {
        if (!isCandidate(candidate)) {
          errors.push(`fallback policy.fallbacks[${index}] must declare a non-empty provider and model.`);
          return;
        }
        const key = candidateKey(candidate);
        if (seen.has(key)) {
          errors.push(`fallback policy.fallbacks[${index}] duplicates candidate "${key}"; candidates must be distinct to prevent cycles.`);
        }
        seen.add(key);
      });
    }
  }

  if (policy.maxFallbacks !== undefined && (typeof policy.maxFallbacks !== "number" || !Number.isInteger(policy.maxFallbacks) || policy.maxFallbacks < 1)) {
    errors.push("fallback policy.maxFallbacks must be an integer greater than or equal to 1.");
  }

  return errors;
}

/**
 * Computes the execution plan: the primary followed by the distinct
 * fallback candidates, truncated to maxFallbacks (which also bounds the
 * loop). Plan once, then consume forward — no cycles possible.
 *
 * @param {FallbackPolicy} policy
 * @returns {{ primary: FallbackCandidate, candidates: readonly FallbackCandidate[], maxFallbacks: number }}
 */
export function planFallbacks(policy) {
  const primary = policy.primary;
  const allFallbacks = Array.isArray(policy.fallbacks) ? policy.fallbacks : [];
  const maxFallbacks = policy.maxFallbacks !== undefined ? policy.maxFallbacks : allFallbacks.length;
  const candidates = allFallbacks.slice(0, maxFallbacks);
  return { primary, candidates, maxFallbacks: candidates.length };
}

/**
 * Whether a failed outcome qualifies for a provider/model fallback:
 * only when the adapter reported a fallback-eligible error category
 * (temporary unavailability). Anything unclassified, a code failure, or
 * a guardrail refusal does not qualify.
 *
 * @param {import("./contracts.js").StepExecutionOutcome} outcome
 * @returns {boolean}
 */
export function isFallbackEligible(outcome) {
  const category = outcome?.runtime?.errorCategory;
  return typeof category === "string" && FALLBACK_ELIGIBLE_ERROR_CATEGORIES.includes(category);
}

/**
 * Decides the next move after a failed candidate attempt.
 *
 * @param {{
 *   plan: ReturnType<typeof planFallbacks>,
 *   attemptsMade: readonly { provider: string, model: string, status: string, errorCategory: string | null }[],
 *   outcome: import("./contracts.js").StepExecutionOutcome
 * }} options
 * @returns {{ action: "try-next" | "stop", nextCandidate?: FallbackCandidate, reason: string }}
 */
export function decideNextCandidate({ plan, attemptsMade, outcome }) {
  if (outcome.status === "succeeded") {
    return { action: "stop", reason: "the execution succeeded." };
  }

  if (!isFallbackEligible(outcome)) {
    return {
      action: "stop",
      reason: `error category "${outcome.runtime?.errorCategory ?? "unknown"}" is not fallback-eligible; the failure is returned as-is.`
    };
  }

  if (attemptsMade.length >= plan.candidates.length + 1) {
    return { action: "stop", reason: "all fallback candidates are exhausted." };
  }

  const nextCandidate = plan.candidates[attemptsMade.length - 1];
  if (nextCandidate === undefined) {
    return { action: "stop", reason: "all fallback candidates are exhausted." };
  }
  return { action: "try-next", nextCandidate, reason: `the failure is fallback-eligible; switching to ${nextCandidate.provider}/${nextCandidate.model}.` };
}

function isCandidate(candidate) {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.provider === "string" &&
    candidate.provider.trim() !== "" &&
    typeof candidate.model === "string" &&
    candidate.model.trim() !== ""
  );
}

function candidateKey(candidate) {
  return `${candidate.provider}/${candidate.model}`;
}
