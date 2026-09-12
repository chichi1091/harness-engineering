import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import {
  EXECUTION_STOP_REASONS,
  EXECUTION_STATUSES,
  STEP_STATUSES,
  runWorkflow,
  validateWorkflowForExecution
} from "../src/execution/execution-engine.js";
import {
  createScriptedStepExecutor,
  failOutcome,
  successOutcome
} from "../src/runtimes/mock/mock-step-executor.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A minimal valid artifact per type, for scenarios that hand artifacts forward. */
const validArtifacts = {
  "design-result": {
    type: "design-result",
    produced_by: "architect",
    unresolved: [],
    acceptance_criteria: [{ id: "AC1", description: "設定が保存される" }]
  },
  "exploration-result": {
    type: "exploration-result",
    produced_by: "explorer",
    unresolved: [],
    findings: [{ topic: "対象箇所", evidence: "src/config.js" }],
    relevant_files: ["src/config.js"]
  },
  "implementation-result": {
    type: "implementation-result",
    produced_by: "developer",
    unresolved: [],
    changed_files: [{ path: "src/config.js", reason: "保存処理を追加" }]
  },
  "test-result": {
    type: "test-result",
    produced_by: "test-engineer",
    unresolved: [],
    tests: { executed: [{ name: "config.test.js", outcome: "pass" }], pending: [] }
  },
  "review-result": {
    type: "review-result",
    produced_by: "reviewer",
    unresolved: [],
    decision: "approve",
    findings: []
  }
};

/** Two-step implement → test workflow with the canonical repair edge. */
function implementTestWorkflow({ maxAttempts = 2, retryOn } = {}) {
  return {
    name: "implement-test",
    steps: [
      { id: "implement", agent: "agents/developer.yaml", gate: "実装がある" },
      {
        id: "test",
        agent: "agents/test-engineer.yaml",
        gate: "検証が記録されている",
        on_failure: "implement",
        retry_policy: {
          max_attempts: maxAttempts,
          ...(retryOn !== undefined ? { retry_on: retryOn } : {})
        }
      }
    ]
  };
}

test("状態語彙が契約どおりに定義されている", () => {
  assert.deepEqual(EXECUTION_STATUSES, ["completed", "stopped", "failed"]);
  assert.deepEqual(STEP_STATUSES, ["pending", "running", "succeeded", "failed", "blocked"]);
  assert.equal(typeof EXECUTION_STOP_REASONS.RETRY_EXHAUSTED, "string");
});

test("validateWorkflowForExecutionは実行不能な定義を検出する", () => {
  assert.deepEqual(validateWorkflowForExecution({
    name: "ok",
    steps: [
      { id: "a", agent: "x", gate: "g" },
      { id: "b", agent: "x", gate: "g", on_failure: "a", retry_policy: { max_attempts: 2 } }
    ]
  }), []);

  const errors = validateWorkflowForExecution({
    name: "broken",
    steps: [
      { id: "a", agent: "x", gate: "g" },
      { id: "a", agent: "x", gate: "g" },
      { id: "c", agent: "x", gate: "g", on_failure: "missing", retry_policy: { max_attempts: 2 } },
      { id: "d", agent: "x", gate: "g", on_failure: "a" }
    ]
  });

  assert.equal(errors.length, 3);
  assert.match(errors.join("\n"), /duplicates "a"/);
  assert.match(errors.join("\n"), /on_failure "missing" which is not an earlier step/);
  assert.match(errors.join("\n"), /step "d" declares on_failure and must define retry_policy/);
});

