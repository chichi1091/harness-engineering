/**
 * Escalation Runtime Adapter (Issue #10 / Roadmap AC "escalation
 * tracking"): a decorator over the Runtime Adapter Interface (#31),
 * mirroring the Fallback Runtime Adapter (#23) — but for CAPABILITY,
 * not availability:
 *
 *   Retry      same model/tier/provider, later attempt (Execution Loop)
 *   Fallback   provider/model switched after an eligible FAILURE (#23)
 *   Escalation tier RAISED when the runtime reports LOW CONFIDENCE
 *              (the existing policy in model-tier.js decides)
 *
 * The judgment reuses model-tier.js as-is: decideEscalation with its
 * canonical conditions (low_confidence / critical_and_low_confidence),
 * recordEscalation for the trail, and buildEscalationExhaustionArtifact
 * for the end of the Issue #10 flow (Premium → それでも解決不能 →
 * Human). Nothing here invents a new condition.
 *
 * The trigger is the runtime's own `confidence` report in the outcome
 * metadata. An outcome that reports no confidence is returned unchanged
 * — the policy is never evaluated on a guess, which keeps every
 * existing execution behaviour identical.
 *
 * Loop protection:
 * - decideEscalation enforces the policy's max_escalations
 * - a rule tier that does not resolve in model_tiers is skipped (never
 *   escalate into a nonexistent tier)
 * - a local iteration bound backs the policy bound up structurally
 *
 * Boundaries that cannot be bypassed:
 * - the delegate factory is caller-supplied, so every tier candidate is
 *   composed by the caller with the SAME guardrails / permissions /
 *   fallback chain — escalation changes which MODEL runs next, nothing
 *   else about the execution environment
 * - a guardrail refusal carries no confidence report, so it can never
 *   trigger (or be escaped through) an escalation
 *
 * To the Execution Engine this is just another executeStep.
 *
 * @typedef {import("./contracts.js").RuntimeAdapter} RuntimeAdapter
 */

import { buildRuntimeMetadata } from "./runtime-adapter.js";
import {
  createEscalationLedger,
  decideEscalation,
  recordEscalation,
  buildEscalationExhaustionArtifact
} from "../execution/model-tier.js";

/**
 * @param {{
 *   name?: string,
 *   policy: {
 *     /** The role's current tier name (assignments[role].tier). *
 *     tier: string,
 *     /** The profile's model_tiers: tier name → { provider, model }. *
 *     tiers: Record<string, { provider: string, model: string }>,
 *     /** The profile's model_policy: { escalation: [...], max_escalations }. *
 *     modelPolicy: { escalation: readonly { when: string, tier: string }[], max_escalations: number },
 *     /** The workflow name and step gate context for the exhaustion artifact. *
 *     workflowName?: string
 *   },
 *   createDelegate: (candidate: { tier: string, provider: string, model: string }) => RuntimeAdapter
 * }} options
 * @returns {RuntimeAdapter}
 */
