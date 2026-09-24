/**
 * Improvement Proposal generation (Issue #39).
 *
 * The boundary this module enforces:
 *
 *   Failure Pattern → Proposal (proposed) → Human Review → Human does
 *   the change through the existing flow (branch → PR → CI → merge)
 *
 * This module is a proposal GENERATOR, not a harness mutator. It never
 * writes to AGENTS.md, agents/, workflows/, skills/ or the profile
 * action policies — it only stores proposal artifacts in the Artifact
 * Store and lets humans read, approve or reject them. Approving a
 * proposal changes the proposal's status field and NOTHING else; the
 * canonical change stays with the human's own PR.
 *
 * - Deterministic mapping from pattern to proposal target (no LLM):
 *   guardrail_violation → guardrail candidate (#27 vocabulary),
 *   test-engineer failures → skill candidate (#30 vocabulary),
 *   everything else → AGENTS.md candidate.
 * - Duplicate control: the proposal id is derived from the pattern
 *   fingerprint, so the same pattern can only ever store one proposal —
 *   a second detection returns the existing one unchanged.
 * - Evidence references the Execution History by executionId (plus the
 *   redacted reason for readability) — the history itself is never
 *   copied into a second store.
 */

import { saveArtifact, findArtifactsByType, getArtifact } from "../artifacts/artifact-store.js";
import { redactSecrets } from "../execution/model-execution-tracking.js";

export const PROPOSAL_STATUSES = ["proposed", "approved", "rejected"];

export const PROPOSAL_TARGETS = ["AGENTS.md", "skill", "guardrail"];

/**
 * Deterministic target mapping. The error-category vocabulary decides:
 * a guardrail refusal is a guardrail gap, a test-engineer failure is a
 * procedure gap, anything else is a rule gap.
 *
 * @param {{ errorCategory: string | null, agent: string | null }} fields
 * @returns {"AGENTS.md" | "skill" | "guardrail"}
 */
export function proposalTargetOf(fields) {
  if (fields.errorCategory === "guardrail_violation") return "guardrail";
  if (fields.agent === "test-engineer") return "skill";
  return "AGENTS.md";
}

/**
 * Builds the proposal artifact for one pattern. The suggestion text is
 * assembled from recorded facts and fixed templates ONLY — free-text
 * failure reasons and other untrusted input never become part of the
 * suggestion wording.
 *
 * @param {import("./failure-patterns.js").FailurePattern} pattern
 * @param {{ threshold: number, now?: string }} options
 * @returns {{ type: "improvement-proposal", produced_by: string, unresolved: string[], proposalId: string, status: string, target: string, fingerprint: string, pattern: object, threshold: number, occurrences: number, evidence: object[], suggestion: object, createdAt: string }}
 */
export function buildProposalArtifact(pattern, { threshold, now = new Date().toISOString() }) {
  const target = proposalTargetOf(pattern.fields);
  return {
    type: "improvement-proposal",
    produced_by: "harness",
    unresolved: [],
    proposalId: `fp-${pattern.fingerprint}`,
    status: "proposed",
    target,
    fingerprint: pattern.fingerprint,
    pattern: { ...pattern.fields },
    threshold,
    occurrences: pattern.occurrences,
    evidence: pattern.evidence.map((entry) => ({
      executionId: entry.executionId,
      occurredAt: entry.occurredAt ?? null,
      stepId: entry.stepId,
      attempt: entry.attempt,
      errorCategory: entry.errorCategory ?? null,
      failureReason: redactSecrets(entry.failureReason ?? null)
    })),
    suggestion: buildSuggestion(target, pattern),
    createdAt: now
  };
}

/**
 * Fixed-template suggestion per target, aligned with the canonical
 * vocabularies: #27 action policy (guardrail), #30 skill metadata
 * (skill), AGENTS.md free prose (rules).
 */
function buildSuggestion(target, pattern) {
  const { workflow, stepId, agent, errorCategory } = pattern.fields;
  if (target === "guardrail") {
    return {
      trigger: `repeated ${errorCategory} refusals in workflow "${workflow}" at step "${stepId}"`,
      suggestedAction: "deny",
      reason: `The same refusal occurred ${pattern.occurrences} time(s). Review whether this operation should be denied explicitly in the profile action_policy.`
    };
  }
  if (target === "skill") {
    return {
      suggestedName: `${sanitizeId(stepId ?? "step")}-procedure`,
      purpose: `Captures the procedure for the "${stepId}" step performed by "${agent}" so repeated failures (${errorCategory}, ${pattern.occurrences} time(s)) are less likely.`,
      suggestedSteps: [
        "Review the failing step's gate and outputs",
        "Record the verification commands the step must pass",
        "Document the failure handling in a reusable procedure"
      ],
      appliesTo: { steps: [stepId ?? null].filter((value) => value !== null) }
    };
  }
  return {
    reason: `The same failure occurred ${pattern.occurrences} time(s): workflow "${workflow}", step "${stepId}", role "${agent}", error category "${errorCategory}".`,
    suggestedRule: `Add a rule to AGENTS.md that tells agents how to avoid repeating this failure pattern (workflow ${workflow ?? "(unrecorded)"}, step ${stepId ?? "(unrecorded)"}, error ${errorCategory ?? "(unrecorded)"}).`
  };
}

