import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMemoryArtifactStore,
  saveArtifact
} from "../src/artifacts/artifact-store.js";
import { createFileArtifactStore } from "../src/artifacts/file-artifact-store.js";
import {
  getExecutionHistory,
  listExecutionSummaries
} from "../src/run/execution-history.js";

const implementationArtifact = {
  type: "implementation-result",
  produced_by: "developer",
  unresolved: [],
  changed_files: [{ path: "src/config.js", reason: "保存処理を追加" }]
};

const executionResultArtifact = (overrides = {}) => ({
  type: "execution-result",
  produced_by: "harness",
  unresolved: [],
  executionId: "exec-1",
  status: "completed",
  workflow: "feature-development",
  goal: "JWT認証を追加",
  intent: "feature",
  risk: "high",
  startedAt: "2026-09-19T10:00:00.000Z",
  completedAt: "2026-09-19T10:05:00.000Z",
  durationMs: 300000,
  ...overrides
});

/**
 * 3件の実行を投入したstoreを作る:
 * - exec-1: completed(plan/model record/implementation/verification付き)
 * - exec-2: failed(guardrail拒否あり)
 * - exec-3: secret漏洩failure(redaction検証用)
 */
async function seededStore(makeStore) {
  const store = await makeStore();
  await saveArtifact(store, {
    artifactId: "execution-plan", executionId: "exec-1", stepId: "plan",
    artifact: { type: "execution-plan", produced_by: "harness", unresolved: [], planId: "plan-abc123", workflow: "feature-development", status: "approved", plan: { planHash: "deadbeef" } }
  });
  await saveArtifact(store, {
    artifactId: "implementation-result", executionId: "exec-1", stepId: "implement",
    artifact: implementationArtifact
  });
  await saveArtifact(store, {
    artifactId: "model-execution-record", executionId: "exec-1", stepId: "implement",
    artifact: { type: "model-execution-record", produced_by: "harness", unresolved: [], executionId: "exec-1", stepId: "implement", attempt: 1, runtime: "opencode", status: "succeeded", record: { agent: "developer", resolvedProvider: "openai", resolvedModel: "gpt-5.6-terra" } }
  });
  await saveArtifact(store, {
    artifactId: "verification-result", executionId: "exec-1", stepId: "test",
    artifact: { type: "verification-result", produced_by: "test-engineer", unresolved: [], status: "passed", gates: [{ id: "unit-tests", status: "passed" }], failed_gates: [] }
  });
  await saveArtifact(store, {
    artifactId: "execution-result", executionId: "exec-1", stepId: "execution",
    artifact: executionResultArtifact({ planId: "plan-abc123" })
  });
  await saveArtifact(store, {
    artifactId: "model-execution-record", executionId: "exec-2", stepId: "implement",
    artifact: { type: "model-execution-record", produced_by: "harness", unresolved: [], executionId: "exec-2", stepId: "implement", attempt: 1, runtime: "mock", status: "failed", errorCategory: "guardrail_violation", fallbackCount: 0, record: { failureReason: "refused: shell_disabled", agent: "developer" } }
  });
  await saveArtifact(store, {
    artifactId: "execution-result", executionId: "exec-2", stepId: "execution",
    artifact: executionResultArtifact({ executionId: "exec-2", status: "failed", workflow: "bug-fix", goal: "バグ修正", startedAt: "2026-09-18T09:00:00.000Z" })
  });
  await saveArtifact(store, {
    artifactId: "model-execution-record", executionId: "exec-3", stepId: "implement",
    artifact: { type: "model-execution-record", produced_by: "harness", unresolved: [], executionId: "exec-3", stepId: "implement", attempt: 1, runtime: "mock", status: "failed", errorCategory: "nonzero_exit", fallbackCount: 0, record: { failureReason: "leak: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", agent: "developer" } }
  });
  await saveArtifact(store, {
    artifactId: "execution-result", executionId: "exec-3", stepId: "execution",
    artifact: executionResultArtifact({ executionId: "exec-3", status: "failed", workflow: "refactor", goal: "リファクタリング", startedAt: "2026-09-17T09:00:00.000Z" })
  });
  return store;
}

const storeFactories = [
  ["memory", () => createMemoryArtifactStore()],
  ["file", async () => createFileArtifactStore({ rootDirectory: await mkdtemp(join(tmpdir(), "harness-history-")) })]
];

