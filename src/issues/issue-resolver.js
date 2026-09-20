/**
 * Issue Resolver (Issue #38): transforms a resolved external issue into
 * a structured HarnessInput.
 *
 * Responsibilities (and nothing more):
 * - goal generation (issue title)
 * - context construction (body wrapped in the untrusted boundary,
 *   labels, author, state)
 * - source metadata construction (type / repository / issue number / url)
 * - intent hints from labels (the Decision Engine still decides)
 *
 * It never selects workflow/model/runtime/skills and never executes.
 *
 * The issue body is UNTRUSTED content: it is wrapped in the untrusted
 * content boundary (#34) so it can never merge with trusted
 * instructions, and it cannot grant permissions, disable guardrails, or
 * alter verification — those decisions live in the policies, not in the
 * issue text.
 *
 * @typedef {import("./contracts.js").IssueRecord} IssueRecord
 * @typedef {import("./contracts.js").HarnessInput} HarnessInput
 * @typedef {import("./contracts.js").IssueResolution} IssueResolution
 */

import { containsBoundaryMarkers, wrapUntrusted } from "../guardrails/untrusted-content.js";

/**
 * Label → intent hints. These are INPUT hints only: the actual workflow
 * selection always goes through the existing Decision Engine.
 */
export const DEFAULT_LABEL_INTENTS = Object.freeze({
  bug: "bug-fix",
  "bug-fix": "bug-fix",
  feature: "feature",
  enhancement: "feature",
  refactor: "refactor",
  research: "research",
  design: "design"
});

/** Issue number / repository vocabulary (path and URL safe). */
export const ISSUE_NUMBER_PATTERN = /^\d{1,9}$/;
export const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parses a GitHub issue URL into { repository, issueNumber }.
 * Returns null for non-GitHub or malformed URLs.
 *
 * @param {string} url
 * @returns {{ repository: string, issueNumber: number } | null}
 */
export function parseIssueUrl(url) {
  if (typeof url !== "string") return null;
  const match = url.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d{1,9})\/?$/i);
  if (match === null) return null;
  const [, owner, repo, number] = match;
  return { repository: `${owner}/${repo}`, issueNumber: Number(number) };
}

/**
 * Maps issue labels to an intent hint. Returns the first label that has
 * a hint, otherwise undefined — the Decision Engine still decides.
 *
 * @param {readonly string[] | undefined} labels
 * @param {{ labelIntents?: Record<string, string> }} [options]
 * @returns {string | undefined}
 */
export function mapLabelsToIntent(labels, { labelIntents = DEFAULT_LABEL_INTENTS } = {}) {
  if (!Array.isArray(labels)) return undefined;
  for (const label of labels) {
    const hint = labelIntents[String(label).toLowerCase()];
    if (hint !== undefined) return hint;
  }
  return undefined;
}

/**
 * Transforms a resolved issue into a structured HarnessInput.
 *
 * - goal = issue title (never the body)
 * - body is wrapped in the untrusted content boundary (#34) — a body
 *   containing boundary markers is refused (boundary forgery)
 * - closed issues are refused unless explicitly allowed
 *
 * @param {{
 *   issue: IssueRecord,
 *   intent?: string,
 *   risk?: string,
 *   allowClosedIssue?: boolean,
 *   labelIntents?: Record<string, string>,
 *   now?: string
 * }} options
 * @returns {IssueResolution}
 */
export function resolveIssueInput({ issue, intent, risk, allowClosedIssue = false, labelIntents, now }) {
  if (typeof issue !== "object" || issue === null || Array.isArray(issue)) {
    return { status: "invalid", errors: ["issue must be an object."], message: "Issue情報が不正です。" };
  }

  const errors = [];

  if (typeof issue.number !== "number" || !Number.isInteger(issue.number) || issue.number < 1) {
    errors.push("issue number must be an integer greater than or equal to 1.");
  }
  if (typeof issue.title !== "string" || issue.title.trim() === "") {
    errors.push("issue title is empty; the goal would be empty.");
  }
  if (typeof issue.repository !== "string" || !REPOSITORY_PATTERN.test(issue.repository)) {
    errors.push(`issue repository must match ${REPOSITORY_PATTERN.source} ("owner/repo").`);
  }
  if (issue.body !== undefined && typeof issue.body !== "string") {
    errors.push("issue body must be a string when present.");
  }
  if (errors.length > 0) {
    return { status: "invalid", errors, message: `Issue情報が不正です。${errors.join(" ")}` };
  }

  const body = issue.body ?? "";
  if (containsBoundaryMarkers(body)) {
    return {
      status: "invalid",
      errors: ["issue body contains untrusted boundary markers; strip them before intake."],
      message: "Issue本文にuntrusted境界マーカーが含まれるため、取り込みを拒否しました。"
    };
  }

  const state = issue.state === "closed" ? "closed" : "open";

  if (state === "closed" && allowClosedIssue !== true) {
    const input = buildInput(issue, body, { intent, risk, labelIntents, now, withEnvelope: false, state });
    return {
      status: "issue_closed",
      input,
      message: `Issue #${issue.number} はクローズされています。実行するには明示的に許可してください（--allow-closed-issue）。`
    };
  }

  const input = buildInput(issue, body, { intent, risk, labelIntents, now, withEnvelope: true, state });
  return { status: "resolved", input, warnings: [] };
}

function buildInput(issue, body, { intent, risk, labelIntents, now, withEnvelope, state }) {
  const labels = Array.isArray(issue.labels) ? [...issue.labels] : [];
  const source = {
    type: "github_issue",
    repository: issue.repository,
    issueNumber: issue.number,
    ...(issue.url !== undefined ? { url: issue.url } : {}),
    author: issue.author ?? null
  };

  const untrustedEnvelope = withEnvelope && body.trim() !== ""
    ? wrapUntrusted({
        source: `github-issue-${issue.number}`,
        content: body
      }).envelope
    : null;

  const hint = mapLabelsToIntent(labels, { labelIntents });

  return {
    goal: issue.title.trim(),
    intent: intent ?? hint,
    risk,
    source,
    context: {
      labels,
      state,
      author: issue.author ?? null,
      repository: issue.repository,
      issueNumber: issue.number,
      url: issue.url ?? null,
      untrustedEnvelope
    }
  };
}

/** Builds the plan/run execution context carried alongside the goal. */
export function buildExecutionContextFromInput(input) {
  return {
    goal: input.goal,
    source: input.source,
    untrusted: input.context.untrustedEnvelope
  };
}