test("正常系: 全ステップ成功で完了し、トレースとステップ状態が機械的に判定できる", async () => {
  const workflow = {
    name: "three-steps",
    steps: [
      { id: "a", agent: "x", gate: "g1" },
      { id: "b", agent: "y", gate: "g2" },
      { id: "c", agent: "z", gate: "g3" }
    ]
  };
  const executor = createScriptedStepExecutor({});

  const result = await runWorkflow({ workflow, executeStep: executor.execute });

  assert.equal(result.status, "completed");
  assert.equal(result.stopReason, null);
  assert.equal(result.failedStep, null);
  assert.equal(result.failure, null);
  assert.deepEqual(result.executionTrace, [
    { stepId: "a", attempt: 1, status: "succeeded" },
    { stepId: "b", attempt: 1, status: "succeeded" },
    { stepId: "c", attempt: 1, status: "succeeded" }
  ]);
  assert.deepEqual(result.completedSteps, ["a", "b", "c"]);
  assert.deepEqual(result.blockedSteps, []);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(
    Object.fromEntries(Object.entries(result.steps).map(([id, summary]) => [id, summary.status])),
    { a: "succeeded", b: "succeeded", c: "succeeded" }
  );
});

test("先のステップは前ステップの成果物をArtifactとして受け取る", async () => {
  const workflow = {
    name: "handoff",
    steps: [
      {
        id: "design",
        agent: "x",
        gate: "g",
        output: [{ artifact: "design-result", summary: "設計メモ" }]
      },
      { id: "implement", agent: "y", gate: "g" }
    ]
  };
  const executor = createScriptedStepExecutor({
    design: [successOutcome({ artifacts: [validArtifacts["design-result"]] })]
  });

  const result = await runWorkflow({ workflow, executeStep: executor.execute });

  assert.equal(result.status, "completed");
  assert.deepEqual(executor.calls[1].artifacts, { "design-result": validArtifacts["design-result"] });
  assert.equal(result.artifacts["design-result"], validArtifacts["design-result"]);
  assert.equal(result.artifactsProduced.length, 1);
});

test("Test失敗→Developerへ戻る→再検証→OK のループが自動で閉じる", async () => {
  const workflow = implementTestWorkflow();
  const executor = createScriptedStepExecutor({
    test: [
      failOutcome("受入条件AC1のテストが失敗", { unresolved: ["AC1の実装が不十分"] }),
      successOutcome()
    ]
  });

  const result = await runWorkflow({ workflow, executeStep: executor.execute });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.executionTrace.map((entry) => entry.stepId), [
    "implement", "test", "implement", "test"
  ]);
  assert.deepEqual(executor.calls.map((call) => call.attempt), [1, 1, 2, 2]);
  assert.equal(result.steps.test.executions, 2);
  assert.equal(result.steps.test.failed, 1);
  assert.equal(result.steps.test.succeeded, 1);
  assert.equal(result.steps.test.status, "succeeded");
  assert.equal(result.steps.implement.executions, 2);
  assert.deepEqual(result.completedSteps, ["implement", "test"]);
  assert.deepEqual(result.unresolved, []);
});

test("retry上限: max_attemptsを使い切ったら差し戻さず安全に停止する", async () => {
  const workflow = implementTestWorkflow({ maxAttempts: 2 });
  const executor = createScriptedStepExecutor({
    test: [
      failOutcome("1回目の失敗", { unresolved: ["未解決A"] }),
      failOutcome("2回目の失敗", { unresolved: ["未解決A", "未解決B"] })
    ]
  });

  const result = await runWorkflow({ workflow, executeStep: executor.execute });

  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, EXECUTION_STOP_REASONS.RETRY_EXHAUSTED);
  assert.equal(result.failedStep, "test");
  assert.match(result.failure.reason, /2回目の失敗/);
  assert.deepEqual(result.unresolved, ["未解決A", "未解決B"]);
  assert.equal(result.stopArtifact.type, "retry_exhausted");
  assert.equal(result.stopArtifact.attempts_used, 2);
  assert.equal(result.stopArtifact.max_attempts, 2);
  assert.equal(result.stopArtifact.gate, "検証が記録されている");
  assert.match(result.stopArtifact.message, /2\/2 回の実行で打ち切り/);
  // implement(1) → test(NG) → implement(2) → test(NG) → stop
  assert.deepEqual(result.executionTrace.map((entry) => entry.stepId), [
    "implement", "test", "implement", "test"
  ]);
  assert.deepEqual(result.blockedSteps, []);
  assert.equal(result.completedSteps.includes("test"), false);
});

