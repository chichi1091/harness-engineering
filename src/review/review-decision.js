/**
 * Evaluates review findings against the Reviewer's severity policy.
 *
 * Pure: no I/O and no mutation. The policy is the structured data defined
 * in agents/reviewer.yaml; loading it belongs to the caller. A policy that
 * does not pass validateReviewPolicy may behave permissively: severities
 * without a threshold are treated as non-blocking.
 *
 * @typedef {import("./contracts.js").ReviewPolicy} ReviewPolicy
 * @typedef {import("./contracts.js").ReviewFinding} ReviewFinding
 * @typedef {import("./contracts.js").ReviewDecision} ReviewDecision
 */

const SEVERITY_ACTIONS = new Set(["reject", "report", "ignore"]);

/**
 * Validates the mechanical consistency of a severity policy.
 *
 * - every severity rule must declare a known action
 * - every action:"reject" severity must have an approval threshold
 * - severities whose action is not "reject" must not have a threshold,
 *   which structurally guarantees that report/ignore findings never
 *   reject a workflow on their own
 *
 * @param {ReviewPolicy} policy
 * @returns {string[]}
 */
export function validateReviewPolicy(policy) {
  const errors = [];

  if (!isRecord(policy) || !isRecord(policy.severity) || Object.keys(policy.severity).length === 0) {
    errors.push("policy.severity must be a non-empty object.");
    return errors;
  }

  const severityEntries = Object.entries(policy.severity);
  const rejectSeverities = new Set();

  for (const [severity, rule] of severityEntries) {
    if (!isRecord(rule)) {
      errors.push(`policy.severity["${severity}"] must be an object.`);
      continue;
    }
    if (!SEVERITY_ACTIONS.has(rule.action)) {
      errors.push(`policy.severity["${severity}"].action must be one of "reject", "report", "ignore".`);
    }
    if (rule.action === "reject") {
      rejectSeverities.add(severity);
    }
  }

  const require = isRecord(policy.approval) ? policy.approval.require : undefined;
  if (!isRecord(require)) {
    errors.push("policy.approval.require must be an object.");
    return errors;
  }

  const definedSeverities = new Set(Object.keys(policy.severity));

  for (const [severity, threshold] of Object.entries(require)) {
    if (!definedSeverities.has(severity)) {
      errors.push(`policy.approval.require["${severity}"] references undefined severity "${severity}".`);
      continue;
    }
    if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 0) {
      errors.push(`policy.approval.require["${severity}"] must be a non-negative integer.`);
      continue;
    }
    if (!rejectSeverities.has(severity)) {
      errors.push(`policy.approval.require["${severity}"] must not threshold a severity whose action is not "reject".`);
    }
  }

  for (const severity of rejectSeverities) {
    if (typeof require[severity] !== "number") {
      errors.push(`policy.approval.require must include the action:"reject" severity "${severity}".`);
    }
  }

  return errors;
}

/**
 * Aggregates findings by severity and applies the approval thresholds.
 *
 * - approved: no severity count exceeds its threshold
 * - rejected: at least one threshold is exceeded; reasons name each one
 * - invalid: findings contain malformed entries or unknown severities
 *
 * @param {readonly ReviewFinding[]} findings
 * @param {ReviewPolicy} policy
 * @returns {ReviewDecision}
 */
export function decideReview(findings, policy) {
  const severities = Object.keys(policy.severity);
  const require = policy.approval.require;
  const counts = {};

  for (const severity of severities) {
    counts[severity] = 0;
  }

  if (!Array.isArray(findings)) {
    return { status: "invalid", counts, reasons: ["findings must be an array."] };
  }

  const invalidFindings = [];

  for (const [index, finding] of findings.entries()) {
    const severity = isRecord(finding) ? finding.severity : undefined;
    if (typeof severity !== "string" || !Object.prototype.hasOwnProperty.call(counts, severity)) {
      invalidFindings.push(index);
      continue;
    }
    counts[severity] += 1;
  }

  if (invalidFindings.length > 0) {
    return {
      status: "invalid",
      counts,
      reasons: [`findings contain unknown severity at index ${invalidFindings.join(", ")}.`]
    };
  }

  const reasons = [];

  for (const severity of severities) {
    const threshold = require[severity];
    if (typeof threshold === "number" && counts[severity] > threshold) {
      reasons.push(
        `severity "${severity}" has ${counts[severity]} finding(s), which exceeds the allowed ${threshold}.`
      );
    }
  }

  if (reasons.length > 0) {
    return { status: "rejected", counts, reasons };
  }

  return { status: "approved", counts, reasons: [] };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