export function createEscalationRuntimeAdapter({ name = "escalation", policy, createDelegate }) {
  if (typeof policy?.tier !== "string" || policy.tier === "") {
    throw new Error("escalation runtime adapter requires a current tier name.");
  }
  if (typeof policy?.tiers !== "object" || policy.tiers === null) {
    throw new Error("escalation runtime adapter requires the profile's model_tiers.");
  }
  if (typeof policy?.modelPolicy !== "object" || policy.modelPolicy === null || !Array.isArray(policy.modelPolicy.escalation)) {
    throw new Error("escalation runtime adapter requires the profile's model_policy.");
  }
  if (typeof createDelegate !== "function") {
    throw new Error("escalation runtime adapter requires a createDelegate(candidate) factory.");
  }

  const escalationLedger = createEscalationLedger();
  const iterationBound = (policy.modelPolicy.max_escalations ?? 0) + 2;

  /** Merges the escalation trail into the final outcome's metadata. */
  function withEscalationMetadata(outcome, { fromTier, toTier, reason }) {
    const previous = typeof outcome.runtime === "object" && outcome.runtime !== null ? outcome.runtime : {};
    return {
      ...outcome,
      runtime: buildRuntimeMetadata({
        ...previous,
        adapterName: name,
        escalation: {
          escalated: true,
          fromTier,
          toTier,
          reason
        }
      })
    };
  }

  return {
    name,
    capabilities: {
      operations: ["execute-step", "escalation"],
      tiers: [policy.tier, ...policy.modelPolicy.escalation.map((rule) => rule.tier)]
    },

    async executeStep(request) {
      let currentTier = policy.tier;
      let ledger = escalationLedger;
      let lastOutcome = null;
      /** The escalation trail of THIS executeStep call, re-merged onto
       *  whichever outcome ends up being returned. */
      let escalationReport = null;

      function finalize(outcome) {
        if (escalationReport === null || outcome === null) return outcome;
        return withEscalationMetadata(outcome, escalationReport);
      }

      for (let iteration = 0; iteration < iterationBound; iteration += 1) {
        const tierModel = policy.tiers[currentTier];
        if (tierModel === undefined) {
          // Current tier does not resolve (profile gap): return whatever
          // the last attempt produced, or a plain failure — never invent
          // a tier.
          return finalize(lastOutcome) ?? { status: "failed", failure: { reason: `tier "${currentTier}" is not defined in the profile's model_tiers.`, unresolved: [] } };
        }

        const delegate = createDelegate({ tier: currentTier, provider: tierModel.provider, model: tierModel.model });
        if (typeof delegate?.executeStep !== "function") {
          throw new Error(`delegate for tier "${currentTier}" does not implement executeStep.`);
        }

        lastOutcome = await delegate.executeStep(request);
        const reported = lastOutcome.runtime?.confidence;

        // No confidence report → the escalation policy is not evaluated.
        // Every existing execution is identical to before this adapter.
        if (typeof reported !== "string") {
          return finalize(lastOutcome);
        }
        if (reported === "high") {
          return finalize(lastOutcome);
        }

        const decision = decideEscalation({
          policy: policy.modelPolicy,
          ledger,
          stepId: request.stepId,
          currentTier,
          confidence: reported,
          critical: lastOutcome.runtime?.critical === true
        });

        if (decision.action === "keep") {
          return finalize(lastOutcome);
        }

        if (decision.action === "stop") {
          // Escalation limit reached without a confident judgment: the
          // end of the Issue #10 flow — return to the user (existing
          // Failure Result path of the Execution Loop).
          const artifact = buildEscalationExhaustionArtifact({
            workflowName: policy.workflowName ?? request.workflowName ?? "<unknown workflow>",
            stepId: request.stepId,
            ledger,
            policy: policy.modelPolicy,
            unresolved: [
              decision.reason,
              ...(Array.isArray(lastOutcome.failure?.unresolved) ? lastOutcome.failure.unresolved : [])
            ]
          });
          return {
            status: "failed",
            failure: {
              reason: artifact.message,
              severities: undefined,
              unresolved: artifact.unresolved
            },
            artifacts: [artifact],
            tokensSpent: lastOutcome.tokensSpent ?? 0,
            runtime: lastOutcome.runtime
          };
        }

        // escalate — but never into a tier the profile does not define.
        if (policy.tiers[decision.tier] === undefined) {
          return finalize(lastOutcome);
        }

        ledger = recordEscalation(ledger, decision.record);
        escalationReport = {
          fromTier: currentTier,
          toTier: decision.tier,
          reason: decision.record.reason
        };
        currentTier = decision.tier;
        // Loop: re-execute the same request on the higher tier, then the
        // new outcome's confidence is judged again.
      }

      // Structurally unreachable: decideEscalation stops at
      // max_escalations and the bound is max_escalations + 2.
      return finalize(lastOutcome) ?? { status: "failed", failure: { reason: "escalation bound exceeded.", unresolved: [] } };
    }
  };
}
