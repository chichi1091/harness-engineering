import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBudgetExhaustionArtifact,
  createTokenLedger,
  decideStepBudget,
  recordSpend,
  tokensSpent,
  totalTokensSpent
} from "../src/execution/token-budget.js";

const workflowBudget = { max_total_tokens: 1000, on_budget_exceeded: { action: "stop" } };

test("recordSpendは台帳を非破壊で更新する", () => {
  const ledger = createTokenLedger();
  const next = recordSpend(ledger, "implement", 400);

  assert.equal(tokensSpent(ledger, "implement"), 0);
  assert.equal(tokensSpent(next, "implement"), 400);
  assert.deepEqual(Object.keys(next.spent), ["implement"]);
});

test("recordSpendは負や非数値の消費を拒否する", () => {
  assert.throws(() => recordSpend(createTokenLedger(), "implement", -1));
  assert.throws(() => recordSpend(createTokenLedger(), "implement", Number.NaN));
  assert.throws(() => recordSpend(createTokenLedger(), "implement", "400"));
});

test("totalTokensSpentは全ステップの合計を返す", () => {
  let ledger = createTokenLedger();
  ledger = recordSpend(ledger, "design", 100);
  ledger = recordSpend(ledger, "implement", 400);
  ledger = recordSpend(ledger, "test", 50);

  assert.equal(totalTokensSpent(ledger), 550);
});

test("予算内のステップは実行を許可する", () => {
  let ledger = createTokenLedger();
  ledger = recordSpend(ledger, "design", 800);

  const decision = decideStepBudget({
    ledger,
    stepId: "implement",
    stepBudget: 40000,
    workflowBudget
  });

  assert.equal(decision.status, "within_budget");
  assert.equal(decision.spent, 0);
  assert.equal(decision.totalSpent, 800);
});

test("ステップ予算に達したら超過を返す", () => {
  let ledger = createTokenLedger();
  ledger = recordSpend(ledger, "explore", 500);

  const decision = decideStepBudget({
    ledger,
    stepId: "explore",
    stepBudget: 500,
    workflowBudget
  });

  assert.equal(decision.status, "exceeded");
  assert.equal(decision.scope, "step");
  assert.equal(decision.limit, 500);
  assert.match(decision.reason, /step "explore"/);
});

test("ワークフロー総額に達したらステップ予算より先に超過を返す", () => {
  let ledger = createTokenLedger();
  ledger = recordSpend(ledger, "design", 400);
  ledger = recordSpend(ledger, "explore", 400);
  ledger = recordSpend(ledger, "implement", 200);

  const decision = decideStepBudget({
    ledger,
    stepId: "test",
    stepBudget: 10000,
    workflowBudget
  });

  assert.equal(decision.status, "exceeded");
  assert.equal(decision.scope, "workflow");
  assert.equal(decision.limit, 1000);
  assert.equal(decision.totalSpent, 1000);
});

test("再試行の消費は同じステップ予算に含まれる", () => {
  // test step: initial attempt 600 tokens, retry attempt 400 tokens.
  let ledger = createTokenLedger();
  ledger = recordSpend(ledger, "test", 600);
  ledger = recordSpend(ledger, "test", 400);

  // 総額にはまだ余裕がある(1000 < 5000)ため、ステップ上限で超過判定される。
  const decision = decideStepBudget({
    ledger,
    stepId: "test",
    stepBudget: 1000,
    workflowBudget: { max_total_tokens: 5000, on_budget_exceeded: { action: "stop" } }
  });

  assert.equal(decision.status, "exceeded");
  assert.equal(decision.scope, "step");
  assert.equal(decision.spent, 1000);
});

test("ステップ予算のみでも超過判定できる", () => {
  let ledger = createTokenLedger();
  ledger = recordSpend(ledger, "implement", 5000);

  const decision = decideStepBudget({ ledger, stepId: "implement", stepBudget: 4000 });

  assert.equal(decision.status, "exceeded");
  assert.equal(decision.scope, "step");
});

test("予算超過の成果物は完了済み・未完了・未解決を返す", () => {
  let ledger = createTokenLedger();
  ledger = recordSpend(ledger, "design", 8000);
  ledger = recordSpend(ledger, "explore", 8000);
  ledger = recordSpend(ledger, "implement", 600);

  const artifact = buildBudgetExhaustionArtifact({
    workflowName: "feature-development",
    stepId: "test",
    ledger,
    workflowBudget,
    stepBudget: 10000,
    completedWork: ["design", "explore", "implement"],
    remainingWork: ["test", "review", "document"],
    unresolved: ["受入条件2の検証"]
  });

  assert.equal(artifact.type, "budget_exhausted");
  assert.equal(artifact.workflow, "feature-development");
  assert.equal(artifact.step, "test");
  assert.equal(artifact.total_tokens_spent, 16600);
  assert.equal(artifact.max_total_tokens, 1000);
  assert.deepEqual(artifact.completed_work, ["design", "explore", "implement"]);
  assert.deepEqual(artifact.remaining_work, ["test", "review", "document"]);
  assert.deepEqual(artifact.unresolved, ["受入条件2の検証"]);
  assert.match(artifact.message, /完了済み: design、explore、implement/);
  assert.match(artifact.message, /未完了: test、review、document/);
  assert.match(artifact.message, /未解決事項: 受入条件2の検証/);
  assert.match(artifact.message, /ワークフロー総額/);
});

test("ワークフロー予算なしの超過成果物はステップ上限を理由にする", () => {
  let ledger = createTokenLedger();
  ledger = recordSpend(ledger, "implement", 40000);

  const artifact = buildBudgetExhaustionArtifact({
    workflowName: "lightweight-change",
    stepId: "implement",
    ledger,
    stepBudget: 10000,
    completedWork: [],
    remainingWork: ["test"],
    unresolved: []
  });

  assert.equal(artifact.max_total_tokens, null);
  assert.match(artifact.message, /ステップ上限/);
  assert.match(artifact.message, /完了済み: なし/);
});
