import test from "node:test";
import assert from "node:assert/strict";
import { runHarness } from "../src/run/run-harness.js";
import { createMockRuntimeAdapter } from "../src/runtimes/mock/mock-runtime-adapter.js";
import { createFallbackRuntimeAdapter } from "../src/runtimes/fallback-runtime-adapter.js";
import { createMemoryArtifactStore, findArtifactsByType } from "../src/artifacts/artifact-store.js";
import { EXIT_CODES } from "../src/run/run-harness.js";

const implementationArtifact = {
  type: "implementation-result",
  produced_by: "developer",
  unresolved: [],
  changed_files: [{ path: "src/config.js", reason: "保存処理を追加" }]
};

const testArtifact = {
  type: "test-result",
  produced_by: "test-engineer",
  unresolved: [],
  tests: { executed: [{ name: "a.test.js", outcome: "pass" }], pending: [] }
};

const workflowRegistry = [
  {
    name: "feature-development",
    routing: { intents: ["feature"], required_request_fields: ["goal"], priority: 100, risk: ["medium", "high"] },
    steps: [
      { id: "implement", agent: "agents/developer.yaml", gate: "実装がある" },
      { id: "test", agent: "agents/test-engineer.yaml", gate: "検証", on_failure: "implement", retry_policy: { max_attempts: 2 } }
    ]
  },
  {
    name: "lightweight-change",
    routing: { intents: ["feature"], required_request_fields: ["goal"], priority: 100, risk: ["low"] },
    steps: [
      { id: "implement", agent: "agents/developer.yaml", gate: "実装がある" },
      { id: "test", agent: "agents/test-engineer.yaml", gate: "検証", on_failure: "implement", retry_policy: { max_attempts: 2 } }
    ]
  }
];

const passingGates = {
  name: "test-gates",
  purpose: "テスト用",
  commands: [{ id: "unit-tests", title: "Unit tests", command: "npm", args: ["test"] }]
};

function mockRuntime(script = {}) {
  return toStepExecutorBound(createMockRuntimeAdapter({
    script: { implement: [{ artifacts: [implementationArtifact] }], test: [{ artifacts: [testArtifact] }], ...script }
  }));
}

function toStepExecutorBound(adapter) {
  return adapter.executeStep.bind(adapter);
}

test("harness run正常系: goal+intent → Decision → Workflow実行 → exit 0", async () => {
  const store = createMemoryArtifactStore();

  const run = await runHarness({
    goal: "ログインAPIにJWT認証を追加してください",
    intent: "feature",
    workflowRegistry,
    executeStep: mockRuntime(),
    artifactStore: store,
    executionId: "exec-hr-1",
    trackModelExecutions: true
  });

  assert.equal(run.exitCode, EXIT_CODES.SUCCESS);
  assert.equal(run.workflowName, "feature-development");
  assert.equal(run.executionId, "exec-hr-1");
  assert.equal(run.result.status, "completed");
  assert.match(run.message, /完了しました/);
  // GoalがExecution ContextとしてExecution Engineへ渡っている(DecisionのrequestProfileはrisk処理済み)
  assert.equal(run.decision.status, "ready");

  // Model Execution Trackingがrecordとして残る(#22)
  assert.equal(run.result.modelExecutions.length, 2);

  // Artifact Storeへexecution_id/step_id付きで永続化されている(#29)
  const stored = await findArtifactsByType(store, "implementation-result", { executionId: "exec-hr-1" });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].stepId, "implement");
});

test("Risk指定が既存Decision Engineのroutingとして機能する(low→軽量Workflow)", async () => {
  const run = await runHarness({
    goal: "READMEの誤字を修正してください",
    intent: "feature",
    risk: "low",
    workflowRegistry,
    executeStep: mockRuntime()
  });

  assert.equal(run.exitCode, EXIT_CODES.SUCCESS);
  assert.equal(run.workflowName, "lightweight-change");
});

test("goal欠落はexit 2のinvalid inputになる", async () => {
  const run = await runHarness({
    workflowRegistry,
    executeStep: mockRuntime()
  });

  assert.equal(run.exitCode, EXIT_CODES.INVALID_INPUT);
  assert.match(run.message, /goal が指定されていません/);
});

test("未知intentはDecision Engine経由でexit 2(workflow_not_found)", async () => {
  const run = await runHarness({
    goal: "何かしてください",
    intent: "unknown-intent",
    workflowRegistry,
    executeStep: mockRuntime()
  });

  assert.equal(run.exitCode, EXIT_CODES.INVALID_INPUT);
  assert.match(run.message, /決定できませんでした/);
});

test("required field不足もDecision Engine経由でexit 2(needs_clarification)", async () => {
  // goalは渡すが、registryのrequired_request_fieldsに含まれない構成での確認用:
  // ここでは intent 欠落(needs_clarification)を検証する
  const run = await runHarness({
    goal: "ゴールだけ",
    workflowRegistry,
    executeStep: mockRuntime()
  });

  assert.equal(run.exitCode, EXIT_CODES.INVALID_INPUT);
  assert.match(run.message, /intent/);
});

