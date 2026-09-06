/**
 * Pure decision helpers for model tiers and escalation policies.
 *
 * The canonical policy lives in the Execution Profile YAML: model_tiers
 * name cost/capability classes (each mapping to a concrete provider and
 * model), assignments give each role a default tier, and model_policy
 * defines the conditional escalation rules and their limit. This module
 * performs no I/O and never mutates its inputs.
 *
 * Escalation is bounded (max_escalations) and does not interact with the
 * token ledger: escalating changes which model runs next, not how much
 * budget has been spent, so workflow budgets keep applying afterwards.
 *
 * Rule matching ranks conditions by specificity — critical_and_low_confidence
 * wins over low_confidence regardless of declaration order — so every
 * declared rule stays reachable (Issue #10's example order would otherwise
 * make the premium rule unreachable).
 *
 * @typedef {import("./contracts.js").EscalationCondition} EscalationCondition
 * @typedef {import("./contracts.js").ModelTier} ModelTier
 * @typedef {import("./contracts.js").ModelPolicy} ModelPolicy
 * @typedef {import("./contracts.js").EscalationLedger} EscalationLedger
 * @typedef {import("./contracts.js").EscalationRecord} EscalationRecord
 * @typedef {import("./contracts.js").EscalationDecision} EscalationDecision
 * @typedef {import("./contracts.js").EscalationExhaustionArtifact} EscalationExhaustionArtifact
 */

/**
 * The conditions an escalation rule may declare, ordered from most to
 * least specific. Runtime matching walks this order.
 *
 * @type {readonly EscalationCondition[]}
 */
export const ESCALATION_CONDITIONS = ["critical_and_low_confidence", "low_confidence"];

/**
 * Resolves a tier name to its concrete provider and model.
 *
 * @param {Readonly<Record<string, ModelTier>> | undefined} tiers
 * @param {string} tierName
 * @returns {ModelTier | undefined}
 */
export function resolveTierModel(tiers, tierName) {
  return tiers?.[tierName];
}

/**
 * Creates an empty escalation ledger.
 *
 * @returns {EscalationLedger}
 */
export function createEscalationLedger() {
  return { records: [] };
}

/**
 * Returns a new ledger with the escalation record appended. The input
 * ledger is not modified. The record list is the single source the
 * runtime attaches to the execution result, which is how escalation
 * reasons get recorded (Issue #10).
 *
 * @param {EscalationLedger} ledger
 * @param {EscalationRecord} record
 * @returns {EscalationLedger}
 */
export function recordEscalation(ledger, record) {
  return { records: [...ledger.records, record] };
}

/**
 * @param {EscalationLedger} ledger
 * @returns {number}
 */
export function escalationCount(ledger) {
  return ledger.records.length;
}

/**
 * Decides whether the current judgment may continue on the same tier, must
 * escalate, or has exhausted its escalations and must stop for the user.
 *
 * confidence "high" means the agent is confident; any other value is read
 * as low confidence. critical is a truthy flag for critical decisions.
 *
 * @param {{
 *   policy: ModelPolicy,
 *   ledger: EscalationLedger,
 *   stepId: string,
 *   currentTier: string,
 *   confidence: string,
 *   critical?: boolean
 * }} options
 * @returns {EscalationDecision}
 */
export function decideEscalation({ policy, ledger, stepId, currentTier, confidence, critical = false }) {
  if (confidence === "high") {
    return {
      action: "keep",
      tier: currentTier,
      reason: "confident judgment; no escalation needed."
    };
  }

  if (escalationCount(ledger) >= policy.max_escalations) {
    return {
      action: "stop",
      reason: `escalation limit of ${policy.max_escalations} has been reached; the workflow stops and returns unresolved items to the user.`
    };
  }

  const lowConfidence = confidence !== "high";

  for (const condition of ESCALATION_CONDITIONS) {
    const matches = condition === "critical_and_low_confidence"
      ? lowConfidence && Boolean(critical)
      : lowConfidence;
    const rule = policy.escalation.find((candidate) => candidate.when === condition);

    if (!rule || !matches) continue;

    return {
      action: "escalate",
      tier: rule.tier,
      reason: `condition "${condition}" matched.`,
      record: { step: stepId, from: currentTier, to: rule.tier, reason: condition }
    };
  }

  return {
    action: "keep",
    tier: currentTier,
    reason: "no escalation rule matches the current judgment."
  };
}

/**
 * Builds the artifact returned to the user when the escalation limit is
 * reached without a confident judgment — the end of the Issue #10 flow
 * (Premium → それでも解決不能 → Human).
 *
 * @param {{
 *   workflowName: string,
 *   stepId: string,
 *   ledger: EscalationLedger,
 *   policy: ModelPolicy,
 *   unresolved: readonly string[]
 * }} options
 * @returns {EscalationExhaustionArtifact}
 */
export function buildEscalationExhaustionArtifact({ workflowName, stepId, ledger, policy, unresolved }) {
  const used = escalationCount(ledger);

  return {
    type: "escalation_exhausted",
    workflow: workflowName,
    step: stepId,
    escalations_used: used,
    max_escalations: policy.max_escalations,
    records: [...ledger.records],
    unresolved: [...unresolved],
    message: [
      `Workflow "${workflowName}" はステップ "${stepId}" でエスカレーション上限（${used}/${policy.max_escalations}）に達しても確信できる判断に至りませんでした。`,
      `移動履歴: ${ledger.records.map((record) => `${record.step}:${record.from}→${record.to}(${record.reason})`).join("、") || "なし"}。`,
      `未解決事項: ${unresolved.join("、") || "なし"}。`,
      "利用者が判断してください。続行する場合は条件の見直しまたは上位モデルでの再実行を検討してください。"
    ].join("")
  };
}
