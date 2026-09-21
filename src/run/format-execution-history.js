/**
 * Rendering for Execution History (Issue #35). Pure formatting over the
 * read model (src/run/execution-history.js) — the underlying records
 * are never modified or duplicated here.
 */

/** Formats one line per execution, newest first. */
export function formatExecutionHistoryList(summaries) {
  const lines = [];
  lines.push("Harness Execution History");
  lines.push("────────────────────────────");

  if (summaries.length === 0) {
    lines.push("(no executions found)");
    return lines;
  }

  lines.push("ID           Status    Workflow                Started");
  for (const summary of summaries) {
    const id = String(summary.executionId).slice(0, 28);
    const status = (summary.status ?? "?").toUpperCase().padEnd(9);
    const workflow = (summary.workflow ?? "?").padEnd(23);
    const started = summary.startedAt !== null && summary.startedAt !== undefined
      ? summary.startedAt.replace("T", " ").slice(0, 16)
      : "?";
    lines.push(`${id.padEnd(28)} ${status} ${workflow} ${started}`);
  }
  return lines;
}

function formatDuration(durationMs) {
  if (typeof durationMs !== "number") return "?";
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Renders the full detail of one execution. */
export function formatExecutionDetail(history) {
  const lines = [];
  lines.push("Harness Execution");
  lines.push("────────────────────────────");
  lines.push("Execution ID");
  lines.push(`  ${history.executionId}`);
  if (history.goal !== null && history.goal !== undefined) {
    lines.push("Goal");
    lines.push(`  ${history.goal}`);
  }
  if (history.intent !== null) lines.push(`Intent: ${history.intent}`);
  if (history.risk !== null) lines.push(`Risk: ${history.risk}`);
  lines.push("Status");
  lines.push(`  ${String(history.status).toUpperCase()}`);
  if (history.workflow !== null) lines.push(`Workflow: ${history.workflow}`);
  const source = history.source;
  if (source !== null && source !== undefined) {
    lines.push("Source");
    lines.push(`  ${source.type === "github_issue" ? "GitHub Issue" : String(source.type)} #${source.issueNumber ?? "?"}`);
    if (source.repository) lines.push(`Repository: ${source.repository}`);
    if (source.url) lines.push(`URL: ${source.url}`);
  }
  if (history.planId !== null) lines.push(`Plan ID: ${history.planId}`);
  if (history.planHash !== null) lines.push(`Plan Hash: ${String(history.planHash).slice(0, 16)}…`);
  if (history.startedAt !== null) lines.push(`Started: ${history.startedAt}`);
  if (history.completedAt !== null) lines.push(`Completed: ${history.completedAt}`);
  if (history.durationMs !== null) lines.push(`Duration: ${formatDuration(history.durationMs)}`);

  if (Array.isArray(history.steps) && history.steps.length > 0) {
    lines.push("Steps");
    for (const step of history.steps) {
      const mark = step.status === "succeeded" ? "✓" : "✗";
      const role = step.history[0]?.role ?? step.stepId;
      lines.push(`  ${mark} ${role} (${step.stepId}) — ${step.attempts} attempt(s), ${step.retries} retry`);
      for (const attempt of step.history) {
        const attemptMark = attempt.status === "succeeded" ? "✓" : "✗";
        const model = [attempt.resolvedProvider, attempt.resolvedModel].filter(Boolean).join("/") || "unknown";
        lines.push(`      attempt ${attempt.attempt} ${attemptMark} ${model} (${attempt.status}${attempt.errorCategory ? `, ${attempt.errorCategory}` : ""})`);
        if (attempt.fallbackCount !== null && attempt.fallbackCount > 0) {
          lines.push(`        fallback ×${attempt.fallbackCount}: ${attempt.fallback?.fromProvider}/${attempt.fallback?.fromModel} → ${attempt.fallback?.toProvider}/${attempt.fallback?.toModel} (${attempt.fallback?.reason ?? "?"})`);
        }
        if (attempt.failureReason !== null && attempt.failureReason !== undefined) {
          lines.push(`        reason: ${attempt.failureReason}`);
        }
      }
    }

    const totalRetries = history.steps.reduce((sum, step) => sum + step.retries, 0);
    lines.push(`Retry: ${totalRetries}`);
  }

  if (Array.isArray(history.fallbacks) && history.fallbacks.length > 0) {
    lines.push("Fallback");
    for (const fallback of history.fallbacks) {
      lines.push(`  ${fallback.stepId} (attempt ${fallback.attempt}) ×${fallback.count}: ${fallback.originalProvider}/${fallback.originalModel} → ${fallback.finalProvider}/${fallback.finalModel} (${fallback.reason}) → ${fallback.result}`);
    }
  }

  if (Array.isArray(history.verification) && history.verification.length > 0) {
    lines.push("Verification");
    for (const verification of history.verification) {
      for (const gate of verification.gates) {
        lines.push(`  ${gate.status === "passed" ? "✓" : "✗"} ${gate.id}`);
      }
    }
  }

  const prAutomationRecords = history.artifacts?.filter?.((artifact) => artifact.type === "pr-automation") ?? [];
  if (prAutomationRecords.length > 0) {
    lines.push("PR Automation");
    for (const artifact of prAutomationRecords) {
      const branch = artifact.branch ?? "?";
      const url = artifact.pullRequestUrl ?? "(no pull request)";
      lines.push(`  ${artifact.status.toUpperCase()} ${branch} → ${url}`);
    }
  }

  if (Array.isArray(history.guardrailDenials) && history.guardrailDenials.length > 0) {
    lines.push("Guardrail Denials");
    for (const denial of history.guardrailDenials) {
      lines.push(`  ✗ ${denial.stepId} (attempt ${denial.attempt}): ${denial.reason ?? "denied"}`);
    }
  }

  if (Array.isArray(history.modelExecutions) && history.modelExecutions.length > 0) {
    lines.push("Model Execution Records");
    for (const record of history.modelExecutions) {
      const model = [record.provider, record.model].filter(Boolean).join("/") || "unknown";
      lines.push(`  ${record.stepId} attempt ${record.attempt}: ${record.runtime} / ${model} (${record.status})`);
    }
  }

  if (Array.isArray(history.artifacts) && history.artifacts.length > 0) {
    lines.push("Artifacts");
    for (const artifact of history.artifacts) {
      lines.push(`  ${artifact.artifactId} v${artifact.version} [${artifact.type}] step=${artifact.stepId} (${artifact.validationStatus ?? "?"})`);
    }
  }

  if (history.failureReason !== null && history.failureReason !== undefined) {
    lines.push("Failure Reason");
    lines.push(`  ${history.failureReason}`);
  }

  return lines;
}
