/**
 * Maintenance analysis orchestration (Issue #40).
 *
 * Pure composition layer between usage analysis (facts), size report
 * (facts) and candidate generation (persistence): applies the
 * explainable rules and produces the candidate list. No I/O — the
 * history store, definitions and file content are injected by the CLI.
 *
 * Certainty is kept honest by construction:
 * - Resources with usageCount 0 become "unused" candidates, but every
 *   candidate carries the observation window so a thin history is
 *   visible to the reviewer.
 * - low_usage is only evaluated when the window holds at least
 *   `minUsage` executions — otherwise the data cannot support it.
 * - Guardrails and runtimes/adapters are reported as usage_info only;
 *   they are never pruning candidates.
 */

import { buildCandidateArtifact } from "./candidates.js";
import { exceedsSizeLimit } from "./size-report.js";

export const DEFAULT_MIN_USAGE = 2;

/**
 * @param {object} options
 * @param {import("./usage-analysis.js").ObservationWindow} options.window
 * @param {Map<string, import("./usage-analysis.js").UsageStats>} options.skills
 * @param {Map<string, import("./usage-analysis.js").UsageStats>} options.workflows
 * @param {Map<string, import("./usage-analysis.js").UsageStats>} options.runtimes
 * @param {{ refusals: { stepId: string | null, count: number, exampleReason: string | null }[] }} options.guardrails
 * @param {{ id: string, capabilities?: string[], appliesTo?: { steps?: string[] } }[]} options.skillDefinitions
 * @param {{ name: string, routing?: { intents?: string[] } }[]} options.workflowDefinitions
 * @param {import("./size-report.js").SizeReport} options.ruleFileSize
 * @param {{ minUsage?: number, maxAgentsMdBytes?: number, now?: string }} [options.options]
 * @returns {object[]} candidate artifacts (all "proposed")
 */
export function detectMaintenanceCandidates({
  window,
  skills,
  workflows,
  runtimes,
  guardrails,
  skillDefinitions,
  workflowDefinitions,
  ruleFileSize,
  options: { minUsage = DEFAULT_MIN_USAGE, maxAgentsMdBytes, now } = {}
}) {
  assertMinUsage(minUsage);
  const candidates = [];

  const observation = {
    observedExecutions: window.executions,
    observedFrom: window.from,
    observedUntil: window.until
  };

  // --- Skills: unused / low_usage (well-used resources yield no candidate)
  for (const definition of skillDefinitions) {
    const stats = skills.get(definition.id) ?? emptyStats();
    const candidate = usageCandidate("skill", definition.id, stats, observation, minUsage, now);
    if (candidate !== null) candidates.push(candidate);
  }

  // --- Workflows: unused / low_usage
  for (const definition of workflowDefinitions) {
    const stats = workflows.get(definition.name) ?? emptyStats();
    const candidate = usageCandidate("workflow", definition.name, stats, observation, minUsage, now);
    if (candidate !== null) candidates.push(candidate);
  }

  // --- Runtimes/adapters: usage information ONLY (never candidates for removal)
  for (const [runtime, stats] of runtimes) {
    candidates.push(buildCandidateArtifact(
      { resourceType: "runtime", resourceId: runtime, kind: "usage_info" },
      { evidence: { ...observation, usageCount: stats.usageCount, lastUsedAt: stats.lastUsedAt, ageDays: stats.ageDays, evidenceExecutions: stats.evidenceExecutions } },
      { now }
    ));
  }

  // --- Guardrails: usage information ONLY (safety mechanisms are never pruning candidates)
  for (const refusal of guardrails.refusals) {
    candidates.push(buildCandidateArtifact(
      { resourceType: "guardrail", resourceId: `guardrail@${refusal.stepId ?? "(unknown)"}`, kind: "usage_info" },
      { evidence: { ...observation, refusedCount: refusal.count, exampleReason: refusal.exampleReason } },
      { now }
    ));
  }

  // --- AGENTS.md: size report always; oversized only with an explicit human limit
  const sizeEvidence = {
    path: "AGENTS.md",
    bytes: ruleFileSize.bytes,
    lines: ruleFileSize.lines,
    characters: ruleFileSize.characters,
    estimatedTokens: ruleFileSize.estimatedTokens,
    tokenEstimateNote: "estimated (characters / 4) — actual token counts differ per runtime tokenizer",
    ...observation
  };
  if (exceedsSizeLimit(ruleFileSize, maxAgentsMdBytes)) {
    candidates.push(buildCandidateArtifact(
      { resourceType: "AGENTS.md", resourceId: "AGENTS.md", kind: "oversized", secondaryKey: String(maxAgentsMdBytes) },
      { evidence: { ...sizeEvidence, limitBytes: maxAgentsMdBytes } },
      { now }
    ));
  } else {
    candidates.push(buildCandidateArtifact(
      { resourceType: "AGENTS.md", resourceId: "AGENTS.md", kind: "usage_info" },
      { evidence: sizeEvidence },
      { now }
    ));
  }

  return candidates;
}

/**
 * Marks duplicate pairs on an already-generated candidate list. Kept
 * separate from usage detection so the machine-comparison evidence
 * (shared fields) is recorded exactly where the duplicate was found.
 *
 * @param {object[]} candidates
 * @param {{ id: string, duplicateOf: string, sharedCapabilities?: string[], sharedSteps?: string[], sharedIntents?: string[] }[]} duplicateFindings
 * @param {{ now?: string }} [options]
 * @returns {object[]} additional duplicate candidates
 */
export function duplicateCandidates(duplicateFindings, { now } = {}) {
  return duplicateFindings.map((finding) => {
    const evidence = {
      duplicateOf: finding.duplicateOf,
      ...(finding.sharedCapabilities !== undefined ? { sharedCapabilities: finding.sharedCapabilities } : {}),
      ...(finding.sharedSteps !== undefined ? { sharedSteps: finding.sharedSteps } : {}),
      ...(finding.sharedIntents !== undefined ? { sharedIntents: finding.sharedIntents } : {})
    };
    return buildCandidateArtifact(
      { resourceType: finding.sharedIntents !== undefined ? "workflow" : "skill", resourceId: finding.id, kind: "duplicate", secondaryKey: finding.duplicateOf },
      { evidence, duplicateOf: finding.duplicateOf },
      { now }
    );
  });
}

function usageCandidate(resourceType, resourceId, stats, observation, minUsage, now) {
  const evidence = {
    skillIdOrName: resourceId,
    ...observation,
    usageCount: stats.usageCount,
    lastUsedAt: stats.lastUsedAt,
    ageDays: stats.ageDays,
    evidenceExecutions: stats.evidenceExecutions
  };
  if (stats.usageCount === 0) {
    return buildCandidateArtifact(
      { resourceType, resourceId, kind: "unused" },
      { evidence },
      { now }
    );
  }
  if (observation.observedExecutions >= minUsage && stats.usageCount < minUsage) {
    return buildCandidateArtifact(
      { resourceType, resourceId, kind: "low_usage", secondaryKey: String(minUsage) },
      { evidence: { ...evidence, minUsage } },
      { now }
    );
  }
  // Enough usage (or an observation window too thin to judge): no
  // candidate — absence of a candidate is a value, not an error.
  return null;
}

function emptyStats() {
  return { usageCount: 0, lastUsedAt: null, ageDays: null, evidenceExecutions: [] };
}

function assertMinUsage(minUsage) {
  if (typeof minUsage !== "number" || !Number.isInteger(minUsage) || minUsage < 1) {
    throw new Error(`min usage must be an integer greater than or equal to 1 (got ${String(minUsage)}).`);
  }
}
