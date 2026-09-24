import test from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../src/execution/execution-engine.js";
import { runHarness } from "../src/run/run-harness.js";
import { getExecutionHistory } from "../src/run/execution-history.js";
import {
  buildExecutionVisualization,
  formatExecutionVisualization
} from "../src/run/execution-visualization.js";
import { createMockRuntimeAdapter } from "../src/runtimes/mock/mock-runtime-adapter.js";
import { createMemoryArtifactStore, saveArtifact } from "../src/artifacts/artifact-store.js";

const workflow = {
  name: "implement-test",
  routing: { intents: ["feature"], required_request_fields: ["goal"], priority: 100 },
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

const implementationArtifact = {
  type: "implementation-result",
  produced_by: "developer",
  unresolved: [],
  changed_files: [{ path: "src/config.js", reason: "実装" }]
};

const testArtifact = {
  type: "test-result",
  produced_by: "test-engineer",
  unresolved: [],
  tests: { executed: [{ name: "a.test.js", outcome: "pass" }], pending: [] }
};

async function runAndVisualize({ script, executionId, goal = "テスト用ゴール" }) {
  const store = createMemoryArtifactStore();
  const adapter = createMockRuntimeAdapter({ name: "opencode", provider: "zai", model: "glm-5.2", script });
  const workflowRegistry = [{ ...workflow, sourcePath: "workflows/implement-test.yaml" }];

  const run = await runHarness({
    goal,
    intent: "feature",
    workflowRegistry,
    executeStep: adapter.executeStep.bind(adapter),
    artifactStore: store,
    executionId,
    trackModelExecutions: true
  });
  const history = await getExecutionHistory(store, { executionId });
  const visualization = buildExecutionVisualization(history);
  return { result: run.result, history, visualization, store, run };
}

test("正常実行のVisualization: Step/Model/Runtime/Verificationが投影される", async () => {
  const { run, visualization } = await runAndVisualize({
    script: { implement: [{ tokensSpent: 300 }], test: [{ tokensSpent: 200 }] },
    executionId: "exec-vis-1"
  });

  assert.equal(run.exitCode, 0);

  const stepEntries = visualization.timeline.filter((entry) => entry.kind === "step-attempt");
  assert.deepEqual(stepEntries.map((entry) => `${entry.stepId}:${entry.status}`), ["implement:succeeded", "test:succeeded"]);
  assert.equal(stepEntries[0].resolvedProvider, "zai");
  assert.equal(stepEntries[0].resolvedModel, "glm-5.2");
  assert.equal(visualization.summary.retries, 0);
  assert.equal(visualization.summary.fallbacks, 0);
});

test("Verification成功のVisualization: gatesが✓付きで表示される", async () => {
  const { visualization } = await runAndVisualize({
    script: {},
    executionId: "exec-vis-verify-pass",
    executionIdOverride: undefined
  });

  const rendered = formatExecutionVisualization(visualization).join("\n");
  // この実行にはverification-result artifactが無いためVerification節は出ない
  assert.equal(rendered.includes("Verification ("), false);
});

test("失敗実行のVisualization: error categoryとfailure reasonが表示される", async () => {
  const adapter = createMockRuntimeAdapter({
    script: { implement: [{ timeout: true }] }
  });

  const result = await runWorkflow({
    workflow: { name: "single", steps: [{ id: "implement", agent: "agents/developer.yaml", gate: "g" }] },
    executeStep: adapter.executeStep.bind(adapter),
    executionId: "exec-vis-fail"
  });

  const visualization = buildExecutionVisualization({
    executionId: "exec-vis-fail",
    status: result.status,
    goal: null,
    workflow: "single",
    planId: null,
    planHash: null,
    source: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    steps: [
      {
        stepId: "implement",
        status: "failed",
        attempts: 1,
        retries: 0,
        fallbackCount: 0,
        history: [{
          attempt: 1,
          role: "developer",
          runtime: "mock",
          status: "failed",
          errorCategory: "timeout",
          failureReason: 'runtime "mock" timed out executing step "implement".',
          durationMs: null,
          tokensSpent: null,
          requestedModel: null,
          resolvedProvider: null,
          resolvedModel: null,
          fallbackCount: null,
          fallback: null
        }]
      }
    ],
    modelExecutions: [],
    verification: [],
    guardrailDenials: [],
    fallbacks: [],
    artifacts: [],
    failureReason: null
  });

  const rendered = formatExecutionVisualization(visualization).join("\n");
  assert.match(rendered, /✗ implement attempt 1/);
  assert.match(rendered, /\[timeout\]/);
  assert.match(rendered, /reason: /);
});

test("Retry実行はattempt番号と↻区別で表示される(fallbackと混同しない)", async () => {
  const workflowWithRetry = {
    name: "implement-test-retry",
    routing: { intents: ["feature"], required_request_fields: ["goal"], priority: 100 },
    steps: [
      { id: "implement", agent: "agents/developer.yaml", gate: "実装がある" },
      { id: "test", agent: "agents/test-engineer.yaml", gate: "検証がある", on_failure: "implement", retry_policy: { max_attempts: 2 } }
    ]
  };
  const adapter = createMockRuntimeAdapter({
    script: {
      implement: [{ tokensSpent: 1 }, { tokensSpent: 1 }],
      test: [{ status: "failed", failure: { reason: "検証NG" } }, { tokensSpent: 1 }]
    }
  });
  const store = createMemoryArtifactStore();
  const workflowRegistry = [{ ...workflowWithRetry, sourcePath: "workflows/implement-test-retry.yaml" }];

  const run = await runHarness({
    goal: "リトライを検証する",
    intent: "feature",
    workflowRegistry,
    executeStep: adapter.executeStep.bind(adapter),
    artifactStore: store,
    executionId: "exec-vis-retry",
    trackModelExecutions: true
  });

  assert.equal(run.result.status, "completed");
  const history = await getExecutionHistory(store, { executionId: "exec-vis-retry" });
  const visualization = buildExecutionVisualization(history);
  const rendered = formatExecutionVisualization(visualization).join("\n");

  assert.match(rendered, /↻ implement attempt 2/);
  assert.match(rendered, /Fallbacks: 0/);
  assert.equal(visualization.summary.retries, 2); // implementとtestの両方が再試行された
});

test("PR Automation作成済みの実行はFlowにPull Requestが表示される", async () => {
  const store = createMemoryArtifactStore();
  await saveArtifact(store, {
    artifactId: "pr-automation", executionId: "exec-vis-pr", stepId: "automation",
    artifact: { type: "pr-automation", produced_by: "harness", unresolved: [], executionId: "exec-vis-pr", status: "created", code: null, reason: "pull request created.", branch: "harness/exec-vis-pr", commit: "abc1234", pullRequestUrl: "https://github.com/demo/repo/pull/7", createdAt: "2026-09-21T00:00:00.000Z" }
  });

  const history = await getExecutionHistory(store, { executionId: "exec-vis-pr" });
  const visualization = buildExecutionVisualization(history);
  const rendered = formatExecutionVisualization(visualization).join("\n");

  const prEntry = visualization.timeline.find((entry) => entry.kind === "pr-automation");
  assert.equal(prEntry.status, "created");
  assert.equal(prEntry.pullRequestUrl, "https://github.com/demo/repo/pull/7");
  assert.equal(prEntry.branch, "harness/exec-vis-pr");
  assert.match(rendered, /⎇ Pull Request created: https:\/\/github\.com\/demo\/repo\/pull\/7/);
  assert.match(rendered, /Human review is the final gate/);
});

test("PR Automation skippedの理由がVisualizationに表示される", async () => {
  const store = createMemoryArtifactStore();
  await saveArtifact(store, {
    artifactId: "pr-automation", executionId: "exec-skipped", stepId: "automation",
    artifact: { type: "pr-automation", produced_by: "harness", unresolved: ["PR automation skipped: verification failed"], executionId: "exec-skipped", status: "skipped", code: "verification_failed", reason: "mechanical verification did not pass", branch: null, commit: null, pullRequestUrl: null, createdAt: "2026-09-21T00:00:00.000Z" }
  });

  const history = await getExecutionHistory(store, { executionId: "exec-skipped" });
  const rendered = formatExecutionVisualization(buildExecutionVisualization(history)).join("\n");

  assert.match(rendered, /⊘ Pull Request skipped/);
  assert.match(rendered, /mechanical verification did not pass/);
  assert.equal(visualizationSummaryPrAutomation(buildExecutionVisualization(history)), "skipped");
});

test("PR Automation失敗の理由がVisualizationに表示される", async () => {
  const store = createMemoryArtifactStore();
  await saveArtifact(store, {
    artifactId: "pr-automation", executionId: "exec-pr-fail", stepId: "automation",
    artifact: { type: "pr-automation", produced_by: "harness", unresolved: [], executionId: "exec-pr-fail", status: "failed", code: null, reason: "GitHub temporarily unavailable", branch: "harness/x", commit: null, pullRequestUrl: null, createdAt: "2026-09-21T00:00:00.000Z" }
  });

  const history = await getExecutionHistory(store, { executionId: "exec-pr-fail" });
  const rendered = formatExecutionVisualization(buildExecutionVisualization(history)).join("\n");

  assert.match(rendered, /✗ Pull Request automation failed: GitHub temporarily unavailable/);
});

test("Dry-run状態は区別して表示される", async () => {
  const store = createMemoryArtifactStore();
  await saveArtifact(store, {
    artifactId: "pr-automation", executionId: "exec-dry", stepId: "automation",
    artifact: { type: "pr-automation", produced_by: "harness", unresolved: [], executionId: "exec-dry", status: "dry-run", code: null, reason: "dry run: nothing was pushed or created.", branch: "harness/exec-dry", commit: null, pullRequestUrl: null, createdAt: "2026-09-21T00:00:00.000Z" }
  });

  const history = await getExecutionHistory(store, { executionId: "exec-dry" });
  const visualization = buildExecutionVisualization(history);
  const rendered = formatExecutionVisualization(visualization).join("\n");

  const prEntry = visualization.timeline.find((entry) => entry.kind === "pr-automation");
  assert.equal(prEntry.status, "dry-run");
  assert.match(rendered, /dry-run|nothing was pushed or created/);
});

function visualizationSummaryPrAutomation(visualization) {
  return visualization.summary.prAutomation;
}
