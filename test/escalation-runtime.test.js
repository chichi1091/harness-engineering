import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { createEscalationRuntimeAdapter } from "../src/runtimes/escalation-runtime-adapter.js";
import { createMockRuntimeAdapter } from "../src/runtimes/mock/mock-runtime-adapter.js";
import { getExecutionHistory } from "../src/run/execution-history.js";
import { createMemoryArtifactStore, saveArtifact } from "../src/artifacts/artifact-store.js";
import { formatExecutionVisualization } from "../src/run/execution-visualization.js";
import { buildExecutionVisualization } from "../src/run/execution-visualization.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A two-tier profile policy in the shape of profiles/*.yaml. */
const tiers = {
  standard: { provider: "openai", model: "gpt-standard" },
  premium: { provider: "google", model: "gemini-pro" }
};
const modelPolicy = {
  escalation: [
    { when: "critical_and_low_confidence", tier: "premium" },
    { when: "low_confidence", tier: "premium" }
  ],
  max_escalations: 2
};
const policy = { tier: "standard", tiers, modelPolicy, workflowName: "test-workflow" };

function mockDelegate(script) {
  return () => createMockRuntimeAdapter({ name: "mock", provider: "mock-provider", model: "mock-model", script });
}

function build(policyOverride = {}) {
  return createEscalationRuntimeAdapter({
    name: "escalation",
    policy: { ...policy, ...policyOverride },
    createDelegate: mockDelegate({})
  });
}

// ---------------------------------------------------------------- Case 1: Escalation不要

test("Case 1: confidence報告なしの実行は従来通り(escalation判定も記録も発生しない)", async () => {
  const adapter = build();
  const outcome = await adapter.executeStep({
    stepId: "implement", step: { id: "implement", agent: "agents/developer.yaml" }
  });
  // mock script空 → 成功、confidence報告なし → そのまま返る
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.runtime.confidence, undefined);
  assert.equal(outcome.runtime.escalation, undefined);
});

test("Case 1b: confidence highはkeepで完了する", async () => {
  const adapter = createEscalationRuntimeAdapter({
    name: "escalation",
    policy,
    createDelegate: mockDelegate({ implement: [{ confidence: "high", tokensSpent: 3 }] })
  });
  const outcome = await adapter.executeStep({ stepId: "implement", step: { id: "implement" } });
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.runtime.confidence, "high");
  assert.equal(outcome.runtime.escalation, undefined);
});

// ---------------------------------------------------------------- Case 2: Escalation発生

test("Case 2: low confidenceでhigher tierへescalationし、実行が成功する", async () => {
  let executedProvider = null;
  // 1つのmock adapterがエントリを順に消費する(実運用のdelegateと同様、
  // 状態はadapterの外側の実行環境に属する)
  const delegate = createMockRuntimeAdapter({
    name: "mock",
    provider: "mock-provider",
    model: "mock-model",
    script: {
      implement: [
        { confidence: "low", tokensSpent: 1 },
        { confidence: "high", tokensSpent: 1 }
      ]
    }
  });
  const adapter = createEscalationRuntimeAdapter({
    name: "escalation",
    policy,
    createDelegate: (candidate) => {
      executedProvider = candidate.provider;
      return delegate;
    }
  });

  const outcome = await adapter.executeStep({ stepId: "implement", step: { id: "implement" } });
  assert.equal(outcome.status, "succeeded");
  // 標準tierで低確信 → premium tierへ
  assert.equal(executedProvider, "google"); // premium tierのprovider
  assert.deepEqual(outcome.runtime.escalation, {
    escalated: true,
    fromTier: "standard",
    toTier: "premium",
    reason: "low_confidence"
  });
});

// ---------------------------------------------------------------- Case 3: 記録

test("Case 3: escalation報告がmodel-execution-recordに記録されHistoryから追跡できる", async () => {
  const store = createMemoryArtifactStore();
  await saveArtifact(store, {
    artifactId: "model-execution-record", executionId: "exec-esc-1", stepId: "implement",
    artifact: {
      type: "model-execution-record", produced_by: "harness", unresolved: [],
      executionId: "exec-esc-1", stepId: "implement", attempt: 1, runtime: "mock", status: "succeeded",
      requestedTier: "standard", resolvedTier: "premium",
      escalation: { escalated: true, fromTier: "standard", toTier: "premium", reason: "low_confidence" },
      record: { agent: "developer" }
    }
  });
  await saveArtifact(store, {
    artifactId: "execution-result", executionId: "exec-esc-1", stepId: "execution",
    artifact: {
      type: "execution-result", produced_by: "harness", unresolved: [],
      executionId: "exec-esc-1", status: "completed", workflow: "feature-development",
      startedAt: "2026-09-25T10:00:00.000Z", completedAt: "2026-09-25T10:01:00.000Z"
    }
  });

  const history = await getExecutionHistory(store, { executionId: "exec-esc-1" });
  const attempt = history.steps[0].history[0];
  assert.deepEqual(attempt.escalation, { escalated: true, fromTier: "standard", toTier: "premium", reason: "low_confidence" });
});