test("retry_onに合致しない失敗は1回で打ち切りになる", async () => {
  const workflow = implementTestWorkflow({ maxAttempts: 3, retryOn: ["blocker", "high"] });
  const executor = createScriptedStepExecutor({
    test: [failOutcome("軽微な指摘", { severities: ["medium"] })]
  });

  const result = await runWorkflow({ workflow, executeStep: executor.execute });

  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, EXECUTION_STOP_REASONS.RETRY_EXHAUSTED);
  assert.equal(result.stopArtifact.attempts_used, 1);
  assert.deepEqual(result.executionTrace.map((entry) => entry.stepId), ["implement", "test"]);
});

test("on_failure未定義のステップが失敗したら安全に停止する", async () => {
  const workflow = {
    name: "no-recovery",
    steps: [
      { id: "a", agent: "x", gate: "g1" },
      { id: "b", agent: "y", gate: "g2" },
      { id: "c", agent: "z", gate: "g3" }
    ]
  };
  const executor = createScriptedStepExecutor({
    b: [failOutcome("後続に回復経路のない失敗", { unresolved: ["要判断"] })]
  });

  const result = await runWorkflow({ workflow, executeStep: executor.execute });

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, EXECUTION_STOP_REASONS.STEP_FAILED);
  assert.equal(result.failedStep, "b");
  assert.match(result.failure.reason, /後続に回復経路のない失敗/);
  assert.deepEqual(result.unresolved, ["要判断"]);
  assert.equal(result.stopArtifact, null);
  assert.deepEqual(
    Object.fromEntries(Object.entries(result.steps).map(([id, summary]) => [id, summary.status])),
    { a: "succeeded", b: "failed", c: "blocked" }
  );
  assert.deepEqual(result.blockedSteps, ["c"]);
});

test("存在しないステップへの遷移は実行前に拒否される", async () => {
  const executor = createScriptedStepExecutor({});

  const unknownTarget = await runWorkflow({
    workflow: {
      name: "dangling",
      steps: [
        { id: "a", agent: "x", gate: "g" },
        { id: "b", agent: "y", gate: "g", on_failure: "missing", retry_policy: { max_attempts: 2 } }
      ]
    },
    executeStep: executor.execute
  });

  assert.equal(unknownTarget.status, "failed");
  assert.equal(unknownTarget.stopReason, EXECUTION_STOP_REASONS.INVALID_WORKFLOW);
  assert.match(unknownTarget.diagnostics[0].message, /on_failure "missing"/);
  assert.deepEqual(executor.calls, []);

  const forwardTarget = await runWorkflow({
    workflow: {
      name: "forward",
      steps: [
        { id: "a", agent: "x", gate: "g", on_failure: "c", retry_policy: { max_attempts: 2 } },
        { id: "b", agent: "y", gate: "g" },
        { id: "c", agent: "z", gate: "g" }
      ]
    },
    executeStep: executor.execute
  });

  assert.equal(forwardTarget.status, "failed");
  assert.equal(forwardTarget.stopReason, EXECUTION_STOP_REASONS.INVALID_WORKFLOW);
  assert.deepEqual(executor.calls, []);
});

test("失敗と再実行を繰り返してもmax_attempts内で必ず停止する(無限ループ防止)", async () => {
  const workflow = implementTestWorkflow({ maxAttempts: 5 });
  const executor = createScriptedStepExecutor({
    // test は何度実行しても失敗する: 打ち切りは max_attempts が保証する
    test: Array.from({ length: 5 }, (_, index) => failOutcome(`失敗${index + 1}`))
  });

  const result = await runWorkflow({ workflow, executeStep: executor.execute });

  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, EXECUTION_STOP_REASONS.RETRY_EXHAUSTED);
  assert.equal(result.stopArtifact.attempts_used, 5);
  assert.deepEqual(result.executionTrace.map((entry) => entry.stepId), [
    "implement", "test", "implement", "test", "implement", "test", "implement", "test", "implement", "test"
  ]);
});

