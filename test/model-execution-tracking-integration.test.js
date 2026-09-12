import test from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../src/execution/execution-engine.js";
import { toStepExecutor } from "../src/runtimes/runtime-adapter.js";
import { createMockRuntimeAdapter } from "../src/runtimes/mock/mock-runtime-adapter.js";
import { createOpenCodeRuntimeAdapter } from "../src/runtimes/opencode/opencode-runtime-adapter.js";
import { createMemoryArtifactStore, findArtifactsByType } from "../src/artifacts/artifact-store.js";
import { createGuardedCommandRunner } from "../src/guardrails/guarded-command-runner.js";
import { createDefaultActionPolicy } from "../src/guardrails/action-policy.js";

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

test("全実行のModel Execution Recordがattempt順に記録される(retry=attempt区別)", async () => {
  const adapter = createMockRuntimeAdapter({
    name: "opencode",
    provider: "zai",
    model: "glm-5.2",
    script: {
      implement: [{ tokensSpent: 500 }, { tokensSpent: 600 }],
      test: [{ status: "failed", failure: { reason: "検証NG" }, tokensSpent: 100 }, { artifacts: [testArtifact], tokensSpent: 200 }]
    }
  });

  const result = await runWorkflow({
    workflow,
    executeStep: toStepExecutor(adapter),
    executionId: "exec-track-1"
  });

  assert.equal(result.status, "completed");
  assert.equal(result.modelExecutions.length, 4);

  // Developer attempt 1 → Test attempt 1(NG) → Developer attempt 2 → Test attempt 2(OK)
  assert.deepEqual(
    result.modelExecutions.map((record) => `${record.stepId}#${record.attempt}:${record.status}`),
    ["implement#1:succeeded", "test#1:failed", "implement#2:succeeded", "test#2:succeeded"]
  );

  const firstTest = result.modelExecutions[1];
  assert.equal(firstTest.attempt, 1);
  assert.equal(firstTest.status, "failed");
  assert.equal(firstTest.errorCategory, null);
  assert.match(firstTest.failureReason, /検証NG/);

  const secondTest = result.modelExecutions[3];
  assert.equal(secondTest.attempt, 2);
  assert.equal(secondTest.status, "succeeded");

  // 全レコードでprovider/model/runtimeが記録されている
  assert.ok(result.modelExecutions.every((record) => record.resolvedProvider === "zai"));
  assert.ok(result.modelExecutions.every((record) => record.resolvedModel === "glm-5.2"));
  assert.ok(result.modelExecutions.every((record) => record.runtime === "opencode"));
});

test("max_attempts停止の試行も追跡される", async () => {
  const adapter = createMockRuntimeAdapter({
    script: {
      implement: [{ tokensSpent: 1 }, { tokensSpent: 1 }, { tokensSpent: 1 }],
      test: [{ status: "failed", failure: { reason: "NG1" } }, { status: "failed", failure: { reason: "NG2" } }, { status: "failed", failure: { reason: "NG3" } }]
    }
  });

  const result = await runWorkflow({ workflow, executeStep: toStepExecutor(adapter), executionId: "exec-track-2" });

  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, "retry_exhausted");
  assert.equal(result.modelExecutions.length, 4); // implement×2 + test×2
  const testRuns = result.modelExecutions.filter((record) => record.stepId === "test");
  assert.deepEqual(testRuns.map((record) => record.attempt), [1, 2]);
  assert.deepEqual(testRuns.map((record) => record.status), ["failed", "failed"]);
  assert.match(testRuns[1].failureReason, /NG2/);
});

test("token usage・duration・timestampsがrecordに記録される", async () => {
  const adapter = createMockRuntimeAdapter({
    script: { implement: [{ tokensSpent: 1234, durationMs: 0 }] }
  });

  const result = await runWorkflow({
    workflow: { name: "single", steps: [{ id: "implement", agent: "agents/developer.yaml", gate: "g" }] },
    executeStep: toStepExecutor(adapter),
    executionId: "exec-track-3"
  });

  const record = result.modelExecutions[0];
  assert.equal(record.tokensSpent, 1234);
  assert.ok(record.startedAt !== null && record.endedAt !== null);
  assert.ok(Date.parse(record.endedAt) >= Date.parse(record.startedAt));
  assert.ok(typeof record.durationMs === "number" && record.durationMs >= 0);
});

test("trackModelExecutions有効時、recordがmodel-execution-record artifactとしてStoreへ保存される", async () => {
  const store = createMemoryArtifactStore();
  const adapter = createMockRuntimeAdapter({
    provider: "google",
    model: "gemini-pro",
    script: {
      implement: [{ tokensSpent: 400 }],
      test: [{ status: "failed", failure: { reason: "NG" } }, { artifacts: [testArtifact] }]
    }
  });

  const result = await runWorkflow({
    workflow,
    executeStep: toStepExecutor(adapter),
    artifactStore: store,
    executionId: "exec-track-4",
    trackModelExecutions: true
  });

  assert.equal(result.status, "completed");
  const records = await findArtifactsByType(store, "model-execution-record", { executionId: "exec-track-4" });
  assert.equal(records.length, 4);

  const storedRecords = records.map((record) => record.artifact);
  const attempts = storedRecords
    .filter((artifact) => artifact.stepId === "test")
    .map((artifact) => artifact.attempt)
    .sort((left, right) => left - right);
  assert.deepEqual(attempts, [1, 2]); // retry区別が永続化されている

  assert.ok(storedRecords.every((artifact) => artifact.produced_by === "harness"));
});

test("OpenCode Runtime Adapterもrequested/resolved modelを報告する", async () => {
  const runner = createGuardedCommandRunner({
    runner: { async runCommand(request) { return { id: request.id, exitCode: 0, stdout: "", stderr: "", durationMs: 3 }; } },
    policy: { ...createDefaultActionPolicy(), shell: { execute: "allow" } },
    permissions: { read: "allow", edit: "allow", write: "allow" },
    profileMode: "write"
  });
  const adapter = createOpenCodeRuntimeAdapter({
    commandRunner: runner,
    provider: "zai",
    model: "glm-5.2",
    projectRoot: process.cwd()
  });

  const outcome = await adapter.executeStep({
    workflowName: "wf",
    stepId: "implement",
    attempt: 1,
    step: { id: "implement", agent: "agents/developer.yaml", gate: "g" },
    artifacts: {}
  });

  assert.equal(outcome.runtime.requestedProvider, "zai");
  assert.equal(outcome.runtime.requestedModel, "glm-5.2");
  assert.equal(outcome.runtime.provider, "zai");
  assert.equal(outcome.runtime.model, "glm-5.2");
});

test("CoreがOpenCode固有実装に依存していないこと: tracking moduleは純粋", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");

  const content = await readFile(join(root, "src/execution/model-execution-tracking.js"), "utf8");
  assert.equal(/child_process/.test(content), false);
  assert.equal(/opencode/i.test(content), false); // OpenCode固有名は登場しない
  assert.equal(/from\s+["'][^"']*node:fs/.test(content), false); // ファイルI/Oもしない
});
