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
      priority: 100,
      risk: ["medium", "high"]
    }
  },
  {
    name: "bug-fix",
    purpose: "不具合を根拠に基づいて修正し、再発を防ぐ",
    routing: {
      intents: ["bug-fix"],
      required_request_fields: ["expected_behavior", "actual_behavior"],
      priority: 100,
      risk: ["medium", "high"]
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
  },
  {
    name: "lightweight-change",
    purpose: "軽微な変更を最小工程で安全に届ける",
    routing: {
      intents: ["feature", "bug-fix"],
      required_request_fields: ["goal"],
      priority: 100,
      risk: ["low"]
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

test("risk=lowの要求では軽量Workflowを選択する", () => {
  const plan = decide({
    request: { intent: "feature", goal: "READMEのtypoを修正する", risk: "low" },
    workflowRegistry
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.selectedWorkflow?.name, "lightweight-change");
});

test("risk未指定は既定のhighとして扱いフルWorkflowを選択する", () => {
  const plan = decide({
    request: { intent: "feature", goal: "利用者が設定を保存できる" },
    workflowRegistry
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.selectedWorkflow?.name, "feature-development");
  assert.equal(plan.requestProfile.risk, "high");
});

test("risk=highでは従来どおりフルWorkflowを選択する", () => {
  const plan = decide({
    request: { intent: "bug-fix", expected_behavior: "保存に成功する", actual_behavior: "エラーが返る", risk: "high" },
    workflowRegistry
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.selectedWorkflow?.name, "bug-fix");
});

test("risk=mediumでもフルWorkflowを選択する", () => {
  const plan = decide({
    request: { intent: "feature", goal: "利用者が設定を保存できる", risk: "medium" },
    workflowRegistry
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.selectedWorkflow?.name, "feature-development");
});

test("宣言されたriskが要求のriskを含まないWorkflowは候補から外れる", () => {
  const plan = decide({
    request: { intent: "bug-fix", goal: "タイポ修正", risk: "low" },
    workflowRegistry
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.selectedWorkflow?.name, "lightweight-change");
});

test("risk語彙外の値はneeds_clarificationを返す", () => {
  const plan = decide({
    request: { intent: "feature", goal: "利用者が設定を保存できる", risk: "minimal" },
    workflowRegistry
  });

  assert.equal(plan.status, "needs_clarification");
  assert.deepEqual(plan.clarification?.missing_fields, ["risk"]);
  assert.equal(plan.diagnostics[0].code, "invalid_risk");
});

test("complexity語彙外の値はneeds_clarificationを返す", () => {
  const plan = decide({
    request: { intent: "feature", goal: "利用者が設定を保存できる", complexity: "huge" },
    workflowRegistry
  });

  assert.equal(plan.status, "needs_clarification");
  assert.deepEqual(plan.clarification?.missing_fields, ["complexity"]);
  assert.equal(plan.diagnostics[0].code, "invalid_complexity");
});

test("planには実効riskとcomplexityのrequestProfileを記録する", () => {
  const plan = decide({
    request: { intent: "feature", goal: "READMEのtypoを修正する", risk: "low", complexity: "low" },
    workflowRegistry
  });

  assert.deepEqual(plan.requestProfile, { risk: "low", complexity: "low" });
});

test("complexity未指定はnullとして記録され選択に影響しない", () => {
  const plan = decide({
    request: { intent: "feature", goal: "利用者が設定を保存できる", risk: "low" },
    workflowRegistry
  });

  assert.deepEqual(plan.requestProfile, { risk: "low", complexity: null });
  assert.equal(plan.selectedWorkflow?.name, "lightweight-change");
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

test("同一intentに同一優先度のWorkflowが複数ある場合はblockedを返す", () => {
  const plan = decide({
    request: { intent: "feature", goal: "利用者が設定を保存できる" },
    workflowRegistry: [
      workflowRegistry[0],
      {
        name: "feature-development-quick",
        purpose: "小規模な機能追加向けのWorkflow",
        routing: {
          intents: ["feature"],
          required_request_fields: ["goal"],
          priority: 100
        }
      }
    ]
  });

  assert.equal(plan.status, "blocked");
  assert.equal(plan.selectedWorkflow, null);
  assert.equal(plan.diagnostics[0].code, "ambiguous_workflow");
});

test("同一intentでは優先度が高いWorkflowを選択する", () => {
  const plan = decide({
    request: { intent: "feature", goal: "利用者が設定を保存できる" },
    workflowRegistry: [
      workflowRegistry[0],
      {
        name: "feature-development-urgent",
        routing: {
          intents: ["feature"],
          required_request_fields: ["goal"],
          priority: 110
        }
      }
    ]
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.selectedWorkflow?.name, "feature-development-urgent");
});

test("priority未指定のWorkflowは既定の0として扱われる", () => {
  // CIの `validate:workflows` を通過したRegistryではpriorityは必ず有限数のため、
  // この状況は検証済みRegistryでは発生しない。ここではEngineの契約（`?? 0`）を固定する。
  const plan = decide({
    request: { intent: "feature", goal: "利用者が設定を保存できる" },
    workflowRegistry: [
      {
        name: "feature-development-fallback",
        routing: {
          intents: ["feature"],
          required_request_fields: ["goal"]
        }
      },
      workflowRegistry[0]
    ]
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.selectedWorkflow?.name, "feature-development");
});

test("intentがない場合はneeds_clarificationを返す", () => {
  const plan = decide({ request: {}, workflowRegistry });

  assert.equal(plan.status, "needs_clarification");
  assert.deepEqual(plan.clarification?.missing_fields, ["intent"]);
  assert.equal(plan.diagnostics[0].code, "missing_intent");
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
