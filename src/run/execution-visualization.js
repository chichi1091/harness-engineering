/**
 * Execution Visualization (Issue #36): a read-only projection of the
 * Execution History (#35) that renders an execution as a human
 * followable flow:
 *
 *   Execution → Workflow → Plan → Step attempts (retry / fallback)
 *     → Verification → PR Automation → Pull Request
 *
 * Design constraints:
 * - this is a PROJECTION of getExecutionHistory output: it holds no
 *   state, records no new data, and never invents values (unknown
 *   fields stay unknown)
 * - no Web UI, no graphs, no ANSI-heavy output — plain text that stays
 *   readable when redirected
 * - Retry (re-attempt of the same step) and Fallback (switching
 *   provider/model) are drawn with distinct markers; escalation is
 *   shown only when a record actually carries escalation data
 */

/**
 * Builds the visualization model from an execution history.
 *
 * @param {import("./execution-history.js") extends never ? never : object} history
 * @returns {object} visualization model
 */
export function buildExecutionVisualization(history) {
  if (typeof history !== "object" || history === null) {
    throw new Error("execution visualization requires an execution history object.");
  }

  const timeline = [];

  if (history.goal !== null && history.goal !== undefined) {
    timeline.push({ kind: "goal", goal: history.goal });
  }
  if (history.planId !== null && history.planId !== undefined) {
    timeline.push({
      kind: "plan",
      planId: history.planId,
      planHash: history.planHash ?? null
    });
  }

  for (const step of history.steps ?? []) {
    for (const attempt of step.history) {
      timeline.push({
        kind: "step-attempt",
        stepId: step.stepId,
        role: attempt.role,
        attempt: attempt.attempt,
        status: attempt.status,
        runtime: attempt.runtime,
        resolvedProvider: attempt.resolvedProvider,
        resolvedModel: attempt.resolvedModel,
        errorCategory: attempt.errorCategory,
        failureReason: attempt.failureReason,
        fallbackCount: attempt.fallbackCount ?? null,
        fallback: attempt.fallback ?? null,
        escalation: attempt.escalation ?? null,
        // Retry = a later attempt of the same step (execution loop
        // on_failure); Fallback is provider/model switching (drawn with
        // its own marker); Escalation is a tier raise (drawn with its
        // own marker, only when a record actually carries the data).
        isRetry: attempt.attempt > 1,
        durationMs: attempt.durationMs
      });
    }
  }

  for (const verification of history.verification ?? []) {
    timeline.push({
      kind: "verification",
      stepId: verification.stepId,
      status: verification.status,
      gates: verification.gates ?? [],
      failedGates: verification.failedGates ?? []
    });
  }

  for (const fallback of history.fallbacks ?? []) {
    timeline.push({
      kind: "fallback",
      stepId: fallback.stepId,
      attempt: fallback.attempt,
      count: fallback.count,
      originalProvider: fallback.originalProvider,
      originalModel: fallback.originalModel,
      finalProvider: fallback.finalProvider,
      finalModel: fallback.finalModel,
      reason: fallback.reason,
      result: fallback.result
    });
  }

  for (const denial of history.guardrailDenials ?? []) {
    timeline.push({
      kind: "guardrail-denial",
      stepId: denial.stepId,
      attempt: denial.attempt,
      reason: denial.reason
    });
  }

  for (const prAutomation of history.prAutomations ?? []) {
    timeline.push({
      kind: "pr-automation",
      status: prAutomation.status,
      reason: prAutomation.reason,
      branch: prAutomation.branch,
      commit: prAutomation.commit,
      pullRequestUrl: prAutomation.pullRequestUrl
    });
  }

  const guardrailDenialCount = (history.guardrailDenials ?? []).length;
  const fallbackCount = (history.fallbacks ?? []).reduce((sum, fallback) => sum + (fallback.count ?? 0), 0);
  const verificationStatuses = (history.verification ?? []).map((verification) => verification.status);
  const prStatuses = (history.prAutomations ?? []).map((pr) => pr.status);

  return {
    executionId: history.executionId,
    status: history.status,
    goal: history.goal,
    intent: history.intent,
    risk: history.risk,
    workflow: history.workflow,
    planId: history.planId,
    planHash: history.planHash,
    source: history.source ?? null,
    runtime: history.steps?.[0]?.history?.[0]?.runtime ?? null,
    startedAt: history.startedAt,
    completedAt: history.completedAt,
    durationMs: history.durationMs,
    timeline,
    summary: {
      totalAttempts: (history.steps ?? []).reduce((sum, step) => sum + step.attempts, 0),
      retries: (history.steps ?? []).reduce((sum, step) => sum + step.retries, 0),
      fallbacks: fallbackCount,
      guardrailDenials: guardrailDenialCount,
      verification: verificationStatuses.length > 0
        ? verificationStatuses.every((status) => status === "passed") ? "passed" : "failed"
        : null,
      prAutomation: prStatuses.length > 0 ? prStatuses[prStatuses.length - 1] : null
    },
    unresolved: history.failureReason !== null && history.failureReason !== undefined
      ? [history.failureReason]
      : []
  };
}

