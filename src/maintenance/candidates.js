/**
 * Pruning Candidate generation (Issue #40).
 *
 * The boundary this module enforces — the exact mirror of #39:
 *
 *   Usage / Size data → Maintenance Candidate (proposed) → Human
 *   Review → human does the change through the normal flow (branch →
 *   PR → quality gates → human merge)
 *
 * This is a CANDIDATE GENERATOR, not a pruner. It never deletes
 * skills, workflows, rules, guardrails or adapters, never edits
 * AGENTS.md, and never executes anything — functions like
 * deleteUnusedSkills() or pruneGuardrails() do not exist here. The
 * recommendation wording always asks a human to REVIEW, never states
 * that something should be removed.
 *
 * Deterministic and mechanical (no LLM, no embeddings):
 * - unused:      usageCount === 0 in the observed history
 * - low_usage:   0 < usageCount < min-usage, only when the observation
 *                window is large enough to mean anything
 * - duplicate:   exact machine-comparable equality (skill capabilities
 *                + appliesTo steps; workflow intent sets)
 * - oversized:   AGENTS.md bytes > a HUMAN-PROVIDED limit (no default)
 * - usage_info:  informational usage data for guardrails and
 *                runtimes/adapters — safety mechanisms and
 *                statically-referenceable code are never pruning
 *                candidates
 */

import { saveArtifact, findArtifactsByType, getArtifact } from "../artifacts/artifact-store.js";
import { createHash } from "node:crypto";
import { MAINTENANCE_STATUSES } from "./usage-analysis.js";

/**
 * Builds the deterministic candidate id from resource + kind. The same
 * resource and the same kind always produce the same id, so repeated
 * detections can never spawn duplicate candidates (the same idempotence
 * scheme as #39 proposals).
 *
 * @param {{ resourceType: string, resourceId: string, kind: string, secondaryKey?: string | null }} core
 * @returns {string} `mc-` + 12 hex chars
 */
export function candidateIdOf(core) {
  const fingerprint = createHash("sha256")
    .update([core.resourceType, core.resourceId, core.kind, core.secondaryKey ?? ""].join("|"))
    .digest("hex")
    .slice(0, 12);
  return `mc-${fingerprint}`;
}

/**
 * Detects duplicate SKILLS by exact machine-comparable equality:
 * identical non-empty capabilities AND identical appliesTo.steps.
 * Different skills are never flagged — a single shared field is not a
 * duplicate.
 *
 * @param {{ id: string, capabilities?: string[], appliesTo?: { steps?: string[] } }[]} skillDefinitions
 * @returns {{ id: string, duplicateOf: string, sharedCapabilities: string[], sharedSteps: string[] }[]}
 */
export function detectDuplicateSkills(skillDefinitions) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  const duplicates = [];
  for (const skill of skillDefinitions) {
    const capabilities = [...new Set(skill.capabilities ?? [])].sort();
    const steps = [...new Set(skill.appliesTo?.steps ?? [])].sort();
    if (capabilities.length === 0) continue; // nothing machine-comparable
    const key = JSON.stringify({ capabilities, steps });
    if (seen.has(key)) {
      duplicates.push({
        id: skill.id,
        duplicateOf: seen.get(key),
        sharedCapabilities: capabilities,
        sharedSteps: steps
      });
    } else {
      seen.set(key, skill.id);
    }
  }
  return duplicates;
}

/**
 * Detects duplicate WORKFLOWS by identical routing intent sets.
 *
 * @param {{ name: string, routing?: { intents?: string[] } }[]} workflowDefinitions
 * @returns {{ id: string, duplicateOf: string, sharedIntents: string[] }[]}
 */
export function detectDuplicateWorkflows(workflowDefinitions) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  const duplicates = [];
  for (const workflow of workflowDefinitions) {
    const intents = [...new Set(workflow.routing?.intents ?? [])].sort();
    if (intents.length === 0) continue;
    const key = JSON.stringify(intents);
    if (seen.has(key)) {
      duplicates.push({
        id: workflow.name,
        duplicateOf: seen.get(key),
        sharedIntents: intents
      });
    } else {
      seen.set(key, workflow.name);
    }
  }
  return duplicates;
}

/**
 * One pruning candidate (before persistence).
 *
 * @typedef {object} MaintenanceCandidate
 * @property {string} candidateId
 * @property {string} kind — unused | low_usage | duplicate | oversized | usage_info
 * @property {string} resourceType — skill | workflow | runtime | guardrail | AGENTS.md
 * @property {string} resourceId
 * @property {string} status — always "proposed" at generation time
 * @property {object} evidence — measured facts only (usage, sizes, comparison data)
 * @property {string | null} duplicateOf
 * @property {string} recommendation — fixed template asking for human review
 * @property {string} createdAt
 */

/**
 * Builds the candidate artifact envelope (maintenance-candidate).
 *
 * @param {object} core
 * @param {{ evidence: object, duplicateOf?: string | null }} fields
 * @param {{ now?: string }} options
 * @returns {MaintenanceCandidate}
 */
export function buildCandidateArtifact(core, { evidence, duplicateOf = null }, { now = new Date().toISOString() } = {}) {
  return {
    type: "maintenance-candidate",
    produced_by: "harness",
    unresolved: [],
    candidateId: candidateIdOf(core),
    kind: core.kind,
    resourceType: core.resourceType,
    resourceId: core.resourceId,
    status: "proposed",
    evidence,
    duplicateOf,
    recommendation: recommendationFor(core.kind, core.resourceType, core.resourceId),
    createdAt: now
  };
}