/**
 * Generates (or reuses) proposals for the given patterns. Idempotent:
 * a pattern whose proposal already exists is reported as "existing"
 * and left completely untouched — no second artifact, no status change.
 *
 * @param {import("../artifacts/contracts.js").ArtifactStore} feedbackStore
 * @param {import("./failure-patterns.js").FailurePattern[]} patterns
 * @param {{ threshold: number, now?: string }} options
 * @returns {Promise<{ proposalId: string, target: string, status: string, occurrences: number, stored: "created" | "existing", proposal: object }[]>}
 */
export async function generateImprovementProposals(feedbackStore, patterns, { threshold, now } = {}) {
  const results = [];
  for (const pattern of patterns) {
    const proposalId = `fp-${pattern.fingerprint}`;
    const existing = await getProposal(feedbackStore, proposalId);
    if (existing !== null) {
      results.push({
        proposalId,
        target: existing.target,
        status: existing.status,
        occurrences: existing.occurrences,
        stored: "existing",
        proposal: existing
      });
      continue;
    }

    const artifact = buildProposalArtifact(pattern, { threshold, now });
    await saveArtifact(feedbackStore, {
      artifactId: "improvement-proposal",
      executionId: proposalId,
      stepId: "proposals",
      artifact
    });
    results.push({
      proposalId,
      target: artifact.target,
      status: artifact.status,
      occurrences: artifact.occurrences,
      stored: "created",
      proposal: artifact
    });
  }
  return results;
}

/**
 * Lists proposals, newest first, optionally filtered by status.
 *
 * @param {import("../artifacts/contracts.js").ArtifactStore} feedbackStore
 * @param {{ status?: string }} [options]
 * @returns {Promise<object[]>}
 */
export async function listProposals(feedbackStore, { status } = {}) {
  if (status !== undefined && !PROPOSAL_STATUSES.includes(status)) {
    throw new Error(`unknown proposal status "${String(status)}" (expected one of ${PROPOSAL_STATUSES.join(", ")}).`);
  }
  const records = await findArtifactsByType(feedbackStore, "improvement-proposal");
  const proposals = records
    .map((record) => record.artifact)
    .filter((artifact) => status === undefined || artifact.status === status)
    .sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")));
  return proposals;
}

/**
 * Reads one proposal by id, or null when unknown.
 *
 * @param {import("../artifacts/contracts.js").ArtifactStore} feedbackStore
 * @param {string} proposalId
 * @returns {Promise<object | null>}
 */
export async function getProposal(feedbackStore, proposalId) {
  const record = await getArtifact(feedbackStore, "improvement-proposal", { executionId: proposalId });
  return record === null ? null : record.artifact;
}

/**
 * Human-only status transition (`proposed → approved/rejected`, or
 * back). The artifact content is preserved byte-for-byte except for the
 * status field; nothing outside the feedback store is touched. The
 * detection/generation path never calls this — approval is an explicit
 * human command.
 *
 * @param {import("../artifacts/contracts.js").ArtifactStore} feedbackStore
 * @param {string} proposalId
 * @param {string} status
 * @returns {Promise<object>} the updated proposal
 */
export async function setProposalStatus(feedbackStore, proposalId, status) {
  if (!PROPOSAL_STATUSES.includes(status)) {
    throw new Error(`unknown proposal status "${String(status)}" (expected one of ${PROPOSAL_STATUSES.join(", ")}).`);
  }
  const record = await getArtifact(feedbackStore, "improvement-proposal", { executionId: proposalId });
  if (record === null) {
    throw new Error(`proposal not found: ${proposalId}`);
  }
  if (typeof feedbackStore.replaceRecord !== "function") {
    throw new Error("artifact store does not support status updates (missing replaceRecord).");
  }
  await feedbackStore.replaceRecord("improvement-proposal", record.version, { ...record, artifact: { ...record.artifact, status } });
  return { ...record.artifact, status };
}

function sanitizeId(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "step";
}
