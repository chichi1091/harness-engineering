/**
 * Human-readable rendering for Maintenance / Pruning (Issue #40).
 *
 * Plain text, data-as-data, review-oriented: candidates are presented
 * as "please review" with their measured evidence — never as "delete
 * this". Estimates (tokens) are always labeled as estimates.
 */

/**
 * Renders the result of a maintenance detection run.
 *
 * @param {{ candidates: { candidateId: string, kind: string, resourceType: string, resourceId: string, status: string, stored: string }[], window: { executions: number, from: string | null, until: string | null }, minUsage: number }} run
 * @returns {string[]}
 */
export function formatMaintenanceRun({ candidates, window, minUsage }) {
  const lines = [];
  lines.push("Harness Maintenance");
  lines.push("──────────────────");
  lines.push(`Observed executions: ${window.executions}${window.from !== null ? `  (${window.from} … ${window.until})` : ""}  min usage threshold: ${minUsage}`);

  if (candidates.length === 0) {
    lines.push("");
    lines.push("No pruning candidates detected. Nothing proposed.");
    return lines;
  }

  lines.push("");
  lines.push("Candidates");
  for (const candidate of candidates) {
    const mark = candidate.stored === "created" ? "proposed" : "already proposed";
    lines.push(`  ${candidate.candidateId}  [${candidate.kind}]  ${candidate.resourceType}:${candidate.resourceId}  (${mark}, ${candidate.status})`);
  }

  lines.push("");
  lines.push("Candidates are review requests, not removals. Nothing is deleted automatically — changes happen through the normal flow (branch → PR → quality gates → human merge).");
  return lines;
}

/**
 * Renders one candidate: Resource → Evidence → Recommendation.
 *
 * @param {object} candidate — a maintenance-candidate artifact
 * @returns {string[]}
 */
export function formatCandidateDetail(candidate) {
  const lines = [];
  lines.push(`Maintenance Candidate: ${candidate.candidateId}`);
  lines.push("──────────────────");
  lines.push(`Status: ${candidate.status}  Kind: ${candidate.kind}  Resource: ${candidate.resourceType}:${candidate.resourceId}`);
  lines.push("");
  lines.push("Evidence (measured, not inferred)");
  for (const line of describeEvidence(candidate)) {
    lines.push(`  ${line}`);
  }
  if (candidate.duplicateOf !== null && candidate.duplicateOf !== undefined) {
    lines.push(`  duplicate of: ${candidate.duplicateOf}`);
  }

  lines.push("");
  lines.push("Recommendation");
  lines.push(`  ${candidate.recommendation}`);

  lines.push("");
  lines.push("Approval is a human decision recorded on this candidate only. Even an approved candidate is removed or rewritten by YOU through the normal flow (branch → PR → quality gates → human merge) — never by harness.");
  return lines;
}

/**
 * Renders a candidate list.
 *
 * @param {object[]} candidates
 * @returns {string[]}
 */
export function formatCandidateList(candidates) {
  const lines = [];
  lines.push("Harness Maintenance Candidates");
  lines.push("──────────────────");
  if (candidates.length === 0) {
    lines.push("No candidates yet. Run `harness maintenance` to analyze usage and size.");
    return lines;
  }
  for (const candidate of candidates) {
    lines.push(`  ${candidate.candidateId}  [${candidate.kind.padEnd(10)}]  ${(candidate.resourceType + ":" + candidate.resourceId).padEnd(34)}  ${candidate.status}`);
  }
  return lines;
}

function describeEvidence(candidate) {
  const evidence = candidate.evidence ?? {};
  const lines = [];
  if (evidence.usageCount !== undefined) lines.push(`usage count: ${evidence.usageCount}`);
  if (evidence.lastUsedAt !== undefined) lines.push(`last used: ${evidence.lastUsedAt === null ? "never (in observed history)" : evidence.lastUsedAt}`);
  if (evidence.ageDays !== undefined && evidence.ageDays !== null) lines.push(`age (days since last use): ${evidence.ageDays}`);
  if (evidence.observedExecutions !== undefined) lines.push(`observed executions: ${evidence.observedExecutions}${evidence.observedFrom !== null && evidence.observedFrom !== undefined ? ` (${evidence.observedFrom} … ${evidence.observedUntil})` : ""}`);
  if (evidence.evidenceExecutions !== undefined && evidence.evidenceExecutions.length > 0) {
    lines.push(`used by executions: ${evidence.evidenceExecutions.join(", ")}  (track with: harness history <execution-id>)`);
  }
  if (candidate.resourceType === "AGENTS.md") {
    lines.push(`bytes: ${evidence.bytes}  lines: ${evidence.lines}  characters: ${evidence.characters}`);
    lines.push(`estimated tokens: ${evidence.estimatedTokens}  (${evidence.tokenEstimateNote})`);
    if (evidence.limitBytes !== undefined) lines.push(`provided size limit: ${evidence.limitBytes} bytes — exceeded by ${evidence.bytes - evidence.limitBytes} bytes`);
  }
  if (candidate.kind === "duplicate") {
    if (evidence.sharedCapabilities !== undefined) lines.push(`shared capabilities: ${evidence.sharedCapabilities.join(", ")}`);
    if (evidence.sharedSteps !== undefined && evidence.sharedSteps.length > 0) lines.push(`shared appliesTo steps: ${evidence.sharedSteps.join(", ")}`);
    if (evidence.sharedIntents !== undefined) lines.push(`shared routing intents: ${evidence.sharedIntents.join(", ")}`);
  }
  if (candidate.resourceType === "guardrail") {
    lines.push(`refusals recorded: ${evidence.refusedCount}  (informational only — safety mechanisms are never pruning candidates)`);
    if (evidence.exampleReason !== null) lines.push(`example reason: ${evidence.exampleReason}`);
  }
  if (candidate.resourceType === "runtime") {
    lines.push("runtime/adapter usage is informational — statically referenced code is never flagged for removal");
  }
  return lines.length > 0 ? lines : ["(no evidence recorded)"];
}
