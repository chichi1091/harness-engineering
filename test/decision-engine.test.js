import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/decision-engine/decision-engine.js";

const workflowRegistry = [
  {
    name: "feature-development",
    purpose: "新機能を設計から文書化まで一貫して届ける",
    routing: {
      intents: ["feature"],
      required_request_fields: ["goal"],
      priority: 100
    }
  },
  {
    name: "bug-fix",
    purpose: "不具合を根拠に基づいて修正し、再発を防ぐ",
    routing: {
      intents: ["bug-fix"],
      required_request_fields: ["expected_behavior", "actual_behavior"],
      priority: 100
    }
  },
  {
    name: "review",
    purpose: "変更または設計を根拠に基づいてレビューし、品質判断を残す",
    routing: {
      intents: ["review"],
      required_request_fields: ["review_target"],
      priority: 100
    }
  },
  {
    name: "design",
    purpose: "実装前に設計方針と受入条件を確立し、レビューする",
    routing: {
      intents: ["design"],
      required_request_fields: ["goal"],
      priority: 100
    }
  },
  {
    name: "refactor",
    purpose: "外部仕様を維持しながら、保守性を改善する",
    routing: {
      intents: ["refactor"],
      required_request_fields: ["target", "goal"],
      priority: 100
    }
  },
  {
    name: "research",
    purpose: "技術的な問いを調査し、根拠付きの選択肢と推奨を提示する",
    routing: {
      intents: ["research"],
      required_request_fields: ["question"],
      priority: 100
    }
  }
];

test("feature要求ではfeature Workflowを選択する", () => {
  const plan = decide({
    request: { intent: "feature", goal: "利用者が設定を保存できる" },
    workflowRegistry
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.selectedWorkflow?.name, "feature-development");
});

test("bug要求ではbug-fix Workflowを選択する", () => {
  const plan = decide({
    request: {
      intent: "bug-fix",
      expected_behavior: "保存に成功する",
      actual_behavior: "エラーが返る"
    },
    workflowRegistry
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.selectedWorkflow?.name, "bug-fix");
});

for (const { intent, request, workflow } of [
  { intent: "review", request: { review_target: "現在の変更差分" }, workflow: "review" },
  { intent: "design", request: { goal: "通知設定を追加する" }, workflow: "design" },
  { intent: "refactor", request: { target: "認証モジュール", goal: "重複を減らす" }, workflow: "refactor" },
  { intent: "research", request: { question: "キャッシュ方式の選択肢は何か" }, workflow: "research" }
]) {
  test(`${intent}要求ではRegistryから${workflow} Workflowを選択する`, () => {
    const plan = decide({ request: { intent, ...request }, workflowRegistry });

    assert.equal(plan.status, "ready");
    assert.equal(plan.selectedWorkflow?.name, workflow);
  });
}

test("Workflowが存在しない場合はblockedを返す", () => {
  const plan = decide({
    request: { intent: "release" },
    workflowRegistry
  });

  assert.equal(plan.status, "blocked");
  assert.equal(plan.selectedWorkflow, null);
  assert.equal(plan.diagnostics[0].code, "workflow_not_found");
});

test("必要情報が不足する場合はneeds_clarificationを返す", () => {
  const plan = decide({
    request: { intent: "feature" },
    workflowRegistry
  });

  assert.equal(plan.status, "needs_clarification");
  assert.deepEqual(plan.clarification?.missing_fields, ["goal"]);
  assert.equal(plan.selectedWorkflow?.name, "feature-development");
});

test("同じ入力から常に同じDelegation Planを返し、入力を変更しない", () => {
  const context = {
    request: { intent: "feature", goal: "利用者が設定を保存できる" },
    workflowRegistry
  };
  const before = structuredClone(context);

  const first = decide(context);
  const second = decide(context);

  assert.deepEqual(first, second);
  assert.deepEqual(context, before);
});
