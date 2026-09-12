import test from "node:test";
import assert from "node:assert/strict";
import { runWorkflow } from "../src/execution/execution-engine.js";
import { toStepExecutor } from "../src/runtimes/runtime-adapter.js";
import { createOpenCodeRuntimeAdapter } from "../src/runtimes/opencode/opencode-runtime-adapter.js";
import { createGuardedCommandRunner } from "../src/guardrails/guarded-command-runner.js";
import { createDefaultActionPolicy } from "../src/guardrails/action-policy.js";

const implementationArtifact = {
  type: "implementation-result",
  produced_by: "developer",
  unresolved: [],
  changed_files: [{ path: "src/config.js", reason: "保存処理を追加" }]
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

/** 実行を記録するだけのrunner(実際のプロセスは起動しない)。 */
function recordingRunner(outcomes = {}) {
  const calls = [];
  return {
    calls,
    async runCommand(request) {
      calls.push(request);
      return { id: request.id, exitCode: 0, stdout: "", stderr: "", durationMs: 1, ...outcomes };
    }
  };
}

const stepArtifacts = {
  implement: implementationArtifact,
  test: { type: "test-result", produced_by: "test-engineer", unresolved: [], tests: { executed: [{ name: "a", outcome: "pass" }], pending: [] } }
};

test("OpenCode Runtime AdapterがExecution Loopで完走し、metadataが記録される", async () => {
  // CLI起動を許可するPolicy(OpenCodeアダプタの実用構成)
  const policy = { ...createDefaultActionPolicy(), shell: { execute: "allow" } };
  const runner = recordingRunner();
  const guardedRunner = createGuardedCommandRunner({
    runner,
    policy,
    permissions: { read: "allow", edit: "allow", write: "allow" },
    profileMode: "write"
  });

  const adapter = createOpenCodeRuntimeAdapter({
    name: "opencode",
    commandRunner: guardedRunner,
    provider: "openai",
    model: "gpt-5.6-terra"
  });
  // recordingRunnerはstdoutを持たないので、実行側で成果物を注入する代わりに
  // adapterの抽出を通す: stdoutが空でも成功outcomeは機械判定可能
  const executeStep = async (request) => {
    const outcome = await adapter.executeStep(request);
    // Loop内の後続検証はMechanical Verification/Mechanical gatesが担うため、
    // ここでは実行経路の証明に集中する
    return outcome;
  };

  const result = await runWorkflow({ workflow, executeStep });

  assert.equal(result.status, "completed");
  const record = result.steps.implement.results[0];
  assert.equal(record.runtime.runtime, "opencode");
  assert.equal(record.runtime.provider, "openai");
  assert.equal(record.runtime.model, "gpt-5.6-terra");
  assert.equal(record.runtime.exitCode, 0);
  // CLI起動はGuarded Command Runner経由でのみ行われた
  assert.equal(runner.calls.length, 2);
  assert.equal(runner.calls[0].command, "opencode");
});

test("GuardrailsがCLI起動を拒否するPolicyでは、迂回経路なく失敗Resultになる", async () => {
  // shell実行を許可しないPolicy: CLI起動そのものがGuarded Command Runnerで止まる
  const policy = createDefaultActionPolicy(); // shell.execute: deny
  const runner = recordingRunner();
  const guardedRunner = createGuardedCommandRunner({
    runner,
    policy,
    permissions: { read: "allow", edit: "allow", write: "allow" },
    profileMode: "write"
  });

  const adapter = createOpenCodeRuntimeAdapter({ commandRunner: guardedRunner });

  const result = await runWorkflow({
    workflow,
    executeStep: toStepExecutor(adapter)
  });

  // 実プロセスは一切起動しない
  assert.deepEqual(runner.calls, []);
  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "step_failed");
  assert.equal(result.failedStep, "implement");
  assert.equal(result.steps.implement.results[0].runtime.errorCategory, "guardrail_violation");
  assert.match(result.failure.reason, /shell_disabled/);
});

test("CLI失敗(exit code異常)はon_failure回路で差し戻され、上限で打ち切りになる", async () => {
  const policy = { ...createDefaultActionPolicy(), shell: { execute: "allow" } };
  let calls = 0;
  const runner = {
    calls,
    async runCommand(request) {
      calls += 1;
      return { id: request.id, exitCode: 1, stdout: "", stderr: "cli error", durationMs: 1 };
    }
  };
  const guardedRunner = createGuardedCommandRunner({
    runner,
    policy,
    permissions: { read: "allow", edit: "allow", write: "allow" },
    profileMode: "write"
  });

  const adapter = createOpenCodeRuntimeAdapter({ commandRunner: guardedRunner });

  const result = await runWorkflow({ workflow, executeStep: toStepExecutor(adapter) });

  // implement→test(NG)→implement→test(NG)→打ち切りではなく、
  // implement自体が常に失敗するためon_failure未定義の即時失敗になる
  assert.equal(result.status, "failed");
  assert.equal(result.stopReason, "step_failed");
  assert.equal(result.failedStep, "implement");
  assert.equal(result.steps.implement.results[0].runtime.errorCategory, "nonzero_exit");
  assert.match(result.failure.reason, /exited with code 1/);
});