for (const [label, makeStore] of storeFactories) {
  test(`[${label}] Execution一覧が新着順で取得でき、limitが機能する`, async () => {
    const store = await seededStore(makeStore);

    const all = await listExecutionSummaries(store, { limit: 10 });
    assert.deepEqual(all.map((summary) => summary.executionId), ["exec-1", "exec-2", "exec-3"]);

    const limited = await listExecutionSummaries(store, { limit: 2 });
    assert.deepEqual(limited.map((summary) => summary.executionId), ["exec-1", "exec-2"]);
  });

  test(`[${label}] status / workflow / since filterが機能する`, async () => {
    const store = await seededStore(makeStore);

    const failed = await listExecutionSummaries(store, { limit: 10, status: "failed" });
    assert.deepEqual(failed.map((summary) => summary.executionId), ["exec-2", "exec-3"]);

    const byWorkflow = await listExecutionSummaries(store, { limit: 10, workflow: "bug-fix" });
    assert.deepEqual(byWorkflow.map((summary) => summary.executionId), ["exec-2"]);

    const sinceRecent = await listExecutionSummaries(store, { limit: 10, since: "2026-09-19T00:00:00.000Z" });
    assert.deepEqual(sinceRecent.map((summary) => summary.executionId), ["exec-1"]);
    const sinceFuture = await listExecutionSummaries(store, { limit: 10, since: "2099-01-01T00:00:00.000Z" });
    assert.deepEqual(sinceFuture, []);
  });

  test(`[${label}] 詳細取得: goal/workflow/plan/steps/model/verification/artifacts`, async () => {
    const store = await seededStore(makeStore);

    const history = await getExecutionHistory(store, { executionId: "exec-1" });

    assert.equal(history.executionId, "exec-1");
    assert.equal(history.goal, "JWT認証を追加");
    assert.equal(history.workflow, "feature-development");
    assert.equal(history.planId, "plan-abc123");
    assert.equal(history.planHash, "deadbeef");
    assert.equal(history.status, "completed");
    assert.equal(history.durationMs, 300000);

    assert.ok(history.artifacts.some((artifact) => artifact.artifactId === "implementation-result" && artifact.stepId === "implement"));
    assert.equal(history.verification[0].status, "passed");
    assert.deepEqual(history.verification[0].gates, [{ id: "unit-tests", status: "passed" }]);
  });

  test(`[${label}] 存在しない実行はnull(明確なnot found)`, async () => {
    const store = await makeStore();
    assert.equal(await getExecutionHistory(store, { executionId: "missing" }), null);
    assert.deepEqual(await listExecutionSummaries(store), []);
  });

  test(`[${label}] 不正なexecution idは機械判定エラーになる`, async () => {
    const store = await makeStore();
    await assert.rejects(
      () => getExecutionHistory(store, { executionId: "../escape" }),
      (error) => error.code === "invalid_entry"
    );
  });

  test(`[${label}] secretを含むfailureはHistory表示時にredactionされる`, async () => {
    const store = await seededStore(makeStore);

    const history = await getExecutionHistory(store, { executionId: "exec-3" });
    const serialized = JSON.stringify(history);
    assert.equal(serialized.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);
    assert.ok(history.modelExecutions.some((record) => String(record.failureReason ?? "").includes("[redacted")));
  });

  test(`[${label}] Guardrail拒否とFallback履歴が参照できる`, async () => {
    const store = await seededStore(makeStore);
    await saveArtifact(store, {
      artifactId: "model-execution-record", executionId: "exec-2", stepId: "implement",
      artifact: { type: "model-execution-record", produced_by: "harness", unresolved: [], executionId: "exec-2", stepId: "implement", attempt: 2, runtime: "mock", status: "succeeded", errorCategory: null, fallbackCount: 1, fallback: { fromProvider: "openai", fromModel: "gpt-5.6-terra", toProvider: "google", toModel: "gemini-pro", reason: "rate_limited", count: 1, attempts: [] }, record: { agent: "developer", resolvedProvider: "google", resolvedModel: "gemini-pro" } }
    });

    const history = await getExecutionHistory(store, { executionId: "exec-2" });

    assert.equal(history.guardrailDenials.length, 1);
    assert.equal(history.guardrailDenials[0].reason, "refused: shell_disabled");
    assert.equal(history.fallbacks.length, 1);
    assert.equal(history.fallbacks[0].reason, "rate_limited");
    assert.equal(history.fallbacks[0].result, "succeeded");
  });
}