/**
 * Fixed recommendation templates. Deliberately review-oriented: the
 * generator never asserts that a resource SHOULD be deleted.
 *
 * @param {string} kind
 * @param {string} resourceType
 * @returns {string}
 */
export function recommendationFor(kind, resourceType, resourceId = "") {
  if (kind === "unused") {
    return `No usage of ${resourceType} "${resourceId}" was found in the recorded Execution History. Review with the evidence below whether it is still required — history coverage may be thin, so absence of usage is not proof of uselessness.`;
  }
  if (kind === "low_usage") {
    return `Usage of this ${resourceType} is below the requested threshold in the observed window. Review whether it earns its maintenance cost — the decision is yours, this is not a removal.`;
  }
  if (kind === "duplicate") {
    return `Machine-comparable fields of this ${resourceType} exactly match another definition. Review whether one of them can be consolidated — check the shared fields before deciding.`;
  }
  if (kind === "oversized") {
    return "The always-loaded rule file exceeds the size limit you provided. Review whether content can be moved into skills (#30) — keep AGENTS.md to the minimum rules every task needs.";
  }
  return "Usage information only. This resource type is intentionally never a pruning candidate.";
}

/**
 * Generates (or reuses) candidates idempotently. A candidate that
 * already exists is returned as "existing" and left untouched — no
 * second artifact, no status change. Detection never transitions
 * status; only an explicit human command does.
 *
 * @param {import("../artifacts/contracts.js").ArtifactStore} maintenanceStore
 * @param {MaintenanceCandidate[]} candidates
 * @returns {Promise<{ candidateId: string, kind: string, resourceType: string, resourceId: string, status: string, stored: "created" | "existing", candidate: object }[]>}
 */
export async function generateMaintenanceCandidates(maintenanceStore, candidates) {
  const results = [];
  for (const candidate of candidates) {
    const existing = await getCandidate(maintenanceStore, candidate.candidateId);
    if (existing !== null) {
      results.push({
        candidateId: candidate.candidateId,
        kind: existing.kind,
        resourceType: existing.resourceType,
        resourceId: existing.resourceId,
        status: existing.status,
        stored: "existing",
        candidate: existing
      });
      continue;
    }
    await saveArtifact(maintenanceStore, {
      artifactId: "maintenance-candidate",
      executionId: candidate.candidateId,
      stepId: "candidates",
      artifact: candidate
    });
    results.push({
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      resourceType: candidate.resourceType,
      resourceId: candidate.resourceId,
      status: candidate.status,
      stored: "created",
      candidate
    });
  }
  return results;
}

/**
 * Lists candidates, newest first, optionally filtered.
 *
 * @param {import("../artifacts/contracts.js").ArtifactStore} maintenanceStore
 * @param {{ status?: string, resourceType?: string, kind?: string }} [options]
 * @returns {Promise<object[]>}
 */
export async function listCandidates(maintenanceStore, { status, resourceType, kind } = {}) {
  for (const [name, value, vocabulary] of [
    ["status", status, MAINTENANCE_STATUSES],
    ["resource type", resourceType, ["skill", "workflow", "runtime", "guardrail", "AGENTS.md"]],
    ["kind", kind, ["unused", "low_usage", "duplicate", "oversized", "usage_info"]]
  ]) {
    if (value !== undefined && !vocabulary.includes(value)) {
      throw new Error(`unknown candidate ${name} "${String(value)}".`);
    }
  }
  const records = await findArtifactsByType(maintenanceStore, "maintenance-candidate");
  return records
    .map((record) => record.artifact)
    .filter((candidate) => (status === undefined || candidate.status === status)
      && (resourceType === undefined || candidate.resourceType === resourceType)
      && (kind === undefined || candidate.kind === kind))
    .sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")));
}

/**
 * Reads one candidate by id, or null when unknown.
 *
 * @param {import("../artifacts/contracts.js").ArtifactStore} maintenanceStore
 * @param {string} candidateId
 * @returns {Promise<object | null>}
 */
export async function getCandidate(maintenanceStore, candidateId) {
  const record = await getArtifact(maintenanceStore, "maintenance-candidate", { executionId: candidateId });
  return record === null ? null : record.artifact;
}

/**
 * Human-only status transition. Updates the status field of the stored
 * candidate and NOTHING else; canonical files are never touched and
 * the detection path never calls this.
 *
 * @param {import("../artifacts/contracts.js").ArtifactStore} maintenanceStore
 * @param {string} candidateId
 * @param {string} status
 * @returns {Promise<object>} the updated candidate
 */
export async function setCandidateStatus(maintenanceStore, candidateId, status) {
  if (!MAINTENANCE_STATUSES.includes(status)) {
    throw new Error(`unknown candidate status "${String(status)}" (expected one of ${MAINTENANCE_STATUSES.join(", ")}).`);
  }
  const record = await getArtifact(maintenanceStore, "maintenance-candidate", { executionId: candidateId });
  if (record === null) {
    throw new Error(`candidate not found: ${candidateId}`);
  }
  if (typeof maintenanceStore.replaceRecord !== "function") {
    throw new Error("artifact store does not support status updates (missing replaceRecord).");
  }
  await maintenanceStore.replaceRecord("maintenance-candidate", record.version, { ...record, artifact: { ...record.artifact, status } });
  return { ...record.artifact, status };
}