test("Mechanical Verification FAIL → on_failure回路 → 打ち切りでexit 1", async () => {
  // 常に失敗するquality gates: verification failureはコード品質の失敗として
  // Fallbackではなく既存Loop(retry→打ち切り)で処理される
  const failingGates = {
    name: "always-fail",
    purpose: "常に対象外の品質失敗を再現",
    commands: [{ id: "unit-tests", title: "Unit tests", command: "npm", args: ["test"] }]
  };
  const failingRunCommand = async () => ({ exitCode: 1, stdout: "3 tests failed", stderr: "", durationMs: 1 });

  const run = await runHarness({
    goal: "何かを実装してください",
    intent: "feature",
    workflowRegistry,
    executeStep: mockRuntime({
      implement: [{ artifacts: [implementationArtifact] }]
    }),
    verification: { stepId: "test", gates: failingGates, runCommand: failingRunCommand },
    executionId: "exec-hr-2"
  });

  assert.equal(run.exitCode, EXIT_CODES.EXECUTION_FAILED);
  assert.equal(run.result.status, "stopped");
  assert.equal(run.result.stopReason, "retry_exhausted");
  const verification = run.result.artifacts["verification-result"];
  assert.equal(verification.status, "failed");
  assert.deepEqual(verification.failed_gates, ["unit-tests"]);
});

test("承認されていないPlanは実行されない(exit 3)", async () => {
  const run = await runHarness({
    goal: "何かを実装してください",
    intent: "feature",
    workflowRegistry,
    executeStep: mockRuntime(),
    plan: { approved: false, intent: "feature" }
  });

  assert.equal(run.exitCode, EXIT_CODES.PLAN_NOT_APPROVED);
  assert.equal(run.result, null);
  assert.match(run.message, /承認されていません/);
});

test("承認済みPlanは実行される(#34との境界: 最小契約のみ)", async () => {
  const run = await runHarness({
    workflowRegistry,
    executeStep: mockRuntime(),
    plan: { approved: true, goal: "JWT認証を追加", intent: "feature", risk: "high", unknownFutureField: "plan側の拡張は保持される" }
  });

  assert.equal(run.exitCode, EXIT_CODES.SUCCESS);
  assert.equal(run.workflowName, "feature-development");
});

test("Fallback構成のRuntimeがrate limitから回復してexit 0になる(#23利用、CLI再実装なし)", async () => {
  const adapter = createFallbackRuntimeAdapter({
    policy: {
      primary: { provider: "openai", model: "gpt-5.6-terra" },
      fallbacks: [{ provider: "google", model: "gemini-pro" }],
      maxFallbacks: 1
    },
    createDelegate: (candidate) => ({
      name: "mock",
      async executeStep(request) {
        if (candidate.provider === "openai") {
          return { status: "failed", failure: { reason: "429" }, runtime: { runtime: "mock", provider: candidate.provider, model: candidate.model, errorCategory: "rate_limited", exitCode: null } };
        }
        return { status: "succeeded", artifacts: [implementationArtifact], runtime: { runtime: "mock", provider: candidate.provider, model: candidate.model, exitCode: 0 } };
      }
    })
  });

  const run = await runHarness({
    goal: "JWT認証を追加",
    intent: "feature",
    workflowRegistry: [{ name: "feature-development", routing: { intents: ["feature"], required_request_fields: ["goal"], priority: 100 }, steps: [{ id: "implement", agent: "agents/developer.yaml", gate: "g" }] }],
    executeStep: toStepExecutorBound(adapter),
    executionId: "exec-hr-3"
  });

  assert.equal(run.exitCode, EXIT_CODES.SUCCESS);
  assert.equal(run.result.modelExecutions[0].fallbackCount, 1);
  assert.equal(run.result.modelExecutions[0].fallback.toProvider, "google");
});

test("Guardrails違反のoutcomeはFallbackされず、Failure ResultとしてExecution Resultへ伝播する", async () => {
  const adapter = createFallbackRuntimeAdapter({
    policy: {
      primary: { provider: "openai", model: "gpt-5.6-terra" },
      fallbacks: [{ provider: "google", model: "gemini-pro" }],
      maxFallbacks: 1
    },
    createDelegate: () => ({
      name: "mock",
      async executeStep() {
        return { status: "failed", failure: { reason: "refused: shell_disabled" }, runtime: { runtime: "mock", errorCategory: "guardrail_violation", exitCode: null } };
      }
    })
  });

  const run = await runHarness({
    goal: "JWT認証を追加",
    intent: "feature",
    workflowRegistry: [{ name: "single", routing: { intents: ["feature"], required_request_fields: ["goal"], priority: 100 }, steps: [{ id: "implement", agent: "agents/developer.yaml", gate: "g" }] }],
    executeStep: toStepExecutorBound(adapter),
    executionId: "exec-hr-4"
  });

  assert.equal(run.exitCode, EXIT_CODES.EXECUTION_FAILED);
  // Guardrails違反はfallback対象外: 1回の試行で即Failure Resultになる
  assert.match(run.result.failure.reason, /refused: shell_disabled/);
  const record = run.result.modelExecutions[0];
  assert.equal(record.errorCategory, "guardrail_violation");
  assert.equal(record.fallbackCount, 0);
});

test("nonInteractiveフラグが受入れられ、実行結果に反映される", async () => {
  const run = await runHarness({
    goal: "JWT認証を追加",
    intent: "feature",
    workflowRegistry,
    executeStep: mockRuntime(),
    executionId: "exec-hr-5",
    nonInteractive: true
  });

  assert.equal(run.exitCode, EXIT_CODES.SUCCESS);
  assert.equal(run.executionId, "exec-hr-5");
});