// ---------------------------------------------------------------- Case 4: Visualization

test("Case 4: VisualizationでEscalationがRetryと区別して表示される", async () => {
  const store = createMemoryArtifactStore();
  await saveArtifact(store, {
    artifactId: "model-execution-record", executionId: "exec-esc-2", stepId: "implement",
    artifact: {
      type: "model-execution-record", produced_by: "harness", unresolved: [],
      executionId: "exec-esc-2", stepId: "implement", attempt: 1, runtime: "mock", status: "succeeded",
      escalation: { escalated: true, fromTier: "standard", toTier: "premium", reason: "critical_and_low_confidence" },
      record: { agent: "developer" }
    }
  });
  await saveArtifact(store, {
    artifactId: "execution-result", executionId: "exec-esc-2", stepId: "execution",
    artifact: {
      type: "execution-result", produced_by: "harness", unresolved: [],
      executionId: "exec-esc-2", status: "completed", workflow: "w",
      startedAt: "2026-09-25T10:00:00.000Z", completedAt: "2026-09-25T10:01:00.000Z"
    }
  });

  const history = await getExecutionHistory(store, { executionId: "exec-esc-2" });
  const visualization = buildExecutionVisualization(history);
  const rendered = formatExecutionVisualization(visualization).join("\n");

  assert.match(rendered, /⇡ escalation standard→premium \(critical_and_low_confidence\)/);
  // Retry記号(↻)はattempt 1には付かない — escalationとretryは区別される
  assert.doesNotMatch(rendered, /↻ implement attempt 1/);
});

// ---------------------------------------------------------------- Case 5: Escalation後失敗

test("Case 5: escalation後もtier上限で失敗すれば失敗として返る", async () => {
  const adapter = createEscalationRuntimeAdapter({
    name: "escalation",
    policy,
    createDelegate: mockDelegate({
      implement: [{ confidence: "low", tokensSpent: 1 }]
    })
  });

  const outcome = await adapter.executeStep({ stepId: "implement", step: { id: "implement" } });
  // premiumでlow confidence継続 → 上限(2)到達でstop → 失敗+exhaustion artifact
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.artifacts[0].type, "escalation_exhausted");
  assert.equal(outcome.artifacts[0].escalations_used, 2);
  assert.equal(outcome.artifacts[0].max_escalations, 2);
  assert.match(outcome.failure.reason, /エスカレーション上限/);
});

// ---------------------------------------------------------------- Case 6: Maximum Tier

test("Case 6: rule tierがtiers未定義ならescalationせず返す(存在しないtierへ移行しない)", async () => {
  const adapter = createEscalationRuntimeAdapter({
    name: "escalation",
    policy: {
      tier: "standard",
      tiers: { standard: tiers.standard }, // premium未定義
      modelPolicy,
      workflowName: "w"
    },
    createDelegate: mockDelegate({
      implement: [{ confidence: "low", tokensSpent: 1 }]
    })
  });

  const outcome = await adapter.executeStep({ stepId: "implement", step: { id: "implement" } });
  // premiumへ移行できない → escalationせずoutcomeをそのまま返す
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.runtime.escalation, undefined);
});

// ---------------------------------------------------------------- Case 7: Retry + Escalation

test("Case 7: escalationはstep内tier移動であり、Execution Loopのattempt/retryと独立する", async () => {
  // escalation adapterはengineから見て単一executeStep: 同一attempt内でtier移動する
  let calls = 0;
  const adapter = createEscalationRuntimeAdapter({
    name: "escalation",
    policy,
    createDelegate: () => ({
      async executeStep(request) {
        calls += 1;
        return { status: "succeeded", tokensSpent: 1, runtime: { runtime: "mock", confidence: calls === 1 ? "low" : "high" } };
      }
    })
  });

  const outcome = await adapter.executeStep({ stepId: "implement", step: { id: "implement" }, attempt: 1 });
  assert.equal(outcome.status, "succeeded");
  assert.equal(calls, 2); // tier内で2回実行(attempt番号はengine側で管理される)
});

// ---------------------------------------------------------------- Case 8: Fallbackとの分離

