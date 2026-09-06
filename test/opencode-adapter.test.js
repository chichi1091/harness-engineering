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

test("retry_policyを持つ正本WorkflowのコマンドにRetry policyセクションを含める", async () => {
  const registry = await loadWorkflowRegistry(projectWorkflowsDirectory);
  const delegation = createOpenCodeDelegation(
    { intent: "feature", goal: "利用者が設定を保存できる" },
    registry
  );

  const content = delegation.command?.content ?? "";
  assert.match(content, /## Retry policy/);
  assert.match(content, /on_failure による差し戻しを実行しないでください/);
  assert.match(content, /- test: 最大 2 回まで実行できます（on_failure: implement）。/);
  assert.match(
    content,
    /- review: 最大 2 回まで実行できます（on_failure: implement）。再試行は失敗に blocker、high が含まれる場合に限ります。/
  );
  assert.match(content, /未解決事項を利用者へ返してください/);
});

test("retry_policyを持たないWorkflowのコマンドにRetry policyセクションを含めない", async () => {
  const registry = await loadWorkflowRegistry(fixturesDirectory);
  const delegation = createOpenCodeDelegation(
    { intent: "feature", goal: "利用者が設定を保存できる" },
    registry
  );

  assert.doesNotMatch(delegation.command?.content ?? "", /## Retry policy/);
});

test("artifact型参照を含むWorkflowのコマンドにArtifact contractsセクションを含める", async () => {
  const registry = await loadWorkflowRegistry(projectWorkflowsDirectory);
  const delegation = createOpenCodeDelegation(
    { intent: "feature", goal: "利用者が設定を保存できる" },
    registry
  );

  const content = delegation.command?.content ?? "";
  assert.match(content, /## Artifact contracts/);
  assert.match(content, /対応する共通Schemaの必須フィールドを満たしてください/);
  assert.match(
    content,
    /implementation-result: 必須 type \/ produced_by \/ unresolved \/ changed_files\(path, reason\)/
  );
  assert.match(
    content,
    /review-result: 必須 type \/ produced_by \/ unresolved \/ decision\(approve or reject\), findings\(severity, location, problem\)/
  );
});

test("artifact型参照を持たないWorkflowのコマンドにArtifact contractsセクションを含めない", async () => {
  const registry = await loadWorkflowRegistry(fixturesDirectory);
  const delegation = createOpenCodeDelegation(
    { intent: "feature", goal: "利用者が設定を保存できる" },
    registry
  );

  assert.doesNotMatch(delegation.command?.content ?? "", /## Artifact contracts/);
});

test("予算を持つWorkflowのコマンドにToken budgetセクションを含める", async () => {
  const registry = await loadWorkflowRegistry(projectWorkflowsDirectory);
  const delegation = createOpenCodeDelegation(
    { intent: "feature", goal: "利用者が設定を保存できる" },
    registry
  );

  const content = delegation.command?.content ?? "";
  assert.match(content, /## Token budget/);
  assert.match(content, /このWorkflow全体で最大 80000 トークンまで使用できます/);
  assert.match(content, /- design: 最大 10000 トークン（再試行の消費を含む）/);
  assert.match(content, /- implement: 最大 40000 トークン（再試行の消費を含む）/);
  assert.match(content, /上限に達した場合は追加のモデル呼び出しを行わずにWorkflowを停止してください/);
  assert.match(content, /完了済み・未完了・未解決事項を成果物として利用者へ返し/);
});

test("予算を持たないWorkflowのコマンドにToken budgetセクションを含めない", async () => {
  const registry = await loadWorkflowRegistry(fixturesDirectory);
  const delegation = createOpenCodeDelegation(
    { intent: "feature", goal: "利用者が設定を保存できる" },
    registry
  );

  assert.doesNotMatch(delegation.command?.content ?? "", /## Token budget/);
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
  { intent: "research", request: { question: "キャッシュ方式の選択肢は何か" }, workflow: "research" },
  { intent: "feature", request: { goal: "READMEのtypoを修正する", risk: "low" }, workflow: "lightweight-change" },
  { intent: "bug-fix", request: { goal: "設定読込時のnullチェックを追加する", risk: "low" }, workflow: "lightweight-change" }
]) {
  test(`Workflow YAML Registryから${intent}を${workflow}へルーティングする`, async () => {
    const registry = await loadWorkflowRegistry(projectWorkflowsDirectory);
    const delegation = createOpenCodeDelegation({ intent, ...request }, registry);

    assert.equal(delegation.delegationPlan.status, "ready");
    assert.equal(delegation.delegationPlan.selectedWorkflow?.name, workflow);
  });
}