test("防御バウンド: maxStepExecutionsを超えたらエラー終了する", async () => {
  const workflow = {
    name: "bounded",
    steps: [
      { id: "a", agent: "x", gate: "g1" },
      { id: "b", agent: "y", gate: "g2" }
    ]
  };
  const executor = createScriptedStepExecutor({});

  const result = await runWorkflow({ workflow, executeStep: executor.execute, maxStepExecutions: 1 });

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, EXECUTION_STOP_REASONS.BOUND_EXCEEDED);
  assert.match(result.diagnostics[0].message, /bound of 1 step executions/);
  assert.deepEqual(result.executionTrace.map((entry) => entry.stepId), ["a"]);
});

test("トークン予算を使い切ったら次の実行前に停止する", async () => {
  const workflow = {
    name: "budgeted",
    budget: {
      max_total_tokens: 100,
      on_budget_exceeded: { action: "stop", output: ["completed_work", "remaining_work", "unresolved"] }
    },
    steps: [
      { id: "a", agent: "x", gate: "g1" },
      { id: "b", agent: "y", gate: "g2" },
      { id: "c", agent: "z", gate: "g3" }
    ]
  };
  const executor = createScriptedStepExecutor({
    a: [successOutcome({ tokensSpent: 60 })],
    b: [successOutcome({ tokensSpent: 60 })]
  });

  const result = await runWorkflow({ workflow, executeStep: executor.execute });

  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, EXECUTION_STOP_REASONS.BUDGET_EXHAUSTED);
  assert.equal(result.tokensSpent, 120);
  assert.equal(result.stopArtifact.type, "budget_exhausted");
  assert.equal(result.stopArtifact.total_tokens_spent, 120);
  assert.deepEqual(result.stopArtifact.completed_work, ["a", "b"]);
  assert.deepEqual(result.stopArtifact.remaining_work, ["c"]);
  assert.deepEqual(result.blockedSteps, ["c"]);
  // c は実行されていない: 予算超過後に追加呼び出しは行わない
  assert.deepEqual(result.executionTrace.map((entry) => entry.stepId), ["a", "b"]);
});

test("executorが例外を投げても例外ではなく失敗として扱う", async () => {
  const workflow = implementTestWorkflow({ maxAttempts: 2 });
  const executor = createScriptedStepExecutor({});
  const executeStep = async (request) => {
    if (request.stepId === "test") {
      throw new Error("runtime crashed");
    }
    return executor.execute(request);
  };

  const result = await runWorkflow({ workflow, executeStep });

  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, EXECUTION_STOP_REASONS.RETRY_EXHAUSTED);
  assert.match(result.failure.reason, /executor threw: runtime crashed/);
  assert.deepEqual(result.executionTrace.map((entry) => entry.stepId), [
    "implement", "test", "implement", "test"
  ]);
});

test("不正な成果物を返したステップは失敗として扱われる", async () => {
  const workflow = {
    name: "artifact-gate",
    steps: [{ id: "design", agent: "x", gate: "g" }]
  };
  const executor = createScriptedStepExecutor({
    design: [successOutcome({ artifacts: [{ type: "design-result", produced_by: "architect", unresolved: [] }] })]
  });

  const result = await runWorkflow({ workflow, executeStep: executor.execute });

  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, EXECUTION_STOP_REASONS.STEP_FAILED);
  assert.match(result.failure.reason, /invalid artifacts: design-result: "acceptance_criteria" must be a non-empty list\./);
  assert.equal(result.steps.design.status, "failed");
});

test("feature-development.yaml: 正常系をend-to-endで実行できる", async () => {
  const workflow = parse(
    await readFile(join(projectRoot, "workflows", "feature-development.yaml"), "utf8")
  );
  const executor = createScriptedStepExecutor({
    design: [successOutcome({ artifacts: [validArtifacts["design-result"]] })],
    explore: [successOutcome({ artifacts: [validArtifacts["exploration-result"]] })],
    implement: [successOutcome({ artifacts: [validArtifacts["implementation-result"]] })],
    test: [successOutcome({ artifacts: [validArtifacts["test-result"]] })],
    review: [successOutcome({ artifacts: [validArtifacts["review-result"]] })],
    document: [successOutcome()]
  });

  const result = await runWorkflow({ workflow, executeStep: executor.execute });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.executionTrace.map((entry) => entry.stepId), [
    "design", "explore", "implement", "test", "review", "document"
  ]);
  assert.deepEqual(result.completedSteps, ["design", "explore", "implement", "test", "review", "document"]);
  assert.deepEqual(result.blockedSteps, []);
  assert.equal(result.stopReason, null);
  assert.deepEqual(result.unresolved, []);
});

