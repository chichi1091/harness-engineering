/**
 * Human-readable rendering for Failure Feedback (Issue #39).
 *
 * Plain text only (no ANSI), data-as-data: free-text failure reasons
 * are rendered verbatim as evidence, never interpreted as instructions.
 * JSON output is the CLI's job (the artifacts are already JSON-safe).
 */

/**
 * Renders the result of a feedback detection run.
 *
 * @param {{ patterns: import("./failure-patterns.js").FailurePattern[], results: { proposalId: string, target: string, status: string, occurrences: number, stored: string }[], threshold: number }} run
 * @returns {string[]}
 */
export function formatFeedbackRun({ patterns, results, threshold }) {
  const lines = [];
  lines.push("Harness Failure Feedback");
  lines.push("────────────────────────");
  lines.push(`Threshold: ${threshold}  Patterns above threshold: ${patterns.length}`);

  if (patterns.length === 0) {
    lines.push("");
    lines.push("No repeated failure patterns detected. Nothing proposed.");
    return lines;
  }

  lines.push("");
  lines.push("Patterns");
  for (const pattern of patterns) {
    lines.push("");
    lines.push(`  ${pattern.occurrences}× ${describePattern(pattern)}`);
    lines.push(`    proposal: fp-${pattern.fingerprint}`);
  }

  lines.push("");
  lines.push("Proposals");
  for (const result of results) {
    const mark = result.stored === "created" ? "proposed" : "already proposed";
    lines.push(`  ${result.proposalId}  ${result.target}  ${result.status}  (${mark}, occurrences: ${result.occurrences})`);
  }

  lines.push("");
  lines.push("Human review is required: proposals never change AGENTS.md, skills, workflows or guardrails by themselves.");
  return lines;
}

/**
 * Renders one proposal: Pattern → Evidence → Candidate.
 *
 * @param {object} proposal — an improvement-proposal artifact
 * @returns {string[]}
 */
export function formatProposalDetail(proposal) {
  const lines = [];
  lines.push(`Improvement Proposal: ${proposal.proposalId}`);
  lines.push("────────────────────────");
  lines.push(`Status: ${proposal.status}  Target: ${proposal.target}  Occurrences: ${proposal.occurrences} (threshold: ${proposal.threshold})`);
  lines.push("");
  lines.push("Pattern");
  for (const line of describePatternFields(proposal.pattern)) {
    lines.push(`  ${line}`);
  }

  lines.push("");
  lines.push("Evidence (Execution History references)");
  for (const entry of proposal.evidence ?? []) {
    const reason = entry.failureReason ? `  reason: ${entry.failureReason}` : "";
    lines.push(`  ${entry.occurredAt ?? "(time unrecorded)"}  ${entry.executionId}  step ${entry.stepId} attempt ${entry.attempt}${entry.errorCategory ? ` [${entry.errorCategory}]` : ""}${reason}`);
  }
  lines.push("  Track any execution with: harness history <execution-id>");

  lines.push("");
  lines.push("Candidate");
  for (const line of describeSuggestion(proposal)) {
    lines.push(`  ${line}`);
  }

  lines.push("");
  lines.push("Approval is a human decision. Even an approved proposal is implemented through the normal flow (branch → PR → quality gates → human merge), never by this command.");
  return lines;
}

/**
 * Renders a proposal list.
 *
 * @param {object[]} proposals
 * @returns {string[]}
 */
export function formatProposalList(proposals) {
  const lines = [];
  lines.push("Harness Improvement Proposals");
  lines.push("────────────────────────");
  if (proposals.length === 0) {
    lines.push("No proposals yet. Run `harness feedback` to detect repeated failures.");
    return lines;
  }
  for (const proposal of proposals) {
    lines.push(`  ${proposal.proposalId}  ${proposal.status.padEnd(9)}  ${proposal.target.padEnd(9)}  occurrences: ${proposal.occurrences}  ${describePatternFields(proposal.pattern).join(" / ")}`);
  }
  return lines;
}

function describePattern(pattern) {
  const fields = pattern.fields;
  const parts = [
    fields.workflow !== null ? `workflow ${fields.workflow}` : null,
    `step ${fields.stepId ?? "?"}`,
    fields.agent !== null ? `agent ${fields.agent}` : null,
    fields.errorCategory !== null ? `[${fields.errorCategory}]` : null
  ].filter((part) => part !== null);
  return parts.join(" · ");
}

function describePatternFields(pattern) {
  if (!pattern || typeof pattern !== "object") return ["(pattern unrecorded)"];
  const parts = [];
  if (pattern.workflow !== null && pattern.workflow !== undefined) parts.push(`workflow: ${pattern.workflow}`);
  if (pattern.stepId !== null && pattern.stepId !== undefined) parts.push(`step: ${pattern.stepId}`);
  if (pattern.agent !== null && pattern.agent !== undefined) parts.push(`agent: ${pattern.agent}`);
  if (pattern.errorCategory !== null && pattern.errorCategory !== undefined) parts.push(`error: ${pattern.errorCategory}`);
  if (pattern.runtime !== null && pattern.runtime !== undefined) parts.push(`runtime: ${pattern.runtime}`);
  return parts.length > 0 ? parts : ["(pattern unrecorded)"];
}

function describeSuggestion(proposal) {
  const suggestion = proposal.suggestion ?? {};
  const lines = [];
  if (proposal.target === "guardrail") {
    lines.push(`Trigger: ${suggestion.trigger ?? "(unrecorded)"}`);
    lines.push(`Suggested action: ${suggestion.suggestedAction ?? "deny"}`);
    lines.push(`Reason: ${suggestion.reason ?? ""}`);
  } else if (proposal.target === "skill") {
    lines.push(`Suggested name: ${suggestion.suggestedName ?? "(unrecorded)"}`);
    lines.push(`Purpose: ${suggestion.purpose ?? ""}`);
    for (const step of suggestion.suggestedSteps ?? []) {
      lines.push(`  - ${step}`);
    }
    const appliesTo = suggestion.appliesTo?.steps ?? [];
    if (appliesTo.length > 0) lines.push(`Applies to steps: ${appliesTo.join(", ")}`);
  } else {
    lines.push(`Reason: ${suggestion.reason ?? ""}`);
    lines.push(`Suggested rule: ${suggestion.suggestedRule ?? ""}`);
  }
  return lines;
}