/**
 * Renders the visualization model as human-readable plain text.
 *
 * @param {object} visualization
 * @returns {string[]}
 */
export function formatExecutionVisualization(visualization) {
  const lines = [];
  lines.push("Harness Execution Visualization");
  lines.push("────────────────────────────");
  lines.push(`Execution: ${visualization.executionId} (${String(visualization.status).toUpperCase()})`);
  lines.push(`Workflow: ${visualization.workflow ?? "?"}`);
  if (visualization.goal !== null && visualization.goal !== undefined) {
    lines.push(`Goal: ${visualization.goal}`);
  }
  if (visualization.source !== null && visualization.source !== undefined) {
    lines.push(`Source: ${visualization.source.type === "github_issue" ? "GitHub Issue" : String(visualization.source.type)} #${visualization.source.issueNumber ?? "?"} (${visualization.source.repository ?? "?"})`);
  }
  if (visualization.planId !== null && visualization.planId !== undefined) {
    lines.push(`Plan: ${visualization.planId}`);
  }
  lines.push("");

  lines.push("Flow");
  for (const entry of visualization.timeline) {
    switch (entry.kind) {
      case "goal":
        break;
      case "plan":
        lines.push(`  ▣ Plan ${entry.planId}`);
        break;
      case "step-attempt": {
        const mark = entry.status === "succeeded" ? "✓" : entry.status === "failed" ? "✗" : "·";
        const retryMark = entry.isRetry ? "↻ " : "";
        const model = [entry.resolvedProvider, entry.resolvedModel].filter(Boolean).join("/") || "unknown model";
        const category = entry.errorCategory ? ` [${entry.errorCategory}]` : "";
        lines.push(`  ${mark} ${retryMark}${entry.stepId} attempt ${entry.attempt} — ${entry.role ?? "?"} — ${model}${category}`);
        if (entry.escalation?.escalated === true) {
          lines.push(`        ⇡ escalation ${entry.escalation.fromTier ?? "?"}→${entry.escalation.toTier ?? "?"} (${entry.escalation.reason ?? "no reason recorded"})`);
        }
        if (entry.failureReason) {
          lines.push(`        reason: ${entry.failureReason}`);
        }
        break;
      }
      case "verification": {
        const mark = entry.status === "passed" ? "✓" : "✗";
        lines.push(`  ${mark} Verification (${entry.stepId}): ${entry.status}`);
        for (const gate of entry.gates) {
          lines.push(`      ${gate.status === "passed" ? "✓" : "✗"} ${gate.id}`);
        }
        break;
      }
      case "fallback":
        lines.push(`  ↻ fallback ×${entry.count}: ${entry.originalProvider}/${entry.originalModel} → ${entry.finalProvider}/${entry.finalModel} (${entry.reason})`);
        break;
      case "guardrail-denial":
        lines.push(`  ⛔ guardrail denial at ${entry.stepId} (attempt ${entry.attempt})`);
        break;
      case "pr-automation":
        if (entry.status === "created") {
          lines.push(`  ⎇ Pull Request created: ${entry.pullRequestUrl ?? "(url unknown)"} (branch: ${entry.branch ?? "?"})`);
        } else if (entry.status === "skipped") {
          lines.push(`  ⊘ Pull Request skipped: ${entry.reason ?? ""}`);
        } else {
          lines.push(`  ✗ Pull Request automation failed: ${entry.reason ?? ""}`);
        }
        break;
      default:
        break;
    }
  }

  lines.push("");
  lines.push("Summary");
  lines.push(`  Attempts: ${visualization.summary.totalAttempts}  Retries: ${visualization.summary.retries}  Fallbacks: ${visualization.summary.fallbacks}  Guardrail denials: ${visualization.summary.guardrailDenials}`);
  if (visualization.summary.verification !== null) {
    lines.push(`  Verification: ${visualization.summary.verification}`);
  }
  if (visualization.summary.prAutomation !== null) {
    lines.push(`  PR Automation: ${visualization.summary.prAutomation}`);
  }
  if (Array.isArray(visualization.unresolved) && visualization.unresolved.length > 0) {
    for (const item of visualization.unresolved) {
      lines.push(`  unresolved: ${item}`);
    }
  }
  lines.push("");
  lines.push("Human review is the final gate — this visualization never merges.");

  return lines;
}
