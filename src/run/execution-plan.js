/**
 * Execution Plan (Issue #34): the decision-only intermediate
 * representation between "what the user wants" and "what will run".
 *
 *   Goal → Decision Engine → Execution Plan → (human approval) → Execution
 *
 * A plan is built purely from the Decision outcome plus configuration
 * (workflow definition, profile, policies, verification gates). It
 * carries NO side effects: building a plan never touches the
 * filesystem, spawns nothing, calls no model — it only reads the
 * configuration handed to it and hashes the result.
 *
 * Plan → Run contract:
 * - `planHash` covers the execution-relevant content only (task,
 *   workflow, steps, models, runtime, policies, verification).
 *   Bookkeeping fields (createdAt / approved / approvedAt) are excluded,
 *   so approving a plan does not invalidate its hash.
 * - `harness run --plan` verifies the hash before executing: a tampered
 *   or diverging plan is refused instead of silently re-executed.
 * - Models in a plan are marked `planned: true`. Actual provider/model
 *   resolution is tracked at execution time by Model Execution Tracking
 *   (#22) — the plan never claims to be a result.
 *
 * @typedef {import("./contracts.js").ExecutionPlan} ExecutionPlan
 */

import { createHash } from "node:crypto";
import { validateArtifact } from "../artifacts/artifact-schemas.js";

export const PLAN_VERSION = 1;

/** The artifact type a persisted plan is stored under (#29). */
export const EXECUTION_PLAN_ARTIFACT_TYPE = "execution-plan";

/**
 * Builds an execution plan from the Decision outcome and configuration.
 * Pure: reads only the supplied objects and hashes the result.
 *
 * @param {{
 *   goal: string,
 *   intent: string,
 *   risk?: string,
 *   workflow: Record<string, unknown>,
 *   profile?: Record<string, unknown> | null,
 *   runtimeName?: string,
 *   fallbackCandidates?: readonly { provider: string, model: string }[],
 *   guardrailsSummary?: Record<string, string> | null,
 *   verification?: { stepId?: string, gates?: readonly string[] } | null,
 *   now?: string
 * }} options
 * @returns {ExecutionPlan}
 */
export function createExecutionPlan({
  goal,
  intent,
  risk,
  workflow,
  profile = null,
  runtimeName = "mock",
  fallbackCandidates = [],
  guardrailsSummary = null,
  verification = null,
  now
}) {
  const steps = (Array.isArray(workflow.steps) ? workflow.steps : []).map((step, index, all) => ({
    stepId: step.id,
    role: resolveRole(step.agent),
    agent: step.agent,
    purpose: step.gate,
    tokenBudget: step.token_budget ?? null,
    dependencies: index === 0 ? [] : [all[index - 1].id]
  }));

  const tokenBudget = {
    total: workflow.budget?.max_total_tokens ?? null,
    perStep: Object.fromEntries(
      steps
        .filter((step) => step.tokenBudget !== null)
        .map((step) => [step.stepId, step.tokenBudget])
    )
  };

  const retryPolicies = Object.fromEntries(
    (Array.isArray(workflow.steps) ? workflow.steps : [])
      .filter((step) => step.retry_policy !== undefined)
      .map((step) => [step.id, step.retry_policy.max_attempts])
  );

  const models = planModelsForSteps(workflow, profile);
  const fallback = planFallbackPolicy(fallbackCandidates);

  /** The content the hash covers: everything execution-relevant. */
  const content = {
    task: { goal, intent, risk: risk ?? "high" },
    runtime: runtimeName,
    workflow: { name: workflow.name, purpose: workflow.purpose ?? null },
    steps,
    models,
    tokenBudget,
    retryPolicies,
    fallbackPolicy: fallback,
    guardrailsSummary,
    verification: verification ?? null
  };

  const planHash = computePlanHash(content);
  const planId = `plan-${planHash.slice(0, 12)}`;

  return {
    planId,
    planVersion: PLAN_VERSION,
    planHash,
    createdAt: now ?? new Date().toISOString(),
    approved: false,
    ...content
  };
}