test("feature-development.yaml: Test NG → Developer修正 → 再検証 → OK の閉ループ", async () => {
  const workflow = parse(
    await readFile(join(projectRoot, "workflows", "feature-development.yaml"), "utf8")
  );
  const fixedImplementation = {
    ...validArtifacts["implementation-result"],
    changed_files: [{ path: "src/config.js", reason: "AC1に対応する保存処理を修正" }]
  };
  const executor = createScriptedStepExecutor({
    design: [successOutcome({ artifacts: [validArtifacts["design-result"]] })],
    explore: [successOutcome({ artifacts: [validArtifacts["exploration-result"]] })],
    implement: [
      successOutcome({ artifacts: [validArtifacts["implementation-result"]] }),
      successOutcome({ artifacts: [fixedImplementation] })
    ],
    test: [
      failOutcome("AC1の検証が失敗", { unresolved: ["AC1が未達"] }),
      successOutcome({ artifacts: [validArtifacts["test-result"]] })
    ],
    review: [successOutcome({ artifacts: [validArtifacts["review-result"]] })],
    document: [successOutcome()]
  });

  const result = await runWorkflow({ workflow, executeStep: executor.execute });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.executionTrace.map((entry) => entry.stepId), [
    "design", "explore", "implement", "test", "implement", "test", "review", "document"
  ]);
  assert.equal(result.steps.implement.executions, 2);
  assert.equal(result.steps.test.executions, 2);
  // 再検証の test は、修正後の implementation-result を入力に受け取る
  assert.equal(executor.calls[5].artifacts["implementation-result"], fixedImplementation);
  assert.equal(result.artifacts["test-result"].tests.executed[0].outcome, "pass");
  assert.equal(result.stopArtifact, null);
});

test("feature-development.yaml: Review打ち切り時に後続ステップはblockedで停止する", async () => {
  const workflow = parse(
    await readFile(join(projectRoot, "workflows", "feature-development.yaml"), "utf8")
  );
  const executor = createScriptedStepExecutor({
    design: [successOutcome({ artifacts: [validArtifacts["design-result"]] })],
    explore: [successOutcome({ artifacts: [validArtifacts["exploration-result"]] })],
    implement: [
      successOutcome({ artifacts: [validArtifacts["implementation-result"]] }),
      successOutcome({ artifacts: [validArtifacts["implementation-result"]] })
    ],
    test: [
      successOutcome({ artifacts: [validArtifacts["test-result"]] }),
      successOutcome({ artifacts: [validArtifacts["test-result"]] })
    ],
    review: [
      failOutcome("blocker指摘", { severities: ["blocker"], unresolved: ["セキュリティ指摘の対応方針が未決"] }),
      failOutcome("blocker指摘(再)", { severities: ["blocker"], unresolved: ["対応不能"] })
    ]
  });

  const result = await runWorkflow({ workflow, executeStep: executor.execute });

  assert.equal(result.status, "stopped");
  assert.equal(result.stopReason, EXECUTION_STOP_REASONS.RETRY_EXHAUSTED);
  assert.equal(result.failedStep, "review");
  assert.deepEqual(result.unresolved, ["対応不能"]);
  assert.deepEqual(result.completedSteps, ["design", "explore", "implement", "test"]);
  assert.deepEqual(result.blockedSteps, ["document"]);
  assert.equal(result.steps.review.executions, 2);
  assert.equal(result.steps.document.status, "blocked");
  assert.equal(result.stopArtifact.type, "retry_exhausted");
  assert.equal(result.stopArtifact.gate, "承認されている");
});
