import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflow } from "../src/execution/execution-engine.js";
import { toStepExecutor } from "../src/runtimes/runtime-adapter.js";
import { createMockRuntimeAdapter } from "../src/runtimes/mock/mock-runtime-adapter.js";
import {
  createMemoryArtifactStore,
  findArtifactsByExecution,
  findArtifactsByStep,
  findArtifactsByType,
  getArtifact,
  saveArtifact
} from "../src/artifacts/artifact-store.js";
import { buildVerificationArtifact } from "../src/verification/verification-engine.js";

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

const workflow = {
  name: "implement-test",
  steps: [
    { id: "implement", agent: "agents/developer.yaml", gate: "実装がある" },
    {
      id: "test",
      agent: "agents/test-engineer.yaml",
      gate: "検証が記録されている",
      on_failure: "implement",
      retry_policy: { max_attempts: 2 }
    }
  ]
};

test("Execution Engineが成果物をArtifact Storeへ永続化する(retry再実行は別version)", async () => {
  const store = createMemoryArtifactStore();
  const adapter = createMockRuntimeAdapter({
    script: {
      implement: [
        { artifacts: [implementationArtifact] },
        { artifacts: [{ ...implementationArtifact, changed_files: [{ path: "src/config.js", reason: "修正後の再実装" }] }] }
      ],
      test: [{ status: "failed", failure: { reason: "1回目の検証失敗" }, tokensSpent: 100 }, { artifacts: [testArtifact] }]
    }
  });

  const result = await runWorkflow({
    workflow,
    executeStep: toStepExecutor(adapter),
    artifactStore: store,
    executionId: "exec-store-1"
  });

  // 既存Loopの挙動(NG→差し戻し→再検証→OK)は不変
  assert.equal(result.status, "completed");
  assert.deepEqual(result.executionTrace.map((entry) => entry.stepId), ["implement", "test", "implement", "test"]);

  // Stepごとの成果物がexecution_id/step_id付きで永続化されている
  const implementArtifacts = await findArtifactsByStep(store, "exec-store-1", "implement");
  assert.equal(implementArtifacts.length, 2); // 再実行分も含め両方記録
  assert.deepEqual(implementArtifacts.map((record) => record.version).sort(), [1, 2]);
  assert.ok(implementArtifacts.every((record) => record.producer === "developer"));

  const testArtifacts = await findArtifactsByStep(store, "exec-store-1", "test");
  // 1回目のtest失敗outcomeは成果物を持たないため、保存は再検証成功分の1件
  assert.equal(testArtifacts.length, 1);

  // #22/#23との突合キー(execution_id + type + version)で辿れる
  const byType = await findArtifactsByType(store, "implementation-result", { executionId: "exec-store-1" });
  assert.equal(byType.length, 2);
});

test("store指定時にexecutionIdが欠けていれば即座に拒否される", async () => {
  await assert.rejects(
    () => runWorkflow({ workflow, executeStep: toStepExecutor(createMockRuntimeAdapter({})), artifactStore: createMemoryArtifactStore() }),
    /executionId is required/
  );
});

test("store保存の失敗はartifact_store_error diagnosticsとして機械判定可能(Loopは継続)", async () => {
  // 常に書き込みに失敗するstore(ディスク満杯等の模倣)。契約は満たす。
  const { ArtifactStoreError } = await import("../src/artifacts/artifact-store.js");
  const failingStore = {
    kind: "failing",
    listAll: async () => [],
    writeRecord: async () => {
      throw new ArtifactStoreError("version_conflict", "simulated store failure");
    }
  };

  const adapter = createMockRuntimeAdapter({
    script: { implement: [{ artifacts: [{ ...implementationArtifact }] }] }
  });

  const result = await runWorkflow({
    workflow: { name: "single", steps: [{ id: "implement", agent: "agents/developer.yaml", gate: "g" }] },
    executeStep: toStepExecutor(adapter),
    artifactStore: failingStore,
    executionId: "exec-conflict"
  });

  // 保存失敗でもworkflow自体は成功として完走する
  assert.equal(result.status, "completed");
  const storeDiagnostic = result.diagnostics.find((diagnostic) => diagnostic.code === "artifact_store_error");
  assert.notEqual(storeDiagnostic, undefined);
  assert.match(storeDiagnostic.message, /simulated store failure/);
});

test("Mechanical Verificationのverification-resultをStoreへ保存・取得できる", async () => {
  const store = createMemoryArtifactStore();
  const artifact = buildVerificationArtifact(
    { name: "gates", status: "passed", failedGates: [], notRunGates: [], results: [{ id: "unit-tests", status: "passed", exitCode: 0, durationMs: 1, output: null }], message: "ok" },
    { producedBy: "test-engineer" }
  );

  await saveArtifact(store, {
    artifactId: "verification-result",
    executionId: "exec-verify-manual",
    stepId: "test",
    artifact
  });

  const record = await getArtifact(store, "verification-result");
  assert.notEqual(record, null);
  assert.equal(record.type, "verification-result");
  assert.equal(record.producer, "test-engineer");
  assert.equal(record.artifact.status, "passed");

  // Developer → Test → verification-result → Store の流れをEngine統合でも確認
  const workflowWithVerification = {
    name: "implement-test",
    steps: [
      { id: "implement", agent: "agents/developer.yaml", gate: "実装がある" },
      { id: "test", agent: "agents/test-engineer.yaml", gate: "検証が記録されている" }
    ]
  };
  const adapter = createMockRuntimeAdapter({
    script: {
      implement: [{ artifacts: [implementationArtifact] }],
      test: [{ artifacts: [artifact] }]
    }
  });
  const result = await runWorkflow({
    workflow: workflowWithVerification,
    executeStep: toStepExecutor(adapter),
    artifactStore: store,
    executionId: "exec-verify"
  });

  assert.equal(result.status, "completed");
  const persisted = await findArtifactsByType(store, "verification-result", { executionId: "exec-verify" });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].stepId, "test");
});

test("Step間Context Handoff: Storeを介して次Stepが成果物を取得して処理できる", async () => {
  const store = createMemoryArtifactStore();

  // Step A(implement)が成果物を産み、Storeへ保存される
  const adapter = createMockRuntimeAdapter({
    script: {
      implement: [{ artifacts: [implementationArtifact] }],
      test: [{ artifacts: [testArtifact] }]
    }
  });

  // Testステップは会話履歴なしで、request.artifacts(EngineがStore由来の
  // 最新成果物を供給)だけを根拠に検証できる。ここではRuntimeが受け取った
  // contextを検査する簡易ランタイムで handoff を実証する
  const receivedContexts = [];
  const executeStep = async (request) => {
    receivedContexts.push({ stepId: request.stepId, artifacts: { ...request.artifacts } });
    return toStepExecutor(adapter).executeStep ? adapter.executeStep(request) : adapter.executeStep(request);
  };

  const result = await runWorkflow({
    workflow,
    executeStep,
    artifactStore: store,
    executionId: "exec-handoff"
  });

  assert.equal(result.status, "completed");
  // Testステップは会話履歴なしに implementation-result をContextとして受け取った
  const testContext = receivedContexts.find((context) => context.stepId === "test");
  assert.equal(testContext.artifacts["implementation-result"].type, "implementation-result");

  // Store側からも同一成果物が取得でき、handoffの正本として機能する
  const stored = await getArtifact(store, "implementation-result");
  assert.equal(stored.artifact.changed_files[0].path, testContext.artifacts["implementation-result"].changed_files[0].path);
});