/**
 * Recomputes the hash of a plan's execution-relevant content and
 * compares it with the stored `planHash`. Detects any divergence
 * between the approved plan and the plan handed to the runner.
 *
 * @param {ExecutionPlan} plan
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function verifyPlanIntegrity(plan) {
  const errors = [];
  if (typeof plan?.planHash !== "string" || plan.planHash === "") {
    return { valid: false, errors: ["plan has no planHash to verify."] };
  }
  if (plan.approved !== true) {
    errors.push("plan is not approved (approved: true is required).");
  }
  if (typeof plan.workflow?.name !== "string" || plan.workflow.name.trim() === "") {
    errors.push("plan does not name a workflow.");
  }

  const recomputed = computePlanHash(plan);
  if (recomputed !== plan.planHash) {
    errors.push(`plan hash mismatch: approved "${plan.planHash}" but content hashes to "${recomputed}". The plan was modified after approval; re-plan and re-approve.`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Returns a new plan with the human approval recorded. The execution
 * content — and therefore the plan hash — is unchanged.
 *
 * @param {ExecutionPlan} plan
 * @param {{ approvedBy?: string, now?: string }} [options]
 * @returns {ExecutionPlan}
 */
export function approvePlan(plan, { approvedBy, now } = {}) {
  return {
    ...plan,
    approved: true,
    ...(approvedBy !== undefined ? { approvedBy } : {}),
    ...(now !== undefined ? { approvedAt: now } : {})
  };
}

/**
 * Wraps a plan as a common-schema artifact (#29) under the registered
 * `execution-plan` type.
 *
 * @param {ExecutionPlan} plan
 * @returns {object}
 */
export function toExecutionPlanArtifact(plan) {
  return {
    type: EXECUTION_PLAN_ARTIFACT_TYPE,
    produced_by: "harness",
    unresolved: [],
    planId: plan.planId,
    workflow: plan.workflow.name,
    status: plan.approved ? "approved" : "draft",
    plan
  };
}

/**
 * Canonical (sorted-key) JSON serialization for hashing.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * @param {Record<string, unknown>} content
 * @returns {string} sha256 hex digest over the execution-relevant
 * content only — bookkeeping fields (planHash, createdAt, approval) are
 * excluded so that approving a plan does not change its hash.
 */
export function computePlanHash(content) {
  const {
    planHash, planVersion, planId,
    createdAt, approved, approvedAt, approvedBy,
    ...executionContent
  } = content;
  return createHash("sha256").update(canonicalJson(executionContent)).digest("hex");
}

function planModelsForSteps(workflow, profile) {
  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  const models = [];

  for (const step of steps) {
    const role = resolveRole(step.agent);
    if (role === null) continue;
    const assignment = profile?.assignments?.[role];
    let tier = null;
    let provider = null;
    let model = null;

    if (typeof assignment === "object" && assignment !== null) {
      if (typeof assignment.tier === "string") {
        tier = assignment.tier;
        const resolved = profile?.model_tiers?.[assignment.tier];
        if (typeof resolved === "object" && resolved !== null) {
          provider = resolved.provider ?? null;
          model = resolved.model ?? null;
        }
      }
      if (typeof assignment.provider === "string" && typeof assignment.model === "string") {
        provider = assignment.provider;
        model = assignment.model;
      }
    }

    // Planned/requested only: actual resolution is tracked by #22 at
    // execution time. Roles without a profile assignment are reported
    // as unassigned rather than guessed.
    models.push({ role, provider, model, tier, planned: true });
  }

  return models;
}

function planFallbackPolicy(fallbackCandidates) {
  if (!Array.isArray(fallbackCandidates) || fallbackCandidates.length === 0) {
    return null;
  }
  return {
    candidates: fallbackCandidates.map((candidate) => `${candidate.provider}/${candidate.model}`),
    maxFallbacks: fallbackCandidates.length
  };
}

function resolveRole(agentPath) {
  if (typeof agentPath !== "string" || agentPath.trim() === "") return null;
  const role = agentPath.replace(/^.*[\\/]/, "").replace(/\.ya?ml$/, "").trim();
  return role === "" ? null : role;
}
