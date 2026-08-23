import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createDecisionContext,
  createOpenCodeDelegation,
  loadWorkflowRegistry
} from "../src/adapters/opencode/opencode-adapter.js";

const fixturesDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/workflows"
);
const projectWorkflowsDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../workflows"
);

test("Workflow YAMLを読み込み、sourcePath付きRegistryを構築する", async () => {
  const registry = await loadWorkflowRegistry(fixturesDirectory);

  assert.deepEqual(registry.map((workflow) => workflow.name), [
    "bug-fix",
    "feature-development"
  ]);
  assert.match(registry[0].sourcePath, /bug-fix\.yaml$/);
});

test("DecisionContextは要求と読込済みRegistryだけで構築する", async () => {
  const registry = await loadWorkflowRegistry(fixturesDirectory);
  const request = { intent: "feature", goal: "利用者が設定を保存できる" };

  assert.deepEqual(createDecisionContext(request, registry), {
    request,
    workflowRegistry: registry
  });
});

test("readyのDelegation PlanをOpenCode Markdownコマンドへ変換する", async () => {
  const registry = await loadWorkflowRegistry(fixturesDirectory);
  const delegation = createOpenCodeDelegation(
    { intent: "feature", goal: "利用者が設定を保存できる" },
    registry
  );

  assert.equal(delegation.delegationPlan.status, "ready");
  assert.equal(
    delegation.command?.relativePath,
    ".opencode/commands/harness-feature-development.md"
  );
  assert.match(delegation.command?.content ?? "", /^---\ndescription: /);
  assert.match(delegation.command?.content ?? "", /AGENTS\.md/);
  assert.match(delegation.command?.content ?? "", /agents\/architect\.yaml/);
});

test("readyでないPlanはOpenCodeコマンドへ変換しない", async () => {
  const registry = await loadWorkflowRegistry(fixturesDirectory);
  const delegation = createOpenCodeDelegation({ intent: "feature" }, registry);

  assert.equal(delegation.delegationPlan.status, "needs_clarification");
  assert.equal(delegation.command, null);
});

for (const { intent, request, workflow } of [
  { intent: "review", request: { review_target: "現在の変更差分" }, workflow: "review" },
  { intent: "design", request: { goal: "通知設定を追加する" }, workflow: "design" },
  { intent: "refactor", request: { target: "認証モジュール", goal: "重複を減らす" }, workflow: "refactor" },
  { intent: "research", request: { question: "キャッシュ方式の選択肢は何か" }, workflow: "research" }
]) {
  test(`Workflow YAML Registryから${intent}を${workflow}へルーティングする`, async () => {
    const registry = await loadWorkflowRegistry(projectWorkflowsDirectory);
    const delegation = createOpenCodeDelegation({ intent, ...request }, registry);

    assert.equal(delegation.delegationPlan.status, "ready");
    assert.equal(delegation.delegationPlan.selectedWorkflow?.name, workflow);
  });
}
