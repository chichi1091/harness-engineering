import test from "node:test";
import assert from "node:assert/strict";
import {
  ESCALATION_CONDITIONS,
  buildEscalationExhaustionArtifact,
  createEscalationLedger,
  decideEscalation,
  escalationCount,
  recordEscalation,
  resolveTierModel
} from "../src/execution/model-tier.js";
import { createTokenLedger, decideStepBudget, recordSpend } from "../src/execution/token-budget.js";

const tiers = {
  economy: { provider: "google", model: "gemini-flash" },
  standard: { provider: "openai", model: "gpt-5.6-terra" },
  premium: { provider: "google", model: "gemini-pro" }
};

const policy = {
  escalation: [
    { when: "low_confidence", tier: "standard" },
    { when: "critical_and_low_confidence", tier: "premium" }
  ],
  max_escalations: 2
};

test("条件語彙は具体性の高い順に固定される", () => {
  assert.deepEqual(ESCALATION_CONDITIONS, ["critical_and_low_confidence", "low_confidence"]);
});

test("resolveTierModelはTierをprovider/modelへ解決する", () => {
  assert.deepEqual(resolveTierModel(tiers, "standard"), { provider: "openai", model: "gpt-5.6-terra" });
  assert.equal(resolveTierModel(tiers, "unknown"), undefined);
});

test("確信できる判断はエスカレーションしない", () => {
  const decision = decideEscalation({
    policy,
    ledger: createEscalationLedger(),
    stepId: "design",
    currentTier: "economy",
    confidence: "high"
  });

  assert.equal(decision.action, "keep");
  assert.equal(decision.tier, "economy");
});

test("low_confidenceは宣言された上位Tierへエスカレーションする", () => {
  const decision = decideEscalation({
    policy,
    ledger: createEscalationLedger(),
    stepId: "design",
    currentTier: "economy",
    confidence: "low"
  });

  assert.equal(decision.action, "escalate");
  assert.equal(decision.tier, "standard");
  assert.deepEqual(decision.record, {
    step: "design",
    from: "economy",
    to: "standard",
    reason: "low_confidence"
  });
});

test("重大かつ判断困難な場合はより具体性の高い条件を優先する", () => {
  const decision = decideEscalation({
    policy,
    ledger: createEscalationLedger(),
    stepId: "review",
    currentTier: "standard",
    confidence: "low",
    critical: true
  });

  assert.equal(decision.action, "escalate");
  assert.equal(decision.tier, "premium");
  assert.equal(decision.record.reason, "critical_and_low_confidence");
});

test("recordEscalationは台帳を非破壊で更新する", () => {
  const ledger = createEscalationLedger();
  const next = recordEscalation(ledger, { step: "design", from: "economy", to: "standard", reason: "low_confidence" });

  assert.equal(escalationCount(ledger), 0);
  assert.equal(escalationCount(next), 1);
  assert.equal(next.records[0].to, "standard");
});

test("エスカレーション上限に達したら利用者へ返すために停止する", () => {
  let ledger = createEscalationLedger();
  ledger = recordEscalation(ledger, { step: "design", from: "economy", to: "standard", reason: "low_confidence" });
  ledger = recordEscalation(ledger, { step: "design", from: "standard", to: "premium", reason: "critical_and_low_confidence" });

  const decision = decideEscalation({
    policy,
    ledger,
    stepId: "design",
    currentTier: "premium",
    confidence: "low",
    critical: true
  });

  assert.equal(decision.action, "stop");
  assert.match(decision.reason, /escalation limit of 2/);
});

test("一致する条件がない場合は現在のTierで継続する", () => {
  const narrowPolicy = { escalation: [{ when: "critical_and_low_confidence", tier: "premium" }], max_escalations: 2 };

  const decision = decideEscalation({
    policy: narrowPolicy,
    ledger: createEscalationLedger(),
    stepId: "explore",
    currentTier: "economy",
    confidence: "low",
    critical: false
  });

  assert.equal(decision.action, "keep");
  assert.equal(decision.tier, "economy");
});

test("エスカレーション後もWorkflow Budgetは継続して適用される", () => {
  // Escalation changes the model, never the ledger: spend recorded before
  // and after escalation accumulates in the same token ledger.
  let tokenLedger = createTokenLedger();
  tokenLedger = recordSpend(tokenLedger, "design", 400);

  const escalationLedger = recordEscalation(
    createEscalationLedger(),
    { step: "design", from: "economy", to: "standard", reason: "low_confidence" }
  );

  tokenLedger = recordSpend(tokenLedger, "design", 600);

  const decision = decideStepBudget({
    ledger: tokenLedger,
    stepId: "design",
    stepBudget: 1000,
    workflowBudget: { max_total_tokens: 1000, on_budget_exceeded: { action: "stop" } }
  });

  assert.equal(escalationCount(escalationLedger), 1);
  assert.equal(decision.status, "exceeded");
  assert.equal(decision.spent, 1000);
});

test("エスカレーション上限到達の成果物は移動履歴と未解決事項を返す", () => {
  let ledger = createEscalationLedger();
  ledger = recordEscalation(ledger, { step: "design", from: "economy", to: "standard", reason: "low_confidence" });
  ledger = recordEscalation(ledger, { step: "design", from: "standard", to: "premium", reason: "critical_and_low_confidence" });

  const artifact = buildEscalationExhaustionArtifact({
    workflowName: "feature-development",
    stepId: "design",
    ledger,
    policy,
    unresolved: ["競合する受入条件の優先順位"]
  });

  assert.equal(artifact.type, "escalation_exhausted");
  assert.equal(artifact.workflow, "feature-development");
  assert.equal(artifact.escalations_used, 2);
  assert.equal(artifact.max_escalations, 2);
  assert.deepEqual(artifact.records, ledger.records);
  assert.deepEqual(artifact.unresolved, ["競合する受入条件の優先順位"]);
  assert.match(artifact.message, /エスカレーション上限（2\/2）/);
  assert.match(artifact.message, /economy→standard\(low_confidence\)/);
  assert.match(artifact.message, /未解決事項: 競合する受入条件の優先順位/);
});
