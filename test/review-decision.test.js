import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { decideReview, validateReviewPolicy } from "../src/review/review-decision.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const policy = {
  severity: {
    blocker: { action: "reject", criteria: "進行を続けられない問題" },
    high: { action: "reject", criteria: "修正と再検証が必須の問題" },
    medium: { action: "report", criteria: "次工程以降で対処すべき問題" },
    low: { action: "ignore", criteria: "任意の改善提案" }
  },
  approval: { require: { blocker: 0, high: 0 } }
};

function finding(severity) {
  return { severity, location: "src/example.js", problem: "問題の要約", rationale: "根拠" };
}

test("blockerが1件ある場合はrejectedを返す", () => {
  const decision = decideReview([finding("blocker")], policy);

  assert.equal(decision.status, "rejected");
  assert.match(decision.reasons[0], /"blocker"/);
});

test("highのみでもrejectedを返す", () => {
  const decision = decideReview([finding("high")], policy);

  assert.equal(decision.status, "rejected");
  assert.match(decision.reasons[0], /"high"/);
});

test("MEDIUMとLOWだけではWorkflowを差し戻さない", () => {
  const decision = decideReview([finding("medium"), finding("low"), finding("medium")], policy);

  assert.equal(decision.status, "approved");
  assert.deepEqual(decision.reasons, []);
  assert.deepEqual(decision.counts, { blocker: 0, high: 0, medium: 2, low: 1 });
});

test("指摘がない場合はapprovedを返す", () => {
  const decision = decideReview([], policy);

  assert.equal(decision.status, "approved");
  assert.deepEqual(decision.counts, { blocker: 0, high: 0, medium: 0, low: 0 });
});

test("未知のseverityを含む場合はinvalidを返す", () => {
  const decision = decideReview([finding("critical"), finding("medium")], policy);

  assert.equal(decision.status, "invalid");
  assert.match(decision.reasons[0], /index 0/);
  assert.equal(decision.counts.medium, 1);
});

test("validateReviewPolicyはreject actionのseverityに閾値を要求する", () => {
  const incomplete = {
    severity: {
      blocker: { action: "reject", criteria: "進行を続けられない問題" },
      medium: { action: "report", criteria: "次工程以降で対処すべき問題" }
    },
    approval: { require: {} }
  };

  assert.deepEqual(validateReviewPolicy(incomplete), [
    'policy.approval.require must include the action:"reject" severity "blocker".'
  ]);
});

test("validateReviewPolicyはreport/ignoreのseverityへの閾値を拒否する", () => {
  const overreaching = {
    ...policy,
    approval: { require: { blocker: 0, high: 0, medium: 0 } }
  };

  assert.deepEqual(validateReviewPolicy(overreaching), [
    'policy.approval.require["medium"] must not threshold a severity whose action is not "reject".'
  ]);
});

test("validateReviewPolicyは未定義severityと不正な閾値を拒否する", () => {
  const malformed = {
    ...policy,
    approval: { require: { blocker: 0, high: -1, critical: 0 } }
  };

  const errors = validateReviewPolicy(malformed);

  assert.deepEqual(errors, [
    'policy.approval.require["high"] must be a non-negative integer.',
    'policy.approval.require["critical"] references undefined severity "critical".'
  ]);
});

test("validateReviewPolicyは不正なactionを拒否する", () => {
  const unknownAction = {
    severity: { blocker: { action: "escalate", criteria: "..." } },
    approval: { require: {} }
  };

  // 未知のactionはrejectと分類されないため、閾値必須のエラーは発生しない。
  assert.deepEqual(validateReviewPolicy(unknownAction), [
    'policy.severity["blocker"].action must be one of "reject", "report", "ignore".'
  ]);
});

test("正本のReviewer定義は機械的承認基準と整合する", async () => {
  const definition = parse(await readFile(join(projectRoot, "agents/reviewer.yaml"), "utf8"));
  const canonicalPolicy = { severity: definition.severity, approval: definition.approval };

  assert.deepEqual(validateReviewPolicy(canonicalPolicy), []);
  assert.equal(decideReview([], canonicalPolicy).status, "approved");
  assert.deepEqual(decideReview([], canonicalPolicy).counts, { blocker: 0, high: 0, medium: 0, low: 0 });
});