test("Case 8: fallback報告を持つoutcomeもconfidence報告次第で透過し、混同しない", async () => {
  const adapter = createEscalationRuntimeAdapter({
    name: "escalation",
    policy,
    createDelegate: () => ({
      async executeStep() {
        return {
          status: "succeeded",
          tokensSpent: 1,
          runtime: {
            runtime: "mock",
            confidence: "high",
            fallback: { fromProvider: "a", toProvider: "b" },
            fallbackCount: 1
          }
        };
      }
    })
  });

  const outcome = await adapter.executeStep({ stepId: "implement", step: { id: "implement" } });
  // fallback情報はそのまま保持、escalation情報は付かない
  assert.equal(outcome.runtime.fallbackCount, 1);
  assert.equal(outcome.runtime.escalation, undefined);
});

// ---------------------------------------------------------------- Case 9: Guardrail

test("Case 9: guardrail violation(confidence未報告)はescalationせず既存失敗のまま", async () => {
  const adapter = createEscalationRuntimeAdapter({
    name: "escalation",
    policy,
    createDelegate: mockDelegate({
      implement: [{ status: "failed", errorCategory: "guardrail_violation", failure: { reason: "refused: shell_disabled" } }]
    })
  });

  const outcome = await adapter.executeStep({ stepId: "implement", step: { id: "implement" } });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.runtime.errorCategory, "guardrail_violation");
  assert.equal(outcome.runtime.escalation, undefined); // 境界迂回のescalationは発生しない
});

// ---------------------------------------------------------------- E2E: engine + escalation + history

test("E2E: runHarness + escalation adapterでlow confidence→tier上→完了→History記録まで通る", async () => {
  const { runHarness } = await import("../src/run/run-harness.js");
  const delegate = createMockRuntimeAdapter({
    name: "mock",
    provider: "mock-provider",
    model: "mock-model",
    script: {
      implement: [
        { confidence: "low", critical: true, tokensSpent: 2 },
        { confidence: "high", tokensSpent: 2 }
      ]
    }
  });
  const store = createMemoryArtifactStore();

  const run = await runHarness({
    goal: "escalation e2e",
    intent: "feature",
    risk: "high",
    workflowRegistry: [{
      name: "esc-e2e",
      routing: { intents: ["feature"], required_request_fields: ["goal"], priority: 100 },
      steps: [{ id: "implement", agent: "agents/developer.yaml", gate: "g" }],
      sourcePath: "workflows/esc-e2e.yaml"
    }],
    executeStep: createEscalationRuntimeAdapter({
      name: "escalation",
      policy: { tier: "standard", tiers, modelPolicy, workflowName: "esc-e2e" },
      createDelegate: () => delegate
    }).executeStep.bind(null),
    executionId: "exec-esc-e2e",
    artifactStore: store,
    trackModelExecutions: true
  });

  assert.equal(run.exitCode, 0);
  assert.equal(run.result.status, "completed");

  // engineから見たmodel recordにescalation報告が載る(#22 reserved shape発動)
  const record = run.result.modelExecutions[0];
  assert.deepEqual(record.escalation, {
    escalated: true,
    fromTier: "standard",
    toTier: "premium",
    reason: "critical_and_low_confidence" // critical優先ルール(既存判定順序)
  });

  // 永続化されたrecordからHistory経由でも追跡できる
  const history = await getExecutionHistory(store, { executionId: "exec-esc-e2e" });
  assert.deepEqual(history.steps[0].history[0].escalation, record.escalation);

  // Visualizationにもescalation行が表示される
  const rendered = formatExecutionVisualization(buildExecutionVisualization(history)).join("\n");
  assert.match(rendered, /⇡ escalation standard→premium/);
});

// ---------------------------------------------------------------- 正本Profileとの整合

test("正本profile(opencode-gpt-gemini)のpolicyでescalation adapterが構成できる", async () => {
  const definition = parse(await readFile(join(projectRoot, "profiles", "opencode-gpt-gemini.yaml"), "utf8"));
  const adapter = createEscalationRuntimeAdapter({
    name: "escalation",
    policy: { tier: "standard", tiers: definition.model_tiers, modelPolicy: definition.model_policy },
    createDelegate: mockDelegate({ implement: [{ confidence: "high" }] })
  });
  const outcome = await adapter.executeStep({ stepId: "design", step: { id: "design" } });
  assert.equal(outcome.status, "succeeded");
});

// ---------------------------------------------------------------- 構成エラー

test("policy欠落時は構成時に失敗する(実行時に黙って無効化されない)", () => {
  assert.throws(() => createEscalationRuntimeAdapter({ policy: { tiers, modelPolicy }, createDelegate: mockDelegate({}) }), /tier/);
  assert.throws(() => createEscalationRuntimeAdapter({ policy: { tier: "standard", modelPolicy }, createDelegate: mockDelegate({}) }), /model_tiers/);
  assert.throws(() => createEscalationRuntimeAdapter({ policy: { tier: "standard", tiers }, createDelegate: mockDelegate({}) }), /model_policy/);
});
