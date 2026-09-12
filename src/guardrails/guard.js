/**
 * Enforcement entry point: judge an action and shape refusals for the
 * Execution Loop.
 *
 * The guard composes the two existing safety layers instead of
 * duplicating them:
 * - Issue #6's permission model (role declaration crossed with the
 *   profile mode, never widened) governs the filesystem surface
 * - the declarative action policy (deny-by-default) governs shell, git,
 *   network, external, secrets, and destructive operations
 *
 * A refusal becomes an ActionViolation plus a StepFailure-shaped object:
 * the step runtime returns it as `outcome.failure`, and the existing
 * on_failure / retry circuitry of runWorkflow treats the step exactly
 * like any other failure. No Execution Engine changes were needed.
 *
 * Runtime adapters (OpenCode etc.) are the intended consumers of the
 * allow decision and the failure shape — the model itself stays
 * runtime-independent.
 *
 * @typedef {import("./contracts.js").ActionEnforcement} ActionEnforcement
 * @typedef {import("./contracts.js").ActionPolicy} ActionPolicy
 * @typedef {import("./contracts.js").ActionRequest} ActionRequest
 * @typedef {import("./contracts.js").ActionViolation} ActionViolation
 * @typedef {import("../permission/contracts.js").Permissions} Permissions
 * @typedef {import("../permission/contracts.js").ProfileMode} ProfileMode
 */

import { decideAction } from "./action-decision.js";
import { resolveEffectivePermissions } from "../permission/permissions.js";

/**
 * @param {{
 *   policy: ActionPolicy,
 *   permissions: Permissions,
 *   profileMode?: ProfileMode,
 *   action: ActionRequest,
 *   approvals?: readonly string[]
 * }} options
 * @returns {ActionEnforcement}
 */
export function enforceAction({ policy, permissions, profileMode, action, approvals = [] }) {
  const effectivePermissions = resolveEffectivePermissions(permissions, profileMode);
  const decision = decideAction({ policy, permissions: effectivePermissions, action, approvals });

  if (decision.decision === "allow") {
    return { decision: "allow", reason: decision.reason, violation: null, failure: null };
  }

  const violation = {
    code: decision.code,
    kind: action.kind,
    operation: action.operation,
    ...(action.target !== undefined ? { target: action.target } : {}),
    ...(decision.approvable !== undefined ? { approvable: decision.approvable } : {}),
    reason: decision.reason
  };

  return {
    decision: decision.decision,
    reason: decision.reason,
    violation,
    failure: buildActionViolationFailure(violation)
  };
}

/**
 * Builds the StepFailure a refusing runtime returns to the Execution
 * Loop. Deliberately carries no severities: policies that declare
 * retry_on judge an unclassifiable refusal as non-retryable, and simply
 * retrying the same refused action would loop pointlessly — the failure
 * text tells the repair round what to change instead.
 *
 * @param {ActionViolation} violation
 * @returns {import("../execution/contracts.js").StepFailure}
 */
export function buildActionViolationFailure(violation) {
  const targetText = violation.target ? ` (target: ${violation.target})` : "";
  const unresolved = violation.approvable !== undefined
    ? [
        `操作 ${violation.kind}.${violation.operation}${targetText} には人間の承認が必要です。承認トークン: "${violation.approvable}"。`,
        "承認を得られない場合は、この操作を使わない別の手段でタスクを続行してください。"
      ]
    : [
        `操作 ${violation.kind}.${violation.operation}${targetText} はPolicyにより拒否されました（${violation.reason}）。`,
        "Policyの宣言を見直すか、この操作を必要としない別の手段で続行してください。同じ操作の再試行は再度拒否されます。"
      ];

  return {
    reason: `Action guardrail violation (${violation.code}): ${violation.kind}.${violation.operation}${targetText} — ${violation.reason}`,
    unresolved
  };
}
